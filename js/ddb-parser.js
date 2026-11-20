/**
 * D&D Beyond Character v5 JSON Parser.
 * Converts raw character-service.dndbeyond.com/character/v5/character/{id} payloads
 * into clean party HUD & tactical spell-advisor models.
 */
(function (global) {
  const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];
  const ABILITY_SUBTYPES = {
    "strength-score": 0,
    "dexterity-score": 1,
    "constitution-score": 2,
    "intelligence-score": 3,
    "wisdom-score": 4,
    "charisma-score": 5
  };
  const SAVE_ABILITY_NAMES = {
    1: "STR",
    2: "DEX",
    3: "CON",
    4: "INT",
    5: "WIS",
    6: "CHA"
  };

  const MULTICLASS_SLOTS_BY_CASTER_LEVEL = [
    [],
    [2],
    [3],
    [4, 2],
    [4, 3],
    [4, 3, 2],
    [4, 3, 3],
    [4, 3, 3, 1],
    [4, 3, 3, 2],
    [4, 3, 3, 3, 1],
    [4, 3, 3, 3, 2],
    [4, 3, 3, 3, 2, 1],
    [4, 3, 3, 3, 2, 1],
    [4, 3, 3, 3, 2, 1, 1],
    [4, 3, 3, 3, 2, 1, 1],
    [4, 3, 3, 3, 2, 1, 1, 1],
    [4, 3, 3, 3, 2, 1, 1, 1],
    [4, 3, 3, 3, 2, 1, 1, 1, 1],
    [4, 3, 3, 3, 3, 1, 1, 1, 1],
    [4, 3, 3, 3, 3, 2, 1, 1, 1],
    [4, 3, 3, 3, 3, 2, 2, 1, 1]
  ];

  const CONDITION_NAMES = {
    1: "Blinded",
    2: "Charmed",
    3: "Deafened",
    4: "Exhaustion",
    5: "Frightened",
    6: "Grappled",
    7: "Incapacitated",
    8: "Invisible",
    9: "Paralyzed",
    10: "Petrified",
    11: "Poisoned",
    12: "Prone",
    13: "Restrained",
    14: "Stunned",
    15: "Unconscious"
  };

  function stripHtml(html) {
    if (!html) return "";
    return String(html)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function abilityMod(score) {
    return Math.floor(((score || 10) - 10) / 2);
  }

  function collectAllModifiers(data) {
    const modGroups = data.modifiers || {};
    const all = [];
    for (const sourceKey of Object.keys(modGroups)) {
      const arr = modGroups[sourceKey];
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && m.isGranted !== false) {
            all.push(m);
          }
        }
      }
    }
    return all;
  }

  function computeAbilityScores(data, modifiers) {
    const scores = [10, 10, 10, 10, 10, 10];
    const stats = Array.isArray(data.stats) ? data.stats : [];
    const bonusStats = Array.isArray(data.bonusStats) ? data.bonusStats : [];
    const overrideStats = Array.isArray(data.overrideStats) ? data.overrideStats : [];

    for (let i = 0; i < 6; i++) {
      const base = stats[i]?.value ?? 10;
      const bonus = bonusStats[i]?.value ?? 0;
      scores[i] = base + bonus;
    }

    for (const mod of modifiers) {
      const idx = ABILITY_SUBTYPES[mod.subType];
      if (idx === undefined) continue;
      const val = Number(mod.value ?? mod.fixedValue ?? 0);
      if (mod.type === "bonus" && Number.isFinite(val)) {
        scores[idx] += val;
      }
    }

    for (const mod of modifiers) {
      const idx = ABILITY_SUBTYPES[mod.subType];
      if (idx === undefined) continue;
      const val = Number(mod.value ?? mod.fixedValue ?? 0);
      if (mod.type === "set" && val > scores[idx]) {
        scores[idx] = val;
      }
    }

    for (let i = 0; i < 6; i++) {
      if (overrideStats[i]?.value != null) {
        scores[i] = overrideStats[i].value;
      }
    }

    const result = {};
    ABILITY_KEYS.forEach((k, idx) => {
      result[k] = {
        score: scores[idx],
        mod: abilityMod(scores[idx])
      };
    });
    return result;
  }

  function computeHitPoints(data, abilities, modifiers, totalLevel) {
    const tempHp = Number(data.temporaryHitPoints || 0);
    const removed = Number(data.removedHitPoints || 0);

    if (data.overrideHitPoints != null && data.overrideHitPoints > 0) {
      const maxHp = Number(data.overrideHitPoints);
      return {
        maxHp,
        currentHp: Math.max(0, maxHp - removed),
        tempHp
      };
    }

    let perLevelBonus = abilities.con.mod;
    let flatModBonus = 0;
    for (const mod of modifiers) {
      if (mod.type === "bonus" && mod.subType === "hit-points-per-level") {
        perLevelBonus += Number(mod.value ?? mod.fixedValue ?? 0);
      } else if (mod.type === "bonus" && mod.subType === "hit-points") {
        flatModBonus += Number(mod.value ?? mod.fixedValue ?? 0);
      }
    }

    // DDB hitPointType === 1 is Fixed/Average (slightly higher rounding), otherwise Rolled/Manual
    const baseHp = Number(data.baseHitPoints || 10);
    const bonusHp = Number(data.bonusHitPoints || 0);
    const maxHp = Math.max(1, baseHp + bonusHp + flatModBonus + perLevelBonus * Math.max(1, totalLevel));
    const currentHp = Math.max(0, Math.min(maxHp, maxHp - removed));

    return { maxHp, currentHp, tempHp };
  }

  function computeArmorClass(data, abilities, modifiers) {
    if (data.overrideArmorClass != null && data.overrideArmorClass > 0) {
      return Number(data.overrideArmorClass);
    }

    // Check Custom Values (typeId 1 = Override AC, typeId 2 = Magic Bonus AC, typeId 3 = Misc AC)
    const customValues = Array.isArray(data.characterValues) ? data.characterValues : [];
    for (const cv of customValues) {
      if (cv.typeId === 1 && Number(cv.value) > 0) {
        return Number(cv.value);
      }
    }

    const inventory = Array.isArray(data.inventory) ? data.inventory : [];
    let bodyArmorAc = null;
    let armorType = 0; // 1 Light, 2 Medium, 3 Heavy
    let shieldBonus = 0;

    for (const item of inventory) {
      if (!item?.equipped || !item?.definition) continue;
      const def = item.definition;
      if (def.armorClass != null && def.armorTypeId) {
        if (def.armorTypeId === 4) {
          // Shield
          shieldBonus += Number(def.armorClass || 2);
        } else if (def.armorTypeId >= 1 && def.armorTypeId <= 3) {
          bodyArmorAc = Number(def.armorClass);
          armorType = def.armorTypeId;
        }
      }
    }

    let ac = 10 + abilities.dex.mod;
    if (bodyArmorAc !== null) {
      if (armorType === 1) {
        ac = bodyArmorAc + abilities.dex.mod;
      } else if (armorType === 2) {
        let maxDex = 2;
        if (modifiers.some((m) => m.subType === "ac-max-dex-modifier")) {
          maxDex = 3;
        }
        ac = bodyArmorAc + Math.min(maxDex, abilities.dex.mod);
      } else if (armorType === 3) {
        ac = bodyArmorAc;
      }
    } else {
      // Unarmored Defense (Barbarian CON / Monk WIS / Draconic 13+DEX)
      for (const mod of modifiers) {
        if (mod.type === "set" && mod.subType === "unarmored-armor-class") {
          const statId = mod.statId;
          const extra =
            statId === 3
              ? abilities.con.mod
              : statId === 5
              ? abilities.wis.mod
              : Number(mod.value ?? mod.fixedValue ?? 0);
          const candidate = 10 + abilities.dex.mod + extra;
          if (candidate > ac) ac = candidate;
        }
      }
    }

    let bonusAc = 0;
    for (const mod of modifiers) {
      if (
        mod.type === "bonus" &&
        (mod.subType === "armor-class" ||
          (bodyArmorAc !== null && mod.subType === "armored-armor-class") ||
          (bodyArmorAc === null && mod.subType === "unarmored-armor-class"))
      ) {
        bonusAc += Number(mod.value ?? mod.fixedValue ?? 0);
      }
    }

    for (const cv of customValues) {
      if ((cv.typeId === 2 || cv.typeId === 3) && Number.isFinite(Number(cv.value))) {
        bonusAc += Number(cv.value);
      }
    }

    return ac + shieldBonus + bonusAc;
  }

  function computeSpellSlots(data) {
    const classes = Array.isArray(data.classes) ? data.classes : [];
    let effectiveCasterLevel = 0;
    let singleCastingClassSlots = null;
    const castingClasses = [];

    for (const cls of classes) {
      const def = cls.definition || {};
      const subDef = cls.subclassDefinition || {};
      const lvl = Number(cls.level || 0);
      const clsName = (def.name || "").toLowerCase();

      if (clsName === "warlock") continue; // Handled via pactMagic

      const spellRules = def.spellRules || subDef.spellRules;
      const canCast = def.canCastSpells || subDef.canCastSpells;
      if (!canCast) continue;

      castingClasses.push({ lvl, spellRules, clsName });

      const divisor = Number(spellRules?.multiClassSpellSlotDivisor || 0);
      if (divisor === 1 || ["bard", "cleric", "druid", "sorcerer", "wizard"].includes(clsName)) {
        effectiveCasterLevel += lvl;
      } else if (divisor === 2 || ["paladin", "ranger", "artificer"].includes(clsName)) {
        effectiveCasterLevel += clsName === "artificer" ? Math.ceil(lvl / 2) : Math.floor(lvl / 2);
      } else if (divisor === 3) {
        effectiveCasterLevel += Math.floor(lvl / 3);
      }
    }

    if (castingClasses.length === 1 && Array.isArray(castingClasses[0].spellRules?.levelSpellSlots)) {
      const table = castingClasses[0].spellRules.levelSpellSlots;
      const row = table[castingClasses[0].lvl];
      if (Array.isArray(row)) {
        singleCastingClassSlots = row;
      }
    }

    const fallbackSlots =
      singleCastingClassSlots ||
      MULTICLASS_SLOTS_BY_CASTER_LEVEL[Math.min(20, Math.max(0, effectiveCasterLevel))] ||
      [];

    const rawSlots = Array.isArray(data.spellSlots) ? data.spellSlots : [];
    const slots = [];

    for (let level = 1; level <= 9; level++) {
      const entry = rawSlots.find((s) => Number(s.level) === level) || rawSlots[level - 1] || {};
      const explicitAvailable = Number(entry.available || 0);
      const fallbackMax = Number(fallbackSlots[level - 1] || 0);
      const max = Math.max(explicitAvailable, fallbackMax);
      const used = Math.min(max, Math.max(0, Number(entry.used || 0)));
      if (max > 0) {
        slots.push({
          level,
          max,
          used,
          remaining: Math.max(0, max - used),
          isPact: false
        });
      }
    }

    // Warlock Pact Magic
    const pactArr = Array.isArray(data.pactMagic) ? data.pactMagic : [];
    for (const pact of pactArr) {
      const max = Number(pact.available || 0);
      const used = Number(pact.used || 0);
      const level = Number(pact.level || 1);
      if (max > 0) {
        slots.push({
          level,
          max,
          used: Math.min(max, Math.max(0, used)),
          remaining: Math.max(0, max - used),
          isPact: true
        });
      }
    }

    // Fallback Warlock pact slots from class table if pactMagic array only stores used count
    const warlockCls = classes.find((c) => (c.definition?.name || "").toLowerCase() === "warlock");
    if (warlockCls && !slots.some((s) => s.isPact)) {
      const wLvl = Number(warlockCls.level || 1);
      const pactSlotLevel = Math.min(5, Math.ceil(wLvl / 2));
      const pactMax = wLvl >= 17 ? 4 : wLvl >= 11 ? 3 : wLvl >= 2 ? 2 : 1;
      const matchingPact = pactArr.find((p) => Number(p.level) === pactSlotLevel) || pactArr[0] || {};
      const used = Math.min(pactMax, Math.max(0, Number(matchingPact.used || 0)));
      slots.push({
        level: pactSlotLevel,
        max: pactMax,
        used,
        remaining: Math.max(0, pactMax - used),
        isPact: true
      });
    }

    return slots;
  }

  function activationLabel(activationType) {
    switch (Number(activationType)) {
      case 1:
        return "Action";
      case 3:
        return "Bonus Action";
      case 4:
        return "Reaction";
      case 6:
        return "1 Min";
      case 7:
        return "10 Min";
      case 8:
        return "1 Hour";
      default:
        return "Action";
    }
  }

  const SKILL_DEFS = {
    acrobatics: { label: "Acrobatics", ability: "dex" },
    "animal-handling": { label: "Animal Handling", ability: "wis" },
    arcana: { label: "Arcana", ability: "int" },
    athletics: { label: "Athletics", ability: "str" },
    deception: { label: "Deception", ability: "cha" },
    history: { label: "History", ability: "int" },
    insight: { label: "Insight", ability: "wis" },
    intimidation: { label: "Intimidation", ability: "cha" },
    investigation: { label: "Investigation", ability: "int" },
    medicine: { label: "Medicine", ability: "wis" },
    nature: { label: "Nature", ability: "int" },
    perception: { label: "Perception", ability: "wis" },
    performance: { label: "Performance", ability: "cha" },
    persuasion: { label: "Persuasion", ability: "cha" },
    religion: { label: "Religion", ability: "int" },
    "sleight-of-hand": { label: "Sleight of Hand", ability: "dex" },
    stealth: { label: "Stealth", ability: "dex" },
    survival: { label: "Survival", ability: "wis" }
  };

  const SKILL_SLUGS = Object.fromEntries(
    Object.entries(SKILL_DEFS).map(([k, v]) => [k, v.label])
  );

  function extractNotableItems(data) {
    const inv = Array.isArray(data.inventory) ? data.inventory : [];
    const seen = new Set();
    const magicOrPriority = [];
    const fallbackEquipped = [];

    for (const item of inv) {
      const def = item?.definition || {};
      const name = String(def.name || "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;

      const isMagic = Boolean(def.magic);
      const isAttuned = Boolean(item?.isAttuned);
      const isEquipped = Boolean(item?.equipped);
      if (!isMagic && !isAttuned && !isEquipped) continue;

      seen.add(name.toLowerCase());
      const entry = {
        name,
        equipped: isEquipped,
        attuned: isAttuned,
        magic: isMagic,
        snippet: stripHtml(def.snippet || def.description || "").slice(0, 140)
      };
      if (isMagic || isAttuned) {
        magicOrPriority.push(entry);
      } else {
        fallbackEquipped.push(entry);
      }
    }

    return [...magicOrPriority, ...fallbackEquipped].slice(0, 12);
  }

  function extractWeaponsAndCombatItems(data, abilities, profBonus) {
    const inv = Array.isArray(data.inventory) ? data.inventory : [];
    const out = [];
    const seen = new Set();

    for (const item of inv) {
      const def = item?.definition || {};
      const name = String(def.name || "").trim();
      if (!name) continue;
      const isEquipped = Boolean(item?.equipped);
      const isStaff = def.filterType === "Staff" || /\bstaff\b/i.test(name);
      const isWeapon = def.filterType === "Weapon" || Boolean(def.damage?.diceString) || isStaff;
      const isCombatWondrous =
        /\b(necklace of fireballs|clockwork amulet|wand of|rod of|hat of wizardry|scroll)\b/i.test(name);

      if (!isWeapon && !isCombatWondrous) continue;
      if (isWeapon && !isEquipped && !item?.isAttuned && !isCombatWondrous) continue;

      const low = name.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);

      const props = Array.isArray(def.properties) ? def.properties.map((p) => String(p?.name || "")) : [];
      const isFinesse = props.some((p) => /finesse/i.test(p));
      const isRanged = def.attackType === 2 || /bow|crossbow|sling|dart/i.test(name);
      const gm = Array.isArray(def.grantedModifiers) ? def.grantedModifiers : [];
      let magicBonus = 0;
      const extraDamage = [];
      for (const m of gm) {
        if (m?.type === "bonus" && m?.subType === "magic") {
          magicBonus += Number(m.fixedValue ?? m.value ?? 0);
        }
        if (m?.type === "damage" && (m.dice?.diceString || m.die?.diceString)) {
          extraDamage.push({
            formula: m.dice?.diceString || m.die?.diceString,
            type: m.subType || ""
          });
        }
      }

      const abilityKey = isRanged
        ? "dex"
        : isFinesse
        ? abilities.dex.mod >= abilities.str.mod
          ? "dex"
          : "str"
        : "str";
      const statMod = Number(abilities?.[abilityKey]?.mod || 0);
      const baseFormula = def.damage?.diceString || (isStaff ? "1d6" : "");
      const damageType = def.damageType || (isStaff ? "bludgeoning" : "");

      out.push({
        name,
        kind: isWeapon ? "weapon" : "item",
        equipped: isEquipped,
        attuned: Boolean(item?.isAttuned),
        isMagic: Boolean(def.magic),
        magicBonus,
        ability: abilityKey,
        attackBonus: isWeapon ? statMod + profBonus + magicBonus : null,
        damageFormula: baseFormula
          ? `${baseFormula}${statMod + magicBonus >= 0 ? `+${statMod + magicBonus}` : statMod + magicBonus}`
          : "",
        damageType: String(damageType || "").toLowerCase(),
        extraDamage,
        isFinesse,
        isRanged,
        snippet: stripHtml(def.snippet || def.description || "").slice(0, 160)
      });
    }
    return out.slice(0, 10);
  }

  function extractRacialTraits(data) {
    const rawTraits = Array.isArray(data.race?.racialTraits) ? data.race.racialTraits : [];
    const traits = [];
    const seen = new Set();
    for (const t of rawTraits) {
      const def = t?.definition || {};
      const name = String(def.name || "").trim();
      if (!name || def.hideInSheet || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      traits.push({
        name,
        snippet: stripHtml(def.snippet || def.description || "").slice(0, 180)
      });
    }
    return traits;
  }

  function extractNotableFeatures(data, classes) {
    const names = [];
    const details = [];
    const seen = new Set();
    const pushFeature = (raw, source, snippetHtml) => {
      const clean = String(raw || "").trim();
      if (!clean) return;
      const low = clean.toLowerCase();
      if (seen.has(low)) return;
      seen.add(low);
      names.push(clean);
      details.push({
        name: clean,
        source,
        snippet: stripHtml(snippetHtml || "").slice(0, 180)
      });
    };

    for (const feat of Array.isArray(data.feats) ? data.feats : []) {
      const fDef = feat?.definition || feat || {};
      pushFeature(fDef.name, "feat", fDef.snippet || fDef.description);
    }
    for (const cls of classes) {
      const lvl = Number(cls?.level || 0);
      for (const cf of Array.isArray(cls?.classFeatures) ? cls.classFeatures : []) {
        const def = cf?.definition || {};
        if (def.hideInSheet) continue;
        if (def.requiredLevel != null && Number(def.requiredLevel) > lvl) continue;
        pushFeature(def.name, "class", def.snippet || def.description);
      }
    }
    for (const rt of extractRacialTraits(data)) {
      pushFeature(rt.name, "race", rt.snippet);
    }
    return { names: names.slice(0, 16), details: details.slice(0, 24) };
  }

  function computeSavingThrows(abilities, modifiers, profBonus) {
    const bonusAllSaves = modifiers
      .filter((m) => m.type === "bonus" && m.subType === "saving-throws")
      .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);

    const savingThrows = {};
    const saveAdvantages = [];

    for (const k of ABILITY_KEYS) {
      const fullSub =
        k === "str"
          ? "strength-saving-throws"
          : k === "dex"
          ? "dexterity-saving-throws"
          : k === "con"
          ? "constitution-saving-throws"
          : k === "int"
          ? "intelligence-saving-throws"
          : k === "wis"
          ? "wisdom-saving-throws"
          : "charisma-saving-throws";

      const isProf = modifiers.some((m) => m.type === "proficiency" && m.subType === fullSub);
      const specificBonus = modifiers
        .filter((m) => m.type === "bonus" && m.subType === fullSub)
        .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);
      const hasAdv = modifiers.some((m) => m.type === "advantage" && m.subType === fullSub);
      if (hasAdv) saveAdvantages.push(k);

      savingThrows[k] = Number(abilities?.[k]?.mod || 0) + (isProf ? profBonus : 0) + bonusAllSaves + specificBonus;
    }
    return { savingThrows, saveAdvantages, bonusAllSaves };
  }

  function computeFullSkills(abilities, modifiers, profBonus) {
    const bonusAllChecks = modifiers
      .filter((m) => m.type === "bonus" && m.subType === "ability-checks")
      .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);
    const halfProfAll = modifiers.some(
      (m) => m.type === "half-proficiency" && m.subType === "ability-checks"
    );

    const skills = {};
    const profSummary = [];
    for (const [slug, meta] of Object.entries(SKILL_DEFS)) {
      const hasExp = modifiers.some((m) => m.type === "expertise" && m.subType === slug);
      const hasProf = modifiers.some((m) => m.type === "proficiency" && m.subType === slug);
      const hasHalf = modifiers.some((m) => m.type === "half-proficiency" && m.subType === slug);
      const specificBonus = modifiers
        .filter((m) => m.type === "bonus" && m.subType === slug)
        .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);

      const tier = hasExp ? "expertise" : hasProf ? "proficiency" : hasHalf || halfProfAll ? "half" : "none";
      const profAdd =
        tier === "expertise"
          ? profBonus * 2
          : tier === "proficiency"
          ? profBonus
          : tier === "half"
          ? Math.floor(profBonus / 2)
          : 0;
      const abilityModVal = Number(abilities?.[meta.ability]?.mod || 0);
      skills[slug] = {
        slug,
        label: meta.label,
        ability: meta.ability,
        tier,
        bonus: abilityModVal + profAdd + bonusAllChecks + specificBonus
      };
      if (tier === "expertise") profSummary.push(`${meta.label} (Exp)`);
      else if (tier === "proficiency") profSummary.push(meta.label);
    }

    return {
      skills,
      proficientSkills: profSummary.sort((a, b) => a.localeCompare(b))
    };
  }

  function extractPreparedSpells(data, totalLevel = 1) {
    const classes = Array.isArray(data.classes) ? data.classes : [];
    const classById = new Map();
    classes.forEach((c) => {
      if (c.id) classById.set(c.id, c);
    });

    const collected = new Map();

    function addSpellEntry(rawSpell, forcePrepared = false) {
      const def = rawSpell?.definition;
      if (!def || !def.name) return;

      const isCantrip = Number(def.level || 0) === 0;
      const isPrepared =
        forcePrepared ||
        isCantrip ||
        Boolean(rawSpell.prepared) ||
        Boolean(rawSpell.alwaysPrepared) ||
        Boolean(rawSpell.usesSpellSlot === false);

      if (!isPrepared) return;

      const damageTypes = new Set();
      let damageFormula = "";
      let isHealing = false;
      if (Array.isArray(def.modifiers)) {
        for (const m of def.modifiers) {
          if (m.type === "damage" && m.subType) {
            damageTypes.add(m.subType);
            if (!damageFormula) {
              const baseDie = m.die?.diceString || m.dice?.diceString || "";
              let chosen = baseDie;
              if (isCantrip && Array.isArray(m.atHigherLevels?.higherLevelDefinitions)) {
                const scaled = m.atHigherLevels.higherLevelDefinitions
                  .filter((h) => Number(h?.level || 99) <= totalLevel && (h?.dice?.diceString || h?.die?.diceString))
                  .sort((a, b) => Number(b.level) - Number(a.level));
                if (scaled[0]) {
                  chosen = scaled[0].dice?.diceString || scaled[0].die?.diceString || baseDie;
                }
              }
              const fixed = Number(m.die?.fixedValue ?? m.fixedValue ?? 0);
              if (chosen) {
                damageFormula = fixed ? `${chosen}${fixed >= 0 ? `+${fixed}` : fixed}` : chosen;
              }
            }
          }
          if (m.type === "bonus" && (m.subType === "hit-points" || m.subType === "temporary-hit-points")) {
            isHealing = true;
            if (!damageFormula && (m.die?.diceString || m.dice?.diceString)) {
              damageFormula = m.die?.diceString || m.dice?.diceString;
            }
          }
        }
      }

      const rangeOrigin = def.range?.origin || "";
      const rangeVal = def.range?.rangeValue;
      const rangeText =
        rangeOrigin === "Self"
          ? "Self"
          : rangeOrigin === "Touch"
          ? "Touch"
          : rangeVal
          ? `${rangeVal} ft`
          : rangeOrigin || "60 ft";

      const cleanDesc = stripHtml(def.snippet || def.description || "");
      const saveAbility = SAVE_ABILITY_NAMES[def.saveDcAbilityId] || "";

      const key = def.name.toLowerCase();
      if (collected.has(key)) return;

      collected.set(key, {
        id: def.id,
        name: def.name,
        level: Number(def.level || 0),
        school: def.school || "",
        castingTime: activationLabel(def.activation?.activationType),
        concentration: Boolean(def.concentration),
        ritual: Boolean(def.ritual),
        range: rangeText,
        requiresAttack: Boolean(def.requiresAttackRoll),
        attackType: def.attackType === 1 ? "melee" : def.attackType === 2 ? "ranged" : "",
        requiresSave: Boolean(def.requiresSavingThrow),
        saveAbility,
        damageFormula,
        damageTypes: Array.from(damageTypes),
        isHealing,
        tags: Array.isArray(def.tags) ? def.tags : [],
        summary: cleanDesc.slice(0, 260)
      });
    }

    // 1. Class spells (handles both Prepared casters and Known casters like Sorcerer/Bard/Warlock/Ranger)
    const classSpells = Array.isArray(data.classSpells) ? data.classSpells : [];
    for (const cs of classSpells) {
      const cls = classById.get(cs.characterClassId);
      const clsName = (cls?.definition?.name || "").toLowerCase();
      const isKnownCaster =
        cls?.definition?.canPrepareSpells === false ||
        ["bard", "sorcerer", "warlock", "ranger"].includes(clsName) ||
        Boolean(cls?.subclassDefinition && cls?.definition?.canCastSpells === false);

      const spellsArr = Array.isArray(cs.spells) ? cs.spells : [];
      for (const sp of spellsArr) {
        addSpellEntry(sp, isKnownCaster);
      }
    }

    // 2. Race / Feat / Class-feature / Item granted spells
    const extraGroups = data.spells || {};
    for (const groupKey of ["race", "class", "feat", "item", "background"]) {
      const arr = extraGroups[groupKey];
      if (Array.isArray(arr)) {
        for (const sp of arr) {
          addSpellEntry(sp, true);
        }
      }
    }

    return Array.from(collected.values()).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }

  function parseCharacterJson(rawPayload) {
    const data = rawPayload?.data ? rawPayload.data : rawPayload;
    if (!data || (!data.name && !data.classes)) {
      throw new Error("Payload does not appear to be a valid D&D Beyond character JSON.");
    }

    const classes = Array.isArray(data.classes) ? data.classes : [];
    const totalLevel = classes.reduce((sum, c) => sum + Number(c.level || 0), 0) || 1;
    const classSummary = classes
      .map((c) => {
        const name = c.definition?.name || "Adventurer";
        const sub = c.subclassDefinition?.name ? ` (${c.subclassDefinition.name})` : "";
        return `${name}${sub} ${c.level || 1}`;
      })
      .join(" / ");

    const profBonus = Math.ceil(totalLevel / 4) + 1;
    const modifiers = collectAllModifiers(data);
    const abilities = computeAbilityScores(data, modifiers);
    const hp = computeHitPoints(data, abilities, modifiers, totalLevel);
    const ac = computeArmorClass(data, abilities, modifiers);
    const spellSlots = computeSpellSlots(data);
    const spells = extractPreparedSpells(data, totalLevel);

    const bonusInitiative = modifiers
      .filter((m) => m.type === "bonus" && m.subType === "initiative")
      .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);
    const spellAttackItemBonus = modifiers
      .filter((m) => m.type === "bonus" && m.subType === "spell-attacks")
      .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);
    const spellDcItemBonus = modifiers
      .filter((m) => m.type === "bonus" && m.subType === "spell-save-dc")
      .reduce((acc, m) => acc + Number(m.fixedValue ?? m.value ?? 0), 0);

    // Passive Perception
    const { skills, proficientSkills } = computeFullSkills(abilities, modifiers, profBonus);
    const perceptionBonus = skills.perception ? skills.perception.bonus : abilities.wis.mod;
    const { savingThrows, saveAdvantages, bonusAllSaves } = computeSavingThrows(
      abilities,
      modifiers,
      profBonus
    );

    // Conditions
    const activeConditions = [];
    if (Array.isArray(data.conditions)) {
      for (const cond of data.conditions) {
        const name = CONDITION_NAMES[cond.id];
        if (name) {
          activeConditions.push(cond.id === 4 && cond.level ? `${name} ${cond.level}` : name);
        }
      }
    }

    // Spell Save DC & Attack Bonus (best casting stat among classes)
    let spellCastingMod = Math.max(abilities.int.mod, abilities.wis.mod, abilities.cha.mod);
    for (const cls of classes) {
      const statId = cls.definition?.spellCastingAbilityId || cls.subclassDefinition?.spellCastingAbilityId;
      if (statId >= 1 && statId <= 6) {
        const key = ABILITY_KEYS[statId - 1];
        spellCastingMod = abilities[key].mod;
        break;
      }
    }

    const rawUrl = String(data.readonlyUrl || "").trim();
    const sheetUrl = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl.startsWith("/")
      ? `https://www.dndbeyond.com${rawUrl}`
      : data.id
      ? `https://www.dndbeyond.com/characters/${data.id}`
      : "";

    const notableItems = extractNotableItems(data);
    const featRes = extractNotableFeatures(data, classes);
    const racialTraits = extractRacialTraits(data);
    const weapons = extractWeaponsAndCombatItems(data, abilities, profBonus);

    return {
      id: String(data.id || Date.now()),
      name: data.name || "Unnamed Hero",
      race: data.race?.fullName || data.race?.baseName || "",
      classSummary: classSummary || `Level ${totalLevel}`,
      level: totalLevel,
      avatarUrl:
        data.decorations?.avatarUrl ||
        data.avatarUrl ||
        data.race?.portraitAvatarUrl ||
        "",
      sheetUrl,
      hp: {
        current: hp.currentHp,
        max: hp.maxHp,
        temp: hp.tempHp
      },
      ac,
      initiativeMod: abilities.dex.mod + bonusInitiative,
      passivePerception: 10 + perceptionBonus,
      proficiencyBonus: profBonus,
      spellSaveDc: 8 + profBonus + spellCastingMod + spellDcItemBonus,
      spellAttackBonus: profBonus + spellCastingMod + spellAttackItemBonus,
      spellAttackItemBonus,
      spellDcItemBonus,
      bonusAllSaves,
      abilities,
      savingThrows,
      saveAdvantages,
      skills,
      inspiration: Boolean(data.inspiration),
      conditions: activeConditions,
      concentratingOn: "",
      spellSlots,
      spells,
      notableItems,
      notableFeatures: featRes.names,
      featureDetails: featRes.details,
      racialTraits,
      weapons,
      proficientSkills,
      deathSaves: {
        successes: Number(data.deathSaves?.successCount || 0),
        failures: Number(data.deathSaves?.failCount || 0)
      },
      lastSyncedAt: Date.now()
    };
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.DDBParser = {
    parseCharacterJson,
    stripHtml
  };
})(window);
