/**
 * 3-Way Speech Listener: Switch anytime between Chrome (Built-in), Groq Whisper (VAD + PCM WAV),
 * and Deepgram Nova-3 (Live WebSocket Streaming + Speaker Diarization).
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
      this.onHealthAlert = callbacks.onHealthAlert || (() => {});
      this.onHealthRecovered = callbacks.onHealthRecovered || (() => {});

      this.isListening = false;
      this.activeSourceType = "idle"; // "mic" | "system" | "file" | "idle"
      this.mediaStream = null;
      this.customAudioTrack = null;
      this.boundAudioEl = null;
      this.boundAudioSrc = "";
      this._startingFile = false;

      this.audioCtx = null;
      this.analyser = null;
      this.scriptProc = null;
      this.mediaStreamDest = null;
      this.vuTimer = null;
      this.wakeLock = null;
      this.silenceHintTimer = null;
      this.maxRmsSinceStart = 0;

      this.recognition = null;
      this.mediaRecorder = null;
      this.chunkTimeout = null;
      this.peakRmsInWindow = 0;
      this.rmsSamplesInWindow = 0;

      this._pcmGroqActive = false;
      this.pcmChunks = [];
      this.pcmSampleCount = 0;
      this.pcmHasSpeech = false;
      this.pcmSilenceMs = 0;
      this.pcmIsFirstClip = true;
      this.pcmCarryoverSamples = null;
      this.lastGroqFinalText = "";

      this.dgSocket = null;
      this.dgKeepAliveTimer = null;
      this.dgReconnectTimer = null;
      this.dgReconnectAttempts = 0;

      this.pendingClips = [];
      this.isDrainingClips = false;
      this.hadHealthFailure = false;

      this.hasAnalyzedSinceStart = false;
      this.unprocessedCharsCount = 0;
      this.lastAutoAnalyzeAt = 0;

      if (typeof global.addEventListener === "function") {
        global.addEventListener("online", () => {
          if (this.pendingClips.length > 0 && !this.isDrainingClips) {
            this.#drainGroqQueue();
          }
        });
      }
      if (typeof global.document?.addEventListener === "function") {
        global.document.addEventListener("visibilitychange", () => {
          if (global.document.visibilityState === "visible" && this.isListening) {
            this.#acquireWakeLock();
          }
        });
      }
    }

    /**
     * 1. Live Microphone Input
     */
    async start() {
      if (this.isListening) {
        this.stop();
      }
      const constraints = global.DnDCopilot?.AudioUtils?.buildMicConstraints
        ? global.DnDCopilot.AudioUtils.buildMicConstraints(this.store.settings)
        : {
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          };

      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (
          constraints.audio?.deviceId &&
          (err?.name === "OverconstrainedError" || err?.name === "NotFoundError")
        ) {
          try {
            const fallbackAudio = { ...constraints.audio };
            delete fallbackAudio.deviceId;
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: fallbackAudio });
            this.onInterimText(
              "⚠️ Selected microphone not found — fell back to system default mic."
            );
          } catch (fallbackErr) {
            this.onError("Allow microphone access in Chrome's address bar.");
            throw fallbackErr;
          }
        } else {
          this.onError("Allow microphone access in Chrome's address bar.");
          throw err;
        }
      }

      this.activeSourceType = "mic";
      this.customAudioTrack = this.mediaStream.getAudioTracks()[0] || null;
      this.#attachTrackWatchdog(this.customAudioTrack, "Microphone");
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

    getRawMicStream() {
      return this.mediaStream;
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
     * Hot-swaps between "chrome", "groq", and "deepgram" even while actively listening!
     */
    switchSpeechEngine(nextMode) {
      const normalized =
        nextMode === "groq" ? "groq" : nextMode === "deepgram" ? "deepgram" : "chrome";
      this.store.updateSettings({ speechMode: normalized });

      if (!this.isListening) return;

      this.#stopTranscriberOnly();
      this.#startTranscriberOnly();
    }

    #attachTrackWatchdog(track, label) {
      if (!track || typeof track.addEventListener !== "function") return;
      track.addEventListener("ended", () => {
        if (this.isListening && this.customAudioTrack === track) {
          this.onHealthAlert(
            `⚠️ ${label} audio stopped or disconnected! Check your input in D&D Copilot so the transcript keeps running.`
          );
          this.stop();
        }
      });
      track.addEventListener("mute", () => {
        if (this.isListening && this.customAudioTrack === track) {
          this.onHealthAlert(
            `⚠️ ${label} was muted by your system! Unmute it so D&D Copilot can hear the table.`
          );
        }
      });
      track.addEventListener("unmute", () => {
        if (this.isListening && this.customAudioTrack === track) {
          this.onHealthRecovered();
        }
      });
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

    #normalizedEngineMode() {
      const m = this.store.settings.speechMode;
      if (m === "groq" || m === "deepgram") return m;
      return "chrome";
    }

    #speakerLabelForSource() {
      return this.activeSourceType === "file" || this.activeSourceType === "system"
        ? "Recording"
        : "Table";
    }

    #startTranscriberOnly() {
      const mode = this.#normalizedEngineMode();

      if (mode === "deepgram") {
        const hasDgKey = Boolean((this.store.settings.deepgramApiKey || "").trim());
        if (!hasDgKey) {
          const fallback = (this.store.settings.groqApiKey || "").trim() ? "groq" : "chrome";
          this.onError(
            `Paste your Deepgram API key in Settings first (using ${
              fallback === "groq" ? "Groq Whisper" : "Chrome Speech"
            } for now).`
          );
          this.store.updateSettings({ speechMode: fallback });
          this.#startTranscriberOnly();
          return;
        }
        this.#startDeepgramStreaming();
        this.onStatusChange({ listening: true, source: this.activeSourceType, engine: "deepgram" });
      } else if (mode === "groq") {
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
      if (this._pcmGroqActive) {
        if (this.pcmHasSpeech && this.pcmSampleCount >= 8000) {
          this.#flushGroqPcmBuffer(false);
        }
        this._pcmGroqActive = false;
        this.pcmChunks = [];
        this.pcmSampleCount = 0;
        this.pcmHasSpeech = false;
        this.pcmSilenceMs = 0;
        this.pcmCarryoverSamples = null;
      }

      this.#stopDeepgramStreaming();

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
        if (this.scriptProc) {
          try {
            this.scriptProc.onaudioprocess = null;
            this.scriptProc.disconnect();
          } catch (_) {}
          this.scriptProc = null;
        }
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
        engine: this.#normalizedEngineMode()
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
        if (this.scriptProc) {
          try {
            this.scriptProc.onaudioprocess = null;
            this.scriptProc.disconnect();
          } catch (_) {}
          this.scriptProc = null;
        }
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

        let processedNode = source;
        if (
          this.activeSourceType === "mic" &&
          this.store.settings.rawRoomAudio !== false &&
          typeof this.audioCtx.createBiquadFilter === "function" &&
          typeof this.audioCtx.createDynamicsCompressor === "function"
        ) {
          const highpass = this.audioCtx.createBiquadFilter();
          highpass.type = "highpass";
          highpass.frequency.value = 80;
          highpass.Q.value = 0.7;

          const compressor = this.audioCtx.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 18;
          compressor.ratio.value = 3;
          compressor.attack.value = 0.01;
          compressor.release.value = 0.2;

          source.connect(highpass);
          highpass.connect(compressor);
          processedNode = compressor;
        }

        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;

        // Connect through a zero-gain pull sink so Chromium WebAudio ALWAYS pulls frames
        // from HTMLMediaElement.captureStream() without doubling speaker playback!
        const silentSink = this.audioCtx.createGain();
        silentSink.gain.value = 0;
        processedNode.connect(this.analyser);
        this.analyser.connect(silentSink);
        silentSink.connect(this.audioCtx.destination);

        // Un-throttled audio-thread RMS metering & PCM streaming (runs even when tab is in the background!)
        if (typeof this.audioCtx.createScriptProcessor === "function") {
          this.scriptProc = this.audioCtx.createScriptProcessor(4096, 1, 1);
          this.scriptProc.onaudioprocess = (ev) => {
            if (!this.isListening) return;
            const ch = ev.inputBuffer.getChannelData(0);
            let sum = 0;
            let samplesChecked = 0;
            for (let i = 0; i < ch.length; i += 4) {
              sum += ch[i] * ch[i];
              samplesChecked += 1;
            }
            const rms = Math.sqrt(sum / Math.max(1, samplesChecked));
            if (rms > this.peakRmsInWindow) this.peakRmsInWindow = rms;
            if (rms > this.maxRmsSinceStart) this.maxRmsSinceStart = rms;
            this.rmsSamplesInWindow += 1;

            const inRate = this.audioCtx?.sampleRate || 48000;
            if (this._pcmGroqActive && this.store.settings.speechMode === "groq") {
              this.#handlePcmBufferForGroq(ch, inRate, rms);
            } else if (
              this.store.settings.speechMode === "deepgram" &&
              this.dgSocket?.readyState === 1 &&
              global.DnDCopilot?.AudioUtils
            ) {
              const downsampled = global.DnDCopilot.AudioUtils.downsampleFloat32(ch, inRate, 16000);
              if (downsampled.length > 0) {
                const pcm = global.DnDCopilot.AudioUtils.float32ToInt16Pcm(downsampled);
                try {
                  this.dgSocket.send(pcm.buffer);
                } catch (_) {}
              }
            }
          };
          processedNode.connect(this.scriptProc);
          this.scriptProc.connect(silentSink);
        }

        // Create a standardized WebAudio MediaStreamDestination so MediaRecorder works
        // identically on .mp3/.m4a/.wav/.webm files, PC/Tab audio, and Microphones!
        if (typeof this.audioCtx.createMediaStreamDestination === "function") {
          this.mediaStreamDest = this.audioCtx.createMediaStreamDestination();
          processedNode.connect(this.mediaStreamDest);
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
          this.rmsSamplesInWindow += 1;
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
        const sanitize = (s) =>
          String(s || "")
            .replace(/<\/?s>/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
        let interim = "";
        let latestFinal = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const text = sanitize(res[0]?.transcript || "");
          if (res.isFinal) {
            if (text.length > 1) {
              latestFinal = text;
              this.store.addTranscriptLine(speakerLabel, text, false);
              this.#checkAutoAnalyzeTrigger(text.length);
            }
          } else if (text) {
            interim = interim ? `${interim} ${text}` : text;
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
          } catch (restartErr) {
            if ((this.store.settings.groqApiKey || "").trim()) {
              this.switchSpeechEngine("groq");
            } else {
              this.onHealthAlert(
                "⚠️ Chrome built-in speech paused while in a background tab! Switch to Groq in the top bar for uninterrupted multi-hour transcripts."
              );
            }
          }
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

    async #drainGroqQueue() {
      if (this.isDrainingClips) return;
      this.isDrainingClips = true;

      while (this.pendingClips.length > 0) {
        const item = this.pendingClips[0];
        try {
          this.onInterimText(
            this.pendingClips.length > 1
              ? `⚡ Groq Whisper transcribing (${this.pendingClips.length} queued)...`
              : "⚡ Groq Whisper transcribing..."
          );
          const text = await global.DnDCopilot.GeminiClient.transcribeWithGroq(
            item.blob,
            this.store,
            item.isOverlapped ? "table-vad.wav" : ""
          );
          this.pendingClips.shift();

          if (this.hadHealthFailure) {
            this.hadHealthFailure = false;
            this.onHealthRecovered();
          }

          if (text) {
            let finalOut = text;
            if (
              item.isOverlapped &&
              this.lastGroqFinalText &&
              global.DnDCopilot?.AudioUtils?.dedupeOverlapText
            ) {
              finalOut = global.DnDCopilot.AudioUtils.dedupeOverlapText(
                this.lastGroqFinalText,
                text
              );
            }
            this.lastGroqFinalText = text;
            if (finalOut) {
              this.store.addTranscriptLine(item.speakerLabel, finalOut, false);
              this.onInterimText(`💬 Heard: "${finalOut}"`);
              this.#checkAutoAnalyzeTrigger(finalOut.length);
            }
          }
        } catch (err) {
          const msg = err?.message || String(err);
          this.hadHealthFailure = true;
          this.onInterimText(`⚠️ Transcript issue: ${msg}`);

          if (msg.includes("Groq API Key rejected")) {
            this.pendingClips.length = 0;
            this.onHealthAlert(`⚠️ Transcript stopped: ${msg}`);
            break;
          }

          // Keep up to 20 clips (~4 mins of speech) buffered while Wi-Fi reconnects!
          if (this.pendingClips.length > 20) {
            this.pendingClips.shift();
          }
          this.onHealthAlert(
            `⚠️ Live Transcript delayed (${msg}) — buffering your audio clips automatically and retrying in 8s!`
          );
          await new Promise((r) => setTimeout(r, 8000));
          if (!this.isListening && this.pendingClips.length === 0) break;
        }
      }

      this.isDrainingClips = false;
    }

    #handlePcmBufferForGroq(samples, sampleRate, rms) {
      const AudioUtils = global.DnDCopilot?.AudioUtils;
      if (!AudioUtils) return;

      const downsampled = AudioUtils.downsampleFloat32(samples, sampleRate, 16000);
      if (downsampled.length > 0) {
        this.pcmChunks.push(downsampled);
        this.pcmSampleCount += downsampled.length;
      }

      const bufMs = (samples.length / (Number(sampleRate) || 48000)) * 1000;
      if (rms >= 0.0035) {
        this.pcmHasSpeech = true;
        this.pcmSilenceMs = 0;
      } else {
        this.pcmSilenceMs += bufMs;
      }

      const minSec = this.pcmIsFirstClip ? 6 : 16;
      const maxSec = 32;
      const elapsedSec = this.pcmSampleCount / 16000;

      if ((elapsedSec >= minSec && this.pcmSilenceMs >= 450) || elapsedSec >= maxSec) {
        this.#flushGroqPcmBuffer(true);
      }
    }

    #flushGroqPcmBuffer(keepCarryover = true) {
      const AudioUtils = global.DnDCopilot?.AudioUtils;
      if (!AudioUtils) return;

      const parts = this.pcmCarryoverSamples
        ? [this.pcmCarryoverSamples, ...this.pcmChunks]
        : [...this.pcmChunks];
      const full = AudioUtils.concatFloat32Chunks(parts);
      const hadSpeech = this.pcmHasSpeech;
      const speakerLabel = this.#speakerLabelForSource();

      this.pcmChunks = [];
      this.pcmSampleCount = 0;
      this.pcmHasSpeech = false;
      this.pcmSilenceMs = 0;
      this.pcmIsFirstClip = false;

      if (keepCarryover && full.length > 0) {
        const keepSamples = Math.min(full.length, Math.round(16000 * 1.2));
        this.pcmCarryoverSamples = full.slice(full.length - keepSamples);
      } else {
        this.pcmCarryoverSamples = null;
      }

      if (this.activeSourceType === "mic" && !hadSpeech) {
        if (this.isListening && !this.isDrainingClips) {
          this.onInterimText("🔇 Listening (room is quiet)...");
        }
        return;
      }

      if (full.length < 1600) return;

      const blob = AudioUtils.encodeWavBlob(full, 16000);
      this.pendingClips.push({ blob, speakerLabel, isOverlapped: true });
      this.#drainGroqQueue();
    }

    #startGroqWhisperChunker() {
      // Prefer continuous 16 kHz PCM VAD chunking with 1.2s overlap when WebAudio scriptProc is live
      if (this.audioCtx && this.scriptProc && global.DnDCopilot?.AudioUtils) {
        this._pcmGroqActive = true;
        this.pcmChunks = [];
        this.pcmSampleCount = 0;
        this.pcmHasSpeech = false;
        this.pcmSilenceMs = 0;
        this.pcmIsFirstClip = true;
        this.pcmCarryoverSamples = null;
        this.lastGroqFinalText = "";
        if (!this.isDrainingClips) {
          this.onInterimText(
            `🎧 Groq Whisper VAD active (${this.#sourceLabel()}) — gapless 16 kHz PCM`
          );
        }
        return;
      }

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

      const speakerLabel = this.#speakerLabelForSource();
      let isFirstClip = true;

      const recordNextClip = () => {
        if (!this.isListening || audioOnlyStream.getAudioTracks()[0]?.readyState === "ended") {
          return;
        }
        if (this.activeSourceType === "file" && this.boundAudioEl?.paused) {
          return;
        }

        const clipDurationMs = isFirstClip ? 6000 : 12000;
        isFirstClip = false;

        const chunks = [];
        const clipStartedAt = Date.now();
        this.peakRmsInWindow = 0;
        this.rmsSamplesInWindow = 0;

        let recorder;
        try {
          recorder = preferredMime
            ? new MediaRecorder(audioOnlyStream, {
                mimeType: preferredMime,
                audioBitsPerSecond: 64000
              })
            : new MediaRecorder(audioOnlyStream);
        } catch (err) {
          this.onHealthAlert(`⚠️ Transcript recorder error: ${err.message || err}`);
          return;
        }

        this.mediaRecorder = recorder;
        if (!this.isDrainingClips) {
          this.onInterimText(
            `🎧 Groq Whisper active (${this.#sourceLabel()}) — runs continuously even on other tabs`
          );
        }

        recorder.onerror = (ev) => {
          this.onHealthAlert(
            `⚠️ Transcript audio capture error: ${ev?.error?.message || "MediaRecorder error"}`
          );
        };

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
          }
          if (
            recorder.state === "recording" &&
            Date.now() - clipStartedAt >= clipDurationMs
          ) {
            try {
              recorder.stop();
            } catch (_) {}
          }
        };

        recorder.onstop = () => {
          if (this.chunkTimeout) {
            clearTimeout(this.chunkTimeout);
            this.chunkTimeout = null;
          }

          if (this.isListening && this.store.settings.speechMode === "groq") {
            recordNextClip();
          }

          if (chunks.length === 0) return;

          if (this.activeSourceType === "mic") {
            if (this.rmsSamplesInWindow >= 5 && this.peakRmsInWindow < 0.001) {
              if (this.isListening && !this.isDrainingClips) {
                this.onInterimText("🔇 Listening (room is quiet)...");
              }
              return;
            }
          }

          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size < 600) return;

          this.pendingClips.push({ blob, speakerLabel, isOverlapped: false });
          this.#drainGroqQueue();
        };

        recorder.start(1000);

        this.chunkTimeout = setTimeout(() => {
          if (recorder.state === "recording") {
            try {
              recorder.stop();
            } catch (_) {}
          }
        }, clipDurationMs + 3500);
      };

      recordNextClip();
    }

    static groupDeepgramWordsBySpeaker(words, fallbackTranscript = "", fallbackSpeaker = "Table") {
      const cleanFallback = String(fallbackTranscript || "").trim();
      if (!Array.isArray(words) || words.length === 0) {
        return cleanFallback ? [{ speaker: fallbackSpeaker, text: cleanFallback }] : [];
      }

      const hasSpeakerIds = words.some(
        (w) => w && w.speaker !== undefined && w.speaker !== null && Number.isFinite(Number(w.speaker))
      );
      if (!hasSpeakerIds) {
        return cleanFallback ? [{ speaker: fallbackSpeaker, text: cleanFallback }] : [];
      }

      const turns = [];
      let currentLabel = null;
      let buf = [];

      for (const w of words) {
        const token = String(w?.punctuated_word || w?.word || "").trim();
        if (!token) continue;
        const hasId =
          w?.speaker !== undefined && w?.speaker !== null && Number.isFinite(Number(w.speaker));
        const label = hasId ? `Speaker ${Number(w.speaker) + 1}` : currentLabel || fallbackSpeaker;

        if (currentLabel !== null && label !== currentLabel && buf.length > 0) {
          turns.push({ speaker: currentLabel, text: buf.join(" ").trim() });
          buf = [];
        }
        currentLabel = label;
        buf.push(token);
      }

      if (buf.length > 0 && currentLabel) {
        turns.push({ speaker: currentLabel, text: buf.join(" ").trim() });
      }
      return turns.filter((t) => t.text.length > 0);
    }

    #stopDeepgramStreaming() {
      if (this.dgKeepAliveTimer) {
        clearInterval(this.dgKeepAliveTimer);
        this.dgKeepAliveTimer = null;
      }
      if (this.dgReconnectTimer) {
        clearTimeout(this.dgReconnectTimer);
        this.dgReconnectTimer = null;
      }
      if (this.dgSocket) {
        const sock = this.dgSocket;
        this.dgSocket = null;
        try {
          sock.onopen = null;
          sock.onmessage = null;
          sock.onerror = null;
          sock.onclose = null;
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({ type: "CloseStream" }));
          }
          sock.close();
        } catch (_) {}
      }
    }

    #startDeepgramStreaming() {
      this.#stopDeepgramStreaming();

      const WS = global.WebSocket;
      if (typeof WS !== "function") {
        this.onError("WebSocket streaming is unavailable in this browser.");
        return;
      }

      const deepgramApiKey = String(this.store.settings.deepgramApiKey || "").trim();
      if (!deepgramApiKey) {
        this.onError("Add your Deepgram API Key in Settings first.");
        return;
      }

      const params = new URLSearchParams({
        model: "nova-3",
        language: "en",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        smart_format: "true",
        punctuate: "true",
        interim_results: "true",
        endpointing: "400",
        diarize_model: "latest"
      });

      const vocabTerms =
        typeof this.store.getVocabularyTerms === "function"
          ? this.store.getVocabularyTerms().slice(0, 40)
          : [];
      for (const term of vocabTerms) {
        params.append("keyterm", term);
      }

      const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
      const socket = new WS(wsUrl, ["token", deepgramApiKey]);
      socket.binaryType = "arraybuffer";
      this.dgSocket = socket;

      const fallbackSpeaker = this.#speakerLabelForSource();
      this.onInterimText(`🔌 Connecting to Deepgram Nova-3 (${this.#sourceLabel()})...`);

      socket.onopen = () => {
        if (this.dgSocket !== socket) return;
        this.dgReconnectAttempts = 0;
        if (this.hadHealthFailure) {
          this.hadHealthFailure = false;
          this.onHealthRecovered();
        }
        this.onInterimText(
          `🎧 Deepgram Nova-3 active (${this.#sourceLabel()}) — live speaker diarization on`
        );

        this.dgKeepAliveTimer = setInterval(() => {
          if (this.dgSocket === socket && socket.readyState === 1) {
            try {
              socket.send(JSON.stringify({ type: "KeepAlive" }));
            } catch (_) {}
          }
        }, 8000);
      };

      socket.onmessage = (event) => {
        if (this.dgSocket !== socket) return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        const alt = data?.channel?.alternatives?.[0];
        const rawText = String(alt?.transcript || "").trim();
        if (!rawText) return;

        if (!data?.is_final) {
          this.onInterimText(`🎙️ ${rawText}`);
          return;
        }

        const turns = TableAudioListener.groupDeepgramWordsBySpeaker(
          alt?.words,
          rawText,
          fallbackSpeaker
        );
        for (const turn of turns) {
          this.store.addTranscriptLine(turn.speaker, turn.text, false);
          this.onInterimText(`💬 ${turn.speaker}: "${turn.text}"`);
          this.#checkAutoAnalyzeTrigger(turn.text.length);
        }
      };

      socket.onerror = () => {
        if (this.dgSocket !== socket) return;
        this.onInterimText("⚠️ Deepgram streaming connection error...");
      };

      socket.onclose = (event) => {
        if (this.dgKeepAliveTimer) {
          clearInterval(this.dgKeepAliveTimer);
          this.dgKeepAliveTimer = null;
        }
        if (
          !this.isListening ||
          this.store.settings.speechMode !== "deepgram" ||
          this.dgSocket !== socket
        ) {
          return;
        }
        this.dgSocket = null;
        if (this.activeSourceType === "file" && this.boundAudioEl?.paused) {
          return;
        }

        this.hadHealthFailure = true;
        const attempt = this.dgReconnectAttempts;
        this.dgReconnectAttempts += 1;
        const delayMs = Math.min(15000, 2000 * Math.pow(2, attempt));
        const reason = event?.code ? `code ${event.code}` : "connection closed";
        this.onHealthAlert(
          `⚠️ Deepgram stream interrupted (${reason}) — reconnecting in ${Math.round(
            delayMs / 1000
          )}s...`
        );
        this.dgReconnectTimer = setTimeout(() => {
          this.dgReconnectTimer = null;
          if (this.isListening && this.store.settings.speechMode === "deepgram") {
            this.#startDeepgramStreaming();
          }
        }, delayMs);
      };
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
