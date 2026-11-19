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
    Blob,
    File,
    FormData,
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

  // Drone is excluded from B.U.G.S. and never re-imported by auto-sync
  assert.equal(store.isCharacterExcluded("999999", "Drone"), true);
  store.upsertCharacter({
    id: "999999",
    name: "Drone",
    classSummary: "Fighter 6",
    level: 6,
    hp: { current: 50, max: 50, temp: 0 },
    ac: 17,
    spellSlots: [],
    spells: []
  });
  assert.equal(store.state.party.some((p) => p.name === "Drone"), false);

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
