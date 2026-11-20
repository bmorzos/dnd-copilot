/**
 * Shared audio constraints, 16 kHz PCM resampling, RIFF/WAVE encoding,
 * overlap text deduplication, and long-audio chunk slicing for D&D Copilot.
 */
(function (global) {
  /**
   * Builds getUserMedia constraints honoring raw room-table defaults vs. voice-call DSP
   * and an optional selected microphone deviceId.
   */
  function buildMicConstraints(settings = {}) {
    const rawRoom = settings?.rawRoomAudio !== false;
    const audio = rawRoom
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 }
        }
      : {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true
        };

    const devId = String(settings?.micDeviceId || "").trim();
    if (devId) {
      audio.deviceId = { exact: devId };
    }
    return { audio };
  }

  /**
   * Downsamples a mono Float32Array to targetSampleRate (default 16 kHz) via box averaging.
   */
  function downsampleFloat32(samples, inputSampleRate, targetSampleRate = 16000) {
    const src = samples instanceof Float32Array ? samples : new Float32Array(samples || 0);
    if (!src.length) return new Float32Array(0);
    const inRate = Number(inputSampleRate) || targetSampleRate;
    if (inRate <= targetSampleRate) {
      return src.slice();
    }

    const ratio = inRate / targetSampleRate;
    const outLength = Math.max(1, Math.floor(src.length / ratio));
    const out = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(src.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += src[j];
        count += 1;
      }
      out[i] = count > 0 ? sum / count : src[start] || 0;
    }
    return out;
  }

  /**
   * Clamps [-1, 1] Float32 PCM samples and converts to signed 16-bit PCM.
   */
  function float32ToInt16Pcm(float32Samples) {
    const src = float32Samples || [];
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, Number(src[i]) || 0));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * Encodes mono Float32 PCM samples into a 16-bit RIFF/WAVE Blob.
   */
  function encodeWavBlob(float32Samples, sampleRate = 16000) {
    const pcm = float32ToInt16Pcm(float32Samples);
    const rate = Math.max(8000, Math.round(Number(sampleRate) || 16000));
    const dataBytes = pcm.byteLength;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // PCM format = 1
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // Byte rate = sampleRate * 1 * 16/8
    view.setUint16(32, 2, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    writeAscii(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: "audio/wav" });
  }

  /**
   * Concatenates an array of Float32Array chunks into a single Float32Array.
   */
  function concatFloat32Chunks(chunks) {
    const valid = (Array.isArray(chunks) ? chunks : []).filter(
      (c) => c && c.length > 0
    );
    let total = 0;
    for (const c of valid) total += c.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of valid) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function normalizeWord(word) {
    return String(word || "")
      .toLowerCase()
      .replace(/[^a-z0-9']/g, "");
  }

  /**
   * Deduplicates boundary word overlap between consecutive overlapped audio chunks.
   */
  function dedupeOverlapText(prevText, nextText) {
    const nextTrimmed = String(nextText || "").trim();
    const prevTrimmed = String(prevText || "").trim();
    if (!prevTrimmed || !nextTrimmed) return nextTrimmed;

    const prevRawWords = prevTrimmed.split(/\s+/).filter(Boolean);
    const nextRawWords = nextTrimmed.split(/\s+/).filter(Boolean);
    const prevTail = prevRawWords.slice(-10).map(normalizeWord);
    const nextHead = nextRawWords.slice(0, 10).map(normalizeWord);

    const maxK = Math.min(prevTail.length, nextHead.length);
    let matchedCount = 0;

    for (let k = maxK; k >= 1; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        const p = prevTail[prevTail.length - k + i];
        const n = nextHead[i];
        if (!p || !n || p !== n) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (k >= 2 || (k === 1 && nextHead[0].length >= 6)) {
        matchedCount = k;
        break;
      }
    }

    if (matchedCount === 0) return nextTrimmed;
    return nextRawWords
      .slice(matchedCount)
      .join(" ")
      .replace(/^[,;:\-–—.!?\s]+/, "")
      .trim();
  }

  /**
   * Downmixes an AudioBuffer to mono 16 kHz and slices it into overlapped WAV chunks.
   */
  function sliceAudioBufferToWavChunks(
    audioBuffer,
    chunkSeconds = 480,
    overlapSeconds = 2
  ) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== "function") {
      return [];
    }
    const numChannels = Math.max(1, Number(audioBuffer.numberOfChannels) || 1);
    const length = Number(audioBuffer.length) || 0;
    if (length === 0) return [];

    let mono;
    if (numChannels === 1) {
      mono = audioBuffer.getChannelData(0);
    } else {
      mono = new Float32Array(length);
      for (let ch = 0; ch < numChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          mono[i] += data[i] / numChannels;
        }
      }
    }

    const srcRate = Number(audioBuffer.sampleRate) || 16000;
    const targetRate = 16000;
    const mono16k =
      srcRate === targetRate ? mono : downsampleFloat32(mono, srcRate, targetRate);

    const chunkSamples = Math.max(targetRate * 10, Math.round(chunkSeconds * targetRate));
    const overlapSamples = Math.max(
      0,
      Math.min(Math.floor(chunkSamples / 2), Math.round(overlapSeconds * targetRate))
    );
    const stepSamples = Math.max(1, chunkSamples - overlapSamples);

    const slices = [];
    for (let start = 0; start < mono16k.length; start += stepSamples) {
      const end = Math.min(mono16k.length, start + chunkSamples);
      slices.push({
        samples: mono16k.subarray(start, end),
        startSec: start / targetRate,
        endSec: end / targetRate
      });
      if (end >= mono16k.length) break;
    }

    const total = slices.length;
    return slices.map((s, idx) => ({
      blob: encodeWavBlob(s.samples, targetRate),
      startSec: s.startSec,
      endSec: s.endSec,
      index: idx,
      total
    }));
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.AudioUtils = {
    buildMicConstraints,
    downsampleFloat32,
    float32ToInt16Pcm,
    encodeWavBlob,
    concatFloat32Chunks,
    dedupeOverlapText,
    sliceAudioBufferToWavChunks
  };
})(window);
