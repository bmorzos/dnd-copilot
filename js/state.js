/**
 * Reactive Session Store & Player-Fair Encounter/Puzzle State Manager.
 * Persists automatically to localStorage so refreshes never lose table progress.
 */
(function (global) {
  const STORAGE_KEY = "dnd_copilot_session_v1";
  const SETTINGS_KEY = "dnd_copilot_settings_v1";
  const PARTY_GROUPS_KEY = "dnd_copilot_party_groups_v1";
  const SAVED_TRANSCRIPTS_KEY = "dnd_copilot_saved_transcripts_v1";
  const CAMPAIGN_MEMORY_KEY = "dnd_copilot_campaign_memory_v1";
  const DEFAULT_PARTY_GROUP = "B.U.G.S.";
  const DEFAULT_BUGS_EXCLUDED_NAMES = ["drone", "thenoeght", "theno", "zahra"];
  const DEFAULT_BUGS_EXCLUDED_IDS = ["46609350", "154372629"];

  function isDemoCharId(id) {
    return String(id || "").startsWith("demo-");
  }

  function normalizeCharacterRecord(pc) {
    if (!pc || typeof pc !== "object") return pc;
    const rawUrl = String(pc.sheetUrl || pc.readonlyUrl || "").trim();
    const idStr = String(pc.id || "").trim();
    let sheetUrl = "";
    if (/^https?:\/\//i.test(rawUrl)) {
      sheetUrl = rawUrl;
    } else if (rawUrl.startsWith("/")) {
      sheetUrl = `https://www.dndbeyond.com${rawUrl}`;
    } else if (/^\d{4,12}$/.test(idStr)) {
      sheetUrl = `https://www.dndbeyond.com/characters/${idStr}`;
    }
    return {
      ...pc,
      sheetUrl,
      notableItems: Array.isArray(pc.notableItems) ? pc.notableItems : [],
      notableFeatures: Array.isArray(pc.notableFeatures) ? pc.notableFeatures : [],
      proficientSkills: Array.isArray(pc.proficientSkills) ? pc.proficientSkills : []
    };
  }

  const DEFAULT_SETTINGS = {
    aiProvider: "auto", // "auto" | "local-free" | "groq" | "gemini"
    groqApiKey: "",
    geminiApiKey: "",
    fastModel: "gemini-3.5-flash-lite",
    advisorModel: "gemini-3.8-flash",
    speechMode: "chrome", // "chrome" ($0 Web Speech API) | "groq" (Groq Whisper) | "deepgram" (Nova-3 Diarize)
    groqWhisperModel: "whisper-large-v3",
    deepgramApiKey: "",
    micDeviceId: "",
    rawRoomAudio: true,
    recordingBitrate: 96000,
    campaignGlossary: "",
    autoAnalyzeSeconds: 25,
    budgetCapUsd: 1.0,
    isFreeTierKey: false,
    autoSyncPartySheets: true,
    autoUpdateIdeas: true
  };

  function createFreshSession() {
    return {
      sessionTitle: "Live Table Session",
      myCharacterId: null,
      bridgeStatus: {
        mode: "disconnected", // "extension" | "bookmarklet" | "tab-share" | "disconnected"
        connectedPage: "",
        isAboveVttActive: false,
        lastHeartbeat: null
      },
      situation: {
        sceneMode: "Exploration", // "Exploration" | "Social" | "Puzzle" | "Combat"
        headline: "Waiting for table conversation or AboveVTT activity...",
        summaryBullets: [
          "Click 'Start Listening' to capture live table conversation.",
          "Connect AboveVTT (Extension or 1-Click Bookmarklet) to sync rolls, initiative, and party D&D Beyond sheets.",
          "Or click 'Load Demo' in the top bar to test every panel right now."
        ],
        activeObjectives: [],
        notableNpcs: [],
        lastUpdatedAt: null
      },
      sessionBeats: [],
      sessionSummary: null,
      transcript: [],
      puzzle: {
        isActive: false,
        title: "No Active Puzzle Detected Yet",
        promptOrInscription: "",
        clues: [],
        hypotheses: [],
        nextChecks: [],
        lastSolvedAt: null
      },
      combat: {
        inCombat: false,
        round: 1,
        activeTargetTokenId: null,
        enemies: [], // Player-fair enemy records: { tokenId, name, damageTaken, isBloodied, visibleHealthPercent, minAcMiss, maxAcHit, conditions, observedTraits, isDefeated, isCurrentTurn, initiative }
        initiativeOrder: []
      },
      gameLog: [],
      party: [],
      advisor: {
        recommendations: [],
        tacticalOverview: "",
        concentrationWarning: "",
        pastSessionConnection: "",
        customAnswer: "",
        lastAdvisedAt: null
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0,
        calls: 0
      }
    };
  }

  function buildDemoSession() {
    const now = Date.now();
    return {
      sessionTitle: "The Sunken Reliquary of Weeks (Demo)",
      myCharacterId: "demo-wizard-101",
      bridgeStatus: {
        mode: "bookmarklet",
        connectedPage: "AboveVTT — Sunken Reliquary Campaign",
        isAboveVttActive: true,
        lastHeartbeat: now
      },
      situation: {
        sceneMode: "Combat",
        headline: "Fighting two Ashen Guardians in a flooded puzzle chamber while a 3-brazier riddle blocks the vault door!",
        summaryBullets: [
          "The vault door reads: 'Feed first the flame that casts no shadow, second the tide that climbs the mountain, last the silence after thunder.'",
          "Ashen Guardian #1 has already taken 41 damage and visibly looks Bloodied; fire damage barely scorched its stone plating.",
          "Brynjar (Paladin) dropped to 14/52 HP holding the choke point; Lyra is concentrating on Bless for the party."
        ],
        activeObjectives: [
          "Survive & finish off Bloodied Ashen Guardian #1 before its next multiattack",
          "Light or activate the 3 elemental basins in the riddle's sequence (Bonus Action / Object Interaction)"
        ],
        notableNpcs: ["Vaelen the Blind Archivist (warned not to use fire on the guardians)"],
        lastUpdatedAt: now
      },
      transcript: [
        {
          id: "t1",
          timestamp: now - 240000,
          speaker: "DM",
          text: "Carved across the sealed bronze arch are three basins—one filled with mirror-glass, one with dry mist-salt, and one hollow bell—beneath the inscription: 'Feed first the flame that casts no shadow, second the tide that climbs the mountain, last the silence after thunder.'",
          pinnedAsClue: true
        },
        {
          id: "t2",
          timestamp: now - 170000,
          speaker: "Player (Kaelen)",
          text: "Wait—the moment I touched the wrong basin, those two stone statues wrenched off their plinths! Roll initiative!",
          pinnedAsClue: false
        },
        {
          id: "t3",
          timestamp: now - 95000,
          speaker: "DM",
          text: "Your Scorching Ray slams into Ashen Guardian #1, though the flames wash across the blackened rune-stone doing noticeably less than you hoped. A 16 missed its shield earlier, while Brynjar's 18 connected solidly—cracks are spiderwebbing across its chest now, it's bloodied!",
          pinnedAsClue: false
        },
        {
          id: "t4",
          timestamp: now - 35000,
          speaker: "Player (Brynjar)",
          text: "Oof, I just took 24 bludgeoning, I'm down to 14 HP! Kaelen, you're up next—can you lock them down or finish #1?",
          pinnedAsClue: false
        }
      ],
      puzzle: {
        isActive: true,
        title: "The Three Basins of the Bronze Arch",
        promptOrInscription:
          "\"Feed first the flame that casts no shadow, second the tide that climbs the mountain, last the silence after thunder.\"",
        clues: [
          "Three basins present: (1) Mirror-glass basin, (2) Dry mist-salt basin, (3) Hollow bronze bell basin.",
          "Inscription demands a strict 3-step sequence: first 'flame that casts no shadow', second 'tide that climbs the mountain', last 'silence after thunder'.",
          "Touching out of order triggered the Ashen Guardians."
        ],
        hypotheses: [
          {
            solution: "1st: Light/Illusion into Mirror-Glass → 2nd: Water/Fog into Mist-Salt → 3rd: Ring then muffle (or cast Silence/touch) the Hollow Bell",
            confidence: "High (88%)",
            reasoning:
              "Illusory light or Dancing Lights/Light in a mirror shines without fuel/shadow ('flame that casts no shadow'); mist/clouds rise up mountain slopes ('tide that climbs the mountain'); damping a struck bell creates 'the silence after thunder'."
          },
          {
            solution: "Metaphorical answers spoken aloud: Reflection / Cloud (Fog) / Echo",
            confidence: "Medium (55%)",
            reasoning:
              "Notice the verb is 'Feed' with physical basins, which favors placing matching elements/cantrips into each basin rather than speaking a password."
          }
        ],
        nextChecks: [
          "Ask DM if there are scorch marks, condensation, or a striker inside the three basins (Investigation / Arcana).",
          "Test casting Light or Minor Illusion into the mirror-glass basin first using an Action once immediate melee threat is stabilized."
        ],
        lastSolvedAt: now - 30000
      },
      combat: {
        inCombat: true,
        round: 3,
        activeTargetTokenId: "avtt-enemy-1",
        enemies: [
          {
            tokenId: "avtt-enemy-1",
            name: "Ashen Guardian #1",
            isNameRevealed: true,
            damageTaken: 41,
            isBloodied: true,
            visibleHealthPercent: null,
            highestMissRoll: 16,
            lowestHitRoll: 18,
            conditions: ["Bloodied"],
            observedTraits: ["Suspected Fire Resistance"],
            isDefeated: false,
            isCurrentTurn: false,
            initiative: 14
          },
          {
            tokenId: "avtt-enemy-2",
            name: "Ashen Guardian #2",
            isNameRevealed: true,
            damageTaken: 12,
            isBloodied: false,
            visibleHealthPercent: null,
            highestMissRoll: 15,
            lowestHitRoll: 19,
            conditions: [],
            observedTraits: ["Construct / Heavy Armor"],
            isDefeated: false,
            isCurrentTurn: false,
            initiative: 14
          }
        ],
        initiativeOrder: [
          { tokenId: "demo-wizard-101", name: "Kaelen Vance", initiative: 19, isPlayer: true, isCurrentTurn: true },
          { tokenId: "avtt-enemy-1", name: "Ashen Guardian #1", initiative: 14, isPlayer: false, isCurrentTurn: false },
          { tokenId: "avtt-enemy-2", name: "Ashen Guardian #2", initiative: 14, isPlayer: false, isCurrentTurn: false },
          { tokenId: "demo-paladin-102", name: "Brynjar Oathshield", initiative: 12, isPlayer: true, isCurrentTurn: false },
          { tokenId: "demo-cleric-103", name: "Lyra Dawnwhisper", initiative: 9, isPlayer: true, isCurrentTurn: false },
          { tokenId: "demo-warlock-104", name: "Nyx Shadowstep", initiative: 7, isPlayer: true, isCurrentTurn: false }
        ]
      },
      gameLog: [
        {
          fingerprint: "demo-1",
          timestamp: now - 130000,
          actor: "Kaelen Vance",
          action: "Scorching Ray",
          kind: "attack",
          total: 16,
          formula: "1d20+8",
          isCrit: false,
          isFumble: false,
          rawText: "Kaelen Vance rolled Scorching Ray To Hit: 16 (Miss vs Ashen Guardian #1)"
        },
        {
          fingerprint: "demo-2",
          timestamp: now - 110000,
          actor: "Brynjar Oathshield",
          action: "Warhammer",
          kind: "attack",
          total: 18,
          formula: "1d20+7",
          isCrit: false,
          isFumble: false,
          rawText: "Brynjar Oathshield rolled Warhammer To Hit: 18 (Hit!)"
        },
        {
          fingerprint: "demo-3",
          timestamp: now - 105000,
          actor: "Brynjar Oathshield",
          action: "Warhammer + Divine Smite",
          kind: "damage",
          total: 23,
          formula: "1d8+4+2d8",
          isCrit: false,
          isFumble: false,
          attributedTo: "Ashen Guardian #1",
          rawText: "Brynjar Oathshield rolled Damage: 23 radiant/bludgeoning"
        },
        {
          fingerprint: "demo-4",
          timestamp: now - 40000,
          actor: "Ashen Guardian #1",
          action: "Stone Slam",
          kind: "damage",
          total: 24,
          formula: "2d10+5",
          isCrit: false,
          isFumble: false,
          rawText: "Ashen Guardian #1 dealt 24 bludgeoning damage to Brynjar"
        }
      ],
      party: [
        {
          id: "demo-wizard-101",
          name: "Kaelen Vance",
          race: "High Elf",
          classSummary: "Wizard (Evocation) 6",
          level: 6,
          avatarUrl: "",
          sheetUrl: "https://www.dndbeyond.com/characters/101",
          hp: { current: 34, max: 38, temp: 0 },
          ac: 16,
          initiativeMod: 3,
          passivePerception: 14,
          proficiencyBonus: 3,
          spellSaveDc: 15,
          spellAttackBonus: 7,
          abilities: {
            str: { score: 8, mod: -1 },
            dex: { score: 16, mod: 3 },
            con: { score: 14, mod: 2 },
            int: { score: 18, mod: 4 },
            wis: { score: 12, mod: 1 },
            cha: { score: 10, mod: 0 }
          },
          conditions: ["Blessed (+1d4)"],
          concentratingOn: "",
          spellSlots: [
            { level: 1, max: 4, used: 2, remaining: 2, isPact: false },
            { level: 2, max: 3, used: 1, remaining: 2, isPact: false },
            { level: 3, max: 3, used: 1, remaining: 2, isPact: false }
          ],
          spells: [
            {
              id: 1,
              name: "Mind Sliver",
              level: 0,
              school: "Enchantment",
              castingTime: "Action",
              concentration: false,
              ritual: false,
              range: "60 ft",
              requiresAttack: false,
              requiresSave: true,
              saveAbility: "INT",
              damageTypes: ["psychic"],
              isHealing: false,
              summary: "INT save or 2d6 psychic damage and -1d4 on target's next saving throw before end of your next turn."
            },
            {
              id: 2,
              name: "Light",
              level: 0,
              school: "Evocation",
              castingTime: "Action",
              concentration: false,
              ritual: false,
              range: "Touch",
              requiresAttack: false,
              requiresSave: false,
              saveAbility: "",
              damageTypes: [],
              isHealing: false,
              summary: "Object sheds bright flameless light in a 20-foot radius."
            },
            {
              id: 3,
              name: "Shield",
              level: 1,
              school: "Abjuration",
              castingTime: "Reaction",
              concentration: false,
              ritual: false,
              range: "Self",
              requiresAttack: false,
              requiresSave: false,
              saveAbility: "",
              damageTypes: [],
              isHealing: false,
              summary: "+5 bonus to AC until the start of your next turn, including against the triggering attack."
            },
            {
              id: 4,
              name: "Magic Missile",
              level: 1,
              school: "Evocation",
              castingTime: "Action",
              concentration: false,
              ritual: false,
              range: "120 ft",
              requiresAttack: false,
              requiresSave: false,
              saveAbility: "",
              damageTypes: ["force"],
              isHealing: false,
              summary: "3 glowing darts auto-hit for 1d4+1 force damage each (+1 dart per slot level above 1st)."
            },
            {
              id: 5,
              name: "Vortex Warp",
              level: 2,
              school: "Conjuration",
              castingTime: "Action",
              concentration: false,
              ritual: false,
              range: "90 ft",
              requiresAttack: false,
              requiresSave: true,
              saveAbility: "CON",
              damageTypes: [],
              isHealing: false,
              summary: "Teleport a willing ally (like injured Brynjar!) or CON-save enemy up to 90 ft to an unoccupied space."
            },
            {
              id: 6,
              name: "Shatter",
              level: 2,
              school: "Evocation",
              castingTime: "Action",
              concentration: false,
              ritual: false,
              range: "60 ft",
              requiresAttack: false,
              requiresSave: true,
              saveAbility: "CON",
              damageTypes: ["thunder"],
              isHealing: false,
              summary: "10-ft radius CON save for 3d8 thunder damage; inorganic stone/metal creatures have DISADVANTAGE on the save!"
            },
            {
              id: 7,
              name: "Slow",
              level: 3,
              school: "Transmutation",
              castingTime: "Action",
              concentration: true,
              ritual: false,
              range: "120 ft",
              requiresAttack: false,
              requiresSave: true,
              saveAbility: "WIS",
              damageTypes: [],
              isHealing: false,
              summary: "Up to 6 targets make WIS save or -2 AC, no reactions, half speed, and maximum 1 attack per turn (shuts down Multiattack!)."
            },
            {
              id: 8,
              name: "Counterspell",
              level: 3,
              school: "Abjuration",
              castingTime: "Reaction",
              concentration: false,
              ritual: false,
              range: "60 ft",
              requiresAttack: false,
              requiresSave: false,
              saveAbility: "",
              damageTypes: [],
              isHealing: false,
              summary: "Interrupt a creature within 60 ft casting a spell."
            }
          ],
          deathSaves: { successes: 0, failures: 0 },
          lastSyncedAt: now
        },
        {
          id: "demo-paladin-102",
          name: "Brynjar Oathshield",
          race: "Mountain Dwarf",
          classSummary: "Paladin (Devotion) 6",
          level: 6,
          avatarUrl: "",
          sheetUrl: "https://www.dndbeyond.com/characters/102",
          hp: { current: 14, max: 52, temp: 0 },
          ac: 19,
          initiativeMod: 0,
          passivePerception: 11,
          proficiencyBonus: 3,
          spellSaveDc: 14,
          spellAttackBonus: 6,
          abilities: {
            str: { score: 18, mod: 4 },
            dex: { score: 10, mod: 0 },
            con: { score: 16, mod: 3 },
            int: { score: 10, mod: 0 },
            wis: { score: 12, mod: 1 },
            cha: { score: 16, mod: 3 }
          },
          conditions: ["Blessed (+1d4)"],
          concentratingOn: "",
          spellSlots: [
            { level: 1, max: 4, used: 3, remaining: 1, isPact: false },
            { level: 2, max: 2, used: 1, remaining: 1, isPact: false }
          ],
          spells: [],
          deathSaves: { successes: 0, failures: 0 },
          lastSyncedAt: now
        },
        {
          id: "demo-cleric-103",
          name: "Lyra Dawnwhisper",
          race: "Human",
          classSummary: "Cleric (Twilight) 6",
          level: 6,
          avatarUrl: "",
          sheetUrl: "https://www.dndbeyond.com/characters/103",
          hp: { current: 41, max: 45, temp: 6 },
          ac: 18,
          initiativeMod: 1,
          passivePerception: 17,
          proficiencyBonus: 3,
          spellSaveDc: 15,
          spellAttackBonus: 7,
          abilities: {
            str: { score: 14, mod: 2 },
            dex: { score: 12, mod: 1 },
            con: { score: 14, mod: 2 },
            int: { score: 10, mod: 0 },
            wis: { score: 18, mod: 4 },
            cha: { score: 12, mod: 1 }
          },
          conditions: ["Concentrating: Bless"],
          concentratingOn: "Bless",
          spellSlots: [
            { level: 1, max: 4, used: 2, remaining: 2, isPact: false },
            { level: 2, max: 3, used: 1, remaining: 2, isPact: false },
            { level: 3, max: 3, used: 1, remaining: 2, isPact: false }
          ],
          spells: [],
          deathSaves: { successes: 0, failures: 0 },
          lastSyncedAt: now
        },
        {
          id: "demo-warlock-104",
          name: "Nyx Shadowstep",
          race: "Tiefling",
          classSummary: "Warlock (Hexblade) 6",
          level: 6,
          avatarUrl: "",
          sheetUrl: "https://www.dndbeyond.com/characters/104",
          hp: { current: 39, max: 45, temp: 0 },
          ac: 16,
          initiativeMod: 2,
          passivePerception: 13,
          proficiencyBonus: 3,
          spellSaveDc: 15,
          spellAttackBonus: 7,
          abilities: {
            str: { score: 10, mod: 0 },
            dex: { score: 14, mod: 2 },
            con: { score: 14, mod: 2 },
            int: { score: 12, mod: 1 },
            wis: { score: 10, mod: 0 },
            cha: { score: 18, mod: 4 }
          },
          conditions: ["Blessed (+1d4)"],
          concentratingOn: "Hex",
          spellSlots: [{ level: 3, max: 2, used: 1, remaining: 1, isPact: true }],
          spells: [],
          deathSaves: { successes: 0, failures: 0 },
          lastSyncedAt: now
        }
      ],
      advisor: {
        tacticalOverview:
          "It is Kaelen's turn! Brynjar is critically low (14/52 HP) right before both Ashen Guardians act at Initiative 14, and you observed fire resistance + an AC of 17–18.",
        concentrationWarning:
          "You currently have Concentration FREE (unlike Lyra who is holding Bless).",
        recommendations: [
          {
            rank: 1,
            spellOrAction: "Shatter (2nd-level, Sculpt Spells around Brynjar)",
            slotInfo: "2nd-level slot (2/3 left) · Action · No Concentration",
            whyBest:
              "Bypasses their high 17–18 AC and suspected Fire Resistance! Because the Guardians are made of inorganic stone, Shatter forces DISADVANTAGE on their CON save for 3d8 thunder damage, potentially finishing Bloodied Guardian #1 while Evocation Sculpt Spells keeps Brynjar completely safe."
          },
          {
            rank: 2,
            spellOrAction: "Slow (3rd-level, Concentration)",
            slotInfo: "3rd-level slot (2/3 left) · Action · Concentration",
            whyBest:
              "Targets WIS (usually weak on stone constructs!), drops their AC from 17–18 to 15–16 for Brynjar & Nyx, strips Reactions so Brynjar can retreat safely, and restricts them to 1 attack per turn so Brynjar survives Initiative 14."
          },
          {
            rank: 3,
            spellOrAction: "Vortex Warp (2nd-level) on Brynjar + Keep 1st-level Shield Ready",
            slotInfo: "2nd-level slot · Action · No Concentration",
            whyBest:
              "Willing allies auto-succeed—instantly teleports 14-HP Brynjar out of melee range before both Guardians take their turns, forcing them to waste their actions Dashing."
          }
        ],
        customAnswer: "",
        lastAdvisedAt: now - 15000
      },
      usage: {
        inputTokens: 8420,
        outputTokens: 1150,
        estimatedUsd: 0.0089,
        calls: 3
      }
    };
  }

  class CopilotStore {
    constructor() {
      this.listeners = new Set();
      this.settings = this.#loadSettings();
      this.state = this.#loadSession();
      this.partyGroups = this.#loadPartyGroups();
      this.savedTranscripts = this.#loadSavedTranscripts();
      this.campaignMemory = this.#loadCampaignMemory();
      this.#bootstrapBugsPartyGroup();
      this.#hydrateFromExtensionStorage();
    }

    #loadPartyGroups() {
      const defaultBugs = () => ({
        name: DEFAULT_PARTY_GROUP,
        myCharacterId: null,
        characters: [],
        excludedIds: [...DEFAULT_BUGS_EXCLUDED_IDS],
        excludedNames: [...DEFAULT_BUGS_EXCLUDED_NAMES],
        updatedAt: Date.now()
      });
      try {
        const raw = localStorage.getItem(PARTY_GROUPS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.groups) {
            if (!parsed.groups[DEFAULT_PARTY_GROUP]) {
              parsed.groups[DEFAULT_PARTY_GROUP] = defaultBugs();
            } else {
              const bg = parsed.groups[DEFAULT_PARTY_GROUP];
              bg.excludedIds = Array.isArray(bg.excludedIds) ? bg.excludedIds : [];
              bg.excludedNames = Array.isArray(bg.excludedNames) ? bg.excludedNames : [];
              for (const exId of DEFAULT_BUGS_EXCLUDED_IDS) {
                if (!bg.excludedIds.includes(exId)) {
                  bg.excludedIds.push(exId);
                }
              }
              for (const exName of DEFAULT_BUGS_EXCLUDED_NAMES) {
                if (!bg.excludedNames.includes(exName)) {
                  bg.excludedNames.push(exName);
                }
              }
            }
            return parsed;
          }
        }
      } catch (_) {}
      return {
        activeGroupName: DEFAULT_PARTY_GROUP,
        groups: {
          [DEFAULT_PARTY_GROUP]: defaultBugs()
        }
      };
    }

    #loadSavedTranscripts() {
      try {
        const raw = localStorage.getItem(SAVED_TRANSCRIPTS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (_) {}
      return [];
    }

    #loadCampaignMemory() {
      try {
        const raw = localStorage.getItem(CAMPAIGN_MEMORY_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (_) {}
      return [];
    }

    isCharacterExcluded(charId, charName, groupName = null) {
      const gName =
        groupName ||
        (this.partyGroups.activeGroupName === "__demo__"
          ? DEFAULT_PARTY_GROUP
          : this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP);
      const grp = this.partyGroups.groups?.[gName];
      if (!grp) return false;
      const cleanId = String(charId || "").trim();
      const cleanName = String(charName || "").trim().toLowerCase();
      if (cleanId && Array.isArray(grp.excludedIds) && grp.excludedIds.includes(cleanId)) {
        return true;
      }
      if (cleanName && Array.isArray(grp.excludedNames)) {
        for (const ex of grp.excludedNames) {
          if (cleanName === ex || cleanName.startsWith(`${ex} `)) {
            return true;
          }
        }
      }
      return false;
    }

    #purgeExcludedFromGroupAndState() {
      let modified = false;
      for (const [gName, grp] of Object.entries(this.partyGroups.groups || {})) {
        if (!grp) continue;
        grp.excludedIds = Array.isArray(grp.excludedIds) ? grp.excludedIds : [];
        grp.excludedNames = Array.isArray(grp.excludedNames) ? grp.excludedNames : [];
        if (gName === DEFAULT_PARTY_GROUP) {
          for (const exId of DEFAULT_BUGS_EXCLUDED_IDS) {
            if (!grp.excludedIds.includes(exId)) {
              grp.excludedIds.push(exId);
              modified = true;
            }
          }
          for (const exName of DEFAULT_BUGS_EXCLUDED_NAMES) {
            if (!grp.excludedNames.includes(exName)) {
              grp.excludedNames.push(exName);
              modified = true;
            }
          }
        }
        if (Array.isArray(grp.characters)) {
          const before = grp.characters.length;
          grp.characters = grp.characters.filter(
            (c) => !this.isCharacterExcluded(c.id, c.name, gName)
          );
          if (grp.characters.length !== before) {
            if (!grp.characters.some((c) => String(c.id) === String(grp.myCharacterId))) {
              grp.myCharacterId = grp.characters[0]?.id || null;
            }
            grp.updatedAt = Date.now();
            modified = true;
          }
        }
      }

      if (this.partyGroups.activeGroupName !== "__demo__" && Array.isArray(this.state.party)) {
        const activeName = this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
        const beforeParty = this.state.party.length;
        this.state.party = this.state.party.filter(
          (c) => !this.isCharacterExcluded(c.id, c.name, activeName)
        );
        if (this.state.party.length !== beforeParty) {
          if (!this.state.party.some((c) => String(c.id) === String(this.state.myCharacterId))) {
            this.state.myCharacterId = this.state.party[0]?.id || null;
          }
          modified = true;
        }
      }
      return modified;
    }

    #normalizeAllCharacterRecords() {
      if (Array.isArray(this.state.party)) {
        this.state.party = this.state.party.map(normalizeCharacterRecord);
      }
      for (const grp of Object.values(this.partyGroups.groups || {})) {
        if (grp && Array.isArray(grp.characters)) {
          grp.characters = grp.characters.map(normalizeCharacterRecord);
        }
      }
    }

    #bootstrapBugsPartyGroup() {
      this.#purgeExcludedFromGroupAndState();
      this.#normalizeAllCharacterRecords();
      const realCurrent = (this.state.party || []).filter((p) => !isDemoCharId(p.id));
      const bugsGroup = this.partyGroups.groups[DEFAULT_PARTY_GROUP];

      if (realCurrent.length > 0 && (!bugsGroup.characters || bugsGroup.characters.length === 0)) {
        bugsGroup.characters = JSON.parse(JSON.stringify(realCurrent));
        bugsGroup.myCharacterId = !isDemoCharId(this.state.myCharacterId)
          ? this.state.myCharacterId
          : realCurrent[0]?.id || null;
        bugsGroup.updatedAt = Date.now();
        this.partyGroups.activeGroupName = DEFAULT_PARTY_GROUP;
        this.#persistPartyGroups();
      } else if (
        this.state.party.length === 0 &&
        this.partyGroups.activeGroupName !== "__demo__"
      ) {
        const active =
          this.partyGroups.groups[this.partyGroups.activeGroupName] || bugsGroup;
        if (active?.characters?.length > 0) {
          this.state.party = JSON.parse(JSON.stringify(active.characters));
          this.state.myCharacterId = active.myCharacterId || this.state.party[0]?.id || null;
        }
      }
      this.#persistPartyGroups();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (_) {}
    }

    #hydrateFromExtensionStorage() {
      const extStorage = global.chrome?.storage?.local;
      if (!extStorage || typeof extStorage.get !== "function") return;

      extStorage.get(
        [PARTY_GROUPS_KEY, SAVED_TRANSCRIPTS_KEY, CAMPAIGN_MEMORY_KEY, STORAGE_KEY],
        (res) => {
          if (!res) return;
          let changed = false;

          if (res[PARTY_GROUPS_KEY]?.groups) {
            const extGroups = res[PARTY_GROUPS_KEY];
            for (const [gName, gVal] of Object.entries(extGroups.groups)) {
              const localGroup = this.partyGroups.groups[gName];
              if (
                !localGroup ||
                ((gVal.updatedAt || 0) > (localGroup.updatedAt || 0) &&
                  (localGroup.characters?.length || 0) === 0)
              ) {
                this.partyGroups.groups[gName] = gVal;
                changed = true;
              }
            }
            if (this.#purgeExcludedFromGroupAndState()) {
              changed = true;
            }
            this.#normalizeAllCharacterRecords();
            const active = this.partyGroups.groups[this.partyGroups.activeGroupName];
            if (this.state.party.length === 0 && active?.characters?.length > 0) {
              this.state.party = JSON.parse(JSON.stringify(active.characters));
              this.state.myCharacterId = active.myCharacterId || this.state.party[0]?.id || null;
              changed = true;
            }
            this.#persistPartyGroups();
          } else {
            this.#persistPartyGroups();
          }

          if (
            Array.isArray(res[SAVED_TRANSCRIPTS_KEY]) &&
            res[SAVED_TRANSCRIPTS_KEY].length > this.savedTranscripts.length
          ) {
            this.savedTranscripts = res[SAVED_TRANSCRIPTS_KEY];
            changed = true;
          }

          if (
            Array.isArray(res[CAMPAIGN_MEMORY_KEY]) &&
            res[CAMPAIGN_MEMORY_KEY].length > this.campaignMemory.length
          ) {
            this.campaignMemory = res[CAMPAIGN_MEMORY_KEY];
            changed = true;
          }

          if (changed) this.save();
        }
      );
    }

    #persistPartyGroups() {
      try {
        localStorage.setItem(PARTY_GROUPS_KEY, JSON.stringify(this.partyGroups));
      } catch (_) {}
      try {
        global.chrome?.storage?.local?.set({ [PARTY_GROUPS_KEY]: this.partyGroups });
      } catch (_) {}
    }

    #persistSavedTranscripts() {
      try {
        localStorage.setItem(SAVED_TRANSCRIPTS_KEY, JSON.stringify(this.savedTranscripts));
      } catch (_) {}
      try {
        global.chrome?.storage?.local?.set({ [SAVED_TRANSCRIPTS_KEY]: this.savedTranscripts });
      } catch (_) {}
    }

    #persistCampaignMemory() {
      try {
        localStorage.setItem(CAMPAIGN_MEMORY_KEY, JSON.stringify(this.campaignMemory));
      } catch (_) {}
      try {
        global.chrome?.storage?.local?.set({ [CAMPAIGN_MEMORY_KEY]: this.campaignMemory });
      } catch (_) {}
    }

    #syncActivePartyGroup() {
      const gName = this.partyGroups.activeGroupName;
      if (!gName || gName === "__demo__") return;
      const prev = this.partyGroups.groups[gName] || {};
      const realChars = (this.state.party || [])
        .filter((p) => !isDemoCharId(p.id))
        .map(normalizeCharacterRecord);
      this.partyGroups.groups[gName] = {
        name: gName,
        myCharacterId: !isDemoCharId(this.state.myCharacterId)
          ? this.state.myCharacterId
          : realChars[0]?.id || null,
        characters: JSON.parse(JSON.stringify(realChars)),
        excludedIds: Array.isArray(prev.excludedIds) ? prev.excludedIds : [],
        excludedNames: Array.isArray(prev.excludedNames) ? prev.excludedNames : [],
        updatedAt: Date.now()
      };
      this.#persistPartyGroups();
    }

    #loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        }
      } catch (_) {}
      return { ...DEFAULT_SETTINGS };
    }

    #loadSession() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const fresh = createFreshSession();
          return {
            ...fresh,
            ...parsed,
            bridgeStatus: { ...fresh.bridgeStatus, ...(parsed.bridgeStatus || {}) },
            situation: { ...fresh.situation, ...(parsed.situation || {}) },
            sessionBeats: Array.isArray(parsed.sessionBeats) ? parsed.sessionBeats : [],
            sessionSummary:
              parsed.sessionSummary && typeof parsed.sessionSummary === "object"
                ? parsed.sessionSummary
                : null,
            puzzle: { ...fresh.puzzle, ...(parsed.puzzle || {}) },
            combat: { ...fresh.combat, ...(parsed.combat || {}) },
            advisor: { ...fresh.advisor, ...(parsed.advisor || {}) },
            usage: { ...fresh.usage, ...(parsed.usage || {}) }
          };
        }
      } catch (_) {}
      return createFreshSession();
    }

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      } catch (_) {}
      try {
        global.chrome?.storage?.local?.set({
          [STORAGE_KEY]: this.state,
          [SETTINGS_KEY]: this.settings
        });
      } catch (_) {}
      this.notify();
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    notify() {
      for (const fn of this.listeners) {
        try {
          fn(this.state, this.settings);
        } catch (err) {
          console.error("Store listener error:", err);
        }
      }
    }

    updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      this.save();
    }

    resetSession() {
      this.state = createFreshSession();
      // Always restore the active saved party group (e.g., B.U.G.S.) so sheets stay saved!
      const gName =
        this.partyGroups.activeGroupName === "__demo__"
          ? DEFAULT_PARTY_GROUP
          : this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
      this.partyGroups.activeGroupName = gName;
      const savedGroup = this.partyGroups.groups[gName];
      if (savedGroup?.characters?.length > 0) {
        this.state.party = JSON.parse(JSON.stringify(savedGroup.characters));
        this.state.myCharacterId = savedGroup.myCharacterId || this.state.party[0]?.id || null;
      }
      this.#persistPartyGroups();
      this.save();
    }

    loadDemo() {
      // Save any real sheets into B.U.G.S. first so Demo never loses them!
      if (this.partyGroups.activeGroupName !== "__demo__") {
        const realCurrent = (this.state.party || []).filter((p) => !isDemoCharId(p.id));
        if (realCurrent.length > 0) {
          this.#syncActivePartyGroup();
        }
      }
      this.partyGroups.activeGroupName = "__demo__";
      this.state = buildDemoSession();
      this.#persistPartyGroups();
      this.save();
    }

    getPartyGroupNames() {
      const names = Object.keys(this.partyGroups.groups || {});
      if (!names.includes(DEFAULT_PARTY_GROUP)) names.unshift(DEFAULT_PARTY_GROUP);
      return names;
    }

    getActivePartyGroupName() {
      return this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
    }

    saveCurrentPartyAsGroup(groupName) {
      const cleanName = String(groupName || "").trim() || DEFAULT_PARTY_GROUP;
      const realChars = (this.state.party || []).filter((p) => !isDemoCharId(p.id));
      this.partyGroups.activeGroupName = cleanName;
      this.partyGroups.groups[cleanName] = {
        name: cleanName,
        myCharacterId: !isDemoCharId(this.state.myCharacterId)
          ? this.state.myCharacterId
          : realChars[0]?.id || null,
        characters: JSON.parse(JSON.stringify(realChars)),
        updatedAt: Date.now()
      };
      this.state.party = JSON.parse(JSON.stringify(realChars));
      this.state.myCharacterId = this.partyGroups.groups[cleanName].myCharacterId;
      this.#persistPartyGroups();
      this.save();
      return cleanName;
    }

    switchPartyGroup(groupName) {
      const cleanName = String(groupName || "").trim();
      if (!cleanName || !this.partyGroups.groups[cleanName]) return;
      this.partyGroups.activeGroupName = cleanName;
      const target = this.partyGroups.groups[cleanName];
      this.state.party = JSON.parse(JSON.stringify(target.characters || []));
      this.state.myCharacterId = target.myCharacterId || this.state.party[0]?.id || null;
      this.#persistPartyGroups();
      this.save();
    }

    getVocabularyTerms() {
      const seen = new Set();
      const terms = [];
      const addTerm = (raw) => {
        const clean = String(raw || "").trim();
        if (!clean || /^unidentified\s+foe/i.test(clean)) return;
        const key = clean.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        terms.push(clean);
      };

      const glossaryRaw = String(this.settings?.campaignGlossary || "");
      for (const part of glossaryRaw.split(/[,\n;]+/)) {
        addTerm(part);
      }
      for (const pc of this.state.party || []) {
        addTerm(pc?.name);
      }
      for (const npc of this.state.situation?.notableNpcs || []) {
        addTerm(npc);
      }
      for (const enemy of this.state.combat?.enemies || []) {
        addTerm(enemy?.name);
      }
      return terms;
    }

    recordSessionBeat(situation) {
      const sit = situation || this.state.situation;
      const headline = String(sit?.headline || "").trim();
      if (
        !headline ||
        /^waiting for table conversation/i.test(headline) ||
        /^listening for table conversation/i.test(headline)
      ) {
        return false;
      }

      if (!Array.isArray(this.state.sessionBeats)) {
        this.state.sessionBeats = [];
      }

      const sceneMode = String(sit?.sceneMode || "Exploration");
      const summary = Array.isArray(sit?.summaryBullets)
        ? sit.summaryBullets.filter(Boolean).join(" ").trim()
        : "";
      const now = Date.now();
      const last = this.state.sessionBeats[this.state.sessionBeats.length - 1];

      if (last && last.headline === headline) {
        return false;
      }

      const elapsed = last ? now - (last.timestamp || 0) : Infinity;
      const shouldAppend =
        !last ||
        last.sceneMode !== sceneMode ||
        elapsed >= 10 * 60 * 1000 ||
        (elapsed >= 4 * 60 * 1000 && last.headline !== headline);

      if (!shouldAppend) return false;

      this.state.sessionBeats.push({
        timestamp: now,
        sceneMode,
        headline,
        summary
      });

      if (this.state.sessionBeats.length > 60) {
        this.state.sessionBeats = this.state.sessionBeats.slice(-60);
      }
      return true;
    }

    setSessionSummary(summaryObj) {
      if (!summaryObj || typeof summaryObj !== "object") return null;
      const clean = {
        headline: String(summaryObj.headline || "").trim(),
        bullets: Array.isArray(summaryObj.bullets)
          ? summaryObj.bullets.map((b) => String(b || "").trim()).filter(Boolean)
          : [],
        generatedAt: Date.now()
      };
      this.state.sessionSummary = clean;
      this.save();
      return clean;
    }

    replaceTranscriptLines(newLines) {
      const arr = Array.isArray(newLines) ? newLines : [];
      const base = Date.now();
      const mapped = [];
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        const cleanText = String(item?.text || "").trim();
        if (!cleanText) continue;
        mapped.push({
          id: `tr-${base}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Number(item?.timestamp) || base + i * 1000,
          speaker: String(item?.speaker || "Recording").trim() || "Recording",
          text: cleanText,
          pinnedAsClue: Boolean(item?.pinnedAsClue)
        });
      }
      this.state.transcript = mapped.slice(-20000);
      this.save();
      return this.state.transcript;
    }

    hasStaleTranscriptGap(thresholdMs = 2 * 60 * 60 * 1000) {
      const lines = this.state.transcript || [];
      if (lines.length === 0) {
        return { isStale: false, gapMinutes: 0, lineCount: 0, lastTimestamp: null };
      }
      const last = lines[lines.length - 1];
      const lastTs = Number(last?.timestamp || 0);
      if (!lastTs) {
        return { isStale: false, gapMinutes: 0, lineCount: lines.length, lastTimestamp: null };
      }
      const gapMs = Math.max(0, Date.now() - lastTs);
      return {
        isStale: gapMs >= thresholdMs,
        gapMinutes: Math.round(gapMs / 60000),
        lineCount: lines.length,
        lastTimestamp: lastTs
      };
    }

    addTranscriptLine(speaker, text, pinnedAsClue = false) {
      const clean = String(text || "").trim();
      if (!clean) return null;
      const entry = {
        id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        speaker: speaker || "Table",
        text: clean,
        pinnedAsClue
      };
      this.state.transcript.push(entry);
      // Allow full 10+ hour D&D sessions without losing lines
      if (this.state.transcript.length > 20000) {
        this.state.transcript = this.state.transcript.slice(-20000);
      }
      if (pinnedAsClue) {
        this.addPuzzleClue(clean);
      } else {
        this.save();
      }
      return entry;
    }

    archiveCurrentTranscript(customTitle = "") {
      if (!this.state.transcript || this.state.transcript.length === 0) {
        throw new Error("No transcript lines to save yet.");
      }
      const now = new Date();
      const stampLabel = now.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
      const partyName =
        this.partyGroups.activeGroupName === "__demo__"
          ? "Demo"
          : this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
      const item = {
        id: `saved-tr-${Date.now()}`,
        title: customTitle.trim() || `${partyName} Session — ${stampLabel}`,
        savedAt: Date.now(),
        partyGroup: partyName,
        headline: this.state.situation?.headline || "",
        summaryBullets: [...(this.state.situation?.summaryBullets || [])],
        sessionBeats: JSON.parse(JSON.stringify(this.state.sessionBeats || [])),
        sessionSummary: this.state.sessionSummary
          ? JSON.parse(JSON.stringify(this.state.sessionSummary))
          : null,
        clues: [...(this.state.puzzle?.clues || [])],
        lines: JSON.parse(JSON.stringify(this.state.transcript))
      };
      this.savedTranscripts.unshift(item);
      if (this.savedTranscripts.length > 50) {
        this.savedTranscripts = this.savedTranscripts.slice(0, 50);
      }
      this.#persistSavedTranscripts();
      this.notify();
      return item;
    }

    exportPortableBackup() {
      this.#normalizeAllCharacterRecords();
      this.#syncActivePartyGroup();
      return {
        version: 4,
        exportedAt: Date.now(),
        settings: this.settings,
        partyGroups: this.partyGroups,
        savedTranscripts: this.savedTranscripts,
        campaignMemory: this.campaignMemory,
        state: this.state
      };
    }

    importPortableBackup(payload) {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid backup file.");
      }
      if (payload.settings && typeof payload.settings === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...this.settings, ...payload.settings };
      }
      if (payload.partyGroups?.groups) {
        this.partyGroups = payload.partyGroups;
      }
      if (Array.isArray(payload.savedTranscripts)) {
        this.savedTranscripts = payload.savedTranscripts;
      }
      if (Array.isArray(payload.campaignMemory)) {
        this.campaignMemory = payload.campaignMemory;
      }
      const incomingState = payload.state || (payload.party ? payload : null);
      if (incomingState) {
        const fresh = createFreshSession();
        this.state = {
          ...fresh,
          ...incomingState,
          bridgeStatus: { ...fresh.bridgeStatus, ...(incomingState.bridgeStatus || {}) },
          situation: { ...fresh.situation, ...(incomingState.situation || {}) },
          sessionBeats: Array.isArray(incomingState.sessionBeats) ? incomingState.sessionBeats : [],
          sessionSummary:
            incomingState.sessionSummary && typeof incomingState.sessionSummary === "object"
              ? incomingState.sessionSummary
              : null,
          puzzle: { ...fresh.puzzle, ...(incomingState.puzzle || {}) },
          combat: { ...fresh.combat, ...(incomingState.combat || {}) },
          advisor: { ...fresh.advisor, ...(incomingState.advisor || {}) }
        };
      }
      this.#purgeExcludedFromGroupAndState();
      this.#normalizeAllCharacterRecords();

      // If imported state.party is empty or demo-only while active group has real sheets, hydrate from active group
      const activeName =
        this.partyGroups.activeGroupName === "__demo__"
          ? DEFAULT_PARTY_GROUP
          : this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
      const activeGroup = this.partyGroups.groups?.[activeName];
      const hasOnlyDemoOrEmpty =
        !Array.isArray(this.state.party) ||
        this.state.party.length === 0 ||
        this.state.party.every((p) => isDemoCharId(p.id));
      if (hasOnlyDemoOrEmpty && activeGroup?.characters?.length > 0) {
        this.partyGroups.activeGroupName = activeName;
        this.state.party = JSON.parse(JSON.stringify(activeGroup.characters));
        this.state.myCharacterId = activeGroup.myCharacterId || this.state.party[0]?.id || null;
      }

      this.#syncActivePartyGroup();
      this.#persistSavedTranscripts();
      this.#persistCampaignMemory();
      this.save();
    }

    addCampaignMemoryEntry({
      title,
      summary = "",
      keyNpcs = [],
      openQuests = [],
      clues = [],
      rawText = "",
      dateLabel = ""
    }) {
      const cleanTitle = String(title || "").trim() || `Session Note (${new Date().toLocaleDateString()})`;
      const entry = {
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: cleanTitle,
        dateLabel: String(dateLabel || "").trim() || new Date().toLocaleDateString(),
        summary: String(summary || "").trim(),
        keyNpcs: Array.isArray(keyNpcs) ? keyNpcs.map((x) => String(x || "").trim()).filter(Boolean) : [],
        openQuests: Array.isArray(openQuests) ? openQuests.map((x) => String(x || "").trim()).filter(Boolean) : [],
        clues: Array.isArray(clues) ? clues.map((x) => String(x || "").trim()).filter(Boolean) : [],
        rawText: String(rawText || "").slice(0, 60000),
        enabled: true,
        createdAt: Date.now()
      };
      this.campaignMemory = this.campaignMemory.filter(
        (m) => m.title.toLowerCase() !== cleanTitle.toLowerCase()
      );
      this.campaignMemory.unshift(entry);
      if (this.campaignMemory.length > 40) {
        this.campaignMemory = this.campaignMemory.slice(0, 40);
      }
      this.#persistCampaignMemory();
      this.notify();
      return entry;
    }

    toggleCampaignMemoryEntry(id) {
      const found = this.campaignMemory.find((m) => m.id === id);
      if (!found) return;
      found.enabled = !found.enabled;
      this.#persistCampaignMemory();
      this.notify();
    }

    deleteCampaignMemoryEntry(id) {
      this.campaignMemory = this.campaignMemory.filter((m) => m.id !== id);
      this.#persistCampaignMemory();
      this.notify();
    }

    updateCharacterSheetUrl(charId, newUrl) {
      const pc = this.state.party.find((p) => String(p.id) === String(charId));
      if (!pc) return null;
      const raw = String(newUrl || "").trim();
      const idMatch = raw.match(/characters\/(\d{4,12})/i) || raw.match(/^(\d{4,12})$/);
      const resolvedUrl = idMatch
        ? `https://www.dndbeyond.com/characters/${idMatch[1]}`
        : /^https?:\/\//i.test(raw)
        ? raw
        : raw.startsWith("/")
        ? `https://www.dndbeyond.com${raw}`
        : "";
      if (!resolvedUrl) return null;

      pc.sheetUrl = resolvedUrl;
      if (idMatch && !/^\d{4,12}$/.test(String(pc.id))) {
        const oldId = pc.id;
        pc.id = idMatch[1];
        if (String(this.state.myCharacterId) === String(oldId)) {
          this.state.myCharacterId = pc.id;
        }
      }
      this.#syncActivePartyGroup();
      this.save();
      return pc;
    }

    getRelevantPastContext(recentTranscriptLines = []) {
      const lines = Array.isArray(recentTranscriptLines)
        ? recentTranscriptLines
        : this.state.transcript.slice(-12);
      const recentText = lines.map((l) => (typeof l === "string" ? l : l?.text || "")).join(" ");

      const enabledMemories = (this.campaignMemory || []).filter((m) => m.enabled !== false);
      const seenTitles = new Set(enabledMemories.map((m) => String(m.title || "").toLowerCase()));

      const recentSaved = (this.savedTranscripts || [])
        .filter((s) => s && !seenTitles.has(String(s.title || "").toLowerCase()))
        .slice(0, 6)
        .map((s) => ({
          title: s.title,
          summary:
            s.sessionSummary?.headline ||
            (s.sessionSummary?.bullets || []).slice(0, 2).join(" ") ||
            s.headline ||
            (s.summaryBullets || []).slice(0, 2).join(" "),
          keyNpcs: [],
          openQuests: [],
          clues: s.clues || [],
          rawText: (s.lines || []).map((l) => `${l.speaker}: ${l.text}`).join("\n")
        }));

      const combined = [...enabledMemories, ...recentSaved];
      if (combined.length === 0) return "";

      const summaryBlocks = combined.slice(0, 10).map((m) => {
        const parts = [`[Past Session: ${m.title}]`];
        if (m.summary) parts.push(`Summary: ${m.summary}`);
        if (m.keyNpcs?.length) parts.push(`NPCs: ${m.keyNpcs.slice(0, 8).join(", ")}`);
        if (m.openQuests?.length) parts.push(`Open Quests: ${m.openQuests.slice(0, 5).join("; ")}`);
        if (m.clues?.length) parts.push(`Clues: ${m.clues.slice(0, 5).join("; ")}`);
        return parts.join(" | ");
      });

      // Extract candidate keywords (capitalized words / >=5 char words) from live scene to match history
      const stopWords = new Set([
        "about", "after", "again", "against", "around", "because", "before", "being", "between",
        "could", "should", "would", "there", "these", "those", "their", "where", "which", "while",
        "going", "table", "recording", "check", "damage", "attack", "spell", "magic", "level",
        "rolled", "initiative", "saving", "throw", "action", "bonus"
      ]);
      const keywords = new Set();
      const capMatches = recentText.match(/\b[A-Z][a-z]{2,20}\b/g) || [];
      for (const w of capMatches) {
        const low = w.toLowerCase();
        if (!stopWords.has(low)) keywords.add(low);
      }
      const longWords = recentText.toLowerCase().match(/\b[a-z]{5,20}\b/g) || [];
      for (const w of longWords) {
        if (!stopWords.has(w)) keywords.add(w);
      }

      const quoteSnippets = [];
      if (keywords.size > 0) {
        const kwList = Array.from(keywords).slice(0, 35);
        for (const m of combined) {
          const raw = String(m.rawText || "").trim();
          if (!raw) continue;
          const sentences = raw.split(/\n+|(?<=[.!?])\s+/);
          for (const sent of sentences) {
            const cleanSent = sent.trim();
            if (cleanSent.length < 18 || cleanSent.length > 260) continue;
            const lowSent = cleanSent.toLowerCase();
            if (kwList.some((kw) => lowSent.includes(kw))) {
              quoteSnippets.push(`[Past: ${m.title}] "${cleanSent}"`);
              if (quoteSnippets.length >= 6) break;
            }
          }
          if (quoteSnippets.length >= 6) break;
        }
      }

      return [
        ...summaryBlocks,
        ...(quoteSnippets.length > 0 ? ["Relevant Past Session Details:", ...quoteSnippets] : [])
      ].join("\n");
    }

    deleteSavedTranscript(id) {
      this.savedTranscripts = this.savedTranscripts.filter((t) => t.id !== id);
      this.#persistSavedTranscripts();
      this.notify();
    }

    formatTranscriptText(archivedItem = null) {
      const title =
        archivedItem?.title ||
        `${
          this.partyGroups.activeGroupName === "__demo__"
            ? "Demo"
            : this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP
        } — D&D Session Transcript (${new Date().toLocaleDateString()})`;
      const headline = archivedItem
        ? archivedItem.headline
        : this.state.situation?.headline || "";
      const bullets = archivedItem
        ? archivedItem.summaryBullets || []
        : this.state.situation?.summaryBullets || [];
      const sessionSummary = archivedItem
        ? archivedItem.sessionSummary || null
        : this.state.sessionSummary || null;
      const sessionBeats = archivedItem
        ? archivedItem.sessionBeats || []
        : this.state.sessionBeats || [];
      const clues = archivedItem ? archivedItem.clues || [] : this.state.puzzle?.clues || [];
      const lines = archivedItem ? archivedItem.lines || [] : this.state.transcript || [];

      const out = [`# ${title}`, ""];
      if (sessionSummary && (sessionSummary.headline || (sessionSummary.bullets || []).length > 0)) {
        out.push(`## Session Summary: ${sessionSummary.headline || headline || title}`);
        for (const b of sessionSummary.bullets || []) out.push(`- ${b}`);
        out.push("");
      } else if (Array.isArray(sessionBeats) && sessionBeats.length > 1) {
        out.push("## Session Timeline");
        for (const beat of sessionBeats) {
          const bTime = beat.timestamp
            ? new Date(beat.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
              })
            : "";
          const modeLabel = beat.sceneMode ? ` (${beat.sceneMode})` : "";
          const prefix = bTime ? `[${bTime}]${modeLabel} ` : modeLabel ? `${modeLabel.trim()} ` : "";
          out.push(`- ${prefix}${beat.headline}`);
          if (beat.summary && beat.summary !== beat.headline) {
            out.push(`  - ${beat.summary}`);
          }
        }
        if (bullets.length > 0) {
          out.push("");
          out.push("### Latest Scene Notes");
          for (const b of bullets) out.push(`- ${b}`);
        }
        out.push("");
      } else if (headline) {
        out.push(`## Summary: ${headline}`);
        for (const b of bullets) out.push(`- ${b}`);
        out.push("");
      }
      if (clues.length > 0) {
        out.push("## Clues & Notes");
        for (const c of clues) out.push(`- ${c}`);
        out.push("");
      }
      out.push(`## Full Transcript (${lines.length} lines)`, "");
      for (const l of lines) {
        const tStr = l.timestamp
          ? new Date(l.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
            })
          : "";
        out.push(`[${tStr}] ${l.speaker}: ${l.text}`);
      }
      return out.join("\n");
    }

    togglePinTranscriptClue(transcriptId) {
      const item = this.state.transcript.find((t) => t.id === transcriptId);
      if (!item) return;
      item.pinnedAsClue = !item.pinnedAsClue;
      if (item.pinnedAsClue) {
        this.state.puzzle.isActive = true;
        if (!this.state.puzzle.clues.includes(item.text)) {
          this.state.puzzle.clues.push(item.text);
        }
      }
      this.save();
    }

    addPuzzleClue(clueText) {
      const clean = String(clueText || "").trim();
      if (!clean) return;
      this.state.puzzle.isActive = true;
      if (!this.state.puzzle.clues.includes(clean)) {
        this.state.puzzle.clues.push(clean);
      }
      this.save();
    }

    removePuzzleClue(idx) {
      this.state.puzzle.clues.splice(idx, 1);
      this.save();
    }

    upsertCharacter(rawCharObj, options = {}) {
      const charObj = normalizeCharacterRecord(rawCharObj);
      const manualAdd = Boolean(options.manualAdd);

      // If user was viewing Demo and imports a real sheet, switch straight into B.U.G.S.!
      if (this.partyGroups.activeGroupName === "__demo__" && !isDemoCharId(charObj.id)) {
        this.partyGroups.activeGroupName = DEFAULT_PARTY_GROUP;
        this.state.party = (this.partyGroups.groups[DEFAULT_PARTY_GROUP]?.characters || []).slice();
        this.state.myCharacterId =
          this.partyGroups.groups[DEFAULT_PARTY_GROUP]?.myCharacterId || null;
      }

      const activeGroupName = this.partyGroups.activeGroupName || DEFAULT_PARTY_GROUP;
      const grp = this.partyGroups.groups[activeGroupName];

      if (!manualAdd && this.isCharacterExcluded(charObj.id, charObj.name, activeGroupName)) {
        return;
      }

      // If manually re-added via + Hero, remove from exclusion list
      if (manualAdd && grp) {
        const cleanId = String(charObj.id || "").trim();
        const cleanName = String(charObj.name || "").trim().toLowerCase();
        grp.excludedIds = (grp.excludedIds || []).filter((id) => id !== cleanId);
        grp.excludedNames = (grp.excludedNames || []).filter((nm) => nm !== cleanName);
      }

      const idx = this.state.party.findIndex((p) => String(p.id) === String(charObj.id));
      if (idx >= 0) {
        const existingConc = this.state.party[idx].concentratingOn;
        this.state.party[idx] = {
          ...charObj,
          concentratingOn: charObj.concentratingOn || existingConc || ""
        };
      } else {
        this.state.party.push(charObj);
        if (!this.state.myCharacterId || isDemoCharId(this.state.myCharacterId)) {
          this.state.myCharacterId = charObj.id;
        }
      }
      this.#syncActivePartyGroup();
      this.save();
    }

    removeCharacter(charId) {
      const target = this.state.party.find((p) => String(p.id) === String(charId));
      const activeGroupName = this.partyGroups.activeGroupName;
      if (activeGroupName && activeGroupName !== "__demo__") {
        const grp = this.partyGroups.groups[activeGroupName];
        if (grp) {
          grp.excludedIds = Array.isArray(grp.excludedIds) ? grp.excludedIds : [];
          grp.excludedNames = Array.isArray(grp.excludedNames) ? grp.excludedNames : [];
          const cleanId = String(charId || "").trim();
          if (cleanId && !grp.excludedIds.includes(cleanId)) {
            grp.excludedIds.push(cleanId);
          }
          const cleanName = String(target?.name || "").trim().toLowerCase();
          if (cleanName && !grp.excludedNames.includes(cleanName)) {
            grp.excludedNames.push(cleanName);
          }
        }
      }

      this.state.party = this.state.party.filter((p) => String(p.id) !== String(charId));
      if (String(this.state.myCharacterId) === String(charId)) {
        this.state.myCharacterId = this.state.party[0]?.id || null;
      }
      this.#syncActivePartyGroup();
      this.save();
    }

    setMyCharacter(charId) {
      this.state.myCharacterId = String(charId);
      this.#syncActivePartyGroup();
      this.save();
    }

    adjustPartyHp(charId, delta) {
      const pc = this.state.party.find((p) => String(p.id) === String(charId));
      if (!pc) return;
      if (delta < 0 && pc.hp.temp > 0) {
        const absorb = Math.min(pc.hp.temp, Math.abs(delta));
        pc.hp.temp -= absorb;
        const leftover = Math.abs(delta) - absorb;
        pc.hp.current = Math.max(0, pc.hp.current - leftover);
      } else {
        pc.hp.current = Math.max(0, Math.min(pc.hp.max, pc.hp.current + delta));
      }
      this.#syncActivePartyGroup();
      this.save();
    }

    toggleSpellSlot(charId, slotIndex, deltaUsed) {
      const pc = this.state.party.find((p) => String(p.id) === String(charId));
      if (!pc || !pc.spellSlots[slotIndex]) return;
      const slot = pc.spellSlots[slotIndex];
      slot.used = Math.max(0, Math.min(slot.max, slot.used + deltaUsed));
      slot.remaining = Math.max(0, slot.max - slot.used);
      this.#syncActivePartyGroup();
      this.save();
    }

    setCharacterConcentration(charId, spellName) {
      const pc = this.state.party.find((p) => String(p.id) === String(charId));
      if (!pc) return;
      pc.concentratingOn = String(spellName || "").trim();
      this.#syncActivePartyGroup();
      this.save();
    }

    addManualEnemy(name) {
      const clean = String(name || "").trim() || `Enemy #${this.state.combat.enemies.length + 1}`;
      const tokenId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      const enemy = {
        tokenId,
        name: clean,
        isNameRevealed: true,
        damageTaken: 0,
        isBloodied: false,
        visibleHealthPercent: null,
        highestMissRoll: null,
        lowestHitRoll: null,
        conditions: [],
        observedTraits: [],
        isDefeated: false,
        isCurrentTurn: false,
        initiative: null
      };
      this.state.combat.inCombat = true;
      this.state.combat.enemies.push(enemy);
      if (!this.state.combat.activeTargetTokenId) {
        this.state.combat.activeTargetTokenId = tokenId;
      }
      this.save();
    }

    applyEnemyDamage(tokenId, amount) {
      const enemy = this.state.combat.enemies.find((e) => e.tokenId === tokenId);
      if (!enemy) return;
      enemy.damageTaken = Math.max(0, (enemy.damageTaken || 0) + Number(amount || 0));
      this.save();
    }

    recordEnemyAttackOutcome(tokenId, rollTotal, didHit) {
      const enemy = this.state.combat.enemies.find((e) => e.tokenId === tokenId);
      const val = Number(rollTotal);
      if (!enemy || !Number.isFinite(val) || val <= 1) return;
      if (didHit) {
        if (enemy.lowestHitRoll === null || val < enemy.lowestHitRoll) {
          enemy.lowestHitRoll = val;
        }
      } else {
        if (enemy.highestMissRoll === null || val > enemy.highestMissRoll) {
          enemy.highestMissRoll = val;
        }
      }
      this.save();
    }

    toggleEnemyFlag(tokenId, field) {
      const enemy = this.state.combat.enemies.find((e) => e.tokenId === tokenId);
      if (!enemy) return;
      enemy[field] = !enemy[field];
      this.save();
    }

    syncAboveVttSnapshot(snapshot, modeLabel) {
      if (!snapshot) return [];
      this.state.bridgeStatus = {
        mode: modeLabel || this.state.bridgeStatus.mode || "extension",
        connectedPage: snapshot.pageTitle || snapshot.pageUrl || "D&D Beyond",
        isAboveVttActive: Boolean(snapshot.isAboveVttActive),
        lastHeartbeat: Date.now()
      };

      if (snapshot.combat) {
        this.state.combat.inCombat = Boolean(snapshot.combat.inCombat);
        if (snapshot.combat.round) {
          this.state.combat.round = snapshot.combat.round;
        }

        const incomingCombatants = Array.isArray(snapshot.combat.combatants)
          ? snapshot.combat.combatants
          : [];

        this.state.combat.initiativeOrder = incomingCombatants.map((c) => ({
          tokenId: c.tokenId,
          name: c.name,
          initiative: c.initiative,
          isPlayer: c.isPlayer,
          isCurrentTurn: c.isCurrentTurn
        }));

        // Merge player-fair enemy state without losing cumulative damage tracked at the table
        const existingMap = new Map(this.state.combat.enemies.map((e) => [e.tokenId, e]));
        const incomingEnemies = incomingCombatants.filter((c) => !c.isPlayer);

        if (incomingEnemies.length > 0) {
          const merged = incomingEnemies.map((inc) => {
            const prev = existingMap.get(inc.tokenId);
            return {
              tokenId: inc.tokenId,
              name: inc.isNameRevealed ? inc.name : prev?.name || inc.name,
              isNameRevealed: inc.isNameRevealed,
              damageTaken: prev?.damageTaken || 0,
              isBloodied: Boolean(inc.isBloodied || prev?.isBloodied),
              visibleHealthPercent:
                inc.visibleHealthPercent !== null ? inc.visibleHealthPercent : prev?.visibleHealthPercent ?? null,
              highestMissRoll: prev?.highestMissRoll ?? null,
              lowestHitRoll: prev?.lowestHitRoll ?? null,
              conditions: Array.from(new Set([...(prev?.conditions || []), ...(inc.conditions || [])])),
              observedTraits: prev?.observedTraits || [],
              isDefeated: prev?.isDefeated || false,
              isCurrentTurn: Boolean(inc.isCurrentTurn),
              initiative: inc.initiative
            };
          });

          // Preserve any manually added enemies
          const manualOnes = this.state.combat.enemies.filter((e) => e.tokenId.startsWith("manual-"));
          this.state.combat.enemies = [...merged, ...manualOnes];

          if (
            !this.state.combat.activeTargetTokenId ||
            !this.state.combat.enemies.some((e) => e.tokenId === this.state.combat.activeTargetTokenId)
          ) {
            this.state.combat.activeTargetTokenId = this.state.combat.enemies[0]?.tokenId || null;
          }
        }
      }

      if (Array.isArray(snapshot.recentLog) && snapshot.recentLog.length > 0) {
        this.ingestGameLogRolls(snapshot.recentLog, false);
      }

      this.save();
      return Array.isArray(snapshot.partyCharacters) ? snapshot.partyCharacters : [];
    }

    ingestGameLogRolls(rolls, shouldSave = true) {
      if (!Array.isArray(rolls) || rolls.length === 0) return;
      const existingFps = new Set(this.state.gameLog.map((r) => r.fingerprint));
      let added = false;

      for (const r of rolls) {
        if (!r || !r.fingerprint || existingFps.has(r.fingerprint)) continue;
        existingFps.add(r.fingerprint);
        this.state.gameLog.push({ ...r, attributedTo: "" });
        added = true;
      }

      if (this.state.gameLog.length > 80) {
        this.state.gameLog = this.state.gameLog.slice(-80);
      }

      if (added && shouldSave) {
        this.save();
      }
    }

    attributeRollDamageToEnemy(fingerprint, tokenId, multiplier = 1) {
      const roll = this.state.gameLog.find((r) => r.fingerprint === fingerprint);
      const enemy = this.state.combat.enemies.find((e) => e.tokenId === tokenId);
      if (!roll || !enemy || roll.total == null) return;
      const dmg = Math.max(1, Math.floor(Math.abs(Number(roll.total)) * multiplier));
      enemy.damageTaken = (enemy.damageTaken || 0) + dmg;
      roll.attributedTo = `${enemy.name} (${dmg} dmg)`;
      this.save();
    }

    recordUsage(inputTokens, outputTokens, modelId) {
      const inTok = Number(inputTokens || 0);
      const outTok = Number(outputTokens || 0);
      this.state.usage.inputTokens += inTok;
      this.state.usage.outputTokens += outTok;
      this.state.usage.calls += 1;

      if (!this.settings.isFreeTierKey) {
        // Pricing from official Gemini Developer API docs (per 1M tokens)
        const isFlash38 = String(modelId).includes("3.8-flash");
        const inRate = isFlash38 ? 0.75 : 0.3;
        const outRate = isFlash38 ? 3.75 : 2.5;
        const deltaUsd = (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
        this.state.usage.estimatedUsd += deltaUsd;
      }
      this.save();
    }
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.Store = new CopilotStore();
})(window);
