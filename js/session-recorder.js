/**
 * Crash-Safe Multi-Session Audio Recorder (IndexedDB Persistence).
 * Saves compressed voice-grade Opus audio (~21 MB/hr) to IndexedDB every 5 seconds
 * under dated session entries—never overwrites previous sessions and survives browser crashes.
 */
(function (global) {
  const DB_NAME = "dnd_copilot_recordings_v2";
  const SESSIONS_STORE = "sessions";
  const CHUNKS_STORE = "chunks";

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable in this environment."));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const cs = db.createObjectStore(CHUNKS_STORE, { autoIncrement: true });
          cs.createIndex("bySession", "sessionId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  class SessionRecorder {
    constructor(onUpdate = () => {}, onAlert = () => {}) {
      this.onUpdate = onUpdate;
      this.onAlert = onAlert;
      this.isRecording = false;
      this.activeSessionId = null;
      this.recorder = null;
      this.stream = null;
      this.ownsStream = false;
      this.startedAt = null;
      this.lastChunkSavedAt = null;
      this.elapsedTimer = null;
      this.mimeType = "audio/webm";
      this.savedSessions = [];
      this.refreshSavedList();
    }

    async refreshSavedList() {
      try {
        const db = await openDb();
        const list = await new Promise((resolve, reject) => {
          const tx = db.transaction(SESSIONS_STORE, "readonly");
          const req = tx.objectStore(SESSIONS_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        this.savedSessions = list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        this.onUpdate(this.getStatus());
      } catch (_) {}
      return this.savedSessions;
    }

    async #upsertSessionMeta(meta) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(SESSIONS_STORE, "readwrite");
        tx.objectStore(SESSIONS_STORE).put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async #appendChunk(sessionId, blob) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readwrite");
        tx.objectStore(CHUNKS_STORE).add({ sessionId, blob, ts: Date.now() });

        const sStore = tx.objectStore(SESSIONS_STORE);
        const getReq = sStore.get(sessionId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            existing.bytes = (existing.bytes || 0) + blob.size;
            existing.durationSec = Math.max(
              1,
              Math.round((Date.now() - (existing.startedAt || Date.now())) / 1000)
            );
            sStore.put(existing);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async start(existingStream = null, partyGroupLabel = "B.U.G.S.") {
      if (this.isRecording) return;

      try {
        await global.navigator?.storage?.persist?.();
      } catch (_) {}

      this.stream =
        existingStream ||
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true
          }
        }));

      this.ownsStream = !existingStream;

      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("No audio track available to record.");
      }

      const audioOnly = new MediaStream(audioTracks);
      this.mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const now = new Date();
      const stamp = now.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });

      this.activeSessionId = `rec-${Date.now()}`;
      this.startedAt = Date.now();

      await this.#upsertSessionMeta({
        id: this.activeSessionId,
        title: `${partyGroupLabel} Audio — ${stamp}`,
        startedAt: this.startedAt,
        durationSec: 0,
        bytes: 0,
        mimeType: "audio/webm"
      });

      this.recorder = new MediaRecorder(audioOnly, {
        mimeType: this.mimeType,
        audioBitsPerSecond: 48000 // ~21 MB per hour, crisp voice quality
      });

      const currentId = this.activeSessionId;
      this.lastChunkSavedAt = Date.now();

      audioTracks[0]?.addEventListener?.("ended", () => {
        if (this.isRecording && this.activeSessionId === currentId) {
          this.onAlert(
            "⚠️ Backup audio recording stopped unexpectedly (microphone disconnected)! Check D&D Copilot."
          );
          this.stop();
        }
      });

      this.recorder.onerror = (ev) => {
        this.onAlert(
          `⚠️ Backup audio recorder error: ${ev?.error?.message || "MediaRecorder error"}`
        );
      };

      this.recorder.onstop = () => {
        if (this.isRecording && this.activeSessionId === currentId) {
          this.onAlert("⚠️ Backup audio recorder stopped unexpectedly! Check D&D Copilot.");
          this.stop();
        }
      };

      this.recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          try {
            await this.#appendChunk(currentId, e.data);
            this.lastChunkSavedAt = Date.now();
            await this.refreshSavedList();
          } catch (dbErr) {
            this.onAlert(
              `⚠️ Could not save backup audio chunk to disk (${dbErr?.message || dbErr})!`
            );
          }
        }
      };

      // Flush every 5 seconds to IndexedDB for crash safety
      this.recorder.start(5000);
      this.isRecording = true;

      this.elapsedTimer = setInterval(() => {
        this.onUpdate(this.getStatus());
      }, 1000);

      await this.refreshSavedList();
    }

    stop() {
      if (!this.isRecording) return;
      this.isRecording = false;
      if (this.elapsedTimer) {
        clearInterval(this.elapsedTimer);
        this.elapsedTimer = null;
      }
      if (this.recorder && this.recorder.state !== "inactive") {
        try {
          this.recorder.stop();
        } catch (_) {}
      }
      if (this.ownsStream && this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
      }
      this.stream = null;
      this.recorder = null;
      setTimeout(() => this.refreshSavedList(), 350);
    }

    async downloadRecording(sessionId = null) {
      const db = await openDb();
      const targetId = sessionId || this.savedSessions[0]?.id;
      if (!targetId) {
        throw new Error("No recorded session audio found yet.");
      }

      const meta = this.savedSessions.find((s) => s.id === targetId);
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNKS_STORE, "readonly");
        const idx = tx.objectStore(CHUNKS_STORE).index("bySession");
        const req = idx.getAll(targetId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });

      if (rows.length === 0) {
        throw new Error("Recording has no saved audio chunks yet.");
      }

      const blobs = rows.map((r) => r.blob);
      const fullBlob = new Blob(blobs, { type: "audio/webm" });
      const url = URL.createObjectURL(fullBlob);
      const safeName = String(meta?.title || `dnd-session-${targetId}`)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();

      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    async deleteRecording(sessionId) {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([SESSIONS_STORE, CHUNKS_STORE], "readwrite");
        tx.objectStore(SESSIONS_STORE).delete(sessionId);
        const cStore = tx.objectStore(CHUNKS_STORE);
        const idx = cStore.index("bySession");
        const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      await this.refreshSavedList();
    }

    getStatus() {
      const secs =
        this.isRecording && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
      const mins = String(Math.floor(secs / 60)).padStart(2, "0");
      const rem = String(secs % 60).padStart(2, "0");
      return {
        isRecording: this.isRecording,
        elapsedLabel: `${mins}:${rem}`,
        lastChunkSavedAt: this.lastChunkSavedAt,
        hasSavedChunks: this.savedSessions.length > 0,
        savedSessions: this.savedSessions
      };
    }
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.SessionRecorder = SessionRecorder;
})(window);
