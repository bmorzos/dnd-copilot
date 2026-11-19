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

  async function analyzeTableSituation(store) {
    const st = store.state;
    const recentLines = st.transcript.slice(-25);
    const fullText = recentLines.map((t) => t.text).join(" ");

    // Try Chrome on-device Gemini Nano first if present ($0 local)
    const nanoRes = await tryChromeBuiltInPrompt(
      "Respond ONLY with valid JSON: {\"sceneMode\":\"Exploration|Social|Puzzle|Combat\",\"headline\":\"string\",\"summaryBullets\":[\"string\"],\"activeObjectives\":[\"string\"]}",
      `Summarize this D&D table transcript:\n${recentLines.map((t) => `${t.speaker}: ${t.text}`).join("\n")}`
    );

    if (nanoRes?.headline) {
      st.situation = {
        sceneMode: nanoRes.sceneMode || "Exploration",
        headline: nanoRes.headline,
        summaryBullets: Array.isArray(nanoRes.summaryBullets) ? nanoRes.summaryBullets.slice(0, 4) : [],
        activeObjectives: Array.isArray(nanoRes.activeObjectives) ? nanoRes.activeObjectives.slice(0, 3) : [],
        notableNpcs: extractProperNouns(recentLines.map((l) => l.text)),
        lastUpdatedAt: Date.now()
      };
      store.save();
      return st.situation;
    }

    // Deterministic Local Digest Engine ($0, instant, works in every Chrome version)
    let sceneMode = "Exploration";
    if (st.combat.inCombat || COMBAT_WORDS.test(fullText)) {
      sceneMode = "Combat";
    } else if (PUZZLE_WORDS.test(fullText) || st.puzzle.isActive) {
      sceneMode = "Puzzle";
    } else if (SOCIAL_WORDS.test(fullText)) {
      sceneMode = "Social";
    }

    // Auto-extract spoken puzzle clues & inscriptions
    for (const entry of recentLines) {
      if (PUZZLE_WORDS.test(entry.text)) {
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
      bullets.push("No spoken lines captured yet—play your recording or start the microphone.");
    } else {
      const meaningful = recentLines
        .filter((l) => l.text.split(/\s+/).length >= 5)
        .slice(-4);
      for (const item of meaningful) {
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

    const latestLine = recentLines[recentLines.length - 1]?.text || "";
    const headline =
      recentLines.length > 0
        ? `${sceneMode} Scene — ${latestLine.slice(0, 115)}${latestLine.length > 115 ? "..." : ""}`
        : "Listening for table conversation & rolls (Free Local Mode)...";

    const partyNames = new Set(st.party.map((p) => p.name));
    const npcs = extractProperNouns(recentLines.map((l) => l.text)).filter((n) => !partyNames.has(n));

    st.situation = {
      sceneMode,
      headline,
      summaryBullets: bullets.slice(0, 4),
      activeObjectives: objectives,
      notableNpcs: npcs,
      lastUpdatedAt: Date.now()
    };

    store.save();
    return st.situation;
  }

  async function solvePuzzle(store, extraUserNote = "") {
    const st = store.state;
    const allPuzzleText = [
      st.puzzle.promptOrInscription || "",
      ...(st.puzzle.clues || []),
      extraUserNote,
      ...st.transcript.slice(-20).map((t) => t.text)
    ].join("\n");

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

  async function adviseTacticsAndSpells(store, customQuestion = "") {
    const st = store.state;
    const myChar =
      st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;

    if (!myChar) {
      st.advisor = {
        tacticalOverview:
          "No character sheet loaded yet—click '+ Party Sheets' (or '✨ Demo' in the top bar) so the tactical engine knows your spells and slots!",
        concentrationWarning: "",
        recommendations: [
          {
            rank: 1,
            spellOrAction: "Dodge / Take Cover / Ready an Action",
            slotInfo: "Action · Zero Resources",
            whyBest: "Add your D&D Beyond character sheet on the right to get spell-specific recommendations."
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
    const isConcentrating = Boolean(myChar.concentratingOn);

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
        : `Concentration is FREE on ${myChar.name}.`,
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
    adviseTacticsAndSpells
  };
})(window);
