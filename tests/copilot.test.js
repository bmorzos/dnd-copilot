/**
 * End-to-End & Unit Tests for D&D Table Copilot (Node v24 native test runner).
 * Validates:
 * 1. Chrome MV3 manifest & strict CSP compliance (no inline scripts or inline onclick handlers).
 * 2. D&D Beyond Character v5 JSON parser (HP math, Tough feat, AC, Multiclass/Pact Spell Slots, Prepared vs Known Spells).
 * 3. Session Store (AC bound inference from hit/miss rolls, cumulative damage attribution, AboveVTT player-fair merge, USD budget cap).
 * 4. Bookmarklet generator syntax validity (decodes & parses cleanly as valid JS).
 * 5. Gemini Interactions API client (enforces budget cap & uses strictly current models + Api-Revision 2026-05-20).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function createBrowserSandbox() {
  const storage = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    URL,
    URLSearchParams,
    Blob,
    File,
    FormData,
    ArrayBuffer,
    Uint8Array,
    Int16Array,
    Float32Array,
    DataView,
    encodeURIComponent,
    decodeURIComponent,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    location: {
      href: "http://localhost:8765/index.html",
      protocol: "http:",
      pathname: "/index.html"
    },
    addEventListener: () => {},
    opener: null,
    fetch: null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const rel of [
    "js/ddb-parser.js",
    "js/audio-utils.js",
    "js/state.js",
    "js/local-brain.js",
    "js/gemini-client.js",
    "js/session-recorder.js",
    "js/audio-listener.js",
    "js/bridge-host.js"
  ]) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

test("Manifest V3 and index.html pass strict Chrome Extension CSP rules", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(ROOT, "icons/icon128.png")));

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // MV3 forbids inline <script> blocks without src and inline event attributes like onclick=
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scriptTags.length >= 5);
  for (const tag of scriptTags) {
    assert.match(tag, /\bsrc=/i, `Found disallowed inline script tag: ${tag}`);
  }
  assert.doesNotMatch(html, /\bon\w+\s*=/i, "index.html must not contain inline on* event attributes");
  assert.match(html, /id="colSplitter1"/);
  assert.match(html, /id="colSplitter2"/);
  assert.match(html, /id="driveMysteriesSection"/);
  assert.match(html, /id="combatEventsList"/);
  assert.match(html, /id="fastPlayModal"/);
});

test("D&D Beyond v5 parser computes HP, AC, Spell Slots, Pact Magic, and Prepared Spells accurately", () => {
  const sb = createBrowserSandbox();
  const { parseCharacterJson } = sb.DnDCopilot.DDBParser;

  // Simulate a multiclass Cleric 5 / Warlock 2 with Tough feat, +2 CON, Scale Mail + Shield, 12 removed HP, 5 temp HP
  const mockDdbPayload = {
    id: 99887766,
    data: {
      id: 99887766,
      name: "Seraphina Vale",
      race: { fullName: "Variant Human" },
      baseHitPoints: 41, // before CON & Tough
      removedHitPoints: 12,
      temporaryHitPoints: 5,
      stats: [
        { id: 1, value: 10 },
        { id: 2, value: 14 }, // DEX +2
        { id: 3, value: 14 }, // CON +2
        { id: 4, value: 10 },
        { id: 5, value: 18 }, // WIS +4
        { id: 6, value: 14 }
      ],
      bonusStats: [],
      overrideStats: [],
      modifiers: {
        feat: [{ type: "bonus", subType: "hit-points-per-level", value: 2, isGranted: true }],
        class: [{ type: "proficiency", subType: "perception", isGranted: true }]
      },
      inventory: [
        { equipped: true, definition: { armorClass: 14, armorTypeId: 2 } }, // Medium armor 14 +2 DEX = 16
        { equipped: true, definition: { armorClass: 2, armorTypeId: 4 } } // Shield +2 => AC 18
      ],
      classes: [
        {
          id: 10,
          level: 5,
          definition: {
            name: "Cleric",
            canCastSpells: true,
            canPrepareSpells: true,
            spellCastingAbilityId: 5,
            spellRules: { multiClassSpellSlotDivisor: 1 }
          },
          subclassDefinition: { name: "Life Domain" }
        },
        {
          id: 20,
          level: 2,
          definition: {
            name: "Warlock",
            canCastSpells: true,
            canPrepareSpells: false,
            spellCastingAbilityId: 6
          }
        }
      ],
      spellSlots: [
        { level: 1, available: 4, used: 1 },
        { level: 2, available: 3, used: 2 },
        { level: 3, available: 2, used: 0 }
      ],
      pactMagic: [{ level: 1, available: 2, used: 1 }],
      classSpells: [
        {
          characterClassId: 10,
          spells: [
            {
              prepared: true,
              definition: {
                id: 501,
                name: "Spirit Guardians",
                level: 3,
                concentration: true,
                activation: { activationType: 1 },
                range: { origin: "Self", rangeValue: 15 },
                requiresSavingThrow: true,
                saveDcAbilityId: 5,
                modifiers: [{ type: "damage", subType: "radiant" }],
                description: "<p>Angelic spirits flit around you to a distance of 15 feet.</p>"
              }
            },
            {
              prepared: false,
              alwaysPrepared: false,
              definition: {
                id: 502,
                name: "Daylight",
                level: 3,
                concentration: false,
                activation: { activationType: 1 }
              }
            }
          ]
        },
        {
          characterClassId: 20,
          spells: [
            {
              prepared: false, // Warlock is a Known caster—should still be included!
              definition: {
                id: 601,
                name: "Misty Step",
                level: 2,
                concentration: false,
                activation: { activationType: 3 },
                range: { origin: "Self" },
                description: "Briefly surrounded by silvery mist, you teleport up to 30 feet."
              }
            }
          ]
        }
      ]
    }
  };

  const hero = parseCharacterJson(mockDdbPayload);
  assert.equal(hero.name, "Seraphina Vale");
  assert.equal(hero.sheetUrl, "https://www.dndbeyond.com/characters/99887766");
  assert.equal(hero.level, 7);
  // Max HP = 41 base + (2 CON + 2 Tough) * 7 = 41 + 28 = 69; Current = 69 - 12 = 57
  assert.equal(hero.hp.max, 69);
  assert.equal(hero.hp.current, 57);
  assert.equal(hero.hp.temp, 5);
  assert.equal(hero.ac, 18);
  assert.equal(hero.spellSaveDc, 8 + 3 + 4); // 15

  // Slots: L1 (3/4), L2 (1/3), L3 (2/2), plus Warlock Pact L1 (1/2)
  assert.equal(hero.spellSlots.length, 4);
  const pact = hero.spellSlots.find((s) => s.isPact);
  assert.ok(pact);
  assert.equal(pact.remaining, 1);
  assert.equal(pact.max, 2);

  // Prepared spells: Spirit Guardians (prepared Cleric) + Misty Step (Known Warlock), NOT unprepared Daylight
  const spellNames = Array.from(hero.spells, (s) => s.name);
  assert.deepEqual(spellNames, ["Misty Step", "Spirit Guardians"]);
  assert.equal(hero.spells[0].castingTime, "Bonus Action");
  assert.equal(hero.spells[1].concentration, true);
});

test("Demo session loads cleanly and renders all 3 columns without errors", () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  store.loadDemo();
  assert.equal(store.state.party.length, 4);
  assert.equal(store.state.combat.inCombat, true);
  assert.equal(store.state.puzzle.isActive, true);
  assert.ok(store.state.advisor.recommendations.length >= 3);
});

test("Session Store tracks player-fair enemy damage, AC bounds, and AboveVTT snapshots", () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  store.resetSession();

  // Sync a player-fair AboveVTT snapshot
  const discovered = store.syncAboveVttSnapshot(
    {
      pageTitle: "Curse of Strahd — AboveVTT",
      isAboveVttActive: true,
      partyCharacters: [{ id: "12345678", name: "Ireena" }],
      combat: {
        inCombat: true,
        round: 2,
        combatants: [
          {
            tokenId: "/profile/user/characters/12345678",
            name: "Ireena",
            isNameRevealed: true,
            isPlayer: true,
            isCurrentTurn: true,
            initiative: 18,
            conditions: [],
            isBloodied: false,
            visibleHealthPercent: null
          },
          {
            tokenId: "monster-tok-99",
            name: "Unidentified Foe #1",
            isNameRevealed: false,
            isPlayer: false,
            isCurrentTurn: false,
            initiative: 12,
            conditions: ["Bloodied"],
            isBloodied: true,
            visibleHealthPercent: null
          }
        ]
      },
      recentLog: [
        {
          fingerprint: "fp-dmg-1",
          timestamp: Date.now(),
          actor: "Ireena",
          action: "Rapier",
          kind: "damage",
          total: 14,
          rawText: "Ireena dealt 14 piercing"
        }
      ]
    },
    "bookmarklet"
  );

  assert.equal(discovered.length, 1);
  assert.equal(store.state.combat.enemies.length, 1);
  assert.equal(store.state.combat.enemies[0].isBloodied, true);

  // Attribute damage roll (with half-damage resistance)
  store.attributeRollDamageToEnemy("fp-dmg-1", "monster-tok-99", 0.5);
  assert.equal(store.state.combat.enemies[0].damageTaken, 7);

  // Record attack misses/hits to narrow AC fairly
  store.recordEnemyAttackOutcome("monster-tok-99", 14, false);
  store.recordEnemyAttackOutcome("monster-tok-99", 16, true);
  assert.equal(store.state.combat.enemies[0].highestMissRoll, 14);
  assert.equal(store.state.combat.enemies[0].lowestHitRoll, 16);
});

test("Bookmarklet generator compiles into valid JavaScript with zero syntax errors", () => {
  const sb = createBrowserSandbox();
  const bridge = new sb.DnDCopilot.AboveVttBridgeHost(sb.DnDCopilot.Store);
  const bml = bridge.buildBookmarkletCode("https://example.github.io/dnd-copilot/index.html");
  assert.ok(bml.startsWith("javascript:"));

  const decodedJs = decodeURIComponent(bml.slice("javascript:".length));
  // Verify valid JS syntax using vm.Script
  assert.doesNotThrow(() => new vm.Script(decodedJs));
  assert.ok(decodedJs.includes("dnd-copilot-bookmarklet"));
  assert.ok(!decodedJs.includes("TOKEN_OBJECTS"), "Bookmarklet must never inspect hidden DM TOKEN_OBJECTS");
});

test("Gemini Interactions client uses Api-Revision 2026-05-20 and enforces hard USD budget cap", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  let capturedReq = null;
  sb.fetch = async (url, opts) => {
    capturedReq = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sceneMode: "Puzzle",
                  headline: "Testing vault riddle",
                  summaryBullets: ["Clue A"],
                  activeObjectives: ["Open arch"],
                  notableNpcs: [],
                  puzzleDetected: true,
                  puzzleTitle: "Mirror Arch",
                  puzzleInscription: "Speak friend",
                  newPuzzleClues: ["Three runes glow"],
                  observedEnemyNotes: []
                })
              }
            ]
          }
        ],
        usage: {
          total_input_tokens: 1000,
          total_output_tokens: 200,
          total_tokens: 1200
        }
      })
    };
  };

  store.resetSession();
  store.updateSettings({
    geminiApiKey: "test-key-123",
    budgetCapUsd: 0.5,
    isFreeTierKey: false
  });

  await gemini.analyzeTableSituation(store);
  assert.equal(capturedReq.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(capturedReq.opts.headers["Api-Revision"], "2026-05-20");
  assert.equal(capturedReq.body.model, "gemini-3.5-flash-lite");
  assert.equal(capturedReq.body.store, false);
  assert.equal(capturedReq.body.response_format.type, "text");
  assert.equal(capturedReq.body.response_format.mime_type, "application/json");
  assert.equal(capturedReq.body.generation_config, undefined); // No deprecated temperature/top_p
  assert.equal(store.state.puzzle.isActive, true);
  assert.ok(store.state.usage.estimatedUsd > 0);

  // Now simulate hitting the budget cap and verify cloud calls are blocked!
  store.state.usage.estimatedUsd = 0.51;
  await assert.rejects(() => gemini.analyzeTableSituation(store), /budget cap/i);
});

test("Zero-API-Key Free Local Mode runs Digest, Puzzle Solver, and Tactical Spell Advisor for $0.00", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.loadDemo();
  store.updateSettings({ aiProvider: "auto", geminiApiKey: "" }); // Blank API key!

  store.addTranscriptLine(
    "DM",
    "Carved into the stone altar is a riddle: 'Feed first the flame that casts no shadow.' Your firebolt barely scorches the guardian!",
    false
  );

  const sit = await gemini.analyzeTableSituation(store);
  assert.ok(sit.headline.length > 0);
  assert.equal(store.state.puzzle.isActive, true);

  const puz = await gemini.solvePuzzle(store);
  assert.ok(puz.hypotheses.length >= 1);
  assert.ok(puz.nextChecks.length >= 2);

  const adv = await gemini.adviseTacticsAndSpells(store, "What is best against stone constructs?");
  assert.ok(adv.recommendations.length >= 2);
  // Shatter should rank #1 against high-AC fire-resistant stone guardians!
  assert.match(adv.recommendations[0].spellOrAction, /Shatter/i);
});

test("Groq Whisper transcription, Groq JSON completions, Chrome<->Groq switch, and SessionRecorder work cleanly", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;
  const listener = new sb.DnDCopilot.TableAudioListener(store);
  const recorder = new sb.DnDCopilot.SessionRecorder();

  assert.equal(recorder.getStatus().isRecording, false);
  assert.equal(store.settings.speechMode, "chrome");

  listener.switchSpeechEngine("groq");
  assert.equal(store.settings.speechMode, "groq");
  listener.switchSpeechEngine("chrome");
  assert.equal(store.settings.speechMode, "chrome");

  const seenUrls = [];
  sb.fetch = async (url, opts) => {
    seenUrls.push({ url, opts });
    if (url.includes("/audio/transcriptions")) {
      return {
        ok: true,
        json: async () => ({ text: "Roll for initiative inside the sunken crypt!" })
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                sceneMode: "Combat",
                headline: "Ambush in the sunken crypt",
                summaryBullets: ["Party rolled initiative against crypt guardians"],
                activeObjectives: ["Survive the ambush"],
                notableNpcs: [],
                puzzleDetected: false,
                puzzleTitle: "",
                puzzleInscription: "",
                newPuzzleClues: [],
                observedEnemyNotes: []
              })
            }
          }
        ]
      })
    };
  };

  store.resetSession();
  store.updateSettings({
    aiProvider: "auto",
    groqApiKey: "gsk_test_123",
    geminiApiKey: ""
  });

  const transcriptText = await gemini.transcribeWithGroq(
    new Blob(["fake-audio"], { type: "audio/webm" }),
    store
  );
  assert.equal(transcriptText, "Roll for initiative inside the sunken crypt!");

  store.addTranscriptLine("Table", transcriptText, false);
  const sit = await gemini.analyzeTableSituation(store);
  assert.equal(sit.headline, "Ambush in the sunken crypt");
  assert.equal(seenUrls.length, 2);
  assert.equal(seenUrls[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(seenUrls[1].url, "https://api.groq.com/openai/v1/chat/completions");
});

test("AudioFile and PC/Tab Audio capture connect cleanly and update What's Going On on the first heard sentence", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;

  let batchReadyCount = 0;
  let lastStatus = null;
  let startedRecWithTrack = null;

  sb.webkitSpeechRecognition = class MockSpeechRec {
    start(track) {
      startedRecWithTrack = track || "default-mic";
      // Simulate hearing the first sentence from the recording immediately
      if (this.onresult) {
        const fakeEvent = {
          resultIndex: 0,
          results: [
            Object.assign([{ transcript: "You enter the torchlit vault of the dragon priest." }], {
              isFinal: true
            })
          ]
        };
        this.onresult(fakeEvent);
      }
    }
    stop() {}
  };

  const listener = new sb.DnDCopilot.TableAudioListener(store, {
    onSpeechBatchReady: () => {
      batchReadyCount += 1;
    },
    onStatusChange: (st) => {
      lastStatus = st;
    }
  });

  const fakeTrack = { kind: "audio", readyState: "live", stop: () => {}, addEventListener: () => {} };
  const fakeStream = {
    getAudioTracks: () => [fakeTrack],
    getVideoTracks: () => [],
    getTracks: () => [fakeTrack]
  };
  const fakeAudioEl = {
    paused: true,
    readyState: 4,
    currentSrc: "blob:test-recording",
    play: async function () {
      this.paused = false;
    },
    pause: function () {
      this.paused = true;
    },
    captureStream: () => fakeStream,
    addEventListener: () => {}
  };

  await listener.startFromAudioElement(fakeAudioEl);
  assert.equal(lastStatus.listening, true);
  assert.equal(lastStatus.source, "file");
  assert.equal(startedRecWithTrack, fakeTrack);
  // First sentence immediately triggers What's Going On update without waiting 25s!
  assert.equal(batchReadyCount, 1);

  listener.stop();
});

test("B.U.G.S. party group saves character sheets permanently and transcripts archive cleanly", () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;

  store.resetSession();
  assert.equal(store.getActivePartyGroupName(), "B.U.G.S.");

  store.upsertCharacter({
    id: "88112233",
    name: "Thistle",
    classSummary: "Rogue 6",
    level: 6,
    hp: { current: 45, max: 45, temp: 0 },
    ac: 16,
    spellSlots: [],
    spells: []
  });
  store.upsertCharacter({
    id: "88112244",
    name: "Gimble",
    classSummary: "Artificer 6",
    level: 6,
    hp: { current: 48, max: 48, temp: 0 },
    ac: 18,
    spellSlots: [],
    spells: []
  });

  assert.equal(store.partyGroups.groups["B.U.G.S."].characters.length, 2);

  // Loading Demo must NOT overwrite B.U.G.S., and switching back or resetting restores B.U.G.S.!
  store.loadDemo();
  assert.equal(store.state.party.length, 4);
  store.switchPartyGroup("B.U.G.S.");
  assert.equal(store.state.party.length, 2);
  assert.equal(store.state.party[0].name, "Thistle");

  // Transcript archiving & export
  store.addTranscriptLine("Recording", "We open the iron gate beneath the clocktower.", false);
  const archived = store.archiveCurrentTranscript("B.U.G.S. Episode 12");
  assert.equal(store.savedTranscripts.length, 1);
  const txt = store.formatTranscriptText(archived);
  assert.match(txt, /B\.U\.G\.S\. Episode 12/);
  assert.match(txt, /clocktower/);

  // Resetting session keeps B.U.G.S. party intact!
  store.resetSession();
  assert.equal(store.state.party.length, 2);
  assert.equal(store.state.party[1].name, "Gimble");

  // Drone and NPCs (Thenoeght, Zahra Ellian) are excluded from B.U.G.S. and never re-imported by auto-sync
  assert.equal(store.isCharacterExcluded("999999", "Drone"), true);
  assert.equal(store.isCharacterExcluded("46609350", "Thenoeght"), true);
  assert.equal(store.isCharacterExcluded("", "Theno"), true);
  assert.equal(store.isCharacterExcluded("154372629", "Zahra Ellian"), true);
  for (const npc of [
    { id: "999999", name: "Drone" },
    { id: "46609350", name: "Thenoeght" },
    { id: "154372629", name: "Zahra Ellian" }
  ]) {
    store.upsertCharacter({
      id: npc.id,
      name: npc.name,
      classSummary: "NPC",
      level: 6,
      hp: { current: 50, max: 50, temp: 0 },
      ac: 17,
      spellSlots: [],
      spells: []
    });
  }
  assert.equal(
    store.state.party.some((p) => ["Drone", "Thenoeght", "Zahra Ellian"].includes(p.name)),
    false
  );

  // Portable backup includes API keys + settings + B.U.G.S. party so nothing has to be re-entered
  store.updateSettings({ groqApiKey: "gsk_portable_key_777", speechMode: "groq" });
  const backup = store.exportPortableBackup();
  assert.equal(backup.settings.groqApiKey, "gsk_portable_key_777");

  const sbMac = createBrowserSandbox();
  sbMac.DnDCopilot.Store.importPortableBackup(backup);
  assert.equal(sbMac.DnDCopilot.Store.settings.groqApiKey, "gsk_portable_key_777");
  assert.equal(sbMac.DnDCopilot.Store.settings.speechMode, "groq");
  assert.equal(sbMac.DnDCopilot.Store.state.party.length, 2);
});

test("Groq Whisper retries transient blips, carries rolling context prompt, and fires cross-tab health alerts on mic drop", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.resetSession();
  store.updateSettings({ groqApiKey: "gsk_retry_key" });
  store.addTranscriptLine("Table", "Lord Neverember hid the key beneath the obsidian altar.", false);

  let attempts = 0;
  let capturedPrompt = "";
  sb.fetch = async (_url, opts) => {
    attempts += 1;
    capturedPrompt = String(opts.body.get("prompt") || "");
    if (attempts === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => "0.01" },
        json: async () => ({ error: { message: "Temporary blip" } })
      };
    }
    return {
      ok: true,
      json: async () => ({ text: "We search around the base of the obsidian altar for traps." })
    };
  };

  const out = await gemini.transcribeWithGroq(
    new Blob(["audio-bytes"], { type: "audio/webm" }),
    store
  );
  assert.equal(attempts, 2);
  assert.match(capturedPrompt, /obsidian altar/);
  assert.equal(out, "We search around the base of the obsidian altar for traps.");

  // Verify mic disconnect watchdog triggers onHealthAlert
  let alertReceived = "";
  const endListeners = [];
  sb.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [
          {
            kind: "audio",
            readyState: "live",
            stop: () => {},
            addEventListener: (ev, fn) => {
              if (ev === "ended") endListeners.push(fn);
            }
          }
        ],
        getTracks: () => []
      })
    }
  };
  sb.webkitSpeechRecognition = class {
    start() {}
    stop() {}
  };

  const listener = new sb.DnDCopilot.TableAudioListener(store, {
    onHealthAlert: (m) => {
      alertReceived = m;
    }
  });
  await listener.start();
  assert.equal(endListeners.length, 1);
  // Simulate unexpected microphone unplug mid-session
  endListeners[0]();
  assert.match(alertReceived, /stopped or disconnected/i);
});

test("AudioUtils handles room constraints, 16 kHz PCM WAV encoding, overlap dedupe, and chunk slicing", async () => {
  const sb = createBrowserSandbox();
  const AudioUtils = sb.DnDCopilot.AudioUtils;

  const rawDefault = AudioUtils.buildMicConstraints({});
  assert.equal(rawDefault.audio.noiseSuppression, false);
  assert.equal(rawDefault.audio.autoGainControl, false);
  assert.equal(rawDefault.audio.echoCancellation, false);
  assert.equal(rawDefault.audio.deviceId, undefined);

  const dspCustom = AudioUtils.buildMicConstraints({
    rawRoomAudio: false,
    micDeviceId: "usb-yeti-123"
  });
  assert.equal(dspCustom.audio.noiseSuppression, true);
  assert.equal(dspCustom.audio.autoGainControl, true);
  assert.equal(dspCustom.audio.deviceId?.exact, "usb-yeti-123");

  // Downsample 48 kHz -> 16 kHz (3:1)
  const samples48k = new Float32Array(48000);
  for (let i = 0; i < samples48k.length; i++) {
    samples48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
  }
  const down = AudioUtils.downsampleFloat32(samples48k, 48000, 16000);
  assert.equal(down.length, 16000);

  const wav = AudioUtils.encodeWavBlob(down, 16000);
  assert.equal(wav.type, "audio/wav");
  assert.equal(wav.size, 44 + 16000 * 2);
  const ab = await wav.arrayBuffer();
  const header = new DataView(ab);
  assert.equal(String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3)), "RIFF");
  assert.equal(String.fromCharCode(header.getUint8(8), header.getUint8(9), header.getUint8(10), header.getUint8(11)), "WAVE");
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint16(34, true), 16);

  // Overlap deduplication
  assert.equal(
    AudioUtils.dedupeOverlapText(
      "We head down the well toward Zorzula's Rest.",
      "toward Zorzula's Rest and look for the obsidian doors."
    ),
    "and look for the obsidian doors."
  );
  assert.equal(
    AudioUtils.dedupeOverlapText(
      "Roll initiative now.",
      "Patty sneaks up the spiral staircase."
    ),
    "Patty sneaks up the spiral staircase."
  );

  // Chunk slicing
  const fakeBuffer = {
    numberOfChannels: 2,
    length: 48000 * 25,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(48000 * 25)
  };
  const chunks = AudioUtils.sliceAudioBufferToWavChunks(fakeBuffer, 12, 2);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startSec, 0);
  assert.equal(chunks[1].startSec, 10);
});

test("Groq Whisper uses whisper-large-v3, campaign glossary prompt, and verbose_json hallucination filtering", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.resetSession();
  store.updateSettings({
    groqApiKey: "gsk_glossary_test",
    campaignGlossary: "Phandalin, Zorzula's Rest, Ruxithid, Duergar"
  });
  store.upsertCharacter({
    id: "771122",
    name: "Gonloar",
    classSummary: "Cleric 6",
    level: 6,
    hp: { current: 44, max: 44, temp: 0 },
    ac: 18,
    spellSlots: [],
    spells: []
  });

  let capturedForm = null;
  sb.fetch = async (_url, opts) => {
    capturedForm = opts.body;
    return {
      ok: true,
      json: async () => ({
        text: "Thank you. Phandalin is under attack by Ruxithid.",
        segments: [
          { text: "Thank you.", no_speech_prob: 0.92, avg_logprob: -1.1, compression_ratio: 1.0 },
          { text: "eat eat eat eat eat eat eat", no_speech_prob: 0.1, avg_logprob: -0.4, compression_ratio: 3.4 },
          { text: "Phandalin is under attack by Ruxithid.", no_speech_prob: 0.05, avg_logprob: -0.2, compression_ratio: 1.2 }
        ]
      })
    };
  };

  const result = await gemini.transcribeWithGroq(
    new Blob(["pcm"], { type: "audio/wav" }),
    store,
    "table-vad.wav"
  );
  assert.equal(capturedForm.get("model"), "whisper-large-v3");
  assert.equal(capturedForm.get("response_format"), "verbose_json");
  const prompt = String(capturedForm.get("prompt") || "");
  assert.match(prompt, /Phandalin/);
  assert.match(prompt, /Zorzula's Rest/);
  assert.match(prompt, /Gonloar/);
  assert.equal(result, "Phandalin is under attack by Ruxithid.");
});

test("Deepgram Nova-3 streaming WebSocket, speaker grouping, and pre-recorded diarization follow Nova-3 API rules", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.resetSession();
  store.updateSettings({
    deepgramApiKey: "dg_secret_key_99",
    groqApiKey: "gsk_fallback_key",
    campaignGlossary: "Zorzula's Rest, Moradin"
  });

  let openedUrl = "";
  let openedProtocols = null;
  let lastSocket = null;
  sb.WebSocket = class MockWebSocket {
    constructor(url, protocols) {
      openedUrl = url;
      openedProtocols = protocols;
      this.readyState = 1;
      lastSocket = this;
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  };
  sb.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [
          { kind: "audio", readyState: "live", stop: () => {}, addEventListener: () => {} }
        ],
        getTracks: () => [{ stop: () => {} }]
      })
    }
  };

  const listener = new sb.DnDCopilot.TableAudioListener(store);
  listener.switchSpeechEngine("deepgram");
  await listener.start();

  assert.match(openedUrl, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(openedUrl, /model=nova-3/);
  assert.match(openedUrl, /diarize_model=latest/);
  assert.match(openedUrl, /keyterm=Moradin/);
  assert.doesNotMatch(openedUrl, /keywords=/);
  assert.doesNotMatch(openedUrl, /diarize=true/);
  assert.deepEqual(Array.from(openedProtocols), ["token", "dg_secret_key_99"]);

  // Simulate multi-speaker Deepgram final message
  lastSocket.onmessage({
    data: JSON.stringify({
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: "Push the obsidian doors open. I got a 19 plus 3!",
            words: [
              { word: "push", punctuated_word: "Push", speaker: 0 },
              { word: "the", punctuated_word: "the", speaker: 0 },
              { word: "obsidian", punctuated_word: "obsidian", speaker: 0 },
              { word: "doors", punctuated_word: "doors", speaker: 0 },
              { word: "open", punctuated_word: "open.", speaker: 0 },
              { word: "i", punctuated_word: "I", speaker: 1 },
              { word: "got", punctuated_word: "got", speaker: 1 },
              { word: "a", punctuated_word: "a", speaker: 1 },
              { word: "19", punctuated_word: "19", speaker: 1 },
              { word: "plus", punctuated_word: "plus", speaker: 1 },
              { word: "3", punctuated_word: "3!", speaker: 1 }
            ]
          }
        ]
      }
    })
  });

  assert.equal(store.state.transcript.length, 2);
  assert.equal(store.state.transcript[0].speaker, "Speaker 1");
  assert.equal(store.state.transcript[0].text, "Push the obsidian doors open.");
  assert.equal(store.state.transcript[1].speaker, "Speaker 2");
  assert.equal(store.state.transcript[1].text, "I got a 19 plus 3!");

  listener.stop();

  // Pre-recorded Deepgram utterances
  let postUrl = "";
  sb.fetch = async (url) => {
    postUrl = url;
    return {
      ok: true,
      json: async () => ({
        results: {
          utterances: [
            { speaker: 0, start: 1.2, end: 3.5, transcript: "Welcome to Zorzula's Rest." },
            { speaker: 2, start: 4.0, end: 5.1, transcript: "I roll perception!" }
          ]
        }
      })
    };
  };

  const lines = await gemini.transcribeLongAudioBlob(
    new Blob(["audio"], { type: "audio/webm" }),
    store,
    { baseTimestamp: 1000000 }
  );
  assert.match(postUrl, /utterances=true/);
  assert.match(postUrl, /diarize_model=latest/);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].speaker, "Speaker 1");
  assert.equal(lines[0].timestamp, 1001200);
  assert.equal(lines[1].speaker, "Speaker 3");

  // Pre-recorded Deepgram CORS failure gracefully falls back to Groq Whisper
  sb.fetch = async (url) => {
    if (url.includes("deepgram.com")) {
      throw new TypeError("Failed to fetch");
    }
    return {
      ok: true,
      json: async () => ({
        segments: [
          { text: "Fallback worked cleanly.", no_speech_prob: 0.02, compression_ratio: 1.1 }
        ]
      })
    };
  };
  const fallbackLines = await gemini.transcribeLongAudioBlob(
    new Blob(["audio"], { type: "audio/webm" }),
    store
  );
  assert.equal(fallbackLines.length, 1);
  assert.equal(fallbackLines[0].speaker, "Recording");
  assert.equal(fallbackLines[0].text, "Fallback worked cleanly.");
});

test("Chrome Speech sanitizes leaked </S> tokens and SessionRecorder clones active tracks at 96 kbps", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;

  let activeRecInstance = null;
  sb.webkitSpeechRecognition = class {
    start() {
      activeRecInstance = this;
    }
    stop() {}
  };
  sb.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [
          { kind: "audio", readyState: "live", stop: () => {}, addEventListener: () => {} }
        ],
        getTracks: () => [{ stop: () => {} }]
      })
    }
  };

  const listener = new sb.DnDCopilot.TableAudioListener(store);
  await listener.start();
  activeRecInstance.onresult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "She made the dessert </S> oh no <s>" }], { isFinal: true })
    ]
  });
  assert.equal(store.state.transcript[0].text, "She made the dessert oh no");
  listener.stop();

  // SessionRecorder track cloning & 96 kbps default
  let parentStopped = false;
  let cloneStopped = false;
  const clonedTrack = {
    kind: "audio",
    readyState: "live",
    stop: () => {
      cloneStopped = true;
    },
    addEventListener: () => {}
  };
  const parentTrack = {
    kind: "audio",
    readyState: "live",
    clone: () => clonedTrack,
    stop: () => {
      parentStopped = true;
    },
    addEventListener: () => {}
  };
  const parentStream = {
    getAudioTracks: () => [parentTrack],
    getTracks: () => [parentTrack]
  };

  let recorderOpts = null;
  sb.MediaStream = class MockMediaStream {
    constructor(tracks) {
      this._tracks = tracks;
    }
    getAudioTracks() {
      return this._tracks;
    }
    getTracks() {
      return this._tracks;
    }
  };
  sb.MediaRecorder = class MockMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    constructor(_stream, opts) {
      recorderOpts = opts;
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
    }
  };
  sb.indexedDB = {
    open: () => {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = {
              objectStore: () => ({
                put: () => {},
                getAll: () => {
                  const r = {};
                  setTimeout(() => {
                    r.result = [];
                    r.onsuccess?.();
                  }, 0);
                  return r;
                }
              })
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          }
        };
        req.onsuccess?.();
      }, 0);
      return req;
    }
  };

  const recorder = new sb.DnDCopilot.SessionRecorder();
  await recorder.start(parentStream, "B.U.G.S.");
  assert.equal(recorderOpts.audioBitsPerSecond, 96000);
  recorder.stop();
  assert.equal(cloneStopped, true);
  assert.equal(parentStopped, false);
});

test("Session timeline beats, full-session summary, stale gap check, and settings backup all persist cleanly", async () => {
  const sb = createBrowserSandbox();
  const store = sb.DnDCopilot.Store;
  const localBrain = sb.DnDCopilot.LocalBrain;

  store.resetSession();
  store.updateSettings({
    aiProvider: "local-free",
    groqWhisperModel: "whisper-large-v3",
    deepgramApiKey: "dg_backup_test",
    micDeviceId: "mic-99",
    rawRoomAudio: false,
    recordingBitrate: 128000,
    campaignGlossary: "Phandalin, Zorzula's Rest"
  });

  store.addTranscriptLine("DM", "You speak with Toblen Stonehill inside the tavern.", false);
  await localBrain.analyzeTableSituation(store);
  store.state.combat.inCombat = true;
  store.addTranscriptLine("DM", "Roll initiative against the psionic goblins!", false);
  await localBrain.analyzeTableSituation(store);

  assert.equal(store.state.sessionBeats.length, 2);

  await localBrain.summarizeFullSession(store);
  const exported = store.formatTranscriptText();
  assert.match(exported, /^## Session Summary:/m);
  assert.match(exported, /Social → Combat/);

  // Stale transcript gap check (> 2 hours old)
  store.state.transcript[store.state.transcript.length - 1].timestamp =
    Date.now() - 3 * 60 * 60 * 1000;
  const gap = store.hasStaleTranscriptGap();
  assert.equal(gap.isStale, true);
  assert.ok(gap.gapMinutes >= 179);

  // Portable backup preserves all new audio/transcription settings
  const backup = store.exportPortableBackup();
  const sb2 = createBrowserSandbox();
  sb2.DnDCopilot.Store.importPortableBackup(backup);
  const s2 = sb2.DnDCopilot.Store.settings;
  assert.equal(s2.groqWhisperModel, "whisper-large-v3");
  assert.equal(s2.deepgramApiKey, "dg_backup_test");
  assert.equal(s2.micDeviceId, "mic-99");
  assert.equal(s2.rawRoomAudio, false);
  assert.equal(s2.recordingBitrate, 128000);
  assert.equal(s2.campaignGlossary, "Phandalin, Zorzula's Rest");
});

test("Parser extracts magic items/features/skills, backups backfill sheetUrl + campaignMemory, and Live Ideas ties into past sessions", async () => {
  const sb = createBrowserSandbox();
  const { parseCharacterJson } = sb.DnDCopilot.DDBParser;
  const store = sb.DnDCopilot.Store;
  const localBrain = sb.DnDCopilot.LocalBrain;
  const gemini = sb.DnDCopilot.GeminiClient;

  // 1. DDB parser extracts items, features, and skills
  const hero = parseCharacterJson({
    id: 44556677,
    name: "lyra Whisperwind",
    stats: [
      { id: 1, value: 8 },
      { id: 2, value: 14 },
      { id: 3, value: 14 },
      { id: 4, value: 12 },
      { id: 5, value: 18 },
      { id: 6, value: 16 }
    ],
    modifiers: {
      class: [
        { type: "proficiency", subType: "insight", isGranted: true },
        { type: "expertise", subType: "perception", isGranted: true }
      ]
    },
    inventory: [
      {
        equipped: true,
        isAttuned: true,
        definition: {
          name: "Wand of the War Mage, +1",
          magic: true,
          snippet: "+1 spell attack and ignore half cover."
        }
      }
    ],
    feats: [{ definition: { name: "War Caster" } }],
    classes: [
      {
        id: 1,
        level: 5,
        definition: { name: "Cleric", canCastSpells: true, canPrepareSpells: true, spellCastingAbilityId: 5 },
        classFeatures: [{ definition: { name: "Channel Divinity", requiredLevel: 2, hideInSheet: false } }]
      }
    ],
    classSpells: [
      {
        characterClassId: 1,
        spells: [
          {
            prepared: true,
            definition: {
              id: 701,
              name: "Detect Magic",
              level: 1,
              ritual: true,
              activation: { activationType: 1 },
              description: "Sense magic within 30 feet."
            }
          }
        ]
      }
    ]
  });

  assert.equal(hero.notableItems.length, 1);
  assert.equal(hero.notableItems[0].name, "Wand of the War Mage, +1");
  assert.deepEqual(Array.from(hero.notableFeatures), ["War Caster", "Channel Divinity"]);
  assert.deepEqual(Array.from(hero.proficientSkills), ["Insight", "Perception (Exp)"]);

  // 2. Portable backup backfills missing sheetUrl on legacy numeric-ID B.U.G.S. sheets & preserves campaignMemory
  store.resetSession();
  store.upsertCharacter(
    {
      id: "44556677",
      name: "Lyra",
      classSummary: "Cleric 5",
      level: 5,
      hp: { current: 30, max: 38, temp: 0 },
      ac: 16,
      spellSlots: [{ level: 1, max: 4, used: 0, remaining: 4 }],
      spells: Array.from(hero.spells),
      notableItems: Array.from(hero.notableItems),
      notableFeatures: Array.from(hero.notableFeatures),
      proficientSkills: Array.from(hero.proficientSkills)
      // Notice sheetUrl intentionally omitted to simulate legacy backup!
    },
    { manualAdd: true }
  );
  // Force legacy missing sheetUrl in exported JSON before import
  const backup = JSON.parse(JSON.stringify(store.exportPortableBackup()));
  backup.partyGroups.groups["B.U.G.S."].characters[0].sheetUrl = "";
  backup.state.party[0].sheetUrl = "";

  store.addCampaignMemoryEntry({
    title: "Session 11 — Clockwork Vault",
    summary: "Brother Vane promised a silver passkey if the party returns the astrolabe gear.",
    keyNpcs: ["Brother Vane", "Magistrate Corin"],
    openQuests: ["Return astrolabe gear to Brother Vane"],
    clues: ["Passkey opens the bronze archive"],
    rawText: "DM: Brother Vane whispers that the astrolabe gear is hidden inside the clockwork vault."
  });
  const backupWithMemory = store.exportPortableBackup();
  assert.equal(backupWithMemory.campaignMemory.length, 1);

  const sbMac = createBrowserSandbox();
  sbMac.DnDCopilot.Store.importPortableBackup(backup);
  assert.equal(
    sbMac.DnDCopilot.Store.state.party[0].sheetUrl,
    "https://www.dndbeyond.com/characters/44556677"
  );
  sbMac.DnDCopilot.Store.importPortableBackup(backupWithMemory);
  assert.equal(sbMac.DnDCopilot.Store.campaignMemory.length, 1);

  // 3. Past context keyword matching + Exploration Live Ideas (Local + Mocked Groq)
  const storeMac = sbMac.DnDCopilot.Store;
  storeMac.addTranscriptLine(
    "DM",
    "You spot Brother Vane waiting near the bell tower asking about the astrolabe.",
    false
  );
  const pastCtx = storeMac.getRelevantPastContext(storeMac.state.transcript);
  assert.match(pastCtx, /Brother Vane/);
  assert.match(pastCtx, /Clockwork Vault/);

  storeMac.updateSettings({ aiProvider: "local-free" });
  storeMac.state.situation.sceneMode = "Social";
  const localAdv = await sbMac.DnDCopilot.LocalBrain.adviseTacticsAndSpells(storeMac, "");
  assert.match(localAdv.pastSessionConnection, /Brother Vane|Clockwork Vault/);
  assert.ok(localAdv.recommendations.length >= 2);
  assert.match(localAdv.recommendations[0].spellOrAction, /Insight|Persuasion/i);

  // Mocked Groq mode returns pastSessionConnection + ideas
  storeMac.updateSettings({ aiProvider: "groq", groqApiKey: "gsk_ideas_test" });
  sbMac.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tacticalOverview: "Brother Vane is testing whether you recovered his astrolabe.",
              concentrationWarning: "",
              pastSessionConnection:
                "From Session 11: Vane promised the silver passkey for the astrolabe gear.",
              recommendations: [
                {
                  rank: 1,
                  spellOrAction: "Ask Brother Vane about the silver passkey before handing anything over",
                  slotInfo: "Social Leverage · Free",
                  whyBest: "Verify he still intends to honor the Session 11 bargain."
                }
              ],
              customAnswer: ""
            })
          }
        }
      ]
    })
  });
  await sbMac.DnDCopilot.GeminiClient.adviseTacticsAndSpells(storeMac, "");
  assert.match(storeMac.state.advisor.pastSessionConnection, /silver passkey/);
  assert.match(storeMac.state.advisor.recommendations[0].spellOrAction, /silver passkey/);

  // 4. Bridge refreshAllPartySheets extracts ID from sheetUrl and refreshes stats cleanly
  const toasts = [];
  const bridge = new sbMac.DnDCopilot.AboveVttBridgeHost(storeMac, {
    onToast: (m) => toasts.push(m)
  });
  sbMac.fetch = async (url) => {
    assert.match(url, /characters?\/v5\/character\/44556677/);
    return {
      ok: true,
      json: async () => ({
        id: 44556677,
        name: "Lyra Whisperwind",
        baseHitPoints: 38,
        removedHitPoints: 3,
        stats: [
          { id: 1, value: 8 },
          { id: 2, value: 14 },
          { id: 3, value: 10 },
          { id: 4, value: 12 },
          { id: 5, value: 18 },
          { id: 6, value: 16 }
        ],
        classes: [{ id: 1, level: 5, definition: { name: "Cleric" } }]
      })
    };
  };
  const refreshRes = await bridge.refreshAllPartySheets(false);
  assert.equal(refreshRes.updated, 1);
  assert.equal(storeMac.state.party[0].hp.current, 35);
  assert.ok(toasts.some((t) => /Updated 1\/1 character sheet/i.test(t)));
});

test("DDBParser extracts inspiration and Live Speech auto-updates sheets with cursor dedupe, Undo, and smart DDB merge", async () => {
  const sb = createBrowserSandbox();
  const { parseCharacterJson } = sb.DnDCopilot.DDBParser;
  const store = sb.DnDCopilot.Store;
  const localBrain = sb.DnDCopilot.LocalBrain;

  // 1. Parse inspiration flag from DDB JSON
  const parsedInspired = parseCharacterJson({
    id: 777001,
    name: "Bone Hawk",
    inspiration: true,
    baseHitPoints: 48,
    removedHitPoints: 0,
    temporaryHitPoints: 0,
    stats: [
      { id: 1, value: 10 },
      { id: 2, value: 18 },
      { id: 3, value: 14 },
      { id: 4, value: 12 },
      { id: 5, value: 12 },
      { id: 6, value: 10 }
    ],
    classes: [{ id: 1, level: 6, definition: { name: "Rogue" } }]
  });
  assert.equal(parsedInspired.inspiration, true);

  store.resetSession();
  store.updateSettings({ aiProvider: "local-free", autoUpdatePartyFromTranscript: true });

  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 48, max: 48, temp: 0 },
      ac: 13,
      inspiration: false,
      conditions: [],
      spellSlots: [
        { level: 1, max: 4, used: 0, remaining: 4, isPact: false },
        { level: 2, max: 3, used: 0, remaining: 3, isPact: false },
        { level: 3, max: 3, used: 0, remaining: 3, isPact: false }
      ],
      spells: [
        { name: "Fireball", level: 3, concentration: false, ritual: false },
        { name: "Hold Person", level: 2, concentration: true, ritual: false },
        { name: "Detect Magic", level: 1, concentration: true, ritual: true },
        { name: "Mage Armor", level: 1, concentration: false, ritual: false },
        { name: "Fire Bolt", level: 0, concentration: false, ritual: false }
      ]
    },
    { manualAdd: true }
  );
  store.upsertCharacter(
    {
      id: "156978335",
      name: "Munder",
      classSummary: "Barbarian 6",
      level: 6,
      hp: { current: 60, max: 60, temp: 5 },
      ac: 16,
      inspiration: false,
      conditions: [],
      spellSlots: [],
      spells: []
    },
    { manualAdd: true }
  );
  store.upsertCharacter(parsedInspired, { manualAdd: true });
  assert.equal(store.state.party.find((p) => p.name === "Bone Hawk").inspiration, true);
  store.toggleInspiration("777001", false);
  store.setMyCharacter("141442264");

  // 2. Hypothetical brainstorming must NOT mutate sheets
  store.addTranscriptLine("Player", "Maybe I should cast Fireball next turn or should we take a long rest?", false);
  const sitHypo = await localBrain.analyzeTableSituation(store);
  assert.deepEqual(Array.from(sitHypo._appliedPartyUpdates || []), []);
  assert.equal(store.state.party[0].spellSlots[2].remaining, 3);

  // 3. Committed speech updates spells, damage (absorbing Temp HP), and Inspiration
  store.addTranscriptLine(
    "Table",
    "I cast Fireball and Munder takes 12 fire damage and Bone Hawk gains inspiration.",
    false
  );
  const sit1 = await localBrain.analyzeTableSituation(store);
  assert.equal(sit1._appliedPartyUpdates.length, 3);
  const raine = store.state.party.find((p) => p.name === "Raine");
  const munder = store.state.party.find((p) => p.name === "Munder");
  const boneHawk = store.state.party.find((p) => p.name === "Bone Hawk");

  assert.equal(raine.spellSlots[2].remaining, 2); // L3 slot deducted once
  assert.equal(munder.hp.temp, 0);
  assert.equal(munder.hp.current, 53); // 5 temp HP absorbed -> 7 net damage
  assert.equal(boneHawk.inspiration, true);

  // Running analyze again without new transcript lines must NOT double-count!
  const sitRepeat = await localBrain.analyzeTableSituation(store);
  assert.deepEqual(Array.from(sitRepeat._appliedPartyUpdates || []), []);
  assert.equal(raine.spellSlots[2].remaining, 2);
  assert.equal(munder.hp.current, 53);

  // 4. Undo cleanly reverts the batch
  assert.equal(store.undoLastAutoSheetBatch(), true);
  assert.equal(store.state.party.find((p) => p.name === "Raine").spellSlots[2].remaining, 3);
  assert.equal(store.state.party.find((p) => p.name === "Munder").hp.current, 60);
  assert.equal(store.state.party.find((p) => p.name === "Munder").hp.temp, 5);
  assert.equal(store.state.party.find((p) => p.name === "Bone Hawk").inspiration, false);

  // 5. Upcasting, Ritual (0 slot cost), Concentration, Rage, Heal, explicit Set HP
  store.addTranscriptLine(
    "Table",
    "Raine casts Detect Magic as a ritual. Raine casts Hold Person. Raine casts Mage Armor at 2nd level. Munder goes into a rage and heals for 6. Bone Hawk spends inspiration and is down to 20 HP.",
    false
  );
  await localBrain.analyzeTableSituation(store);
  const r2 = store.state.party.find((p) => p.name === "Raine");
  const m2 = store.state.party.find((p) => p.name === "Munder");
  const bh2 = store.state.party.find((p) => p.name === "Bone Hawk");

  assert.equal(r2.spellSlots[0].remaining, 4); // Detect Magic as Ritual saved L1 slot, Mage Armor upcast used L2
  assert.equal(r2.spellSlots[1].remaining, 1); // Hold Person (-1 L2) + Mage Armor at 2nd (-1 L2)
  assert.equal(r2.concentratingOn, "Hold Person");
  assert.ok(Array.from(m2.conditions).includes("Raging"));
  assert.equal(m2.hp.current, 60);
  assert.equal(bh2.inspiration, false);
  assert.equal(bh2.hp.current, 20);

  // 6. Smart DDB Merge: unchanged DDB poll preserves live voice-tracked changes; changed DDB wins; forceRemote resets
  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 48, max: 48, temp: 0 }, // same baseline as before!
      ac: 13,
      inspiration: false,
      conditions: [],
      spellSlots: [
        { level: 1, max: 4, used: 0, remaining: 4, isPact: false },
        { level: 2, max: 3, used: 0, remaining: 3, isPact: false },
        { level: 3, max: 3, used: 0, remaining: 3, isPact: false }
      ],
      spells: r2.spells
    },
    { forceRemote: false }
  );
  assert.equal(store.state.party.find((p) => p.name === "Raine").spellSlots[1].remaining, 1);

  // Changed DDB HP updates HP while unchanged slots stay preserved
  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 31, max: 48, temp: 0 },
      ac: 13,
      inspiration: false,
      conditions: [],
      spellSlots: [
        { level: 1, max: 4, used: 0, remaining: 4, isPact: false },
        { level: 2, max: 3, used: 0, remaining: 3, isPact: false },
        { level: 3, max: 3, used: 0, remaining: 3, isPact: false }
      ],
      spells: r2.spells
    },
    { forceRemote: false }
  );
  assert.equal(store.state.party.find((p) => p.name === "Raine").hp.current, 31);
  assert.equal(store.state.party.find((p) => p.name === "Raine").spellSlots[1].remaining, 1);

  // forceRemote: true resets live voice tracking to DDB values
  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 48, max: 48, temp: 0 },
      ac: 13,
      inspiration: false,
      conditions: [],
      spellSlots: [
        { level: 1, max: 4, used: 0, remaining: 4, isPact: false },
        { level: 2, max: 3, used: 0, remaining: 3, isPact: false },
        { level: 3, max: 3, used: 0, remaining: 3, isPact: false }
      ],
      spells: r2.spells
    },
    { forceRemote: true }
  );
  assert.equal(store.state.party.find((p) => p.name === "Raine").spellSlots[1].remaining, 3);

  // 7. Long rest restores everyone's HP, slots, and clears Rage/Concentration
  store.applyRest("141442264", "long_rest");
  store.addTranscriptLine("DM", "Everyone finishes a long rest safely at the inn.", false);
  await localBrain.analyzeTableSituation(store);
  assert.equal(store.state.party.find((p) => p.name === "Bone Hawk").hp.current, 60);
  assert.equal(Array.from(store.state.party.find((p) => p.name === "Munder").conditions).includes("Raging"), false);
});

test("GeminiClient applies AI partyUpdates and merges localhost Google Drive archive search into advice prompts", async () => {
  const sb = createBrowserSandbox();
  sb.location.hostname = "localhost";
  sb.location.href = "http://localhost:8765/index.html";
  const store = sb.DnDCopilot.Store;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.resetSession();
  store.updateSettings({ aiProvider: "groq", groqApiKey: "gsk_live_sheets" });
  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 48, max: 48, temp: 0 },
      ac: 13,
      spellSlots: [{ level: 3, max: 3, used: 0, remaining: 3, isPact: false }],
      spells: [{ name: "Fireball", level: 3, concentration: false, castingTime: "Action", range: "150 ft", summary: "20-ft radius fire" }]
    },
    { manualAdd: true }
  );
  store.addTranscriptLine("Raine", "I cast Fireball at Zorzula's Rest!", false);

  let capturedAdvisorPrompt = "";
  sb.fetch = async (url, opts) => {
    if (String(url).includes("/api/campaign-memory/search")) {
      return {
        ok: true,
        json: async () => ({
          contextText: "[Drive Matched Summary: BUGS 68] Gwen mentioned Zorzula's Rest under Phandalin's well."
        })
      };
    }
    const body = JSON.parse(opts.body);
    const userMsg = body.messages[1].content;
    if (userMsg.includes("partyUpdates")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sceneMode: "Combat",
                  headline: "Fireball hits near Zorzula's Rest",
                  summaryBullets: ["Raine unleashed Fireball."],
                  activeObjectives: [],
                  notableNpcs: ["Gwen"],
                  puzzleDetected: false,
                  puzzleTitle: "",
                  puzzleInscription: "",
                  newPuzzleClues: [],
                  observedEnemyNotes: [],
                  partyUpdates: [{ characterName: "Raine", eventType: "spell_cast", spellName: "Fireball", slotLevel: 3 }]
                })
              }
            }
          ]
        })
      };
    }
    capturedAdvisorPrompt = userMsg;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                tacticalOverview: "Good opening blast.",
                concentrationWarning: "",
                pastSessionConnection: "Connected to Zorzula's Rest under the well.",
                recommendations: [
                  { rank: 1, spellOrAction: "Hold Fire Bolt", slotInfo: "Cantrip", whyBest: "Save remaining slots." }
                ],
                customAnswer: ""
              })
            }
          }
        ]
      })
    };
  };

  const sit = await gemini.analyzeTableSituation(store);
  assert.equal(sit._appliedPartyUpdates.length, 1);
  assert.equal(store.state.party[0].spellSlots[0].remaining, 2);

  await gemini.adviseTacticsAndSpells(store, "What do we know about Zorzula?");
  assert.match(capturedAdvisorPrompt, /Zorzula's Rest/);
});

test("LocalBrain hides Concentration is FREE, Store ingests spoken combat, and Fast Play replays multi-act transcripts with proxy & fallback", async () => {
  const sb = createBrowserSandbox();
  sb.location.hostname = "localhost";
  sb.location.protocol = "http:";
  sb.location.href = "http://localhost:8765/index.html";
  const store = sb.DnDCopilot.Store;
  const localBrain = sb.DnDCopilot.LocalBrain;
  const gemini = sb.DnDCopilot.GeminiClient;

  store.resetSession();
  store.upsertCharacter(
    {
      id: "141442264",
      name: "Raine",
      classSummary: "Wizard 6",
      level: 6,
      hp: { current: 48, max: 48, temp: 0 },
      ac: 13,
      concentratingOn: "",
      spellSlots: [{ level: 3, max: 3, used: 0, remaining: 3, isPact: false }],
      spells: [
        {
          name: "Fireball",
          level: 3,
          concentration: false,
          castingTime: "Action",
          range: "150 ft",
          summary: "20-ft radius fire explosion"
        },
        {
          name: "Hold Person",
          level: 2,
          concentration: true,
          castingTime: "Action",
          range: "60 ft",
          summary: "Paralyze humanoid"
        }
      ]
    },
    { manualAdd: true }
  );

  // 1. No misleading "Concentration is FREE" when not concentrating; warns only when concentrating
  store.updateSettings({ aiProvider: "local-free" });
  const advFree = await localBrain.adviseTacticsAndSpells(store, "");
  assert.equal(advFree.concentrationWarning, "");

  store.setCharacterConcentration("141442264", "Hold Person");
  const advBusy = await localBrain.adviseTacticsAndSpells(store, "");
  assert.match(advBusy.concentrationWarning, /Hold Person/);
  store.setCharacterConcentration("141442264", "");

  // 2. Spoken combat ingestion creates/merges enemies & dedupes combat action feed
  store.ingestSpokenCombatState({
    inCombat: true,
    round: 2,
    detectedEnemies: [
      { name: "Psychic Goblin", damageDealt: 18, isBloodied: true, trait: "Psychic Burst", missRoll: 14, hitRoll: 17 }
    ],
    combatEvents: [
      { actor: "Raine", target: "Psychic Goblin", action: "Fireball", detail: "Dealt 18 fire damage", kind: "damage" },
      { actor: "Raine", target: "Psychic Goblin", action: "Fireball", detail: "Dealt 18 fire damage", kind: "damage" }
    ]
  });
  assert.equal(store.state.combat.enemies.length, 1);
  assert.equal(store.state.combat.enemies[0].damageTaken, 18);
  assert.equal(store.state.combat.enemies[0].highestMissRoll, 14);
  assert.equal(store.state.combat.enemies[0].lowestHitRoll, 17);
  assert.equal(store.state.combat.combatEvents.length, 1);

  // 3. Localhost proxy routing + Gemini -> Groq fallback + Fast Play multi-act replay
  const proxyUrls = [];
  store.updateSettings({
    aiProvider: "gemini",
    geminiApiKey: "AIza_test_proxy",
    groqApiKey: "gsk_fallback_key"
  });
  sb.fetch = async (url, opts) => {
    proxyUrls.push(String(url));
    if (String(url).includes("/api/campaign-memory/search")) {
      return { ok: true, json: async () => ({ contextText: "" }) };
    }
    if (String(url).includes("/api/proxy/gemini-interactions")) {
      return { ok: false, status: 503, json: async () => ({ error: { message: "Overloaded" } }) };
    }
    assert.match(String(url), /\/api\/proxy\/groq-chat/);
    const body = JSON.parse(opts.body);
    const sys = body.messages[0].content;
    if (sys.includes("partyUpdates")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sceneMode: "Combat",
                  location: "Goblin Camp",
                  headline: "B.U.G.S. ambush psychic goblins in the clearing",
                  summaryBullets: ["Raine scorched the goblins cleanly."],
                  activeObjectives: ["Subdue Scrap for answers"],
                  suggestedNextMoves: ["Ask the DM for an Arcana check on the green glow"],
                  notableNpcs: ["Scrap"],
                  puzzleDetected: true,
                  puzzleTitle: "Green Glow Black Stones",
                  puzzleInscription: "",
                  newPuzzleClues: ["Black stones glow with green psychic energy"],
                  observedEnemyNotes: [],
                  detectedEnemies: [
                    { name: "Psychic Goblin", damageDealt: 28, isBloodied: true, isDefeated: false, trait: "Green Eye Glow" }
                  ],
                  combatEvents: [
                    { actor: "Raine", target: "Psychic Goblin", action: "Fireball", detail: "Sculpted around allies", kind: "damage" }
                  ],
                  partyUpdates: [{ characterName: "Raine", eventType: "spell_cast", spellName: "Fireball", slotLevel: 3 }]
                })
              }
            }
          ]
        })
      };
    }
    if (sys.includes("hypotheses")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "Green Glow Black Stones",
                  promptOrInscription: "",
                  extractedClues: [],
                  hypotheses: [{ solution: "Duergar psionic resonance", confidence: "High", reasoning: "Matches underdark axes" }],
                  nextChecks: ["Ask DM for Arcana check on stones"]
                })
              }
            }
          ]
        })
      };
    }
    if (sys.includes("recommendations")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tacticalOverview: "Goblins broken; press Scrap for info.",
                  concentrationWarning: "",
                  pastSessionConnection: "",
                  recommendations: [
                    { rank: 1, spellOrAction: "Detect Thoughts or Insight", slotInfo: "L2 or Skill", whyBest: "Verify Scrap isn't bluffing." }
                  ],
                  customAnswer: ""
                })
              }
            }
          ]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                headline: "Ambush & Interrogation of Scrap",
                bullets: ["Party tracked goblins from Phandalin", "Defeated psychic ambushers and questioned Scrap"]
              })
            }
          }
        ]
      })
    };
  };

  const sampleRaw = [
    "[Speaker 1]\nWe follow the tracks from Phandalin into the clearing.",
    "[Speaker 2]\nRaine casts Fireball at the goblin camp!",
    "[Speaker 3]\nScrap surrenders and mentions Zorzula's Rest and the black stone."
  ].join("\n\n");
  const fpRes = await gemini.fastPlayTranscript(store, sampleRaw, { title: "BUGS 69 Test", acts: 2 });
  assert.equal(fpRes.actsProcessed, 1);
  assert.ok(proxyUrls.some((u) => u.includes("/api/proxy/gemini-interactions")));
  assert.ok(proxyUrls.some((u) => u.includes("/api/proxy/groq-chat")));
  assert.equal(store.state.situation.location, "Goblin Camp");
  assert.ok(store.state.situation.suggestedNextMoves.length >= 1);
  assert.equal(store.state.party[0].spellSlots[0].remaining, 2);
  assert.equal(store.state.combat.enemies[0].damageTaken, 28);
  assert.equal(store.state.advisor.concentrationWarning, "");
});
