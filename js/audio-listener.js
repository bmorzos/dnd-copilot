/**
 * Clean 2-Way Speech Listener: Switch anytime between Chrome (Built-in) and Groq (Whisper Large v3 Turbo).
 * Supports 3 Audio Inputs:
 *   1. "mic"    — Room / headset microphone (live in-person D&D table)
 *   2. "system" — Tab or Windows/Mac System Audio (playing a recording in YouTube, Drive, VLC, Media Player, even on headphones!)
 *   3. "file"   — Local audio/video recording opened via "📂 Audio File"
 */
(function (global) {
  class TableAudioListener {
    constructor(store, callbacks = {}) {
      this.store = store;
      this.onInterimText = callbacks.onInterimText || (() => {});
      this.onStatusChange = callbacks.onStatusChange || (() => {});
      this.onVolumeLevel = callbacks.onVolumeLevel || (() => {});
      this.onError = callbacks.onError || (() => {});
      this.onSpeechBatchReady = callbacks.onSpeechBatchReady || (() => {});

      this.isListening = false;
      this.activeSourceType = "idle"; // "mic" | "system" | "file" | "idle"
      this.mediaStream = null;
      this.customAudioTrack = null;
      this.boundAudioEl = null;
      this.boundAudioSrc = "";
      this._startingFile = false;

      this.audioCtx = null;
      this.analyser = null;
      this.mediaStreamDest = null;
      this.vuTimer = null;
      this.wakeLock = null;
      this.silenceHintTimer = null;
      this.maxRmsSinceStart = 0;

      this.recognition = null;
      this.mediaRecorder = null;
      this.chunkTimeout = null;
      this.peakRmsInWindow = 0;

      this.hasAnalyzedSinceStart = false;
      this.unprocessedCharsCount = 0;
      this.lastAutoAnalyzeAt = 0;
    }

    /**
     * 1. Live Microphone Input
     */
    async start() {
      if (this.isListening) {
        this.stop();
      }
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (err) {
        this.onError("Allow microphone access in Chrome's address bar.");
        throw err;
      }

      this.activeSourceType = "mic";
      this.customAudioTrack = this.mediaStream.getAudioTracks()[0] || null;
      this.#activateCurrentEngine();

      // If mic hears dead silence for 6s, remind user about PC Audio / Audio File in case they're playing a recording in headphones
      this.silenceHintTimer = setTimeout(() => {
        if (
          this.isListening &&
          this.activeSourceType === "mic" &&
          this.maxRmsSinceStart < 0.0025
        ) {
          this.onInterimText(
            '🔇 Mic hears silence — playing a recording in headphones or another app? Click "🔊 PC Audio" or "📂 Audio File" in the top bar!'
          );
        }
      }, 6000);
    }

    /**
     * 2. Capture Chrome Tab Audio OR Windows/Mac System Audio (works even with headphones!)
     */
    async startSystemOrTabAudio() {
      if (this.isListening) {
        this.stop();
      }
      let displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false
          }
        });
      } catch (err) {
        if (err?.name !== "NotAllowedError") {
          this.onError("Could not start PC/Tab audio capture.");
        }
        return false;
      }

      const audioTrack = displayStream.getAudioTracks()[0];
      if (!audioTrack) {
        displayStream.getTracks().forEach((t) => t.stop());
        this.onError(
          'No audio shared! Pick the tab or screen AND toggle ON "Also share tab audio" / "Share system audio".'
        );
        return false;
      }

      // Disable video frames to save CPU while keeping the shared audio session alive
      displayStream.getVideoTracks().forEach((vt) => {
        vt.enabled = false;
      });

      audioTrack.addEventListener("ended", () => {
        if (this.isListening && this.activeSourceType === "system") {
          this.stop();
        }
      });

      this.mediaStream = displayStream;
      this.customAudioTrack = audioTrack;
      this.activeSourceType = "system";
      this.#activateCurrentEngine();
      return true;
    }

    /**
     * 3. Capture Local Audio/Video File Element ("📂 Audio File")
     */
    async startFromAudioElement(audioEl) {
      if (!audioEl || this._startingFile) return;
      this._startingFile = true;

      try {
        if (this.isListening && this.activeSourceType !== "file") {
          this.stop(false);
        } else if (this.isListening && this.activeSourceType === "file") {
          this.#stopTranscriberOnly();
        }

        this.boundAudioEl = audioEl;

        // Wait until media element has decoded enough data to expose an audio track
        if (audioEl.readyState < 2) {
          await new Promise((resolve) => {
            let settled = false;
            const done = () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            audioEl.addEventListener("canplay", done, { once: true });
            setTimeout(done, 2500);
          });
        }

        if (audioEl.paused) {
          await audioEl.play();
        }

        // Reuse existing captured stream if same src and track is still live
        let stream =
          this.boundAudioSrc === audioEl.currentSrc &&
          audioEl._copilotStream &&
          audioEl._copilotStream.getAudioTracks()[0]?.readyState === "live"
            ? audioEl._copilotStream
            : null;

        if (!stream) {
          const captureFn = audioEl.captureStream || audioEl.mozCaptureStream;
          if (!captureFn) {
            this.onError("Audio element capture is not supported in this browser.");
            return;
          }
          stream = captureFn.call(audioEl);
          audioEl._copilotStream = stream;
          this.boundAudioSrc = audioEl.currentSrc;
        }

        let audioTrack = stream.getAudioTracks()[0];
        for (let attempt = 0; attempt < 6 && (!audioTrack || audioTrack.readyState !== "live"); attempt++) {
          await new Promise((r) => setTimeout(r, 150));
          audioTrack = stream.getAudioTracks()[0];
        }

        if (!audioTrack) {
          this.onError("This recording file has no playable audio track.");
          return;
        }

        this.mediaStream = stream;
        this.customAudioTrack = audioTrack;
        this.activeSourceType = "file";
        this.#activateCurrentEngine();
      } finally {
        this._startingFile = false;
      }
    }

    /**
     * Hot-swaps between "chrome" and "groq" even while actively listening!
     */
    switchSpeechEngine(nextMode) {
      const normalized = nextMode === "groq" ? "groq" : "chrome";
      this.store.updateSettings({ speechMode: normalized });

      if (!this.isListening) return;

      this.#stopTranscriberOnly();
      this.#startTranscriberOnly();
    }

    async #acquireWakeLock() {
      try {
        if (global.navigator?.wakeLock?.request && !this.wakeLock) {
          this.wakeLock = await global.navigator.wakeLock.request("screen");
          this.wakeLock.addEventListener?.("release", () => {
            this.wakeLock = null;
          });
        }
      } catch (_) {}
    }

    #releaseWakeLock() {
      if (this.wakeLock) {
        try {
          this.wakeLock.release();
        } catch (_) {}
        this.wakeLock = null;
      }
    }

    #activateCurrentEngine() {
      this.isListening = true;
      this.maxRmsSinceStart = 0;
      this.hasAnalyzedSinceStart = false;
      this.unprocessedCharsCount = 0;
      this.#acquireWakeLock();
      this.#startVuMeter();
      this.#startTranscriberOnly();
    }

    #sourceLabel() {
      if (this.activeSourceType === "file") return "Audio File";
      if (this.activeSourceType === "system") return "PC / Tab Audio";
      return "Microphone";
    }

    #startTranscriberOnly() {
      const mode = this.store.settings.speechMode === "groq" ? "groq" : "chrome";

      if (mode === "groq") {
        const hasGroqKey = Boolean((this.store.settings.groqApiKey || "").trim());
        if (!hasGroqKey) {
          this.onError(
            "Paste your free Groq API key in Settings first (using Chrome Speech for now)."
          );
          this.store.updateSettings({ speechMode: "chrome" });
          this.#startChromeRecognition(this.customAudioTrack);
          this.onStatusChange({ listening: true, source: this.activeSourceType, engine: "chrome" });
          return;
        }
        this.#startGroqWhisperChunker();
        this.onStatusChange({ listening: true, source: this.activeSourceType, engine: "groq" });
      } else {
        this.#startChromeRecognition(this.customAudioTrack);
        this.onStatusChange({ listening: true, source: this.activeSourceType, engine: "chrome" });
      }
    }

    #stopTranscriberOnly() {
      if (this.recognition) {
        try {
          this.recognition.onend = null;
          this.recognition.onerror = null;
          this.recognition.stop();
        } catch (_) {}
        this.recognition = null;
      }
      if (this.chunkTimeout) {
        clearTimeout(this.chunkTimeout);
        this.chunkTimeout = null;
      }
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try {
          this.mediaRecorder.onstop = null;
          this.mediaRecorder.stop();
        } catch (_) {}
      }
      this.mediaRecorder = null;
    }

    stop(pauseBoundAudio = true) {
      this.isListening = false;
      const prevSource = this.activeSourceType;
      this.activeSourceType = "idle";
      this.customAudioTrack = null;

      if (this.silenceHintTimer) {
        clearTimeout(this.silenceHintTimer);
        this.silenceHintTimer = null;
      }

      this.#stopTranscriberOnly();
      this.#releaseWakeLock();
      this.onInterimText("");

      if (pauseBoundAudio && this.boundAudioEl && !this.boundAudioEl.paused) {
        try {
          this.boundAudioEl.pause();
        } catch (_) {}
      }

      if (this.vuTimer) {
        clearInterval(this.vuTimer);
        this.vuTimer = null;
      }

      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
        this.analyser = null;
        this.mediaStreamDest = null;
      }

      if (this.mediaStream && prevSource !== "file") {
        this.mediaStream.getTracks().forEach((t) => t.stop());
      }
      this.mediaStream = null;

      this.onVolumeLevel(0);
      this.onStatusChange({
        listening: false,
        source: "idle",
        engine: this.store.settings.speechMode === "groq" ? "groq" : "chrome"
      });
    }

    getRecordableStream() {
      if (this.mediaStreamDest?.stream?.getAudioTracks().length > 0) {
        return this.mediaStreamDest.stream;
      }
      return this.mediaStream;
    }

    #startVuMeter() {
      if (this.vuTimer) {
        clearInterval(this.vuTimer);
        this.vuTimer = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
        this.analyser = null;
        this.mediaStreamDest = null;
      }

      const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextCtor || !this.mediaStream) return;

      const audioTracks = this.mediaStream.getAudioTracks();
      if (audioTracks.length === 0) return;

      try {
        this.audioCtx = new AudioContextCtor();
        if (this.audioCtx.state === "suspended") {
          this.audioCtx.resume().catch(() => {});
        }
        const audioOnlyStream = new MediaStream(audioTracks);
        const source = this.audioCtx.createMediaStreamSource(audioOnlyStream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;

        // Connect through a zero-gain pull sink so Chromium WebAudio ALWAYS pulls frames
        // from HTMLMediaElement.captureStream() without doubling speaker playback!
        const silentSink = this.audioCtx.createGain();
        silentSink.gain.value = 0;
        source.connect(this.analyser);
        this.analyser.connect(silentSink);
        silentSink.connect(this.audioCtx.destination);

        // Create a standardized WebAudio MediaStreamDestination so MediaRecorder works
        // identically on .mp3/.m4a/.wav/.webm files, PC/Tab audio, and Microphones!
        if (typeof this.audioCtx.createMediaStreamDestination === "function") {
          this.mediaStreamDest = this.audioCtx.createMediaStreamDestination();
          source.connect(this.mediaStreamDest);
        }

        const buf = new Float32Array(this.analyser.fftSize);
        this.vuTimer = setInterval(() => {
          if (!this.analyser || !this.isListening) return;
          if (this.audioCtx?.state === "suspended") {
            this.audioCtx.resume().catch(() => {});
          }
          this.analyser.getFloatTimeDomainData(buf);
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
          const rms = Math.sqrt(sumSq / buf.length);
          if (rms > this.peakRmsInWindow) this.peakRmsInWindow = rms;
          if (rms > this.maxRmsSinceStart) this.maxRmsSinceStart = rms;
          this.onVolumeLevel(Math.min(100, Math.round(rms * 420)));
        }, 120);
      } catch (_) {}
    }

    #startChromeRecognition(audioTrack = null, retriedAfterPerm = false) {
      const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
      if (!SpeechRec) {
        this.onError("Chrome Speech Recognition is unavailable — switch to Groq in the top bar.");
        return false;
      }

      const rec = new SpeechRec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";

      const speakerLabel =
        this.activeSourceType === "file" || this.activeSourceType === "system"
          ? "Recording"
          : "Table";

      this.onInterimText(`🎧 Listening via Chrome Speech (${this.#sourceLabel()})...`);

      rec.onresult = (event) => {
        let interim = "";
        let latestFinal = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const text = res[0]?.transcript || "";
          if (res.isFinal) {
            const clean = text.trim();
            if (clean.length > 1) {
              latestFinal = clean;
              this.store.addTranscriptLine(speakerLabel, clean, false);
              this.#checkAutoAnalyzeTrigger(clean.length);
            }
          } else {
            interim += text;
          }
        }
        if (interim.trim()) {
          this.onInterimText(`🎙️ ${interim.trim()}`);
        } else if (latestFinal) {
          this.onInterimText(`💬 Heard: "${latestFinal}"`);
        }
      };

      rec.onerror = async (event) => {
        const code = event?.error || "unknown";
        if (code === "no-speech" || code === "aborted") {
          return;
        }

        // If playing an Audio File or PC Audio before ever granting mic permission on chrome-extension://,
        // Chrome blocks SpeechRecognition with "not-allowed" until getUserMedia is granted once!
        if (
          code === "not-allowed" &&
          !retriedAfterPerm &&
          (this.activeSourceType === "file" || this.activeSourceType === "system")
        ) {
          try {
            const tempMic = await navigator.mediaDevices.getUserMedia({ audio: true });
            tempMic.getTracks().forEach((t) => t.stop());
            if (this.isListening) {
              this.#startChromeRecognition(audioTrack, true);
            }
            return;
          } catch (_) {}
        }

        // If Groq API key is already saved, auto-failover seamlessly!
        if ((this.store.settings.groqApiKey || "").trim()) {
          this.onError(
            `Chrome Speech hit "${code}" — automatically switching to Groq Whisper!`
          );
          this.switchSpeechEngine("groq");
          return;
        }

        if (code === "network" || code === "service-not-allowed") {
          this.onInterimText(
            `⚠️ Chrome blocked built-in speech (${code}). Click "Groq" in the top bar (free key at console.groq.com/keys) for reliable transcription!`
          );
          this.onError(
            `Chrome Speech error (${code}): Chrome extensions often throttle built-in speech. Switch to Groq in the top bar!`
          );
        } else {
          this.onInterimText(`⚠️ Chrome Speech error: ${code}`);
          this.onError(`Chrome Speech error: ${code}`);
        }
      };

      rec.onend = () => {
        if (!this.isListening || this.store.settings.speechMode === "groq") return;
        if (this.activeSourceType === "file" && this.boundAudioEl?.paused) {
          this.stop(false);
          return;
        }
        setTimeout(() => {
          if (!this.isListening || this.recognition !== rec) return;
          try {
            if (audioTrack && audioTrack.readyState === "live") {
              rec.start(audioTrack);
            } else if (this.activeSourceType === "mic") {
              rec.start();
            }
          } catch (_) {}
        }, 220);
      };

      try {
        if (audioTrack && audioTrack.readyState === "live") {
          try {
            rec.start(audioTrack);
          } catch (trackErr) {
            if (this.activeSourceType === "mic") {
              rec.start();
            } else {
              this.onInterimText(
                '⚠️ Your Chrome version cannot feed recorded audio into Chrome Speech — switch to "Groq" in the top bar!'
              );
              this.onError(
                "Chrome Speech on recordings requires Chrome 135+ or Groq mode. Click 'Groq' in the top bar!"
              );
              return false;
            }
          }
        } else if (this.activeSourceType === "mic") {
          rec.start();
        } else {
          this.onError("Audio track is not live yet — press Play on the recording.");
          return false;
        }
        this.recognition = rec;
        return true;
      } catch (err) {
        this.onError(`Could not start Chrome Speech: ${err.message || err}`);
        return false;
      }
    }

    #startGroqWhisperChunker() {
      if (!this.mediaStream || typeof MediaRecorder === "undefined") {
        this.onError("MediaRecorder is not supported in this browser.");
        return;
      }

      const sourceStream = this.getRecordableStream();
      const audioTracks = sourceStream ? sourceStream.getAudioTracks() : [];
      if (audioTracks.length === 0) {
        this.onError("No audio track found to transcribe.");
        return;
      }

      const audioOnlyStream = new MediaStream(audioTracks);
      const preferredMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

      const speakerLabel =
        this.activeSourceType === "file" || this.activeSourceType === "system"
          ? "Recording"
          : "Table";

      let isFirstClip = true;

      const recordNextClip = () => {
        if (!this.isListening || audioOnlyStream.getAudioTracks()[0]?.readyState === "ended") {
          return;
        }
        if (this.activeSourceType === "file" && this.boundAudioEl?.paused) {
          return;
        }

        const clipDurationMs = isFirstClip ? 5000 : 7500;
        isFirstClip = false;

        const chunks = [];
        this.peakRmsInWindow = 0;

        let recorder;
        try {
          recorder = preferredMime
            ? new MediaRecorder(audioOnlyStream, {
                mimeType: preferredMime,
                audioBitsPerSecond: 32000
              })
            : new MediaRecorder(audioOnlyStream);
        } catch (err) {
          this.onError(`Recorder error: ${err.message || err}`);
          return;
        }

        this.mediaRecorder = recorder;
        this.onInterimText(
          `🎧 Groq Whisper listening (${this.#sourceLabel()}) — next caption in ${Math.round(
            clipDurationMs / 1000
          )}s...`
        );

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
          // Schedule next clip immediately so zero audio is missed while HTTP request runs!
          if (this.isListening && this.store.settings.speechMode === "groq") {
            recordNextClip();
          }

          if (chunks.length === 0) return;

          // Only skip dead room silence in Microphone mode; always transcribe active Audio File / PC Audio!
          if (this.activeSourceType === "mic") {
            const analyserRunning = this.analyser && this.audioCtx?.state === "running";
            if (analyserRunning && this.peakRmsInWindow < 0.0012) {
              if (this.isListening) {
                this.onInterimText("🔇 Waiting for speech on Microphone...");
              }
              return;
            }
          }

          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size < 600) return;

          try {
            this.onInterimText("⚡ Groq Whisper transcribing...");
            const text = await global.DnDCopilot.GeminiClient.transcribeWithGroq(blob, this.store);
            if (text) {
              this.store.addTranscriptLine(speakerLabel, text, false);
              this.onInterimText(`💬 Heard: "${text}"`);
              this.#checkAutoAnalyzeTrigger(text.length);
            }
          } catch (err) {
            this.onInterimText(`⚠️ Groq error: ${err.message || err}`);
            this.onError(err.message || String(err));
          }
        };

        // 500ms timeslice guarantees Chrome flushes MediaRecorder buffers continuously on captureStream()
        recorder.start(500);
        this.chunkTimeout = setTimeout(() => {
          if (recorder.state === "recording") {
            try {
              recorder.stop();
            } catch (_) {}
          }
        }, clipDurationMs);
      };

      recordNextClip();
    }

    #checkAutoAnalyzeTrigger(addedChars) {
      this.unprocessedCharsCount += addedChars;

      // Update "What's Going On" IMMEDIATELY on the very first transcribed sentence!
      if (!this.hasAnalyzedSinceStart && this.unprocessedCharsCount >= 12) {
        this.hasAnalyzedSinceStart = true;
        this.unprocessedCharsCount = 0;
        this.lastAutoAnalyzeAt = Date.now();
        this.onSpeechBatchReady();
        return;
      }

      const minIntervalMs = Math.max(10, Number(this.store.settings.autoAnalyzeSeconds || 20)) * 1000;
      const elapsed = Date.now() - this.lastAutoAnalyzeAt;
      if (this.unprocessedCharsCount >= 75 && elapsed >= minIntervalMs) {
        this.unprocessedCharsCount = 0;
        this.lastAutoAnalyzeAt = Date.now();
        this.onSpeechBatchReady();
      }
    }
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.TableAudioListener = TableAudioListener;
})(window);
