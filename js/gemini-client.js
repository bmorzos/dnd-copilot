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
    "you",
    ".",
    "bye.",
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

    const resp = await fetch(INTERACTIONS_ENDPOINT, {
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

    const resp = await fetch(GROQ_CHAT_ENDPOINT, {
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
   * Transcribes an audio Blob or File using Groq whisper-large-v3-turbo ($0 free tier / $0.04 per hr).
   */
  async function transcribeWithGroq(audioBlob, store, customFilename = "") {
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

    const partyNames = store.state.party.map((p) => p.name).join(", ");
    const vocabPrompt = `D&D 5e tabletop session. AboveVTT, saving throw, initiative, spell slot.${
      partyNames ? ` Party: ${partyNames}.` : ""
    }`;

    const form = new FormData();
    form.append("file", file);
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "en");
    form.append("response_format", "json");
    form.append("prompt", vocabPrompt);

    const resp = await fetch(GROQ_WHISPER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`
      },
      body: form
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const j = await resp.json();
        detail = j?.error?.message || JSON.stringify(j);
      } catch (_) {
        detail = await resp.text();
      }
      throw new Error(`Groq Whisper HTTP ${resp.status}: ${detail.slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = String(data?.text || "").trim();
    if (!text || WHISPER_HALLUCINATIONS.has(text.toLowerCase())) {
      return "";
    }
    return text;
  }

  function buildCompactSessionContext(store) {
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
        const slots = p.spellSlots
          .map((s) => `${s.isPact ? "Pact " : ""}L${s.level}:${s.remaining}/${s.max}`)
          .join(", ");
        const isMe = myChar && String(p.id) === String(myChar.id) ? " [ME]" : "";
        return `- ${p.name} (${p.classSummary})${isMe}: HP ${p.hp.current}/${p.hp.max}${
          p.hp.temp ? ` +${p.hp.temp}thp` : ""
        }, AC ${p.ac}${p.concentratingOn ? `, Concentrating on ${p.concentratingOn}` : ""}${
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

    return { myChar, recentTranscript, recentRolls, enemiesText, partyText, mySpellsText };
  }

  async function analyzeTableSituation(store) {
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.analyzeTableSituation(store);
    }

    const ctx = buildCompactSessionContext(store);
    const existingClues = store.state.puzzle.clues.join(" | ");

    const prompt = [
      "Summarize what is happening right now at our D&D table in plain, easy-to-read language.",
      `Current Combat Active: ${store.state.combat.inCombat} (Round ${store.state.combat.round || 1})`,
      `Known Puzzle Clues So Far: ${existingClues || "None"}`,
      "--- PARTY ---",
      ctx.partyText || "None synced",
      "--- VISIBLE ENEMIES ---",
      ctx.enemiesText || "None",
      "--- RECENT ROLLS ---",
      ctx.recentRolls || "None",
      "--- RECENT TABLE CONVERSATION ---",
      ctx.recentTranscript || "None",
      "Keep summaryBullets to 3 short, crisp sentences (filter out casual off-topic banter)."
    ].join("\n");

    let res;
    if (backend === "groq") {
      res = await callGroqJson({
        store,
        userPrompt: prompt,
        schemaHint: JSON.stringify({
          sceneMode: "Exploration | Social | Puzzle | Combat",
          headline: "Short 1-sentence headline",
          summaryBullets: ["Bullet 1", "Bullet 2", "Bullet 3"],
          activeObjectives: ["Objective 1"],
          notableNpcs: ["NPC Name"],
          puzzleDetected: false,
          puzzleTitle: "",
          puzzleInscription: "",
          newPuzzleClues: [],
          observedEnemyNotes: [{ enemyName: "Name", trait: "Trait" }]
        })
      });
    } else {
      const schema = {
        type: "object",
        properties: {
          sceneMode: { type: "string", enum: ["Exploration", "Social", "Puzzle", "Combat"] },
          headline: { type: "string" },
          summaryBullets: { type: "array", items: { type: "string" } },
          activeObjectives: { type: "array", items: { type: "string" } },
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
          "observedEnemyNotes"
        ]
      };
      res = await callInteractionsApi({
        store,
        model: store.settings.fastModel || "gemini-3.5-flash-lite",
        systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
        input: prompt,
        jsonSchema: schema
      });
    }

    store.state.situation = {
      sceneMode: res.sceneMode || "Exploration",
      headline: res.headline || store.state.situation.headline,
      summaryBullets: Array.isArray(res.summaryBullets) ? res.summaryBullets.slice(0, 4) : [],
      activeObjectives: Array.isArray(res.activeObjectives) ? res.activeObjectives.slice(0, 3) : [],
      notableNpcs: Array.isArray(res.notableNpcs) ? res.notableNpcs.slice(0, 4) : [],
      lastUpdatedAt: Date.now()
    };

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

    store.save();
    return res;
  }

  async function solvePuzzle(store, extraUserNote = "") {
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.solvePuzzle(store, extraUserNote);
    }

    const ctx = buildCompactSessionContext(store);
    const prompt = [
      "Help solve this D&D puzzle, riddle, or mechanism clearly and concisely.",
      `Inscription / Riddle: ${store.state.puzzle.promptOrInscription || "(Check transcript)"}`,
      `Clues:\n${store.state.puzzle.clues.map((c, i) => `${i + 1}. ${c}`).join("\n") || "None pinned yet"}`,
      extraUserNote ? `Extra Note: ${extraUserNote}` : "",
      "--- MY SPELLS ---",
      ctx.mySpellsText,
      "--- RECENT CONVERSATION ---",
      ctx.recentTranscript || "None"
    ].join("\n");

    let res;
    if (backend === "groq") {
      res = await callGroqJson({
        store,
        userPrompt: prompt,
        schemaHint: JSON.stringify({
          title: "Puzzle Title",
          promptOrInscription: "Riddle text if found",
          extractedClues: ["Clue 1"],
          hypotheses: [
            { solution: "Best Solution", confidence: "High", reasoning: "Short clear reason" }
          ],
          nextChecks: ["Ask DM to check X"]
        })
      });
    } else {
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
      res = await callInteractionsApi({
        store,
        model: store.settings.advisorModel || "gemini-3.8-flash",
        systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
        input: prompt,
        jsonSchema: schema
      });
    }

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
    const backend = resolveBrainBackend(store);
    if (backend === "local" && global.DnDCopilot?.LocalBrain) {
      return await global.DnDCopilot.LocalBrain.adviseTacticsAndSpells(store, customQuestion);
    }

    const ctx = buildCompactSessionContext(store);
    const prompt = [
      "Give top 3 best D&D 5e spells/actions right now for my character in short, easy-to-scan sentences.",
      "Only suggest spells I actually have prepared AND have remaining slots for, and warn before breaking active Concentration.",
      `--- PLAYING AS: ${ctx.myChar ? `${ctx.myChar.name} (${ctx.myChar.classSummary}, Save DC ${ctx.myChar.spellSaveDc})` : "Party Member"} ---`,
      "Prepared Spells:",
      ctx.mySpellsText,
      "--- PARTY ---",
      ctx.partyText || "None synced",
      `--- ENEMIES (Round ${store.state.combat.round || 1}) ---`,
      ctx.enemiesText || "No active enemies listed.",
      "--- RECENT CONVERSATION ---",
      ctx.recentTranscript || "None",
      customQuestion ? `--- QUESTION: ${customQuestion} ---` : ""
    ].join("\n");

    let res;
    if (backend === "groq") {
      res = await callGroqJson({
        store,
        userPrompt: prompt,
        schemaHint: JSON.stringify({
          tacticalOverview: "1-sentence summary of the turn",
          concentrationWarning: "",
          recommendations: [
            {
              rank: 1,
              spellOrAction: "Spell Name",
              slotInfo: "2nd-level slot · Action",
              whyBest: "Short reason why"
            }
          ],
          customAnswer: ""
        })
      });
    } else {
      const schema = {
        type: "object",
        properties: {
          tacticalOverview: { type: "string" },
          concentrationWarning: { type: "string" },
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
        required: ["tacticalOverview", "concentrationWarning", "recommendations", "customAnswer"]
      };
      res = await callInteractionsApi({
        store,
        model: store.settings.advisorModel || "gemini-3.8-flash",
        systemInstruction: PLAYER_FAIR_SYSTEM_PROMPT,
        input: prompt,
        jsonSchema: schema
      });
    }

    store.state.advisor = {
      tacticalOverview: res.tacticalOverview || "",
      concentrationWarning: res.concentrationWarning || "",
      recommendations: Array.isArray(res.recommendations) ? res.recommendations.slice(0, 3) : [],
      customAnswer: customQuestion ? res.customAnswer || "" : "",
      lastAdvisedAt: Date.now()
    };
    store.save();
    return res;
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

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.GeminiClient = {
    transcribeWithGroq,
    analyzeTableSituation,
    solvePuzzle,
    adviseTacticsAndSpells,
    analyzeTabScreenshot
  };
})(window);
