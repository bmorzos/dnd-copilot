/**
 * Unified AI & Transcription Client:
 * - Groq Whisper (whisper-large-v3-turbo) for fast, accurate, free-tier/4¢-hr D&D room transcription.
 * - Groq Chat (llama-3.3-70b-versatile) OR Gemini Interactions API (2026-05-20) for smart summaries, puzzles & spell advice.
 * - Automatic $0 Free Local Brain fallback whenever no API key is entered.
 */
(function (global) {
  const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
  const GROQ_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
  const GROQ_WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
  const API_REVISION = "2026-05-20";

  const PLAYER_FAIR_SYSTEM_PROMPT = [
    "You are D&D Table Copilot, a clear, concise, player-fair 5e tabletop companion.",
    "STRICT FAIR-PLAY RULE: Never reveal secret Monster Manual max HP, hidden AC, or hidden statblock spoilers not observed at the table.",
    "Base combat estimates strictly on player-observed data: cumulative damage dealt so far, visible 'Bloodied' cues, hit/miss attack roll bounds, and what the DM described aloud.",
    "Keep every explanation short, plain, and easy to read quickly at a game table."
  ].join(" ");

  const WHISPER_HALLUCINATIONS = new Set([
    "thank you.",
    "thank you",
    "thanks for watching.",
    "thanks for watching!",
    "thanks for watching",
    "please subscribe.",
    "you",
    ".",
    "..",
    "...",
    "bye.",
    "bye",
    "subtitles by the amara.org community"
  ]);

  function resolveBrainBackend(store) {
    const pref = store.settings?.aiProvider || "auto";
    const groqKey = (store.settings?.groqApiKey || "").trim();
    const geminiKey = (store.settings?.geminiApiKey || "").trim();

    if (pref === "local-free") return "local";
    if (pref === "groq" && groqKey) return "groq";
    if (pref === "gemini" && geminiKey) return "gemini";

    // Auto: use Gemini if set, else Groq if set, else Free Local
    if (geminiKey) return "gemini";
    if (groqKey) return "groq";
    return "local";
  }

  function extractInteractionText(responseJson) {
    if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
      return responseJson.output_text.trim();
    }
    const steps = Array.isArray(responseJson?.steps) ? responseJson.steps : [];
    const collected = [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.type === "model_output" && Array.isArray(step.content)) {
        const textParts = step.content
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text);
        if (textParts.length > 0) {
          collected.unshift(textParts.join(""));
        }
      } else if (collected.length > 0) {
        break;
      }
    }
    if (collected.length > 0) return collected.join("\n").trim();
    const outputs = Array.isArray(responseJson?.outputs) ? responseJson.outputs : [];
    for (let i = outputs.length - 1; i >= 0; i--) {
      if (typeof outputs[i]?.text === "string") return outputs[i].text.trim();
    }
    return "";
  }

  function extractTokenUsage(responseJson) {
    const usage = responseJson?.usage || {};
    const inputTokens = Number(usage.total_input_tokens ?? usage.input_tokens ?? 0);
    const explicitOut = Number(usage.total_output_tokens ?? usage.output_tokens ?? 0);
    const thoughtTok = Number(usage.total_thought_tokens ?? 0);
    const totalTok = Number(usage.total_tokens ?? 0);
    const outputTokens = Math.max(
      explicitOut + thoughtTok,
      totalTok > inputTokens ? totalTok - inputTokens : explicitOut
    );
    return { inputTokens, outputTokens };
  }

  async function callInteractionsApi({ store, model, systemInstruction, input, jsonSchema }) {
    const settings = store.settings;
    const apiKey = (settings.geminiApiKey || "").trim();
    if (!apiKey) {
      throw new Error("Missing Gemini API key.");
    }

    if (
      !settings.isFreeTierKey &&
      Number(settings.budgetCapUsd) > 0 &&
      store.state.usage.estimatedUsd >= Number(settings.budgetCapUsd)
    ) {
      throw new Error(
        `Session budget cap ($${Number(settings.budgetCapUsd).toFixed(2)}) reached.`
      );
    }

    const body = {
      model,
      store: false,
      system_instruction: systemInstruction || PLAYER_FAIR_SYSTEM_PROMPT,
      input
    };

    if (jsonSchema) {
      body.response_format = {
        type: "text",
        mime_type: "application/json",
        schema: jsonSchema
      };
    }

    const endpoint = isLocalServerContext()
      ? "/api/proxy/gemini-interactions"
      : INTERACTIONS_ENDPOINT;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": API_REVISION
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson?.error?.message || JSON.stringify(errJson);
      } catch (_) {
        detail = await resp.text();
      }
      throw new Error(`Gemini API HTTP ${resp.status}: ${detail.slice(0, 220)}`);
    }

    const data = await resp.json();
    const { inputTokens, outputTokens } = extractTokenUsage(data);
    store.recordUsage(inputTokens, outputTokens, model);

    const text = extractInteractionText(data);
    if (!jsonSchema) return text;

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned || "{}");
  }

  async function callGroqJson({ store, systemInstruction, userPrompt, schemaHint }) {
    const groqKey = (store.settings?.groqApiKey || "").trim();
    if (!groqKey) {
      throw new Error("Add your free Groq API Key in Settings to use Groq.");
    }

    const endpoint = isLocalServerContext()
      ? "/api/proxy/groq-chat"
      : GROQ_CHAT_ENDPOINT;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `${systemInstruction || PLAYER_FAIR_SYSTEM_PROMPT}\nRespond ONLY with a valid JSON object matching this exact structure:\n${schemaHint}`
          },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson?.error?.message || JSON.stringify(errJson);
      } catch (_) {
        detail = await resp.text();
      }
      throw new Error(`Groq API HTTP ${resp.status}: ${detail.slice(0, 220)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    store.state.usage.calls += 1;
    store.save();
    return JSON.parse(content);
  }

  /**
   * Transcribes an audio Blob or File using Groq Whisper (defaults to whisper-large-v3)
   * with campaign glossary prompting and verbose_json hallucination filtering.
   */
  async function transcribeWithGroq(audioBlob, store, customFilename = "", options = {}) {
    const groqKey = (store.settings?.groqApiKey || "").trim();
    if (!groqKey) {
      throw new Error("Add your Groq API Key in Settings (console.groq.com/keys) or switch to Chrome Speech.");
    }

    const rawType = String(audioBlob.type || "audio/webm").split(";")[0].trim().toLowerCase();
    let ext = "webm";
    let cleanMime = "audio/webm";

    if (customFilename && /\.(mp3|m4a|mp4|wav|ogg|flac|mpeg|mpga|webm)$/i.test(customFilename)) {
      ext = customFilename.split(".").pop().toLowerCase();
      cleanMime = rawType || `audio/${ext}`;
    } else if (rawType.includes("mp4") || rawType.includes("m4a")) {
      ext = "m4a";
      cleanMime = "audio/mp4";
    } else if (rawType.includes("mpeg") || rawType.includes("mp3")) {
      ext = "mp3";
      cleanMime = "audio/mpeg";
    } else if (rawType.includes("wav")) {
      ext = "wav";
      cleanMime = "audio/wav";
    } else if (rawType.includes("ogg")) {
      ext = "ogg";
      cleanMime = "audio/ogg";
    }

    const file = new File([audioBlob], customFilename || `table-clip.${ext}`, {
      type: cleanMime
    });

    const model =
      options?.model || store.settings?.groqWhisperModel || "whisper-large-v3";
    const terms =
      typeof store.getVocabularyTerms === "function"
        ? store.getVocabularyTerms()
        : (store.state.party || []).map((p) => p.name);
    const glossaryPart =
      terms.length > 0 ? `Glossary: ${terms.slice(0, 35).join(", ")}.` : "";
    const rawPrev =
      options?.prevText !== undefined
        ? String(options.prevText || "")
        : store.state.transcript.length > 0
        ? store.state.transcript[store.state.transcript.length - 1].text
        : "";
    const prevLine = rawPrev.trim().slice(-160);
    const basePrefix = ["D&D 5e tabletop session.", glossaryPart]
      .filter(Boolean)
      .join(" ")
      .slice(0, 600);
    const vocabPrompt = [basePrefix, prevLine].filter(Boolean).join(" ").slice(0, 780);

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      form.append("file", file);
      form.append("model", model);
      form.append("language", "en");
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      form.append("prompt", vocabPrompt);

      try {
        const endpoint = isLocalServerContext()
          ? "/api/proxy/groq-whisper"
          : GROQ_WHISPER_ENDPOINT;
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`
          },
          body: form
        });

        if (resp.ok) {
          const data = await resp.json();
          let rawText = "";
          if (Array.isArray(data?.segments) && data.segments.length > 0) {
            const kept = [];
            for (const seg of data.segments) {
              const segText = String(seg?.text || "").replace(/\s+/g, " ").trim();
              if (!segText) continue;
              if (WHISPER_HALLUCINATIONS.has(segText.toLowerCase())) continue;
              const noSpeech = Number(seg?.no_speech_prob ?? 0);
              const avgLogprob = Number(seg?.avg_logprob ?? 0);
              const compRatio = Number(seg?.compression_ratio ?? 0);
              if (noSpeech > 0.85) continue;
              if (noSpeech > 0.65 && avgLogprob < -0.85) continue;
              if (compRatio > 2.6) continue;
              kept.push(segText);
            }
            rawText = kept.join(" ").trim();
          } else {
            rawText = String(data?.text || "").replace(/\s+/g, " ").trim();
          }

          const text = rawText.replace(/\s+/g, " ").trim();
          if (!text || WHISPER_HALLUCINATIONS.has(text.toLowerCase())) {
            return "";
          }
          return text;
        }

        // Do not retry invalid API key (401/403)
        if (resp.status === 401 || resp.status === 403) {
          throw new Error("Groq API Key rejected (check key in ⚙️ Settings).");
        }

        let detail = "";
        try {
          const j = await resp.json();
          detail = j?.error?.message || JSON.stringify(j);
        } catch (_) {
          detail = await resp.text();
        }
        lastErr = new Error(`Groq Whisper HTTP ${resp.status}: ${detail.slice(0, 180)}`);

        // Respect Retry-After on 429 or backoff on 5xx
        if (attempt < 2 && (resp.status === 429 || resp.status >= 500)) {
          const retryHeader = Number(resp.headers?.get?.("retry-after") || 0);
          const waitMs = retryHeader > 0 ? retryHeader * 1000 : (attempt + 1) * 2000;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        break;
      } catch (netErr) {
        lastErr = netErr;
        if (String(netErr?.message || "").includes("Groq API Key rejected")) {
          throw netErr;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
      }
    }

    throw lastErr || new Error("Groq transcription failed after 3 attempts.");
  }

  /**
   * Transcribes & diarizes a full audio Blob/File via Deepgram Nova-3 pre-recorded API.
   */
  async function transcribeWithDeepgramPrerecorded(audioBlob, store) {
    const deepgramKey = String(store.settings?.deepgramApiKey || "").trim();
    if (!deepgramKey) {
      throw new Error("Add your Deepgram API Key in Settings first.");
    }

    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      diarize_model: "latest"
    });

    const terms =
      typeof store.getVocabularyTerms === "function"
        ? store.getVocabularyTerms().slice(0, 40)
        : [];
    for (const term of terms) {
      params.append("keyterm", term);
    }

    const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": audioBlob?.type || "audio/webm"
      },
      body: audioBlob
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson?.err_msg || errJson?.message || JSON.stringify(errJson);
      } catch (_) {
        detail = await resp.text();
      }
      throw new Error(`Deepgram API HTTP ${resp.status}: ${detail.slice(0, 220)}`);
    }

    const data = await resp.json();
    const utterances = data?.results?.utterances;
    if (Array.isArray(utterances) && utterances.length > 0) {
      return utterances
        .map((u) => {
          const txt = String(u?.transcript || "").replace(/\s+/g, " ").trim();
          if (!txt) return null;
          const hasSpk =
            u?.speaker !== undefined && u?.speaker !== null && Number.isFinite(Number(u.speaker));
          return {
            speaker: hasSpk ? `Speaker ${Number(u.speaker) + 1}` : "Recording",
            text: txt,
            startSec: Number(u?.start || 0),
            endSec: Number(u?.end || 0)
          };
        })
        .filter(Boolean);
    }

    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const fallbackText = String(alt?.transcript || "").replace(/\s+/g, " ").trim();
    if (
      Array.isArray(alt?.words) &&
      alt.words.length > 0 &&
      global.DnDCopilot?.TableAudioListener?.groupDeepgramWordsBySpeaker
    ) {
      const turns = global.DnDCopilot.TableAudioListener.groupDeepgramWordsBySpeaker(
        alt.words,
        fallbackText,
        "Recording"
      );
      return turns.map((t) => ({ speaker: t.speaker, text: t.text, startSec: 0, endSec: 0 }));
    }

    return fallbackText ? [{ speaker: "Recording", text: fallbackText, startSec: 0, endSec: 0 }] : [];
  }

  function groupSentencesToTranscriptLines(
    fullText,
    speaker = "Recording",
    baseTimestamp = Date.now(),
    offsetSec = 0
  ) {
    const clean = String(fullText || "").trim();
    if (!clean) return [];
    const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
    const lines = [];
    let chunkBuf = "";
    for (const s of sentences) {
      chunkBuf = (chunkBuf + " " + s.trim()).trim();
      if (chunkBuf.length >= 180) {
        lines.push({
          speaker,
          text: chunkBuf,
          timestamp: baseTimestamp + Math.round((offsetSec + lines.length * 4) * 1000)
        });
        chunkBuf = "";
      }
    }
    if (chunkBuf) {
      lines.push({
        speaker,
        text: chunkBuf,
        timestamp: baseTimestamp + Math.round((offsetSec + lines.length * 4) * 1000)
      });
    }
    return lines;
  }

  /**
   * Transcribes an audio file/recording of any size: uses Deepgram Nova-3 (diarized) when available,
   * or automatically decodes and chunks >24 MB recordings into 16 kHz WAV parts for Groq Whisper.
   */
  async function transcribeLongAudioBlob(audioBlob, store, options = {}) {
    const filename = options?.filename || "";
    const preferDiarization = options?.preferDiarization !== false;
    const baseTimestamp = Number(options?.baseTimestamp) || Date.now();
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : () => {};

    const hasDg = Boolean(String(store.settings?.deepgramApiKey || "").trim());
    const hasGroq = Boolean(String(store.settings?.groqApiKey || "").trim());

    if (preferDiarization && hasDg) {
      onProgress("Transcribing & diarizing with Deepgram Nova-3...");
      try {
        const utterances = await transcribeWithDeepgramPrerecorded(audioBlob, store);
        return utterances.map((u) => ({
          speaker: u.speaker || "Recording",
          text: u.text,
          timestamp: baseTimestamp + Math.round((Number(u.startSec) || 0) * 1000)
        }));
      } catch (dgErr) {
        const msg = String(dgErr?.message || dgErr || "");
        const looksLikeCorsOrNet =
          dgErr?.name === "TypeError" || /failed to fetch|cors|network/i.test(msg);
        if (looksLikeCorsOrNet && hasGroq) {
          onProgress(
            "Deepgram REST blocked in browser mode — falling back to chunked Groq Whisper v3..."
          );
        } else {
          throw dgErr;
        }
      }
    }

    if (!hasGroq) {
      throw new Error(
        "Add your Groq or Deepgram API Key in Settings to transcribe recordings."
      );
    }

    if (audioBlob.size <= 24 * 1024 * 1024) {
      onProgress("Transcribing audio via Groq Whisper...");
      const fullText = await transcribeWithGroq(audioBlob, store, filename, { prevText: "" });
      return groupSentencesToTranscriptLines(fullText, "Recording", baseTimestamp, 0);
    }

    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    const AudioUtils = global.DnDCopilot?.AudioUtils;
    if (!AudioCtx || !AudioUtils) {
      throw new Error("Audio decoding is unavailable in this browser environment.");
    }

    onProgress("Decoding long recording into 16 kHz chunks...");
    const arrayBuffer = await audioBlob.arrayBuffer();
    const ctx = new AudioCtx({ sampleRate: 16000 });
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      await ctx.close().catch(() => {});
    }

    const chunks = AudioUtils.sliceAudioBufferToWavChunks(decoded, 480, 2);
    if (chunks.length === 0) return [];

    const allLines = [];
    let lastRawChunkText = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      onProgress(`Transcribing part ${i + 1}/${chunks.length} via Groq Whisper...`);
      const chunkText = await transcribeWithGroq(chunk.blob, store, `part-${i + 1}.wav`, {
        prevText: lastRawChunkText
      });
      if (!chunkText) continue;

      const cleanText =
        i > 0 && lastRawChunkText
          ? AudioUtils.dedupeOverlapText(lastRawChunkText, chunkText)
          : chunkText;
      lastRawChunkText = chunkText;
      if (cleanText) {
        allLines.push(
          ...groupSentencesToTranscriptLines(cleanText, "Recording", baseTimestamp, chunk.startSec)
        );
      }
    }
    return allLines;
  }

  function isLocalServerContext() {
    const loc = global.location;
    if (!loc || typeof global.fetch !== "function") return false;
    const host = String(loc.hostname || "");
    return (host === "localhost" || host === "127.0.0.1") && loc.protocol === "http:";
  }

  async function fetchLocalDriveMemoryContext(store, extraQuery = "") {
    if (!isLocalServerContext()) return "";
    let timer = null;
    try {
      const hasAbort = typeof AbortController === "function";
      const ctrl = hasAbort ? new AbortController() : null;
      if (ctrl) {
        timer = setTimeout(() => ctrl.abort(), 2500);
      }
      const recentLines = (store.state.transcript || []).slice(-10).map((t) => t.text);
      const resp = await global.fetch("/api/campaign-memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: String(extraQuery || ""),
          recentLines
        }),
        ...(ctrl ? { signal: ctrl.signal } : {})
      });
      if (!resp || !resp.ok) return "";
      const data = await resp.json();
      return String(data?.contextText || "").trim();
    } catch (_) {
      return "";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function buildCompactSessionContext(store, extraPastContext = "") {
    const st = store.state;
    const myChar =
      st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;

    const recentTranscript = st.transcript
      .slice(-24)
      .map((t) => `[${t.speaker}] ${t.text}`)
      .join("\n");

    const recentRolls = st.gameLog
      .slice(-15)
      .map((r) => `${r.actor}: ${r.action} (${r.kind}) = ${r.total ?? ""} ${r.rawText || ""}`)
      .join("\n");

    const enemiesText = st.combat.enemies
      .map((e) => {
        const acBounds =
          e.highestMissRoll || e.lowestHitRoll
            ? ` [Miss<=${e.highestMissRoll ?? "?"}, Hit>=${e.lowestHitRoll ?? "?"}]`
            : "";
        return `- ${e.name}: ${e.damageTaken} dmg dealt${e.isBloodied ? ", BLOODIED" : ""}${
          e.isDefeated ? ", DEFEATED" : ""
        }${acBounds}${e.observedTraits?.length ? ` (${e.observedTraits.join(", ")})` : ""}`;
      })
      .join("\n");

    const partyText = st.party
      .map((p) => {
        const slots = (p.spellSlots || [])
          .map((s) => `${s.isPact ? "Pact " : ""}L${s.level}:${s.remaining}/${s.max}`)
          .join(", ");
        const isMe = myChar && String(p.id) === String(myChar.id) ? " [ME]" : "";
        const insp = p.inspiration ? ", ✨ Inspired" : "";
        const conds = p.conditions?.length ? `, Conditions: [${p.conditions.join(", ")}]` : "";
        return `- ${p.name} (${p.classSummary})${isMe}: HP ${p.hp.current}/${p.hp.max}${
          p.hp.temp ? ` +${p.hp.temp}thp` : ""
        }, AC ${p.ac}${insp}${conds}${p.concentratingOn ? `, Concentrating on ${p.concentratingOn}` : ""}${
          slots ? `, Slots: [${slots}]` : ""
        }`;
      })
      .join("\n");

    const mySpellsText = myChar?.spells?.length
      ? myChar.spells
          .map(
            (s) =>
              `  * [L${s.level} ${s.castingTime}${s.concentration ? ", Conc" : ""}] ${s.name} (${
                s.range
              }${s.saveAbility ? `, ${s.saveAbility} save` : ""}): ${s.summary}`
          )
          .join("\n")
      : "  (No character spells synced yet)";

    const itemLines = (myChar?.notableItems || []).map(
      (it) =>
        `  * ${it.name}${it.attuned ? " [Attuned]" : it.equipped ? " [Equipped]" : ""}${
          it.snippet ? `: ${it.snippet}` : ""
        }`
    );
    const featureLine = myChar?.notableFeatures?.length
      ? `  Features/Feats: ${myChar.notableFeatures.join(", ")}`
      : "";
    const skillLine = myChar?.proficientSkills?.length
      ? `  Proficient Skills: ${myChar.proficientSkills.join(", ")}`
      : "";
    const myItemsAndSkills = [featureLine, skillLine, ...itemLines].filter(Boolean).join("\n");

    const localPast = store.getRelevantPastContext
      ? store.getRelevantPastContext(st.transcript.slice(-12))
      : "";
    const pastSessionsText = [String(extraPastContext || "").trim(), localPast]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4200);

    return {
      myChar,
      recentTranscript,
      recentRolls,
      enemiesText,
      partyText,
      mySpellsText,
      myItemsAndSkills,
      pastSessionsText
    };
  }

  function canFallbackToGroq(store, err) {
    const msg = String(err?.message || err || "");
    if (/budget cap/i.test(msg)) return false;
    return Boolean(String(store.settings?.groqApiKey || "").trim());
  }

  async function runStructuredAi({
    store,
    backend,
    geminiModel,
    systemInstruction,
    prompt,
    geminiSchema,
    groqSchemaHint
  }) {
    if (backend === "groq") {
      return await callGroqJson({
        store,
        systemInstruction,
        userPrompt: prompt,
        schemaHint: groqSchemaHint
      });
    }
    try {
      return await callInteractionsApi({
        store,
        model: geminiModel,
        systemInstruction,
        input: prompt,
        jsonSchema: geminiSchema
      });
    } catch (err) {
      if (canFallbackToGroq(store, err)) {
        return await callGroqJson({
          store,
          systemInstruction,
          userPrompt: prompt,
          schemaHint: groqSchemaHint
        });
      }
      throw err;
    }
  }

  async function analyzeTableSituation(store, options = {}) {
    const overrideLines = Array.isArray(options?.overrideLines) ? options.overrideLines : null;
    const forceRecordBeat = Boolean(options?.forceRecordBeat);
    const actLabel = String(options?.actLabel || "").trim();

    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.analyzeTableSituation(store, options);
    }

    const drivePastCtx = await fetchLocalDriveMemoryContext(
      store,
      overrideLines ? overrideLines.slice(-10).map((l) => l.text).join(" ") : ""
    );
    const ctx = buildCompactSessionContext(store, drivePastCtx);
    const activeTranscriptText = overrideLines
      ? overrideLines.map((t) => `[${t.speaker}] ${t.text}`).join("\n")
      : ctx.recentTranscript;
    const existingClues = store.state.puzzle.clues.join(" | ");
    const newSheetLines = overrideLines
      ? overrideLines
      : store.getUnprocessedTranscriptLinesForSheets
      ? store.getUnprocessedTranscriptLinesForSheets(18)
      : [];
    const newestLineId = overrideLines
      ? store.state.transcript.length
        ? store.state.transcript[store.state.transcript.length - 1].id
        : null
      : newSheetLines.length
      ? newSheetLines[newSheetLines.length - 1].id
      : null;
    const newLinesText = newSheetLines.map((t) => `[${t.speaker}] ${t.text}`).join("\n");

    const prompt = [
      "Summarize what is happening right now at our D&D table in plain, easy-to-read language.",
      actLabel ? `Chronological Segment: ${actLabel}` : "",
      `Current Combat Active: ${store.state.combat.inCombat} (Round ${store.state.combat.round || 1})`,
      `Known Puzzle Clues So Far: ${existingClues || "None"}`,
      `Playing As: ${ctx.myChar ? `${ctx.myChar.name} (${ctx.myChar.classSummary})` : "Party Member"}`,
      "--- PARTY ---",
      ctx.partyText || "None synced",
      "--- VISIBLE ENEMIES ---",
      ctx.enemiesText || "None",
      "--- RECENT ROLLS ---",
      ctx.recentRolls || "None",
      ...(ctx.pastSessionsText
        ? ["--- PAST SESSIONS / CAMPAIGN MEMORY ---", ctx.pastSessionsText]
        : []),
      "--- TABLE CONVERSATION ---",
      activeTranscriptText || "None",
      ...(newLinesText
        ? [
            "--- NEW TABLE LINES SINCE LAST SHEET CHECK (ONLY extract committed partyUpdates & combatEvents from THESE lines) ---",
            newLinesText
          ]
        : []),
      "Keep summaryBullets to 3 short, crisp sentences focused strictly on story/combat/clerical events (ignore off-topic banter like mic setup, snacks, or printer issues).",
      "For location, give a short scene location name (e.g. 'Stonehill Inn', 'Forest Clearing Camp', 'Phandalin Well') or ''.",
      "For suggestedNextMoves, give 2-3 specific, practical things the 'Playing As' hero can DO, ASK THE DM, CHECK, or CAST right now.",
      "For detectedEnemies and combatEvents, track player-fair observed foes, damage dealt TO foes, bloodied/defeated states, observed resistances/traits, hit/miss AC roll bounds, and key combat actions. Never reveal secret Monster Manual max HP.",
      "For partyUpdates, ONLY record committed party state changes explicitly spoken in the NEW TABLE LINES (damage taken by PCs, healing, set HP, temp HP, spell_cast, gain/spend inspiration, add/remove condition like Raging/Prone/Blessed/Poisoned, drop_concentration, short_rest, or long_rest). Ignore hypothetical brainstorms ('should I', 'what if', 'maybe'). Return [] if none."
    ]
      .filter(Boolean)
      .join("\n");

    const schema = {
      type: "object",
      properties: {
        sceneMode: { type: "string", enum: ["Exploration", "Social", "Puzzle", "Combat"] },
        location: { type: "string" },
        headline: { type: "string" },
        summaryBullets: { type: "array", items: { type: "string" } },
        activeObjectives: { type: "array", items: { type: "string" } },
        suggestedNextMoves: { type: "array", items: { type: "string" } },
        notableNpcs: { type: "array", items: { type: "string" } },
        puzzleDetected: { type: "boolean" },
        puzzleTitle: { type: "string" },
        puzzleInscription: { type: "string" },
        newPuzzleClues: { type: "array", items: { type: "string" } },
        observedEnemyNotes: {
          type: "array",
          items: {
            type: "object",
            properties: { enemyName: { type: "string" }, trait: { type: "string" } },
            required: ["enemyName", "trait"]
          }
        },
        detectedEnemies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              damageDealt: { type: "integer" },
              isBloodied: { type: "boolean" },
              isDefeated: { type: "boolean" },
              trait: { type: "string" },
              missRoll: { type: "integer" },
              hitRoll: { type: "integer" }
            },
            required: ["name"]
          }
        },
        combatEvents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              target: { type: "string" },
              action: { type: "string" },
              detail: { type: "string" },
              kind: { type: "string" }
            },
            required: ["actor", "action", "detail"]
          }
        },
        partyUpdates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              characterName: { type: "string" },
              eventType: {
                type: "string",
                enum: [
                  "spell_cast",
                  "damage",
                  "heal",
                  "set_hp",
                  "temp_hp",
                  "gain_inspiration",
                  "spend_inspiration",
                  "add_condition",
                  "remove_condition",
                  "drop_concentration",
                  "short_rest",
                  "long_rest"
                ]
              },
              spellName: { type: "string" },
              slotLevel: { type: "integer" },
              amount: { type: "integer" },
              condition: { type: "string" },
              isRitual: { type: "boolean" }
            },
            required: ["characterName", "eventType"]
          }
        }
      },
      required: [
        "sceneMode",
        "headline",
        "summaryBullets",
        "activeObjectives",
        "notableNpcs",
        "puzzleDetected",
        "newPuzzleClues",
        "observedEnemyNotes",
        "partyUpdates"
      ]
    };

    const groqSchemaHint = JSON.stringify({
      sceneMode: "Exploration | Social | Puzzle | Combat",
      location: "Short current location name",
      headline: "Short 1-sentence headline",
      summaryBullets: ["Bullet 1", "Bullet 2", "Bullet 3"],
      activeObjectives: ["Objective 1"],
      suggestedNextMoves: ["Actionable move or DM question 1", "Actionable move 2"],
      notableNpcs: ["NPC Name"],
      puzzleDetected: false,
      puzzleTitle: "",
      puzzleInscription: "",
      newPuzzleClues: [],
      observedEnemyNotes: [{ enemyName: "Name", trait: "Trait" }],
      detectedEnemies: [
        { name: "Goblin", damageDealt: 0, isBloodied: false, isDefeated: false, trait: "", missRoll: 0, hitRoll: 0 }
      ],
      combatEvents: [
        { actor: "Actor", target: "Target", action: "Action/Spell", detail: "Brief observed outcome", kind: "action" }
      ],
      partyUpdates: [
        {
          characterName: "PC Name or all",
          eventType: "spell_cast | damage | heal | set_hp | temp_hp | gain_inspiration | spend_inspiration | add_condition | remove_condition | drop_concentration | short_rest | long_rest",
          spellName: "",
          slotLevel: 0,
          amount: 0,
          condition: "",
          isRitual: false
        }
      ]
    });

    const res = await runStructuredAi({
      store,
      backend,
      geminiModel: store.settings.fastModel || "gemini-3.5-flash-lite",
      systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
      prompt,
      geminiSchema: schema,
      groqSchemaHint
    });

    store.state.situation = {
      sceneMode: res.sceneMode || "Exploration",
      location: String(res.location || store.state.situation?.location || "").trim(),
      headline: res.headline || store.state.situation.headline,
      summaryBullets: Array.isArray(res.summaryBullets) ? res.summaryBullets.slice(0, 4) : [],
      activeObjectives: Array.isArray(res.activeObjectives) ? res.activeObjectives.slice(0, 3) : [],
      suggestedNextMoves: Array.isArray(res.suggestedNextMoves)
        ? res.suggestedNextMoves.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4)
        : [],
      notableNpcs: Array.isArray(res.notableNpcs) ? res.notableNpcs.slice(0, 5) : [],
      lastUpdatedAt: Date.now()
    };

    store.recordSessionBeat?.(store.state.situation, forceRecordBeat);

    if (res.puzzleDetected || (Array.isArray(res.newPuzzleClues) && res.newPuzzleClues.length > 0)) {
      store.state.puzzle.isActive = true;
      if (res.puzzleTitle) store.state.puzzle.title = res.puzzleTitle;
      if (res.puzzleInscription) store.state.puzzle.promptOrInscription = res.puzzleInscription;
      for (const c of res.newPuzzleClues || []) {
        if (c && !store.state.puzzle.clues.includes(c)) {
          store.state.puzzle.clues.push(c);
        }
      }
    }

    if (
      Array.isArray(res.detectedEnemies) ||
      Array.isArray(res.combatEvents) ||
      res.sceneMode === "Combat"
    ) {
      store.ingestSpokenCombatState?.({
        inCombat:
          res.sceneMode === "Combat" ||
          (Array.isArray(res.detectedEnemies) && res.detectedEnemies.some((e) => !e.isDefeated)),
        detectedEnemies: res.detectedEnemies || [],
        combatEvents: res.combatEvents || []
      });
    }

    if (Array.isArray(res.observedEnemyNotes)) {
      for (const note of res.observedEnemyNotes) {
        const match = store.state.combat.enemies.find((e) =>
          e.name.toLowerCase().includes((note.enemyName || "").toLowerCase())
        );
        if (match && note.trait && !match.observedTraits.includes(note.trait)) {
          match.observedTraits.push(note.trait);
        }
      }
    }

    const sheetRes = store.applyLivePartyUpdates
      ? store.applyLivePartyUpdates(res.partyUpdates || [], newestLineId)
      : { appliedCount: 0, descriptions: [] };
    res._appliedPartyUpdates = sheetRes.descriptions;

    store.save();
    return res;
  }

  async function solvePuzzle(store, extraUserNote = "") {
    const puzzleQuery = [
      store.state.puzzle.promptOrInscription || "",
      ...(store.state.puzzle.clues || []).slice(-4),
      extraUserNote || ""
    ]
      .filter(Boolean)
      .join(" ");
    const drivePastCtx = await fetchLocalDriveMemoryContext(store, puzzleQuery);
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.solvePuzzle(store, extraUserNote, drivePastCtx);
    }

    const ctx = buildCompactSessionContext(store, drivePastCtx);
    const prompt = [
      "Help solve this D&D puzzle, riddle, or mechanism clearly and concisely.",
      `Inscription / Riddle: ${store.state.puzzle.promptOrInscription || "(Check transcript)"}`,
      `Clues:\n${store.state.puzzle.clues.map((c, i) => `${i + 1}. ${c}`).join("\n") || "None pinned yet"}`,
      extraUserNote ? `Extra Note: ${extraUserNote}` : "",
      "--- MY SPELLS ---",
      ctx.mySpellsText,
      ...(ctx.pastSessionsText
        ? ["--- PAST SESSIONS / DRIVE ARCHIVE ---", ctx.pastSessionsText]
        : []),
      "--- RECENT CONVERSATION ---",
      ctx.recentTranscript || "None"
    ]
      .filter(Boolean)
      .join("\n");

    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        promptOrInscription: { type: "string" },
        extractedClues: { type: "array", items: { type: "string" } },
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              solution: { type: "string" },
              confidence: { type: "string" },
              reasoning: { type: "string" }
            },
            required: ["solution", "confidence", "reasoning"]
          }
        },
        nextChecks: { type: "array", items: { type: "string" } }
      },
      required: ["title", "promptOrInscription", "extractedClues", "hypotheses", "nextChecks"]
    };

    const res = await runStructuredAi({
      store,
      backend,
      geminiModel: store.settings.advisorModel || "gemini-3.8-flash",
      systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
      prompt,
      geminiSchema: schema,
      groqSchemaHint: JSON.stringify({
        title: "Puzzle Title",
        promptOrInscription: "Riddle text if found",
        extractedClues: ["Clue 1"],
        hypotheses: [
          { solution: "Best Solution", confidence: "High", reasoning: "Short clear reason" }
        ],
        nextChecks: ["Ask DM to check X"]
      })
    });

    store.state.puzzle.isActive = true;
    if (res.title) store.state.puzzle.title = res.title;
    if (res.promptOrInscription) store.state.puzzle.promptOrInscription = res.promptOrInscription;
    for (const c of res.extractedClues || []) {
      if (c && !store.state.puzzle.clues.includes(c)) {
        store.state.puzzle.clues.push(c);
      }
    }
    store.state.puzzle.hypotheses = Array.isArray(res.hypotheses) ? res.hypotheses : [];
    store.state.puzzle.nextChecks = Array.isArray(res.nextChecks) ? res.nextChecks : [];
    store.state.puzzle.lastSolvedAt = Date.now();
    store.save();
    return res;
  }

  async function adviseTacticsAndSpells(store, customQuestion = "") {
    const drivePastCtx = await fetchLocalDriveMemoryContext(store, customQuestion);
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.adviseTacticsAndSpells(
        store,
        customQuestion,
        drivePastCtx
      );
    }

    const ctx = buildCompactSessionContext(store, drivePastCtx);
    const sceneMode = store.state.situation?.sceneMode || (store.state.combat.inCombat ? "Combat" : "Exploration");
    const prompt = [
      `Current Scene Mode: ${sceneMode}.`,
      "Give 3 to 4 crisp, practical IDEAS of things I should DO, TRY, ASK THE DM, CHECK, or CAST right now.",
      "Always adapt to the current moment: in Exploration/Social/Puzzle scenes, suggest clever questions to ask the DM, skill checks I'm strong at, magic item/utility spell uses, and past-session callbacks—NOT just combat attacks. In Combat, suggest best spells/actions using only prepared spells with remaining slots, and warn before breaking Concentration.",
      `--- PLAYING AS: ${ctx.myChar ? `${ctx.myChar.name} (${ctx.myChar.classSummary}, Save DC ${ctx.myChar.spellSaveDc})` : "Party Member"} ---`,
      ctx.myItemsAndSkills ? `--- MY SKILLS, FEATURES & MAGIC ITEMS ---\n${ctx.myItemsAndSkills}` : "",
      "Prepared Spells:",
      ctx.mySpellsText,
      "--- PARTY ---",
      ctx.partyText || "None synced",
      `--- ENEMIES (Round ${store.state.combat.round || 1}) ---`,
      ctx.enemiesText || "No active enemies listed.",
      ...(ctx.pastSessionsText
        ? ["--- PAST SESSIONS / CAMPAIGN MEMORY ---", ctx.pastSessionsText]
        : []),
      "--- CURRENT SCENE & RECENT CONVERSATION ---",
      store.state.situation?.headline ? `Scene Headline: ${store.state.situation.headline}` : "",
      ctx.recentTranscript || "None",
      customQuestion ? `--- USER QUESTION: ${customQuestion} ---` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const schema = {
      type: "object",
      properties: {
        tacticalOverview: { type: "string" },
        concentrationWarning: { type: "string" },
        pastSessionConnection: { type: "string" },
        recommendations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "integer" },
              spellOrAction: { type: "string" },
              slotInfo: { type: "string" },
              whyBest: { type: "string" }
            },
            required: ["rank", "spellOrAction", "slotInfo", "whyBest"]
          }
        },
        customAnswer: { type: "string" }
      },
      required: [
        "tacticalOverview",
        "concentrationWarning",
        "pastSessionConnection",
        "recommendations",
        "customAnswer"
      ]
    };

    const res = await runStructuredAi({
      store,
      backend,
      geminiModel: store.settings.advisorModel || "gemini-3.8-flash",
      systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
      prompt,
      geminiSchema: schema,
      groqSchemaHint: JSON.stringify({
        tacticalOverview: "1-sentence read on the moment and our best angle",
        concentrationWarning: "Leave EMPTY string unless PC is actively concentrating on a spell",
        pastSessionConnection: "1-2 sentence tie-in to a past session NPC/clue/quest if relevant right now, otherwise empty string",
        recommendations: [
          {
            rank: 1,
            spellOrAction: "Action, Spell, Check, or Question to Try",
            slotInfo: "Category / Slot Cost / Skill (e.g. L2 Slot (2/3 left) · Action OR Investigation Check OR Ask DM)",
            whyBest: "1-2 clear sentences explaining why to try this now"
          }
        ],
        customAnswer: ""
      })
    });

    const isActivelyConcentrating = Boolean(ctx.myChar?.concentratingOn);
    const rawWarn = String(res.concentrationWarning || "").trim();
    const safeWarn =
      !isActivelyConcentrating || /concentration\s+is\s+free/i.test(rawWarn) ? "" : rawWarn;

    store.state.advisor = {
      tacticalOverview: res.tacticalOverview || "",
      concentrationWarning: safeWarn,
      pastSessionConnection: res.pastSessionConnection || "",
      recommendations: Array.isArray(res.recommendations) ? res.recommendations.slice(0, 4) : [],
      customAnswer: customQuestion ? res.customAnswer || "" : "",
      lastAdvisedAt: Date.now()
    };
    store.save();
    return res;
  }

  function sampleLargeText(rawText, maxChars = 18000) {
    const clean = String(rawText || "").trim();
    if (clean.length <= maxChars) return clean;
    const part = Math.floor(maxChars / 3);
    return [
      clean.slice(0, part),
      "\n... [middle excerpt] ...\n",
      clean.slice(Math.floor(clean.length / 2 - part / 2), Math.floor(clean.length / 2 + part / 2)),
      "\n... [ending excerpt] ...\n",
      clean.slice(-part)
    ].join("");
  }

  async function summarizePastSession(store, title, rawText) {
    const cleanTitle = String(title || "").trim() || `Session (${new Date().toLocaleDateString()})`;
    const excerpt = sampleLargeText(rawText, 18000);
    const backend = resolveBrainBackend(store);

    if (backend === "local" && global.DnDCopilot?.LocalBrain?.summarizePastSession) {
      return await global.DnDCopilot.LocalBrain.summarizePastSession(store, cleanTitle, excerpt);
    }

    const prompt = [
      `Distill this past D&D session notes/transcript titled "${cleanTitle}" into structured campaign memory for future sessions.`,
      "Extract key events, recurring NPCs/factions/locations, unresolved quests/promises, and mystery/puzzle clues.",
      "--- PAST SESSION TEXT ---",
      excerpt
    ].join("\n");

    let res;
    if (backend === "groq") {
      res = await callGroqJson({
        store,
        userPrompt: prompt,
        schemaHint: JSON.stringify({
          title: cleanTitle,
          summary: "3-4 sentence recap of key events and cliffhangers",
          keyNpcs: ["NPC Name (brief role)"],
          openQuests: ["Unresolved thread or promise"],
          clues: ["Important clue, lore item, or secret"]
        })
      });
    } else {
      const schema = {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          keyNpcs: { type: "array", items: { type: "string" } },
          openQuests: { type: "array", items: { type: "string" } },
          clues: { type: "array", items: { type: "string" } }
        },
        required: ["title", "summary", "keyNpcs", "openQuests", "clues"]
      };
      res = await callInteractionsApi({
        store,
        model: store.settings.fastModel || "gemini-3.5-flash-lite",
        systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
        input: prompt,
        jsonSchema: schema
      });
    }

    return {
      title: res.title || cleanTitle,
      summary: res.summary || "",
      keyNpcs: Array.isArray(res.keyNpcs) ? res.keyNpcs : [],
      openQuests: Array.isArray(res.openQuests) ? res.openQuests : [],
      clues: Array.isArray(res.clues) ? res.clues : []
    };
  }

  async function analyzeTabScreenshot(base64Jpeg, store) {
    const schema = {
      type: "object",
      properties: {
        inCombat: { type: "boolean" },
        round: { type: "integer" },
        visibleEnemies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              isBloodied: { type: "boolean" },
              isCurrentTurn: { type: "boolean" }
            },
            required: ["name", "isBloodied", "isCurrentTurn"]
          }
        },
        visibleRolls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              action: { type: "string" },
              kind: { type: "string" },
              total: { type: "integer" }
            },
            required: ["actor", "action", "kind", "total"]
          }
        }
      },
      required: ["inCombat", "visibleEnemies", "visibleRolls"]
    };

    return await callInteractionsApi({
      store,
      model: store.settings.fastModel || "gemini-3.5-flash-lite",
      systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
      input: [
        { type: "text", text: "Extract visible AboveVTT enemies and game-log dice rolls." },
        { type: "image", data: base64Jpeg, mime_type: "image/jpeg" }
      ],
      jsonSchema: schema
    });
  }

  function buildSampledTranscriptText(lines, maxChars = 16000) {
    if (!Array.isArray(lines) || lines.length === 0) return "";
    const formatted = lines.map((l) => `[${l.speaker || "Table"}] ${l.text}`);
    const joined = formatted.join("\n");
    if (joined.length <= maxChars) return joined;

    const bucketCount = 5;
    const bucketSize = Math.ceil(formatted.length / bucketCount);
    const charBudget = Math.floor(maxChars / bucketCount);
    const sections = [];

    for (let b = 0; b < bucketCount; b++) {
      const start = b * bucketSize;
      const end = Math.min(formatted.length, start + bucketSize);
      if (start >= end) break;
      let used = 0;
      const picked = [];
      for (let i = start; i < end; i++) {
        const line = formatted[i];
        if (used + line.length + 1 > charBudget && picked.length > 0) break;
        picked.push(line);
        used += line.length + 1;
      }
      if (picked.length > 0) {
        sections.push(picked.join("\n"));
      }
    }
    return sections.join("\n...\n");
  }

  async function summarizeFullSession(store) {
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain?.summarizeFullSession) {
      return await global.DnDCopilot.LocalBrain.summarizeFullSession(store);
    }

    const ctx = buildCompactSessionContext(store);
    const beats = Array.isArray(store.state.sessionBeats) ? store.state.sessionBeats : [];
    const beatsText = beats
      .map((b) => {
        const t = b.timestamp
          ? new Date(b.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";
        return `- ${t ? `[${t}] ` : ""}(${b.sceneMode || "Scene"}) ${b.headline}${
          b.summary ? ` — ${b.summary}` : ""
        }`;
      })
      .join("\n");
    const sampledText = buildSampledTranscriptText(store.state.transcript, 16000);

    const prompt = [
      "Write a concise, accurate full-session summary of this entire D&D 5e session from start to finish.",
      "Cover the full chronological arc (do NOT summarize only the ending).",
      `--- PARTY ---\n${ctx.partyText || "None synced"}`,
      beatsText ? `--- SCENE TIMELINE BEATS ---\n${beatsText}` : "",
      `--- CHRONOLOGICAL TRANSCRIPT EXCERPTS (${store.state.transcript.length} total lines) ---\n${
        sampledText || "None"
      }`,
      "Return a crisp 1-sentence headline and 4-6 chronological summaryBullets."
    ]
      .filter(Boolean)
      .join("\n");

    const schema = {
      type: "object",
      properties: {
        headline: { type: "string" },
        bullets: { type: "array", items: { type: "string" } }
      },
      required: ["headline", "bullets"]
    };

    const res = await runStructuredAi({
      store,
      backend,
      geminiModel: store.settings.fastModel || "gemini-3.5-flash-lite",
      systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
      prompt,
      geminiSchema: schema,
      groqSchemaHint: JSON.stringify({
        headline: "Short 1-sentence full-session headline",
        bullets: ["Chronological bullet 1", "Chronological bullet 2", "Chronological bullet 3", "Chronological bullet 4"]
      })
    });

    return store.setSessionSummary({
      headline: res.headline || store.state.situation?.headline || "Full Session Summary",
      bullets: Array.isArray(res.bullets) ? res.bullets.slice(0, 8) : []
    });
  }

  function parseTranscriptTextToLines(rawText, defaultSpeaker = "Table") {
    const clean = String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawLines = clean.split("\n");
    const result = [];
    let currentSpeaker = defaultSpeaker;
    let buf = [];
    const baseTs = Date.now() - Math.min(rawLines.length, 3000) * 2000;
    let lineIdx = 0;

    const flush = () => {
      const joined = buf.join(" ").replace(/\s+/g, " ").trim();
      buf = [];
      if (!joined) return;
      if (/^(?:===|---|TRANSCRIPT\s+ATTRIBUTION)/i.test(joined)) return;
      result.push({
        speaker: currentSpeaker || defaultSpeaker,
        text: joined,
        timestamp: baseTs + lineIdx * 2000
      });
      lineIdx++;
    };

    for (const raw of rawLines) {
      const line = raw.trim();
      if (!line) {
        flush();
        continue;
      }
      const standaloneSpeaker = line.match(/^\[([^\]]{1,40})\]$/);
      if (standaloneSpeaker) {
        flush();
        currentSpeaker = standaloneSpeaker[1].trim();
        continue;
      }
      const tsPrefix = line.match(/^\[(?:\d{1,2}:){1,2}\d{2}(?:\s*[AP]M)?\]\s*([^:\n]{1,40}):\s+(.+)$/i);
      if (tsPrefix) {
        flush();
        currentSpeaker = tsPrefix[1].trim();
        result.push({
          speaker: currentSpeaker,
          text: tsPrefix[2].trim(),
          timestamp: baseTs + lineIdx * 2000
        });
        lineIdx++;
        continue;
      }
      const inlineSpeaker = line.match(/^([A-Z][a-zA-Z0-9 _.'()-]{1,28}):\s+(.+)$/);
      if (inlineSpeaker && !/^(?:Note|Summary|Date|Session|Chapter|http|https)$/i.test(inlineSpeaker[1])) {
        flush();
        currentSpeaker = inlineSpeaker[1].trim();
        result.push({
          speaker: currentSpeaker,
          text: inlineSpeaker[2].trim(),
          timestamp: baseTs + lineIdx * 2000
        });
        lineIdx++;
        continue;
      }
      buf.push(line);
    }
    flush();
    return result;
  }

  function selectSalientActLines(actLines, maxChars = 5500) {
    if (!Array.isArray(actLines) || actLines.length === 0) return [];
    const formatted = actLines.map((l, idx) => ({
      idx,
      line: l,
      score: 0
    }));
    const SALIENCE_RE =
      /\b(cast(?:s|ing)?|fireball|hold\s+person|hunter'?s\s+mark|sneak\s+attack|smite|uncanny\s+dodge|damage|heal(?:s|ed)?|hp|hit\s+points?|inspiration|bloodied|unconscious|rage|raging|goblin|duergar|dragon|zorzula|phandalin|stonehill|well|stone|axe|clue|secret|riddle|puzzle|save|saving\s+throw|persuasion|investigation|perception|insight|intimidation|raine|munder|gonloar|bone\s*hawk|lusomorris|keel|patty|scrap|gwen)\b/i;

    for (let i = 0; i < formatted.length; i++) {
      const txt = String(formatted[i].line.text || "");
      let sc = txt.length >= 28 ? 1 : 0;
      const matches = txt.match(new RegExp(SALIENCE_RE.source, "gi"));
      if (matches) sc += matches.length * 4;
      if (/\d{1,3}/.test(txt)) sc += 2;
      if (i < 2 || i >= formatted.length - 6) sc += 3;
      formatted[i].score = sc;
    }

    const pickedIdx = new Set();
    let totalChars = 0;
    const byScore = [...formatted].sort((a, b) => b.score - a.score || b.idx - a.idx);
    for (const item of byScore) {
      const cost = (item.line.speaker?.length || 6) + (item.line.text?.length || 0) + 5;
      if (totalChars + cost > maxChars && pickedIdx.size >= 8) continue;
      pickedIdx.add(item.idx);
      totalChars += cost;
      if (totalChars >= maxChars) break;
    }

    return Array.from(pickedIdx)
      .sort((a, b) => a - b)
      .map((i) => formatted[i].line);
  }

  async function fastPlayTranscript(store, rawText, options = {}) {
    const title = String(options?.title || "Transcript Replay").trim();
    const targetActs = Math.max(1, Math.min(8, Number(options?.acts) || 5));
    const resetFirst = options?.resetFirst !== false;
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : () => {};
    const shouldCancel = typeof options?.shouldCancel === "function" ? options.shouldCancel : () => false;

    const parsedLines = parseTranscriptTextToLines(rawText);
    if (parsedLines.length === 0) {
      throw new Error("No dialogue lines found in transcript to fast-play.");
    }

    if (resetFirst) {
      store.resetSession();
      store.state.sessionTitle = title;
    }

    const numActs = Math.min(targetActs, Math.max(1, Math.ceil(parsedLines.length / 25)));
    const chunkSize = Math.ceil(parsedLines.length / numActs);
    let actsProcessed = 0;

    for (let a = 0; a < numActs; a++) {
      if (shouldCancel()) break;
      const slice = parsedLines.slice(a * chunkSize, (a + 1) * chunkSize);
      if (slice.length === 0) continue;

      const actItems = slice.map((item, j) => ({
        id: `tr-fp-${Date.now()}-${a}-${j}-${Math.random().toString(36).slice(2, 5)}`,
        timestamp: item.timestamp,
        speaker: item.speaker || "Table",
        text: item.text,
        pinnedAsClue: false
      }));
      store.state.transcript.push(...actItems);
      if (store.state.transcript.length > 20000) {
        store.state.transcript = store.state.transcript.slice(-20000);
      }
      store.save();

      const salient = selectSalientActLines(actItems, 5500);
      const actLabel = `Act ${a + 1}/${numActs} (${title})`;
      let res = null;
      try {
        res = await analyzeTableSituation(store, {
          overrideLines: salient,
          forceRecordBeat: true,
          actLabel
        });
      } catch (_) {
        if (global.DnDCopilot?.LocalBrain) {
          res = await global.DnDCopilot.LocalBrain.analyzeTableSituation(store, {
            overrideLines: salient,
            forceRecordBeat: true
          });
        }
      }
      actsProcessed++;
      onProgress({
        phase: "act",
        act: a + 1,
        totalActs: numActs,
        headline: store.state.situation?.headline || "",
        updatesCount: res?._appliedPartyUpdates?.length || 0
      });

      if (a < numActs - 1 && !shouldCancel()) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (!shouldCancel()) {
      onProgress({ phase: "advisor", act: actsProcessed, totalActs: numActs, headline: "Updating Live Ideas..." });
      try {
        await adviseTacticsAndSpells(store, "");
      } catch (_) {
        await global.DnDCopilot?.LocalBrain?.adviseTacticsAndSpells?.(store, "");
      }

      if (store.state.puzzle?.isActive || (store.state.puzzle?.clues || []).length > 0) {
        onProgress({ phase: "puzzle", act: actsProcessed, totalActs: numActs, headline: "Analyzing Clues & Puzzles..." });
        try {
          await solvePuzzle(store, "");
        } catch (_) {
          await global.DnDCopilot?.LocalBrain?.solvePuzzle?.(store, "");
        }
      }

      onProgress({ phase: "summary", act: actsProcessed, totalActs: numActs, headline: "Building Session Story..." });
      try {
        await summarizeFullSession(store);
      } catch (_) {
        await global.DnDCopilot?.LocalBrain?.summarizeFullSession?.(store);
      }
    }

    return {
      title,
      totalLines: parsedLines.length,
      actsProcessed,
      headline: store.state.situation?.headline || ""
    };
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.GeminiClient = {
    transcribeWithGroq,
    transcribeWithDeepgramPrerecorded,
    transcribeLongAudioBlob,
    analyzeTableSituation,
    solvePuzzle,
    adviseTacticsAndSpells,
    summarizePastSession,
    analyzeTabScreenshot,
    summarizeFullSession,
    parseTranscriptTextToLines,
    selectSalientActLines,
    fastPlayTranscript
  };
})(window);
