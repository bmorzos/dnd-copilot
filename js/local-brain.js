/**
 * 100% Free, Zero-API-Key Local Brain for D&D Table Copilot.
 *
 * 1. Uses Chrome's built-in on-device AI (window.LanguageModel / Gemini Nano) if enabled in Chrome ($0, local).
 * 2. Otherwise runs a deterministic D&D 5e Situation Digest, Puzzle Archetype Analyzer, and Tactical Spell Scorer
 *    so every button ("Digest Now", "Suggest Best Move", "Solve Puzzle") works immediately with ZERO API key and $0 cost!
 */
(function (global) {
  const COMBAT_WORDS =
    /\b(initiative|roll\s+to\s+hit|attack\s+roll|saving\s+throw|dex\s+save|wis\s+save|con\s+save|damage|bludgeoning|piercing|slashing|radiant|necrotic|fireball|bloodied|multiattack|armor\s+class|healing\s+word|cure\s+wounds|smite)\b/i;
  const PUZZLE_WORDS =
    /\b(riddle|inscription|carved|rune|runes|pedestal|basin|lever|statue|altar|mirror|sequence|symbol|glyph|lock|sealed\s+door|archway|puzzle|cipher|braziers?|pressure\s+plate)\b/i;
  const SOCIAL_WORDS =
    /\b(persuasion|deception|intimidation|insight|merchant|tavern|innkeeper|guard|king|queen|lord|mayor|negotiate|bribe|quest|coin|gold\s+pieces)\b/i;

  const RIDDLE_CONCEPT_HINTS = [
    {
      pattern: /\b(no\s+shadow|casts?\s+no\s+shadow|mirror|reflection|unseen\s+flame)\b/i,
      theme: "Light / Reflection / Illusion",
      idea: "A 'flame without shadow' or mirror clue usually points to magical/illusory light (Light, Dancing Lights, Minor Illusion) or angling a reflection rather than real fire."
    },
    {
      pattern: /\b(silence|echo|bell|thunder|voice|speak\s+without\s+mouth|hear\s+without\s+ears)\b/i,
      theme: "Sound / Echo / Silence",
      idea: "Sound/bell/silence clues typically require ringing then damping a bell, casting Silence/Thaumaturgy/Minor Illusion, or answering 'an echo'."
    },
    {
      pattern: /\b(tide|climbs?\s+the\s+mountain|mist|cloud|fog|vapor|rain|water)\b/i,
      theme: "Water / Mist / Fog",
      idea: "Water that rises or 'climbs mountains' classicly refers to mist, steam, fog, or clouds—check Mist/Salt basins, Create Water, Fog Cloud, or Prestidigitation."
    },
    {
      pattern: /\b(first|second|third|last|order|before|after|sequence)\b/i,
      theme: "Strict Ordering / Sequence",
      idea: "The wording specifies an exact sequence ('first... second... last'). Activating elements out of order often triggers guardians or resets the lock."
    },
    {
      pattern: /\b(swallows?\s+all|devours?\s+all|mountains?\s+low|rusts?\s+iron)\b/i,
      theme: "Time / Entropy",
      idea: "Classic Tolkien-style riddle phrasing pointing to 'Time' (or hourglass/sundial symbols in the room)."
    },
    {
      pattern: /\b(more\s+you\s+take|leave\s+behind|footsteps)\b/i,
      theme: "Footsteps / Path",
      idea: "'The more you take, the more you leave behind' points to footsteps—check floor tiles or walking backward/matching tracks."
    },
    {
      pattern: /\b(north|south|east|west|dawn|dusk|sunrise|sunset)\b/i,
      theme: "Cardinal / Solar Alignment",
      idea: "Sunrise = East, Noon = Zenith/South, Sunset = West, Midnight = North. Align statues/levers in solar cycle order."
    }
  ];

  const DAMAGE_RESIST_PATTERNS = [
    { regex: /\b(fire|flames?|scorch\w*)\b.*\b(barely|half|little|shrugs?\s+off|resist\w*|immune|no\s+effect)/i, trait: "Suspected Fire Resistance/Immunity" },
    { regex: /\b(cold|frost|ice)\b.*\b(barely|half|little|shrugs?\s+off|resist\w*|immune)/i, trait: "Suspected Cold Resistance/Immunity" },
    { regex: /\b(poison|venom)\b.*\b(barely|half|little|shrugs?\s+off|resist\w*|immune)/i, trait: "Suspected Poison Resistance/Immunity" },
    { regex: /\b(necrotic)\b.*\b(barely|half|little|shrugs?\s+off|resist\w*|immune)/i, trait: "Suspected Necrotic Resistance/Immunity" },
    { regex: /\b(lightning|shock)\b.*\b(barely|half|little|shrugs?\s+off|resist\w*|immune)/i, trait: "Suspected Lightning Resistance/Immunity" },
    { regex: /\b(non-?magical|normal\s+weapon)\b.*\b(barely|half|little|resist\w*)/i, trait: "Resists Nonmagical Weapons" }
  ];

  const HYPO_SKIP_RE =
    /\b(should\s+i|could\s+i|what\s+if|maybe\s+i|might\s+cast|thinking\s+about|wanna|want\s+to|if\s+i\s+cast|why\s+don'?t\s+(?:we|you)|do\s+i\s+have|would\s+it)\b/i;

  const CONDITION_LIST_ALT =
    "blinded|charmed|deafened|frightened|grappled|incapacitated|invisible|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious|blessed|hasted";

  const FALLBACK_SPELL_NAMES = [
    "Spirit Guardians",
    "Healing Word",
    "Cure Wounds",
    "Guiding Bolt",
    "Hunter's Mark",
    "Misty Step",
    "Magic Missile",
    "Hold Person",
    "Silvery Barbs",
    "Eldritch Blast",
    "Hunger of Hadar",
    "Sacred Flame",
    "Scorching Ray",
    "Vortex Warp",
    "Counterspell",
    "Fireball",
    "Fire Bolt",
    "Polymorph",
    "Shield",
    "Bless",
    "Bane",
    "Haste",
    "Hex"
  ];

  function escapeRegex(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildActorPattern(party) {
    const tokens = new Set([
      "i",
      "i'm",
      "im",
      "i'll",
      "i've",
      "me",
      "rain",
      "rayne",
      "bonehawk",
      "bone hawk",
      "gonlor",
      "keel",
      "kiel",
      "munger",
      "munner",
      "patty",
      "bonoc"
    ]);
    for (const pc of party || []) {
      const nm = String(pc?.name || "").trim().toLowerCase();
      if (!nm) continue;
      tokens.add(nm);
      tokens.add(nm.replace(/\s+/g, ""));
      const parts = nm.split(/\s+/);
      if (parts[0] && parts[0].length >= 3) {
        tokens.add(parts[0]);
      }
    }
    return Array.from(tokens)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");
  }

  function resolveRawActorToken(rawActor, speaker, party, myChar, fallbackSpellName = "") {
    const clean = String(rawActor || "").trim().toLowerCase();
    if (/^(i|i'm|im|i'll|i've|me|my)$/.test(clean)) {
      if (speaker) {
        const spkLow = String(speaker).trim().toLowerCase();
        const bySpk = (party || []).find((p) => {
          const pn = String(p.name || "").toLowerCase();
          return pn === spkLow || (pn.split(/\s+/)[0] && spkLow.includes(pn.split(/\s+/)[0]));
        });
        if (bySpk) return bySpk.name;
      }
      return myChar?.name || "me";
    }
    if (clean) return clean;
    if (speaker) {
      const spkLow = String(speaker).trim().toLowerCase();
      const bySpk = (party || []).find((p) => {
        const pn = String(p.name || "").toLowerCase();
        return pn === spkLow || (pn.split(/\s+/)[0] && spkLow.includes(pn.split(/\s+/)[0]));
      });
      if (bySpk) return bySpk.name;
    }
    if (fallbackSpellName) {
      const spLow = String(fallbackSpellName).trim().toLowerCase();
      const owners = (party || []).filter((p) =>
        (p.spells || []).some((s) => String(s.name || "").toLowerCase() === spLow)
      );
      if (owners.length === 1) return owners[0].name;
    }
    return myChar?.name || "";
  }

  function extractPartySheetUpdatesFromLines(lines, party = [], myCharacterId = null) {
    if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(party) || party.length === 0) {
      return [];
    }

    const myChar =
      party.find((p) => String(p.id) === String(myCharacterId)) || party[0] || null;
    const actorAlt = buildActorPattern(party);

    const spellSet = new Set(FALLBACK_SPELL_NAMES);
    for (const pc of party) {
      for (const sp of pc.spells || []) {
        if (sp?.name) spellSet.add(String(sp.name).trim());
      }
    }
    const spellsAlt = Array.from(spellSet)
      .filter((s) => s.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");

    const updates = [];

    for (const entry of lines) {
      const rawText = String(entry?.text || "").trim();
      if (!rawText) continue;
      const speaker = String(entry?.speaker || "");

      const sentences = rawText
        .split(/\s*[.;!\n]+\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const sentence of sentences) {
        if (HYPO_SKIP_RE.test(sentence)) continue;

        const clauses = sentence
          .split(
            /\s+\b(?:and\s+then|then)\b\s+|\s+\band\b\s+(?=(?:[A-Z][a-z]+|I|is|am|are|was|takes?|took|heals?|regains?|gains?|gets?|casts?|uses?|spends?|drops?|loses?|lost|goes?|starts?|becomes?|shakes?|ends?|clears?|removes?)\b)/i
          )
          .map((c) => c.trim())
          .filter(Boolean);

        let lastSubjectActor = "";

        for (const rawClause of clauses) {
          if (HYPO_SKIP_RE.test(rawClause)) continue;

          const actorPrefixMatch = actorAlt
            ? rawClause.match(new RegExp(`\\b(${actorAlt})\\b`, "i"))
            : null;
          const startsBareVerb =
            /^(?:is|am|i'm|are|was|down\s+to|takes?|took|heals?|regains?|recovers?|gains?|gets?|goes?|starts?|becomes?|loses?|lost|drops?|dropped|shakes?|ends?|clears?|removes?|spends?|uses?|casts?)\b/i.test(
              rawClause
            );

          let clause = rawClause;
          if (!actorPrefixMatch && startsBareVerb && lastSubjectActor) {
            clause = `${lastSubjectActor} ${rawClause}`;
          }

          const effectiveActorMatch = actorAlt
            ? clause.match(new RegExp(`\\b(${actorAlt})\\b`, "i"))
            : null;
          if (effectiveActorMatch && !/^(?:the\s+)?(?:enemy|goblin|orc|ogre|dragon|boss|monster)/i.test(rawClause)) {
            const resolved = resolveRawActorToken(effectiveActorMatch[1], speaker, party, myChar);
            if (resolved && resolved !== "me") lastSubjectActor = resolved;
          }

          if (/\b(?:finish(?:ed|es)?|take(?:s|n)?|completes?|had)\s+(?:a\s+|our\s+|the\s+)?long\s+rest\b/i.test(clause)) {
            updates.push({ characterName: "all", eventType: "long_rest" });
            continue;
          }
          if (/\b(?:finish(?:ed|es)?|take(?:s|n)?|completes?|had)\s+(?:a\s+|our\s+|the\s+)?short\s+rest\b/i.test(clause)) {
            updates.push({ characterName: "all", eventType: "short_rest" });
            continue;
          }

          // Damage taken
          const dmgReg1 = new RegExp(
            `\\b(${actorAlt})\\b(?:\\s+is|\\s+am|\\s+just)?\\s+(?:takes?|took|suffers?|suffered|loses?|lost)\\s+(\\d{1,3})\\s*(?:points?\\s+of\\s+)?(?:[a-z]+\\s+)?damage\\b`,
            "i"
          );
          const dmgReg2 = new RegExp(
            `\\b(\\d{1,3})\\s*(?:points?\\s+of\\s+)?(?:[a-z]+\\s+)?damage\\s+(?:to|on)\\s+(${actorAlt})\\b`,
            "i"
          );
          const dm1 = clause.match(dmgReg1);
          const dm2 = clause.match(dmgReg2);
          if (dm1) {
            updates.push({
              characterName: resolveRawActorToken(dm1[1], speaker, party, myChar),
              eventType: "damage",
              amount: Number(dm1[2])
            });
          } else if (dm2) {
            updates.push({
              characterName: resolveRawActorToken(dm2[2], speaker, party, myChar),
              eventType: "damage",
              amount: Number(dm2[1])
            });
          }

          // Temp HP
          const tempReg = new RegExp(
            `\\b(${actorAlt})\\s+(?:gains?|gets?|has|now\\s+has)\\s+(\\d{1,3})\\s+temp(?:orary)?\\s*(?:hp|hit\\s+points?)\\b`,
            "i"
          );
          const tm = clause.match(tempReg);
          if (tm) {
            updates.push({
              characterName: resolveRawActorToken(tm[1], speaker, party, myChar),
              eventType: "temp_hp",
              amount: Number(tm[2])
            });
          }

          // Healing
          const healReg1 = new RegExp(
            `\\b(${actorAlt})\\s+(?:heals?|regains?|recovers?|gets?\\s+healed)\\s+(?:for\\s+)?(\\d{1,3})\\b`,
            "i"
          );
          const healReg2 = new RegExp(
            `\\bheals?\\s+(${actorAlt})\\s+(?:for\\s+)?(\\d{1,3})\\b`,
            "i"
          );
          const hm1 = clause.match(healReg1);
          const hm2 = clause.match(healReg2);
          if (hm1) {
            updates.push({
              characterName: resolveRawActorToken(hm1[1], speaker, party, myChar),
              eventType: "heal",
              amount: Number(hm1[2])
            });
          } else if (hm2) {
            updates.push({
              characterName: resolveRawActorToken(hm2[1], speaker, party, myChar),
              eventType: "heal",
              amount: Number(hm2[2])
            });
          }

          // Explicit HP set
          const setHpReg = new RegExp(
            `\\b(${actorAlt})(?:'s|\\s+is|\\s+am|\\s+drops?|\\s+dropped|\\s+goes?|\\s+went)?\\s*(?:now\\s+)?(?:at|down\\s+to)\\s+(\\d{1,3})\\s*(?:hp|health|hit\\s+points?)\\b`,
            "i"
          );
          const shm = clause.match(setHpReg);
          if (shm) {
            updates.push({
              characterName: resolveRawActorToken(shm[1], speaker, party, myChar),
              eventType: "set_hp",
              amount: Number(shm[2])
            });
          }

          // Heroic Inspiration
          const gainInspReg1 = new RegExp(
            `\\b(${actorAlt})\\s+(?:gains?|gets?|earns?|receives?|is\\s+awarded|has)\\s+(?:a\\s+|an\\s+)?(?:heroic\\s+)?inspiration\\b`,
            "i"
          );
          const gainInspReg2 = new RegExp(
            `\\bgive(?:s)?\\s+(${actorAlt})\\s+(?:a\\s+|an\\s+)?(?:heroic\\s+)?inspiration\\b`,
            "i"
          );
          const spendInspReg = new RegExp(
            `\\b(${actorAlt})\\s+(?:uses?|spends?|spent|used|burns?)\\s+(?:my\\s+|their\\s+|his\\s+|her\\s+|a\\s+)?(?:heroic\\s+)?inspiration\\b`,
            "i"
          );
          const gi1 = clause.match(gainInspReg1);
          const gi2 = clause.match(gainInspReg2);
          const si = clause.match(spendInspReg);
          if (gi1 || gi2) {
            updates.push({
              characterName: resolveRawActorToken((gi1 || gi2)[1], speaker, party, myChar),
              eventType: "gain_inspiration"
            });
          } else if (si) {
            updates.push({
              characterName: resolveRawActorToken(si[1], speaker, party, myChar),
              eventType: "spend_inspiration"
            });
          }

          // Drop concentration
          const concDropReg = new RegExp(
            `\\b(${actorAlt})\\s+(?:loses?|lost|drops?|dropped|breaks?|broke|ends?|ended)\\s+concentration\\b`,
            "i"
          );
          const cdm = clause.match(concDropReg);
          if (cdm) {
            updates.push({
              characterName: resolveRawActorToken(cdm[1], speaker, party, myChar),
              eventType: "drop_concentration"
            });
          }

          // Conditions (Rage + 5e conditions)
          const rageAddReg = new RegExp(
            `\\b(${actorAlt})\\s+(?:(?:starts?|begins?|goes?|is|enters?|pops?)\\s+(?:into\\s+)?(?:a\\s+)?(?:rage|raging)|rages)\\b`,
            "i"
          );
          const rmAdd = clause.match(rageAddReg);
          if (rmAdd) {
            updates.push({
              characterName: resolveRawActorToken(rmAdd[1], speaker, party, myChar),
              eventType: "add_condition",
              condition: "Raging"
            });
          }
          const condRemoveReg = new RegExp(
            `\\b(${actorAlt})\\s+(?:is\\s+no\\s+longer|shakes?\\s+off|ends?|clears?|removes?|stops?)\\s+(${CONDITION_LIST_ALT}|rage|raging)\\b`,
            "i"
          );
          const crm = clause.match(condRemoveReg);
          if (crm) {
            const cond = /^rag/i.test(crm[2]) ? "Raging" : crm[2];
            updates.push({
              characterName: resolveRawActorToken(crm[1], speaker, party, myChar),
              eventType: "remove_condition",
              condition: cond
            });
          } else {
            const condAddReg = new RegExp(
              `\\b(${actorAlt})\\s+(?:is|am|becomes?|gets?|got|knocked|turns?|feels?)\\s+(${CONDITION_LIST_ALT})\\b`,
              "i"
            );
            const cam = clause.match(condAddReg);
            if (cam) {
              updates.push({
                characterName: resolveRawActorToken(cam[1], speaker, party, myChar),
                eventType: "add_condition",
                condition: cam[2]
              });
            }
          }

          // Spell casts
          if (spellsAlt) {
            const spellReg = new RegExp(
              `(?:\\b(${actorAlt})\\b\\s+(?:(?:i'll|ill|will|am\\s+going\\s+to|gonna|go\\s+ahead\\s+and)\\s+)?)?(?:casts?|casting|uses?|pops?|drops?|unleashes?)\\s+(?:out\\s+)?(?:my\\s+|their\\s+|his\\s+|her\\s+|a\\s+|an\\s+)?(?:(\\d)(?:st|nd|rd|th)[-\\s]?level\\s+)?(${spellsAlt})\\b(?:\\s+at\\s+(?:level\\s+)?(\\d)(?:st|nd|rd|th)?(?:\\s+level)?)?`,
              "i"
            );
            const spm = clause.match(spellReg);
            if (spm) {
              const spellMatched = spm[3];
              const slotLevel = Number(spm[2] || spm[4] || 0);
              const isRitual = /\bas\s+a\s+ritual\b|\britual\s+cast/i.test(clause);
              const rawAct = spm[1] || (effectiveActorMatch ? effectiveActorMatch[1] : "");
              const actorName = resolveRawActorToken(
                rawAct,
                speaker,
                party,
                myChar,
                spellMatched
              );
              if (actorName) {
                updates.push({
                  characterName: actorName,
                  eventType: "spell_cast",
                  spellName: spellMatched,
                  ...(slotLevel > 0 ? { slotLevel } : {}),
                  isRitual
                });
              }
            }
          }
        }
      }
    }

    return updates;
  }

  async function tryChromeBuiltInPrompt(systemPrompt, userPrompt) {
    try {
      const lm = global.LanguageModel || global.ai?.languageModel;
      if (!lm || typeof lm.availability !== "function") return null;
      const avail = await lm.availability();
      if (avail !== "available") return null;
      const session = await lm.create({
        initialPrompts: [{ role: "system", content: systemPrompt }]
      });
      const out = await session.prompt(userPrompt);
      session.destroy?.();
      const cleaned = String(out || "")
        .replace(/^```json\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      return JSON.parse(cleaned);
    } catch (_) {
      return null;
    }
  }

  function extractProperNouns(lines) {
    const ignore = new Set([
      "The", "And", "But", "You", "Your", "Wait", "Roll", "Initiative", "Player", "Table",
      "Action", "Bonus", "Reaction", "Round", "Damage", "Hit", "Miss", "Save", "Check",
      "What", "When", "Where", "Why", "How", "There", "This", "That", "They", "Their", "Oof"
    ]);
    const counts = new Map();
    for (const line of lines) {
      const matches = line.match(/\b[A-Z][a-z]{3,16}(?:\s+[A-Z][a-z]{3,16})?\b/g) || [];
      for (const m of matches) {
        if (ignore.has(m.split(" ")[0])) continue;
        counts.set(m, (counts.get(m) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  }

  const MONSTER_NOUN_RE =
    /\b(goblin|goblins|duergar|dragon|guardian|golem|construct|bugbear|skeleton|zombie|ogre|bandit|cultist|reaver|mimic|spider|orc|wolf|troll|wraith|banshee|kobold|owlbear|giant|cultists?)\b/i;

  const BANTER_LINE_RE =
    /\b(recording going|click on|printer stuff|can you move them|check the mic|testing 1|can you hear me|little comp)\b/i;

  function toTitleMonster(raw) {
    const clean = String(raw || "").trim().replace(/s$/i, (m, offset, str) => {
      return /goblins|orcs|wolves|skeletons|zombies|ogres|bandits|cultists|reavers|spiders|trolls|kobolds/i.test(str)
        ? ""
        : m;
    });
    return clean.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  function extractSpokenCombatFromLines(lines, party = []) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { inCombat: false, detectedEnemies: [], combatEvents: [] };
    }
    const partySet = new Set((party || []).map((p) => String(p.name || "").toLowerCase()));
    const enemyMap = new Map();
    const combatEvents = [];
    let combatCueCount = 0;

    for (const entry of lines) {
      const text = String(entry?.text || "").trim();
      if (!text || BANTER_LINE_RE.test(text)) continue;

      if (COMBAT_WORDS.test(text) || /\b(sneak attack|grapple|fireball|eldritch blast|psychic blades|uncanny dodge|smite|saves?)\b/i.test(text)) {
        combatCueCount++;
      }

      const mHit = text.match(MONSTER_NOUN_RE);
      if (mHit) {
        const name = toTitleMonster(mHit[1]);
        if (!partySet.has(name.toLowerCase())) {
          if (!enemyMap.has(name)) {
            enemyMap.set(name, {
              name,
              damageDealt: 0,
              isBloodied: false,
              isDefeated: false,
              observedTraits: []
            });
          }
          const rec = enemyMap.get(name);
          const dmgToMonster = text.match(
            /(?:for|takes?|took|suffers?|dealt?)\s+(\d{1,3})\s*(?:points?\s+of\s+)?(?:[a-z]+\s+)?(?:damage|psychic|fire|radiant|slashing|piercing|bludgeoning)/i
          );
          if (dmgToMonster && !new RegExp(`\\b(${Array.from(partySet).join("|") || "__none__"})\\s+takes?`, "i").test(text)) {
            rec.damageDealt += Number(dmgToMonster[1]);
          }
          if (/\bbloodied\b/i.test(text)) rec.isBloodied = true;
          if (/\b(dead|defeated|killed|unconscious|dies|drops\s+dead|finished\s+it)\b/i.test(text) && !/\btied\s+up\b/i.test(text)) {
            rec.isDefeated = true;
          }
          for (const pat of DAMAGE_RESIST_PATTERNS) {
            if (pat.regex.test(text) && !rec.observedTraits.includes(pat.trait)) {
              rec.observedTraits.push(pat.trait);
            }
          }
          if (/\bpsychic\b/i.test(text) && !rec.observedTraits.includes("Psychic Attacks / Resistance Check")) {
            rec.observedTraits.push("Psychic Capabilities");
          }
        }
      }

      // Extract notable combat events for the Combat Action Feed
      const actionVerb = text.match(
        /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*?\b(casts?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|sneak\s+attack|divine\s+smite|uncanny\s+dodge|grapple[ds]?|takes?\s+\d+\s+[a-z]*\s*damage|fireball|hold\s+person|hunter'?s\s+mark|abjure\s+enemy)\b/i
      );
      if (actionVerb) {
        combatEvents.push({
          actor: actionVerb[1],
          target: mHit ? toTitleMonster(mHit[1]) : "",
          action: actionVerb[2],
          detail: text.slice(0, 140),
          kind: /damage|took|takes/i.test(actionVerb[2]) ? "damage" : "action"
        });
      }
    }

    const detectedEnemies = Array.from(enemyMap.values());
    const inCombat = combatCueCount >= 2 || detectedEnemies.some((e) => e.damageDealt > 0 || combatCueCount >= 1);
    return { inCombat, detectedEnemies, combatEvents: combatEvents.slice(-10) };
  }

  function extractLocationFromLines(lines) {
    const locPatterns = [
      /\b(?:in|at|into|inside|outside|under|near)\s+(Stonehill\s+Inn|Phandalin|Zorzula's?\s+Rest|Miners'?\s+Exchange|Sleeping\s+Giant|Town\s+Hall|Axeholm|Cragmaw\s+\w+|Tavern|Inn)\b/i
    ];
    for (let i = lines.length - 1; i >= 0; i--) {
      const txt = String(lines[i]?.text || "");
      for (const re of locPatterns) {
        const m = txt.match(re);
        if (m) return m[1];
      }
    }
    return "";
  }

  function buildLocalSuggestedMoves(sceneMode, myChar, enemies, npcs, puzzleActive) {
    const moves = [];
    const activeFoes = (enemies || []).filter((e) => !e.isDefeated);
    const topSkill = (myChar?.proficientSkills || [])[0] || "Investigation";
    const utilSpells = (myChar?.spells || []).filter(
      (s) => s.ritual || s.level === 0 || /detect|identify|hold|fireball|bless|healing|misty|message/i.test(s.name)
    );

    if (sceneMode === "Combat" && activeFoes.length > 0) {
      const focus = activeFoes.find((e) => e.isBloodied) || activeFoes[0];
      moves.push(`Focus fire on ${focus.name}${focus.isBloodied ? " (Bloodied)" : ""} or check its save weaknesses`);
      if (utilSpells.length > 0) {
        moves.push(`Prepare ${utilSpells[0].name} for your next turn (watch Reaction/Concentration)`);
      }
      moves.push("Ask the DM for visible cover, lighting, or exits before committing your Bonus Action");
      return moves;
    }

    if (puzzleActive || sceneMode === "Puzzle") {
      moves.push("Cast Detect Magic (as a Ritual) or inspect the mechanism from 30 ft before touching");
      moves.push(`Ask the DM for an ${topSkill} or Arcana check on inscriptions and wear marks`);
      moves.push("Pin any key phrases in the Puzzle tab to cross-reference past sessions");
      return moves;
    }

    if (sceneMode === "Social") {
      const targetNpc = npcs?.[0] || "the NPC";
      moves.push(`Ask the DM for an Insight check on ${targetNpc}'s motives or reactions`);
      moves.push(`Leverage ${topSkill} to press for details, bargains, or hidden leads`);
      moves.push("Check Live Ideas for past-session ties before making promises");
      return moves;
    }

    moves.push(`Ask the DM for a ${topSkill} or Perception sweep of exits, tracks, or hidden compartments`);
    if (utilSpells.length > 0) {
      moves.push(`Consider casting ${utilSpells[0].name}${utilSpells[0].ritual ? " (Ritual, 0 slots)" : ""} to scout safely`);
    } else {
      moves.push("Clarify marching order, light sources, and short-rest readiness with the party");
    }
    moves.push("Note key NPCs/locations discovered so Live Ideas tracks campaign callbacks");
    return moves.slice(0, 3);
  }

  async function analyzeTableSituation(store, options = {}) {
    const st = store.state;
    const overrideLines = Array.isArray(options?.overrideLines) ? options.overrideLines : null;
    const forceRecordBeat = Boolean(options?.forceRecordBeat);
    const recentLines = (overrideLines && overrideLines.length > 0)
      ? overrideLines.slice(-30)
      : st.transcript.slice(-25);
    const fullText = recentLines.map((t) => t.text).join(" ");

    const newSheetLines = overrideLines
      ? overrideLines
      : store.getUnprocessedTranscriptLinesForSheets
      ? store.getUnprocessedTranscriptLinesForSheets(18)
      : [];
    const newestId = overrideLines
      ? st.transcript.length
        ? st.transcript[st.transcript.length - 1].id
        : null
      : newSheetLines.length
      ? newSheetLines[newSheetLines.length - 1].id
      : null;

    // Try Chrome on-device Gemini Nano first if present ($0 local)
    const nanoRes = overrideLines
      ? null
      : await tryChromeBuiltInPrompt(
          "Respond ONLY with valid JSON: {\"sceneMode\":\"Exploration|Social|Puzzle|Combat\",\"location\":\"string\",\"headline\":\"string\",\"summaryBullets\":[\"string\"],\"activeObjectives\":[\"string\"],\"suggestedNextMoves\":[\"string\"]}",
          `Summarize this D&D table transcript:\n${recentLines.map((t) => `${t.speaker}: ${t.text}`).join("\n")}`
        );

    if (nanoRes?.headline) {
      const npcsNano = extractProperNouns(recentLines.map((l) => l.text));
      const myCharNano =
        st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;
      const combatInfo = extractSpokenCombatFromLines(newSheetLines, st.party);
      store.ingestSpokenCombatState?.(combatInfo);
      st.situation = {
        sceneMode: nanoRes.sceneMode || "Exploration",
        location: nanoRes.location || extractLocationFromLines(recentLines),
        headline: nanoRes.headline,
        summaryBullets: Array.isArray(nanoRes.summaryBullets) ? nanoRes.summaryBullets.slice(0, 4) : [],
        activeObjectives: Array.isArray(nanoRes.activeObjectives) ? nanoRes.activeObjectives.slice(0, 3) : [],
        suggestedNextMoves:
          Array.isArray(nanoRes.suggestedNextMoves) && nanoRes.suggestedNextMoves.length > 0
            ? nanoRes.suggestedNextMoves.slice(0, 4)
            : buildLocalSuggestedMoves(
                nanoRes.sceneMode || "Exploration",
                myCharNano,
                st.combat.enemies,
                npcsNano,
                st.puzzle.isActive
              ),
        notableNpcs: npcsNano,
        lastUpdatedAt: Date.now()
      };
      store.recordSessionBeat?.(st.situation, forceRecordBeat);
      const updates = extractPartySheetUpdatesFromLines(newSheetLines, st.party, st.myCharacterId);
      const sheetRes = store.applyLivePartyUpdates
        ? store.applyLivePartyUpdates(updates, newestId)
        : { appliedCount: 0, descriptions: [] };
      store.save();
      return { ...st.situation, _appliedPartyUpdates: sheetRes.descriptions };
    }

    // Deterministic Local Digest Engine ($0, instant, works in every Chrome version)
    const spokenCombat = extractSpokenCombatFromLines(newSheetLines, st.party);
    let sceneMode = "Exploration";
    if (st.combat.inCombat || spokenCombat.inCombat || COMBAT_WORDS.test(fullText)) {
      sceneMode = "Combat";
    } else if (PUZZLE_WORDS.test(fullText) || st.puzzle.isActive) {
      sceneMode = "Puzzle";
    } else if (SOCIAL_WORDS.test(fullText)) {
      sceneMode = "Social";
    }

    if (spokenCombat.detectedEnemies.length > 0 || spokenCombat.combatEvents.length > 0) {
      store.ingestSpokenCombatState?.({
        inCombat: sceneMode === "Combat" && spokenCombat.inCombat,
        detectedEnemies: spokenCombat.detectedEnemies,
        combatEvents: spokenCombat.combatEvents
      });
    }

    // Auto-extract spoken puzzle clues & inscriptions
    for (const entry of recentLines) {
      if (PUZZLE_WORDS.test(entry.text) && !BANTER_LINE_RE.test(entry.text)) {
        st.puzzle.isActive = true;
        const quoted = entry.text.match(/['"]([^'"]{15,240})['"]/);
        if (quoted && !st.puzzle.promptOrInscription) {
          st.puzzle.promptOrInscription = `"${quoted[1]}"`;
        }
        if (entry.text.length >= 18 && !st.puzzle.clues.includes(entry.text)) {
          st.puzzle.clues.push(entry.text.slice(0, 220));
        }
      }

      // Auto-detect spoken enemy resistances & bloodied mentions
      for (const pat of DAMAGE_RESIST_PATTERNS) {
        if (pat.regex.test(entry.text) && st.combat.enemies.length > 0) {
          const target = st.combat.enemies[0];
          if (!target.observedTraits.includes(pat.trait)) {
            target.observedTraits.push(pat.trait);
          }
        }
      }
      if (/\bbloodied\b/i.test(entry.text) && st.combat.enemies.length > 0) {
        st.combat.enemies[0].isBloodied = true;
      }
    }

    const bullets = [];
    if (recentLines.length === 0) {
      bullets.push("No spoken lines captured yet—play your recording, Fast Play an episode, or start the mic.");
    } else {
      const meaningful = recentLines
        .filter((l) => l.text.split(/\s+/).length >= 5 && !BANTER_LINE_RE.test(l.text))
        .slice(-4);
      const sourceList = meaningful.length > 0 ? meaningful : recentLines.slice(-3);
      for (const item of sourceList) {
        bullets.push(`${item.speaker}: "${item.text.slice(0, 150)}${item.text.length > 150 ? "..." : ""}"`);
      }
    }

    const lowParty = st.party.filter((p) => p.hp.current <= p.hp.max * 0.4);
    if (lowParty.length > 0) {
      bullets.push(
        `Party alert: ${lowParty.map((p) => `${p.name} (${p.hp.current}/${p.hp.max} HP)`).join(", ")} low on health.`
      );
    }

    const objectives = [];
    if (sceneMode === "Combat") {
      const activeEnemies = st.combat.enemies.filter((e) => !e.isDefeated);
      if (activeEnemies.length > 0) {
        objectives.push(
          `Focus down ${activeEnemies.find((e) => e.isBloodied)?.name || activeEnemies[0].name}`
        );
      } else {
        objectives.push("Track visible foes and incoming attack/damage rolls");
      }
    }
    if (st.puzzle.isActive) {
      objectives.push(`Solve active puzzle (${st.puzzle.clues.length} clue(s) collected)`);
    }

    const cleanTail = recentLines.filter((l) => !BANTER_LINE_RE.test(l.text));
    const latestLine = (cleanTail[cleanTail.length - 1] || recentLines[recentLines.length - 1])?.text || "";
    const headline =
      recentLines.length > 0
        ? `${sceneMode} Scene — ${latestLine.slice(0, 115)}${latestLine.length > 115 ? "..." : ""}`
        : "Listening for table conversation & rolls (Free Local Mode)...";

    const partyNames = new Set(st.party.map((p) => p.name));
    const npcs = extractProperNouns(recentLines.map((l) => l.text)).filter((n) => !partyNames.has(n));
    const location = extractLocationFromLines(recentLines) || st.situation?.location || "";
    const myChar =
      st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;
    const suggestedNextMoves = buildLocalSuggestedMoves(
      sceneMode,
      myChar,
      st.combat.enemies,
      npcs,
      st.puzzle.isActive
    );

    st.situation = {
      sceneMode,
      location,
      headline,
      summaryBullets: bullets.slice(0, 4),
      activeObjectives: objectives,
      suggestedNextMoves,
      notableNpcs: npcs,
      lastUpdatedAt: Date.now()
    };

    store.recordSessionBeat?.(st.situation, forceRecordBeat);
    const updates = extractPartySheetUpdatesFromLines(newSheetLines, st.party, st.myCharacterId);
    const sheetRes = store.applyLivePartyUpdates
      ? store.applyLivePartyUpdates(updates, newestId)
      : { appliedCount: 0, descriptions: [] };
    store.save();
    return { ...st.situation, _appliedPartyUpdates: sheetRes.descriptions };
  }

  async function summarizeFullSession(store) {
    const st = store.state;
    const beats = Array.isArray(st.sessionBeats) ? st.sessionBeats : [];
    const lines = Array.isArray(st.transcript) ? st.transcript : [];

    if (beats.length === 0 && lines.length === 0) {
      return store.setSessionSummary({
        headline: "No session transcript captured yet.",
        bullets: []
      });
    }

    const bullets = [];
    let headline = "";

    if (beats.length > 0) {
      const first = beats[0];
      const last = beats[beats.length - 1];
      headline =
        beats.length === 1
          ? first.headline
          : `Full Session (${beats.length} scenes): ${first.sceneMode} → ${last.sceneMode}`;

      const maxBullets = 6;
      const step = beats.length <= maxBullets ? 1 : (beats.length - 1) / (maxBullets - 1);
      const pickedIndexes = new Set();
      for (let i = 0; i < Math.min(beats.length, maxBullets); i++) {
        pickedIndexes.add(Math.min(beats.length - 1, Math.round(i * step)));
      }
      for (const idx of Array.from(pickedIndexes).sort((a, b) => a - b)) {
        const b = beats[idx];
        const tStr = b.timestamp
          ? new Date(b.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";
        const prefix = tStr ? `[${tStr}] (${b.sceneMode}) ` : `(${b.sceneMode}) `;
        bullets.push(`${prefix}${b.headline}`);
      }
    } else {
      const meaningful = lines.filter((l) => String(l.text || "").split(/\s+/).length >= 4);
      const source = meaningful.length > 0 ? meaningful : lines;
      const maxBullets = 5;
      const step = source.length <= maxBullets ? 1 : (source.length - 1) / (maxBullets - 1);
      const picked = new Set();
      for (let i = 0; i < Math.min(source.length, maxBullets); i++) {
        picked.add(Math.min(source.length - 1, Math.round(i * step)));
      }
      for (const idx of Array.from(picked).sort((a, b) => a - b)) {
        const item = source[idx];
        bullets.push(`${item.speaker}: "${item.text.slice(0, 140)}${item.text.length > 140 ? "..." : ""}"`);
      }
      headline = `Session Summary (${lines.length} transcript lines)`;
    }

    return store.setSessionSummary({ headline, bullets });
  }

  async function solvePuzzle(store, extraUserNote = "", extraPastContext = "") {
    const st = store.state;
    const allPuzzleText = [
      st.puzzle.promptOrInscription || "",
      ...(st.puzzle.clues || []),
      extraUserNote,
      extraPastContext,
      ...st.transcript.slice(-20).map((t) => t.text)
    ]
      .filter(Boolean)
      .join("\n");

    const matchedHints = RIDDLE_CONCEPT_HINTS.filter((h) => h.pattern.test(allPuzzleText));
    const hypotheses = [];

    if (matchedHints.length > 0) {
      hypotheses.push({
        solution: `Combined Theme: ${matchedHints.map((m) => m.theme).join(" → ")}`,
        confidence: matchedHints.length >= 2 ? "High (Local Pattern Match)" : "Medium",
        reasoning: matchedHints.map((m) => m.idea).join(" ")
      });
    }

    // Check for numbered/ordered items or nouns in clues
    const quotedMatch = allPuzzleText.match(/['"]([^'"]{12,240})['"]/);
    if (quotedMatch && !st.puzzle.promptOrInscription) {
      st.puzzle.promptOrInscription = `"${quotedMatch[1]}"`;
    }

    const myChar =
      st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;
    const utilitySpells = (myChar?.spells || [])
      .filter((s) =>
        /light|mage hand|minor illusion|prestidigitation|thaumaturgy|detect magic|identify|comprehend|knock|vortex|misty|dispel/i.test(
          s.name
        )
      )
      .map((s) => s.name);

    hypotheses.push({
      solution:
        utilitySpells.length > 0
          ? `Test mechanism safely from range or with cantrips (${utilitySpells.join(", ")})`
          : "Match physical objects/containers in the room 1-to-1 with each clause of the clue",
      confidence: "Tactical Safe Play",
      reasoning:
        "D&D room puzzles almost always pair each phrase of an inscription with a physical feature in the chamber (basins, statues, levers, colors, or damage/element types). Test from 30 ft back before touching directly."
    });

    st.puzzle.isActive = true;
    if (!st.puzzle.title || st.puzzle.title === "No Active Puzzle Detected Yet") {
      st.puzzle.title = "Active Chamber Puzzle / Mystery";
    }
    st.puzzle.hypotheses = hypotheses;
    st.puzzle.nextChecks = [
      "Ask the DM for an Investigation or Perception check on wear marks, scorch marks, or dust around the mechanism.",
      "Cast Detect Magic (as a Ritual if available to save slots!) to see which school of magic glows on the puzzle.",
      "Interact from 30 ft away using Mage Hand, a 10-ft pole, or a cantrip in case wrong inputs trigger a trap."
    ];
    st.puzzle.lastSolvedAt = Date.now();
    store.save();
    return st.puzzle;
  }

  async function summarizePastSession(_store, title, rawText) {
    const cleanTitle = String(title || "").trim() || `Session (${new Date().toLocaleDateString()})`;
    const cleanText = String(rawText || "").trim();
    const lines = cleanText
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 14);

    const npcs = extractProperNouns(lines.slice(0, 120));
    const clues = [];
    const quests = [];
    for (const l of lines) {
      if (PUZZLE_WORDS.test(l) || /\b(key|secret|cipher|clue|letter|symbol|ring|Artifact)\b/i.test(l)) {
        if (clues.length < 4) clues.push(l.slice(0, 160));
      }
      if (/\b(quest|promise|deliver|find|rescue|return|meet|owe|mission)\b/i.test(l)) {
        if (quests.length < 4) quests.push(l.slice(0, 160));
      }
    }

    const summarySentences = lines
      .filter((l) => !/^#/.test(l))
      .slice(0, 3)
      .map((l) => l.slice(0, 160));

    return {
      title: cleanTitle,
      summary: summarySentences.join(" ") || cleanText.slice(0, 320),
      keyNpcs: npcs,
      openQuests: quests,
      clues
    };
  }

  async function adviseTacticsAndSpells(store, customQuestion = "", extraPastContext = "") {
    const st = store.state;
    const myChar =
      st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;

    // Extract optional tie-in from campaign memory / saved transcripts / Drive archive
    let pastSessionConnection = "";
    const localPast = store.getRelevantPastContext
      ? store.getRelevantPastContext(st.transcript.slice(-10))
      : "";
    const pastContext = [extraPastContext, localPast].filter(Boolean).join("\n");
    if (pastContext) {
      const relevantLines = pastContext
        .split("\n")
        .filter((l) => l.startsWith("[Past: ") || l.startsWith("[Drive"));
      if (relevantLines.length > 0) {
        pastSessionConnection = relevantLines.slice(0, 2).join(" · ");
      } else {
        const firstSessionLine = pastContext.split("\n")[0];
        if (firstSessionLine) {
          pastSessionConnection = firstSessionLine.slice(0, 220);
        }
      }
    }

    if (!myChar) {
      st.advisor = {
        tacticalOverview:
          "No character sheet loaded yet—click '+ Hero' above the Party column so Live Ideas knows your spells, skills, and gear!",
        concentrationWarning: "",
        pastSessionConnection,
        recommendations: [
          {
            rank: 1,
            spellOrAction: "Help / Ask the DM for a Skill Check",
            slotInfo: "Exploration / Social · Zero Cost",
            whyBest: "Add your D&D Beyond character sheet on the right to get character-specific ideas as the table talks."
          }
        ],
        customAnswer: "",
        lastAdvisedAt: Date.now()
      };
      store.save();
      return st.advisor;
    }

    const activeEnemies = (st.combat.enemies || []).filter((e) => !e.isDefeated);
    const enemyCount = activeEnemies.length;
    const bloodiedEnemy = activeEnemies.find((e) => e.isBloodied);
    const criticalAllies = st.party.filter((p) => p.hp.current <= p.hp.max * 0.35);
    const sceneMode = st.situation?.sceneMode || (st.combat.inCombat ? "Combat" : "Exploration");
    const isConcentrating = Boolean(myChar.concentratingOn);

    // Out-of-Combat / Exploration / Social / Puzzle proactive idea generator ($0 local)
    const isNonCombatQuestion =
      customQuestion && /\b(ask|say|check|search|investigate|persuade|negotiate|door|room|npc|clue|puzzle)\b/i.test(customQuestion);
    if ((sceneMode !== "Combat" && enemyCount === 0) || isNonCombatQuestion) {
      const ideas = [];
      const topSkills = (myChar.proficientSkills || []).slice(0, 3);
      const utilitySpells = (myChar.spells || []).filter((s) =>
        s.ritual ||
        s.level <= 2 &&
          /detect|identify|mage hand|minor illusion|prestidigitation|thaumaturgy|comprehend|guidance|enhance|speak|disguise|charm|suggestion|invisibility|find|knock|light|pass|misty/i.test(
            s.name
          )
      );

      if (sceneMode === "Social") {
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction: "Read Intentions or Press for Details (Insight / Persuasion)",
          slotInfo: "Social Check · Ask the DM",
          whyBest: `Ask the DM what their body language or motive looks like${
            topSkills.length ? ` (your top skills: ${topSkills.join(", ")})` : ""
          } before committing the party.`
        });
      } else if (sceneMode === "Puzzle" || st.puzzle.isActive) {
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction: "Inspect Wear Marks & Test Safely from 30 ft",
          slotInfo: "Puzzle Investigation · No Resources",
          whyBest:
            "Ask the DM for scorch marks, dust gaps, or magic auras on the mechanism, then probe from 30 ft back before touching directly."
        });
      } else {
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction:
            topSkills.length > 0
              ? `Lead with ${topSkills[0]} Check`
              : "Scout Ahead / Check Passive Perception",
          slotInfo: `Skill Check · Passive Perception ${myChar.passivePerception || 10}`,
          whyBest:
            topSkills.length > 0
              ? `Lean on ${myChar.name}'s strengths (${topSkills.join(", ")}) to check for traps, tracks, hidden compartments, or lore.`
              : "Ask the DM what stands out in the room—lighting, exits, tracks, and anything out of place."
        });
      }

      for (const sp of utilitySpells.slice(0, 2)) {
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction: `${sp.name}${sp.ritual ? " (Ritual)" : sp.level === 0 ? " (Cantrip)" : ` (L${sp.level})`}`,
          slotInfo: sp.ritual ? "0 Slots (Ritual, 10 min)" : sp.level === 0 ? "Cantrip (Free)" : `Level ${sp.level} · ${sp.castingTime}`,
          whyBest: sp.summary || "Practical utility spell for this scene."
        });
      }

      if ((myChar.notableItems || []).length > 0) {
        const it = myChar.notableItems[0];
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction: `Check Magic Gear: ${it.name}`,
          slotInfo: it.attuned ? "Attuned Item" : "Equipped Gear",
          whyBest:
            it.snippet ||
            "Keep your attuned/magic item charges and passive bonuses ready if the scene escalates."
        });
      }

      if (ideas.length < 3) {
        ideas.push({
          rank: ideas.length + 1,
          spellOrAction: "Coordinate Help Action or Watch Rear",
          slotInfo: "Team Play · Free",
          whyBest: "Offer the Help action to give an ally Advantage on their next crucial skill check."
        });
      }

      st.advisor = {
        tacticalOverview: `${sceneMode} Ideas for ${myChar.name} (${myChar.classSummary})${
          pastSessionConnection ? " — linked with past session memory" : ""
        }.`,
        concentrationWarning: isConcentrating
          ? `Currently concentrating on ${myChar.concentratingOn}.`
          : "",
        pastSessionConnection,
        recommendations: ideas.slice(0, 4).map((x, idx) => ({ ...x, rank: idx + 1 })),
        customAnswer: customQuestion
          ? `Exploration/Social ideas for "${customQuestion}" using ${myChar.name}'s skills, utility spells, and gear ($0 local).`
          : "",
        lastAdvisedAt: Date.now()
      };
      store.save();
      return st.advisor;
    }

    // Combat Mode scoring (existing tactical spell scorer + pastSessionConnection!)
    // Check highest observed AC & suspected resistances
    const highAcObserved = activeEnemies.some(
      (e) => (e.lowestHitRoll && e.lowestHitRoll >= 17) || (e.highestMissRoll && e.highestMissRoll >= 16)
    );
    const resistedTypes = new Set();
    activeEnemies.forEach((e) => {
      (e.observedTraits || []).forEach((tr) => {
        for (const dmg of ["fire", "cold", "poison", "necrotic", "lightning"]) {
          if (tr.toLowerCase().includes(dmg)) resistedTypes.add(dmg);
        }
      });
    });

    const availableSlotLevels = new Set(
      (myChar.spellSlots || []).filter((s) => s.remaining > 0).map((s) => s.level)
    );
    const highestSlot = availableSlotLevels.size > 0 ? Math.max(...availableSlotLevels) : 0;

    const qLower = (customQuestion || "").toLowerCase();
    const wantsSaveSlots = /\b(save\s+slots?|cantrip|conserve|frugal|no\s+slots?)\b/.test(qLower);
    const wantsAoe = /\b(aoe|multiple|group|crowd|all\s+of\s+them)\b/.test(qLower);
    const wantsProtect = /\b(heal|save|rescue|protect|help|brynjar|ally|teammate)\b/.test(qLower);

    // Score each prepared/known spell deterministically using 5e tactics
    const scoredSpells = [];
    for (const sp of myChar.spells || []) {
      const canCast =
        sp.level === 0 ||
        sp.ritual ||
        Array.from(availableSlotLevels).some((lvl) => lvl >= sp.level);
      if (!canCast) continue;
      if (wantsSaveSlots && sp.level > 0) continue;

      let score = 50;
      const reasons = [];
      const sumLow = (sp.summary || "").toLowerCase();

      // Emergency ally rescue / healing
      if (criticalAllies.length > 0 || wantsProtect) {
        const allyNames = criticalAllies.map((a) => `${a.name} (${a.hp.current}/${a.hp.max} HP)`).join(", ");
        if (sp.isHealing || /\b(heal|restore\w*\s+hit\s+points|vortex\s+warp|sanctuary|polymorph|aid)\b/.test(`${sp.name} ${sumLow}`)) {
          score += 42;
          reasons.push(
            allyNames
              ? `Directly stabilizes or repositions critically injured ${allyNames}`
              : "Strong ally protection/recovery option"
          );
        }
      }

      // High AC foes -> favor saving throws or auto-hit (Magic Missile) over attack rolls
      if (highAcObserved) {
        if (sp.requiresSave) {
          score += 22;
          reasons.push(`Targets ${sp.saveAbility || "a"} save (DC ${myChar.spellSaveDc}), bypassing high enemy AC`);
        } else if (/magic missile/i.test(sp.name)) {
          score += 25;
          reasons.push("Auto-hits with force darts, completely ignoring high enemy AC");
        } else if (sp.requiresAttack) {
          score -= 12;
          reasons.push("Requires an attack roll against high observed AC");
        }
      }

      // Resistance avoidance & Construct/Stone advantage (e.g. Shatter)
      const hitsResisted = (sp.damageTypes || []).some((d) => resistedTypes.has(d.toLowerCase()));
      if (hitsResisted) {
        score -= 35;
        reasons.push(`Avoids wasting slots into observed ${Array.from(resistedTypes).join("/")} resistance`);
      } else if ((sp.damageTypes || []).length > 0 && resistedTypes.size > 0) {
        score += 12;
        reasons.push(`Deals unresisted ${sp.damageTypes.join("/")} damage`);
      }

      if (/shatter/i.test(sp.name) && activeEnemies.some((e) => /guardian|golem|statue|construct|stone|armor/i.test(`${e.name} ${(e.observedTraits || []).join(" ")}`))) {
        score += 28;
        reasons.push("Inorganic stone/metal creatures make the CON save at DISADVANTAGE!");
      }

      // Multi-enemy AoE / Crowd Control
      if (enemyCount >= 2 || wantsAoe) {
        if (/\b(radius|cube|cone|sphere|up to \d+ (creatures|targets)|each creature)\b/.test(sumLow)) {
          score += 24;
          reasons.push(`Hits multiple foes (${enemyCount} enemies active)`);
        }
      }

      // Finishing a bloodied enemy
      if (bloodiedEnemy && (sp.damageTypes?.length > 0 || /magic missile/i.test(sp.name))) {
        score += 14;
        reasons.push(`Can help finish off Bloodied ${bloodiedEnemy.name} to cut enemy action economy`);
      }

      // Concentration check
      if (sp.concentration && isConcentrating) {
        score -= 28;
        reasons.push(`⚠️ Would end your active Concentration on ${myChar.concentratingOn}`);
      } else if (!sp.concentration && sp.level > 0 && sp.castingTime === "Action") {
        score += 8;
        reasons.push("Leaves Concentration completely free");
      }

      // Reaction spells are great to keep in mind, slightly lower than primary Action unless low HP
      if (sp.castingTime === "Reaction") {
        score -= 10;
        reasons.push("Hold a slot open to trigger as a Reaction when needed");
      } else if (sp.castingTime === "Bonus Action") {
        score += 10;
        reasons.push("Uses only your Bonus Action—pair with a Cantrip or Dodge/Disengage!");
      }

      // Slight preference for impactful leveled spells when slots are healthy
      if (!wantsSaveSlots && sp.level > 0 && sp.level <= highestSlot) {
        score += sp.level * 5;
      }

      const matchingSlot = (myChar.spellSlots || []).find((s) => s.level >= sp.level && s.remaining > 0);
      const slotInfo =
        sp.level === 0
          ? `Cantrip ($0 slots) · ${sp.castingTime}${sp.concentration ? " · Conc" : ""}`
          : `${matchingSlot?.isPact ? "Pact " : ""}L${matchingSlot?.level || sp.level} slot (${
              matchingSlot ? `${matchingSlot.remaining}/${matchingSlot.max} left` : "Ritual"
            }) · ${sp.castingTime}${sp.concentration ? " · Conc" : ""}`;

      scoredSpells.push({
        score,
        spellOrAction: `${sp.name}${sp.level > 0 ? ` (Level ${sp.level})` : " (Cantrip)"}`,
        slotInfo,
        whyBest: `${reasons.join(". ")}${reasons.length ? ". " : ""}${sp.summary}`
      });
    }

    scoredSpells.sort((a, b) => b.score - a.score);

    const top3 = scoredSpells.slice(0, 3).map((item, idx) => ({
      rank: idx + 1,
      spellOrAction: item.spellOrAction,
      slotInfo: item.slotInfo,
      whyBest: item.whyBest
    }));

    if (top3.length === 0) {
      top3.push({
        rank: 1,
        spellOrAction: "Weapon Attack / Cantrip / Help / Dodge",
        slotInfo: "Action · No Spell Slots Remaining",
        whyBest: "All leveled spell slots are expended or no prepared spells are listed on this sheet."
      });
    }

    st.advisor = {
      tacticalOverview: `Free Local 5e Tactical Engine for ${myChar.name} (${myChar.classSummary}): ${
        enemyCount > 0
          ? `${enemyCount} visible foe(s)${bloodiedEnemy ? `, ${bloodiedEnemy.name} is Bloodied` : ""}${
              highAcObserved ? ", high enemy AC observed" : ""
            }.`
          : "Out of combat — showing top prepared utility/combat readiness options."
      }`,
      concentrationWarning: isConcentrating
        ? `⚠️ ${myChar.name} is concentrating on ${myChar.concentratingOn}—avoid casting another Concentration spell unless upgrading.`
        : "",
      pastSessionConnection,
      recommendations: top3,
      customAnswer: customQuestion
        ? `Filtered "${customQuestion}" locally across ${myChar.name}'s ${myChar.spells?.length || 0} prepared spells and remaining slots ($0.00 cost).`
        : "",
      lastAdvisedAt: Date.now()
    };

    store.save();
    return st.advisor;
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.LocalBrain = {
    analyzeTableSituation,
    solvePuzzle,
    adviseTacticsAndSpells,
    summarizePastSession,
    summarizeFullSession,
    extractPartySheetUpdatesFromLines
  };
})(window);
