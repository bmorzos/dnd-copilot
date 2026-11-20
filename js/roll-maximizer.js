/**
 * Player-Fair Roll Maximizer & "What to Say / Add" Coach.
 *
 * Uses strictly player-side character data (D&D Beyond feats, items, class features,
 * racial traits, spells, conditions, Heroic Inspiration) and party buffs/auras to:
 *  1. Let the player roll directly from the Roll button with every bonus toggled cleanly.
 *  2. Catch native AboveVTT Game Log rolls and immediately surface "Don't Forget to Add / Say!"
 *
 * Pure module (zero DOM requirement) — safe inside Dashboard, Content Script, and Node tests.
 */
(function (global) {
  const ABILITY_LABELS = {
    str: "STR",
    dex: "DEX",
    con: "CON",
    int: "INT",
    wis: "WIS",
    cha: "CHA"
  };

  function getPaladinAuraBonus(party, _myChar) {
    for (const p of Array.isArray(party) ? party : []) {
      const cls = String(p?.classSummary || "");
      const lvl = Number(p?.level || 0);
      const hasAuraFeature = (p?.notableFeatures || []).some((f) => /aura of protection/i.test(f));
      if ((/\bpaladin\b/i.test(cls) && lvl >= 6) || hasAuraFeature) {
        const chaMod = Number(p?.abilities?.cha?.mod ?? 1);
        return {
          paladinName: p.name || "Paladin",
          bonus: Math.max(1, chaMod)
        };
      }
    }
    return null;
  }

  function getPartySupportBuffs(party) {
    const res = {
      blessSource: null,
      guidanceSource: null,
      bardSource: null
    };
    for (const p of Array.isArray(party) ? party : []) {
      const cls = String(p?.classSummary || "");
      const spells = Array.isArray(p?.spells) ? p.spells : [];
      if (!res.blessSource && (/\b(cleric|paladin)\b/i.test(cls) || spells.some((s) => /\bbless\b/i.test(s?.name)))) {
        res.blessSource = p.name || "Ally";
      }
      if (!res.guidanceSource && (/\b(cleric|druid|artificer)\b/i.test(cls) || spells.some((s) => /\bguidance\b/i.test(s?.name)))) {
        res.guidanceSource = p.name || "Ally";
      }
      if (!res.bardSource && /\bbard\b/i.test(cls)) {
        const lvl = Number(p?.level || 1);
        const die = lvl >= 15 ? "1d12" : lvl >= 10 ? "1d10" : lvl >= 5 ? "1d8" : "1d6";
        res.bardSource = { name: p.name || "Bard", die };
      }
    }
    return res;
  }

  function parseDiceTerms(formula) {
    const clean = String(formula || "").replace(/\s+/g, "");
    if (!clean) return { diceTerms: [], flatMod: 0 };
    const tokens = clean.match(/[+-]?[^+-]+/g) || [];
    const diceTerms = [];
    let flatMod = 0;
    for (const tok of tokens) {
      const m = tok.match(/^([+-]?)(\d*)d(\d+)$/i);
      if (m) {
        const sign = m[1] === "-" ? -1 : 1;
        const count = Number(m[2] || 1);
        const sides = Number(m[3] || 6);
        if (count > 0 && sides > 0 && count <= 50) {
          diceTerms.push({ sign, count, sides });
        }
      } else {
        const num = Number(tok);
        if (Number.isFinite(num)) flatMod += num;
      }
    }
    return { diceTerms, flatMod };
  }

  function rollDiceExpression(formula, options = {}) {
    const rng = typeof options?.rng === "function" ? options.rng : Math.random;
    const minDie = Math.max(1, Number(options?.minDieValue || 1));
    const isCrit = Boolean(options?.isCrit);
    const { diceTerms, flatMod } = parseDiceTerms(formula);

    const dice = [];
    let diceSum = 0;
    let upgradedCount = 0;

    for (const term of diceTerms) {
      const totalRolls = isCrit && term.sign > 0 ? term.count * 2 : term.count;
      for (let i = 0; i < totalRolls; i++) {
        const raw = Math.min(term.sides, Math.max(1, Math.floor(rng() * term.sides) + 1));
        const finalVal = term.sign > 0 ? Math.max(minDie, raw) : raw;
        const upgraded = term.sign > 0 && finalVal > raw;
        if (upgraded) upgradedCount++;
        diceSum += term.sign * finalVal;
        dice.push({
          sides: term.sides,
          sign: term.sign,
          raw,
          final: finalVal,
          upgraded
        });
      }
    }

    return {
      formula: String(formula || "").trim(),
      dice,
      flatMod,
      total: diceSum + flatMod,
      upgradedCount,
      isCrit
    };
  }

  function findSpellScalarDmgTypes(spell) {
    const types = (spell?.damageTypes || []).map((t) => String(t).toLowerCase()).filter(Boolean);
    if (types.length > 0) return types;
    const sum = String(spell?.summary || "").toLowerCase();
    for (const dt of ["cold", "fire", "lightning", "thunder", "acid", "poison", "radiant", "necrotic", "force", "psychic"]) {
      if (sum.includes(dt)) return [dt];
    }
    return [];
  }

  function inferAttackModifierFromRoll(myChar, kind, abilityKey) {
    if (kind === "spell_attack") return Number(myChar?.spellAttackBonus || 5);
    if (kind === "save" && abilityKey) {
      return Number(myChar?.savingThrows?.[abilityKey] ?? myChar?.abilities?.[abilityKey]?.mod ?? 0);
    }
    return 0;
  }

  function getRollCatalog(myChar, _party = []) {
    if (!myChar) {
      return { spellsAndAttacks: [], saves: [], skills: [] };
    }

    const spellsAndAttacks = [];
    const seenIds = new Set();

    // 1. Spells (attacks, damaging saves, healing, and key check spells like Counterspell)
    for (const sp of myChar.spells || []) {
      const dmgTypes = findSpellScalarDmgTypes(sp);
      const isCounterOrDispel = /\b(counterspell|dispel magic)\b/i.test(sp.name);
      const hasCombatEffect =
        sp.requiresAttack ||
        sp.requiresSave ||
        Boolean(sp.damageFormula) ||
        sp.isHealing ||
        dmgTypes.length > 0 ||
        isCounterOrDispel;
      if (!hasCombatEffect) continue;

      const id = `spell:${sp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const kind = isCounterOrDispel
        ? "spell_check"
        : sp.requiresAttack
        ? "spell_attack"
        : sp.requiresSave
        ? "spell_save"
        : "spell_auto";

      spellsAndAttacks.push({
        id,
        category: "spells",
        name: sp.name,
        subLabel:
          kind === "spell_attack"
            ? `+${Number(myChar.spellAttackBonus || 0)} to hit${sp.damageFormula ? ` · ${sp.damageFormula}` : ""}`
            : kind === "spell_save"
            ? `DC ${Number(myChar.spellSaveDc || 10)} ${sp.saveAbility || "Save"}${sp.damageFormula ? ` · ${sp.damageFormula}` : ""}`
            : kind === "spell_check"
            ? `Ability Check (+${Math.max(0, Number(myChar.spellAttackBonus || 0) - Number(myChar.proficiencyBonus || 2) - Number(myChar.spellAttackItemBonus || 0))})`
            : sp.damageFormula || sp.castingTime,
        kind,
        isSpell: true,
        level: Number(sp.level || 0),
        school: sp.school || "",
        castingTime: sp.castingTime || "Action",
        range: sp.range || "",
        concentration: Boolean(sp.concentration),
        attackType: sp.attackType || "",
        attackBonus:
          kind === "spell_attack"
            ? Number(myChar.spellAttackBonus || 0)
            : kind === "spell_check"
            ? Number(myChar.abilities?.int?.mod ?? myChar.abilities?.cha?.mod ?? myChar.abilities?.wis?.mod ?? 2)
            : null,
        saveDc: kind === "spell_save" ? Number(myChar.spellSaveDc || 10) : null,
        saveAbility: sp.saveAbility || "",
        damageFormula: sp.damageFormula || "",
        damageTypes: dmgTypes,
        extraDamage: [],
        summary: sp.summary || ""
      });
    }

    // Prioritize higher-impact combat spells cleanly (cantrips + AoEs at top, then level)
    spellsAndAttacks.sort((a, b) => {
      const aAtk = a.kind === "spell_attack" || a.damageFormula ? 0 : 1;
      const bAtk = b.kind === "spell_attack" || b.damageFormula ? 0 : 1;
      return aAtk - bAtk || a.level - b.level || a.name.localeCompare(b.name);
    });

    // 2. Equipped Weapons & Combat Magic Items
    for (const w of myChar.weapons || []) {
      const id = `weapon:${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (seenIds.has(id)) continue;

      if (/wand of|hat of wizardry|clockwork amulet/i.test(w.name) && w.kind !== "weapon") {
        // Surfaced dynamically inside roll modifiers!
        continue;
      }
      seenIds.add(id);

      const isNecklace = /necklace of fireballs/i.test(w.name);
      if (isNecklace) {
        spellsAndAttacks.push({
          id,
          category: "spells",
          name: w.name,
          subLabel: "DC 15 DEX · 8d6 Fire (1+ beads)",
          kind: "item_save",
          isSpell: false,
          level: 3,
          school: "Evocation",
          castingTime: "Action",
          range: "60 ft",
          saveDc: 15,
          saveAbility: "DEX",
          damageFormula: "8d6",
          damageTypes: ["fire"],
          extraDamage: [],
          summary: w.snippet || "Throw 1 bead (8d6 fire, +1d6 per extra bead) for DC 15 DEX save."
        });
      } else if (w.kind === "weapon") {
        const extraTxt = (w.extraDamage || []).map((e) => `+${e.formula} ${e.type}`).join(" ");
        spellsAndAttacks.push({
          id,
          category: "spells",
          name: w.name,
          subLabel: `+${w.attackBonus ?? 0} to hit · ${w.damageFormula || "1d6"}${extraTxt ? ` ${extraTxt}` : ""}`,
          kind: "weapon_attack",
          isSpell: false,
          isFinesse: Boolean(w.isFinesse),
          isRanged: Boolean(w.isRanged),
          ability: w.ability || "str",
          magicBonus: Number(w.magicBonus || 0),
          attackBonus: Number(w.attackBonus ?? 0),
          damageFormula: w.damageFormula || "1d6",
          damageTypes: w.damageType ? [w.damageType] : [],
          extraDamage: Array.isArray(w.extraDamage) ? w.extraDamage : [],
          summary: w.snippet || ""
        });
      }
    }

    // 3. Saving Throws
    const saves = ["str", "dex", "con", "int", "wis", "cha"].map((k) => {
      const mod = inferAttackModifierFromRoll(myChar, "save", k);
      return {
        id: `save:${k}`,
        category: "saves",
        name: `${ABILITY_LABELS[k]} Saving Throw`,
        subLabel: mod >= 0 ? `+${mod}` : `${mod}`,
        kind: "save",
        ability: k,
        attackBonus: mod
      };
    });

    saves.splice(3, 0, {
      id: "save:con-conc",
      category: "saves",
      name: "Concentration Save (CON)",
      subLabel: `${inferAttackModifierFromRoll(myChar, "save", "con") >= 0 ? "+" : ""}${inferAttackModifierFromRoll(myChar, "save", "con")}`,
      kind: "save",
      ability: "con",
      isConcentration: true,
      attackBonus: inferAttackModifierFromRoll(myChar, "save", "con")
    });

    saves.push({
      id: "save:death",
      category: "saves",
      name: "Death Saving Throw",
      subLabel: `${Number(myChar.bonusAllSaves || 0) > 0 ? `+${myChar.bonusAllSaves}` : "+0"} (10+ passes)`,
      kind: "death_save",
      ability: "",
      attackBonus: Number(myChar.bonusAllSaves || 0)
    });

    // 4. Initiative + All 18 Skills
    const initMod = Number(myChar.initiativeMod ?? myChar.abilities?.dex?.mod ?? 0);
    const skills = [
      {
        id: "skill:initiative",
        category: "skills",
        name: "Initiative",
        subLabel: initMod >= 0 ? `+${initMod}` : `${initMod}`,
        kind: "initiative",
        ability: "dex",
        tier: "initiative",
        attackBonus: initMod
      }
    ];

    const skillMap = myChar.skills && typeof myChar.skills === "object" ? myChar.skills : {};
    const skillRows = Object.values(skillMap).sort((a, b) => {
      const rank = (t) => (t === "expertise" ? 0 : t === "proficiency" ? 1 : t === "half" ? 2 : 3);
      return rank(a.tier) - rank(b.tier) || a.label.localeCompare(b.label);
    });

    for (const sk of skillRows) {
      const tierTag = sk.tier === "expertise" ? " · Exp" : sk.tier === "proficiency" ? " · Prof" : "";
      skills.push({
        id: `skill:${sk.slug}`,
        category: "skills",
        name: sk.label,
        subLabel: `${sk.bonus >= 0 ? `+${sk.bonus}` : sk.bonus}${tierTag}`,
        kind: "skill",
        slug: sk.slug,
        ability: sk.ability,
        tier: sk.tier,
        attackBonus: Number(sk.bonus || 0)
      });
    }

    return { spellsAndAttacks, saves, skills };
  }

  function analyzeRollPotential(rollSpec, myChar, party = []) {
    if (!rollSpec || !myChar) {
      return { baseSummary: "", alreadyIncluded: [], modifiers: [] };
    }

    const clsLow = String(myChar.classSummary || "").toLowerCase();
    const featText = [
      ...(myChar.notableFeatures || []),
      ...(myChar.featureDetails || []).map((f) => `${f.name} ${f.snippet}`),
      ...(myChar.racialTraits || []).map((t) => `${t.name} ${t.snippet}`)
    ].join(" | ");
    const itemText = (myChar.notableItems || []).map((i) => `${i.name} ${i.snippet}`).join(" | ");
    const condsLow = (myChar.conditions || []).map((c) => String(c).toLowerCase());
    const dmgTypesLow = (rollSpec.damageTypes || []).map((d) => String(d).toLowerCase());
    const profBonus = Number(myChar.proficiencyBonus || 2);

    const isD20Roll =
      rollSpec.kind !== "spell_save" &&
      rollSpec.kind !== "item_save" &&
      rollSpec.kind !== "spell_auto";
    const isAttackRoll =
      rollSpec.kind === "spell_attack" || rollSpec.kind === "weapon_attack";

    const alreadyIncluded = [];
    if (rollSpec.kind === "spell_attack") {
      alreadyIncluded.push(`Proficiency +${profBonus}`);
      if (Number(myChar.spellAttackItemBonus || 0) > 0) {
        alreadyIncluded.push(`Item Bonus +${myChar.spellAttackItemBonus}`);
      }
    } else if (rollSpec.kind === "spell_save") {
      alreadyIncluded.push(`Spell Save DC ${rollSpec.saveDc || myChar.spellSaveDc || 10}`);
    } else if (rollSpec.kind === "skill" || rollSpec.kind === "save") {
      const mod = Number(rollSpec.attackBonus || 0);
      alreadyIncluded.push(`Sheet Modifier ${mod >= 0 ? `+${mod}` : mod}`);
    }

    const modifiers = [];

    // 1. Wand of the War Mage (+N already included, but IGNORE HALF COVER must be spoken!)
    const wandMatch = itemText.match(/wand of the war mage(?:,?\s*\+(\d))?/i);
    if (wandMatch && rollSpec.kind === "spell_attack") {
      modifiers.push({
        id: "wand_half_cover",
        title: `Wand of the War Mage${wandMatch[1] ? ` +${wandMatch[1]}` : ""} — Ignore Half Cover`,
        badge: "Ignores Half Cover",
        source: "Item",
        toggleable: true,
        defaultOn: true,
        sayThis: "Wand of the War Mage: my spell attack ignores half cover (and already includes the wand bonus)!"
      });
    }

    // 2. Elemental Adept (Cold, Fire, Lightning, Acid, Thunder)
    const eaMatch = featText.match(/elemental adept\s*\((cold|fire|lightning|acid|thunder)\)/i);
    if (eaMatch) {
      const eaType = eaMatch[1].toLowerCase();
      if (dmgTypesLow.includes(eaType) || (rollSpec.damageFormula && String(rollSpec.summary || "").toLowerCase().includes(eaType))) {
        modifiers.push({
          id: `elemental_adept_${eaType}`,
          title: `Elemental Adept (${eaMatch[1]})`,
          badge: "1s → 2s & Ignore Resist",
          source: "Feat",
          toggleable: true,
          defaultOn: true,
          minDieValue: 2,
          minDieDamageTypes: [eaType],
          sayThis: `Elemental Adept (${eaMatch[1]}): any 1 I roll on ${eaType} damage counts as a 2, and my spell ignores ${eaType} resistance!`
        });
      }
    }

    // 3. Evocation Wizard: Sculpt Spells (AoE Evocation save spell)
    if (
      /sculpt spells/i.test(featText) &&
      rollSpec.isSpell &&
      /evocation/i.test(rollSpec.school || "") &&
      rollSpec.kind === "spell_save" &&
      rollSpec.level > 0
    ) {
      const alliesProtected = 1 + Number(rollSpec.level || 1);
      modifiers.push({
        id: "sculpt_spells",
        title: `Sculpt Spells — Protect ${alliesProtected} Allies`,
        badge: `0 Friendly Fire (${alliesProtected} max)`,
        source: "Evocation 2",
        toggleable: true,
        defaultOn: true,
        sayThis: `Sculpt Spells: I choose up to ${alliesProtected} allies in the area—they auto-succeed on the save and take ZERO damage!`
      });
    }

    // 4. Evocation Wizard 6: Potent Cantrip (save cantrip deals half on pass)
    if (
      /potent cantrip/i.test(featText) &&
      rollSpec.isSpell &&
      rollSpec.level === 0 &&
      rollSpec.kind === "spell_save"
    ) {
      modifiers.push({
        id: "potent_cantrip",
        title: "Potent Cantrip — Half Damage Even on Save",
        badge: "Guaranteed ½ Dmg",
        source: "Evocation 6",
        toggleable: true,
        defaultOn: true,
        sayThis: "Potent Cantrip (Evocation 6): even if the enemy succeeds on its saving throw, it still takes half damage!"
      });
    }

    // 5. Clockwork Amulet (replace attack d20 with 10, 1/dawn)
    if (/clockwork amulet/i.test(itemText) && isAttackRoll) {
      modifiers.push({
        id: "clockwork_amulet",
        title: "Clockwork Amulet (1/Dawn)",
        badge: "Take Flat 10 on d20",
        source: "Item",
        toggleable: true,
        defaultOn: false,
        setD20To: 10,
        sayThis: `Clockwork Amulet (1/dawn): instead of rolling the d20, I take a flat 10 on the die (total ${10 + Number(rollSpec.attackBonus || 0)})!`
      });
    }

    // 6. Spider Staff extra +1d6 Poison on melee hit
    if (
      /spider staff/i.test(rollSpec.name || "") &&
      Array.isArray(rollSpec.extraDamage) &&
      rollSpec.extraDamage.length > 0
    ) {
      const poison = rollSpec.extraDamage[0];
      modifiers.push({
        id: "spider_staff_poison",
        title: `Spider Staff (+${poison.formula} ${poison.type || "poison"})`,
        badge: `+${poison.formula} Poison`,
        source: "Staff",
        toggleable: true,
        defaultOn: true,
        damageDiceBonus: poison.formula,
        damageBonusType: poison.type || "poison",
        sayThis: `Spider Staff adds an extra ${poison.formula} ${poison.type || "poison"} damage on a hit!`
      });
    }

    // 7. Hat of Wizardry on Arcana checks
    if (/hat of wizardry/i.test(itemText) && rollSpec.slug === "arcana") {
      modifiers.push({
        id: "hat_of_wizardry",
        title: "Hat of Wizardry (1/Long Rest)",
        badge: "DC 10 Any Cantrip",
        source: "Item",
        toggleable: true,
        defaultOn: false,
        sayThis: "Hat of Wizardry (DC 10 Arcana): lets me cast ANY Wizard cantrip—even one not prepared!"
      });
    }

    // 8. Spell Riders & Multi-Ray Notes
    if (/ray of frost/i.test(rollSpec.name)) {
      modifiers.push({
        id: "rider_ray_of_frost",
        title: "Ray of Frost Rider (-10 ft Speed)",
        badge: "-10 ft Speed",
        source: "Spell Effect",
        toggleable: true,
        defaultOn: true,
        sayThis: "On a hit, Ray of Frost reduces the target's speed by 10 ft until the start of my next turn!"
      });
    } else if (/rime'?s binding ice/i.test(rollSpec.name)) {
      modifiers.push({
        id: "rider_binding_ice",
        title: "Rime's Binding Ice Rider (Speed = 0)",
        badge: "Hindered (Action to Break)",
        source: "Spell Effect",
        toggleable: true,
        defaultOn: true,
        sayThis: "Anything that fails the CON save is locked in ice—0 speed until it or another creature spends an Action to break free!"
      });
    } else if (/scorching ray/i.test(rollSpec.name)) {
      modifiers.push({
        id: "rider_scorching_ray",
        title: "Scorching Ray — 3 Separate Rays (+2d6 each)",
        badge: "Roll 3× Attacks",
        source: "Spell Effect",
        toggleable: true,
        defaultOn: true,
        sayThis: "Scorching Ray fires 3 separate rays (or +1 ray per slot above L2)—each ray rolls to hit and deals 2d6 fire!"
      });
    } else if (/fireball/i.test(rollSpec.name)) {
      modifiers.push({
        id: "rider_fireball",
        title: "Fireball — 20-ft Radius Spread Around Corners",
        badge: "20-ft Sphere · Half on Save",
        source: "Spell Effect",
        toggleable: true,
        defaultOn: true,
        sayThis: "Fireball spreads around corners in a 20-ft radius sphere and deals half damage even on a successful DEX save!"
      });
    }

    // 9. Gnome Cunning & Save Advantages
    const saveAdvs = Array.isArray(myChar.saveAdvantages) ? myChar.saveAdvantages : [];
    if (
      rollSpec.kind === "save" &&
      (saveAdvs.includes(rollSpec.ability) ||
        (/gnome cunning/i.test(featText) && ["int", "wis", "cha"].includes(rollSpec.ability)))
    ) {
      modifiers.push({
        id: "gnome_cunning",
        title: "Gnome Cunning (Advantage vs Magic)",
        badge: "Advantage vs Magic",
        source: "Racial Trait",
        toggleable: true,
        defaultOn: true,
        grantsAdvantage: true,
        sayThis: `Gnome Cunning: if this ${ABILITY_LABELS[rollSpec.ability]} save is against a spell or magical effect, I roll with Advantage!`
      });
    }

    // 10. War Caster on Concentration Save
    if (rollSpec.isConcentration && /war caster/i.test(featText)) {
      modifiers.push({
        id: "war_caster",
        title: "War Caster — Advantage on Concentration",
        badge: "Advantage",
        source: "Feat",
        toggleable: true,
        defaultOn: true,
        grantsAdvantage: true,
        sayThis: "War Caster: I roll Concentration saving throws with Advantage!"
      });
    }

    // 11. Dwarven Resilience (Poison save advantage)
    if (rollSpec.kind === "save" && rollSpec.ability === "con" && /dwarven resilience/i.test(featText)) {
      modifiers.push({
        id: "dwarven_resilience",
        title: "Dwarven Resilience (if vs Poison)",
        badge: "Advantage + Poison Resist",
        source: "Racial Trait",
        toggleable: true,
        defaultOn: false,
        grantsAdvantage: true,
        sayThis: "Dwarven Resilience: if this is against poison, I have Advantage on the save and Resistance to the damage!"
      });
    }

    // 12. Artificer's Lore & Stonecunning on History checks
    if (rollSpec.slug === "history" && /artificer.?s lore/i.test(featText)) {
      const addBonus = rollSpec.tier === "proficiency" ? profBonus : rollSpec.tier === "expertise" ? 0 : profBonus * 2;
      modifiers.push({
        id: "artificers_lore",
        title: "Artificer's Lore (Magic / Alchemy / Tech History)",
        badge: addBonus > 0 ? `+${addBonus} (2× Prof)` : "2× Prof (check)",
        source: "Rock Gnome",
        toggleable: true,
        defaultOn: false,
        flatBonus: addBonus,
        sayThis: `Artificer's Lore: if this History check relates to magic items, alchemical objects, or tech devices, I add twice my proficiency (+${profBonus * 2} total Prof)!`
      });
    }
    if (rollSpec.slug === "history" && /stonecunning/i.test(featText)) {
      modifiers.push({
        id: "stonecunning",
        title: "Stonecunning (Stonework Origin History)",
        badge: "2× Proficiency",
        source: "Dwarf",
        toggleable: true,
        defaultOn: false,
        flatBonus: rollSpec.tier === "proficiency" ? profBonus : profBonus * 2,
        sayThis: "Stonecunning: if this History check is about the origin of stonework, I'm considered proficient with double proficiency!"
      });
    }

    // 13. Rogue Sneak Attack / Barbarian Rage / Paladin Divine Smite
    if (/\brogue\b/i.test(clsLow) && rollSpec.kind === "weapon_attack" && (rollSpec.isFinesse || rollSpec.isRanged)) {
      const saDice = `${Math.max(1, Math.ceil(Number(myChar.level || 1) / 2))}d6`;
      modifiers.push({
        id: "sneak_attack",
        title: `Sneak Attack (+${saDice}, 1/turn)`,
        badge: `+${saDice} Damage`,
        source: "Rogue",
        toggleable: true,
        defaultOn: false,
        damageDiceBonus: saDice,
        damageBonusType: "weapon (sneak)",
        sayThis: `Since I have Advantage or an ally within 5 ft, adding ${saDice} Sneak Attack damage!`
      });
    }

    if (/\bbarbarian\b/i.test(clsLow) && (rollSpec.kind === "weapon_attack" || rollSpec.ability === "str")) {
      const isRaging = condsLow.some((c) => /rag/i.test(c));
      if (rollSpec.kind === "weapon_attack" && rollSpec.ability === "str") {
        modifiers.push({
          id: "barbarian_rage_dmg",
          title: "Rage Melee Damage (+2)",
          badge: "+2 Damage",
          source: isRaging ? "Active Rage" : "Barbarian",
          toggleable: true,
          defaultOn: isRaging,
          damageFlatBonus: 2,
          sayThis: "While Raging, adding +2 melee damage!"
        });
      } else if (rollSpec.ability === "str") {
        modifiers.push({
          id: "barbarian_rage_adv",
          title: "Rage — Advantage on STR Checks/Saves",
          badge: "Advantage",
          source: isRaging ? "Active Rage" : "Barbarian",
          toggleable: true,
          defaultOn: isRaging,
          grantsAdvantage: true,
          sayThis: "Raging gives me Advantage on Strength checks and Strength saving throws!"
        });
      }
    }

    if (/\bpaladin\b/i.test(clsLow) && rollSpec.kind === "weapon_attack" && !rollSpec.isRanged) {
      modifiers.push({
        id: "divine_smite",
        title: "Divine Smite (+2d8 Radiant, L1 slot)",
        badge: "+2d8 Radiant",
        source: "Paladin",
        toggleable: true,
        defaultOn: false,
        damageDiceBonus: "2d8",
        damageBonusType: "radiant",
        sayThis: "Using Divine Smite with a 1st-level slot for an extra 2d8 radiant (+1d8 vs undead/fiend)!"
      });
    }

    // 14. Party Auras & Buffs (Lusomorris's Paladin Aura of Protection, Bless, Guidance!)
    const aura = getPaladinAuraBonus(party, myChar);
    if (aura && (rollSpec.kind === "save" || rollSpec.kind === "death_save")) {
      modifiers.push({
        id: "paladin_aura",
        title: `${aura.paladinName}'s Aura of Protection (within 10 ft)`,
        badge: `+${aura.bonus} to Save`,
        source: "Party Aura",
        toggleable: true,
        defaultOn: false,
        flatBonus: aura.bonus,
        sayThis: `Within 10 ft of ${aura.paladinName}: adding +${aura.bonus} from Paladin Aura of Protection!`
      });
    }

    const support = getPartySupportBuffs(party);
    const isBlessed = condsLow.some((c) => /bless/i.test(c));
    if ((isAttackRoll || rollSpec.kind === "save") && (isBlessed || support.blessSource)) {
      modifiers.push({
        id: "party_bless",
        title: `Bless (+1d4)${support.blessSource ? ` (${support.blessSource})` : ""}`,
        badge: "+1d4",
        source: isBlessed ? "Active Buff" : "Party Buff",
        toggleable: true,
        defaultOn: isBlessed,
        diceBonus: "1d4",
        sayThis: "Bless is up—adding +1d4 to the roll!"
      });
    }

    if ((rollSpec.kind === "skill" || rollSpec.kind === "initiative" || rollSpec.kind === "spell_check") && support.guidanceSource) {
      modifiers.push({
        id: "party_guidance",
        title: `Guidance (+1d4) (${support.guidanceSource})`,
        badge: "+1d4",
        source: "Party Cantrip",
        toggleable: true,
        defaultOn: false,
        diceBonus: "1d4",
        sayThis: `${support.guidanceSource} cast Guidance—adding +1d4 to the check!`
      });
    }

    // 15. Heroic Inspiration & Advantage / Disadvantage
    if (isD20Roll) {
      modifiers.push({
        id: "heroic_inspiration",
        title: myChar.inspiration
          ? "Heroic Inspiration ✨ (READY on Sheet!)"
          : "Heroic Inspiration ✨",
        badge: "Advantage / Reroll",
        source: myChar.inspiration ? "Active on Sheet" : "Optional",
        toggleable: true,
        defaultOn: Boolean(myChar.inspiration),
        grantsAdvantage: true,
        sayThis: "Using Heroic Inspiration for Advantage / reroll!"
      });

      modifiers.push({
        id: "help_advantage",
        title: "Help Action / Flanking / Unseen (Advantage)",
        badge: "Roll 2d20 High",
        source: "Situational",
        toggleable: true,
        defaultOn: false,
        grantsAdvantage: true,
        sayThis: ""
      });

      const hasDisadvCond =
        (isAttackRoll && condsLow.some((c) => /poisoned|prone|restrained|frightened|blinded/i.test(c))) ||
        (rollSpec.kind === "skill" && condsLow.some((c) => /poisoned|frightened/i.test(c))) ||
        (rollSpec.kind === "save" && rollSpec.ability === "dex" && condsLow.some((c) => /restrained/i.test(c)));

      if (hasDisadvCond) {
        modifiers.push({
          id: "condition_disadv",
          title: `Condition Penalty (${myChar.conditions.join(", ")})`,
          badge: "Disadvantage",
          source: "Active Condition",
          toggleable: true,
          defaultOn: true,
          grantsDisadvantage: true,
          sayThis: ""
        });
      }
    }

    const baseMod = Number(rollSpec.attackBonus || 0);
    const modTxt = baseMod >= 0 ? `+${baseMod}` : `${baseMod}`;
    let baseSummary = "";
    if (rollSpec.kind === "spell_attack" || rollSpec.kind === "weapon_attack") {
      baseSummary = `1d20 ${modTxt} to hit${rollSpec.damageFormula ? ` · ${rollSpec.damageFormula} ${(rollSpec.damageTypes || []).join("/")}` : ""}`;
    } else if (rollSpec.kind === "spell_save" || rollSpec.kind === "item_save") {
      baseSummary = `DC ${rollSpec.saveDc} ${rollSpec.saveAbility || ""} Save${rollSpec.damageFormula ? ` · ${rollSpec.damageFormula} ${(rollSpec.damageTypes || []).join("/")}` : ""}`;
    } else {
      baseSummary = `1d20 ${modTxt}`;
    }

    return {
      baseSummary: baseSummary.trim(),
      alreadyIncluded,
      modifiers
    };
  }

  function executeRoll(rollSpec, myChar, party = [], options = {}) {
    const rng = typeof options?.rng === "function" ? options.rng : Math.random;
    const analysis = analyzeRollPotential(rollSpec, myChar, party);

    const activeSet =
      options?.activeToggleIds instanceof Set
        ? options.activeToggleIds
        : Array.isArray(options?.activeToggleIds)
        ? new Set(options.activeToggleIds)
        : new Set(analysis.modifiers.filter((m) => m.defaultOn).map((m) => m.id));

    const activeMods = analysis.modifiers.filter((m) => activeSet.has(m.id));
    const isD20Roll =
      rollSpec.kind !== "spell_save" &&
      rollSpec.kind !== "item_save" &&
      rollSpec.kind !== "spell_auto";

    let d20Result = null;
    let isCrit = false;
    let isFumble = false;

    if (isD20Roll) {
      const clockwork = activeMods.find((m) => m.setD20To != null);
      const hasAdv = Boolean(options?.forceAdvantage) || activeMods.some((m) => m.grantsAdvantage);
      const hasDis = activeMods.some((m) => m.grantsDisadvantage);
      const rollMode = hasAdv && !hasDis ? "advantage" : hasDis && !hasAdv ? "disadvantage" : "normal";

      let rawD20s = [];
      let chosenD20 = 10;
      if (clockwork) {
        chosenD20 = Number(clockwork.setD20To);
        rawD20s = [chosenD20];
      } else if (rollMode === "normal") {
        const d = Math.min(20, Math.max(1, Math.floor(rng() * 20) + 1));
        rawD20s = [d];
        chosenD20 = d;
      } else {
        const d1 = Math.min(20, Math.max(1, Math.floor(rng() * 20) + 1));
        const d2 = Math.min(20, Math.max(1, Math.floor(rng() * 20) + 1));
        rawD20s = [d1, d2];
        chosenD20 = rollMode === "advantage" ? Math.max(d1, d2) : Math.min(d1, d2);
      }

      isCrit = chosenD20 === 20;
      isFumble = chosenD20 === 1;

      const baseMod = Number(rollSpec.attackBonus || 0);
      let flatExtra = 0;
      const bonusDiceRolls = [];

      for (const m of activeMods) {
        if (m.flatBonus) flatExtra += Number(m.flatBonus);
        if (m.diceBonus) {
          const br = rollDiceExpression(m.diceBonus, { rng });
          bonusDiceRolls.push({ label: m.title, ...br });
        }
      }

      const bonusDiceSum = bonusDiceRolls.reduce((s, r) => s + r.total, 0);
      d20Result = {
        mode: clockwork ? "flat-10" : rollMode,
        rawD20s,
        chosenD20,
        baseMod,
        flatExtra,
        bonusDiceRolls,
        total: chosenD20 + baseMod + flatExtra + bonusDiceSum,
        isCrit,
        isFumble
      };
    }

    // Damage / Healing Roll
    let damageResult = null;
    if (rollSpec.damageFormula) {
      const dmgTypesLow = (rollSpec.damageTypes || []).map((d) => String(d).toLowerCase());
      const eaMod = activeMods.find(
        (m) =>
          m.minDieValue > 1 &&
          (!m.minDieDamageTypes?.length ||
            m.minDieDamageTypes.some((t) => dmgTypesLow.includes(String(t).toLowerCase())))
      );
      const minDieValue = eaMod ? eaMod.minDieValue : 1;
      const baseRoll = rollDiceExpression(rollSpec.damageFormula, {
        rng,
        minDieValue,
        isCrit: isD20Roll && isCrit
      });

      const extraDamageRolls = [];
      let damageFlatExtra = 0;
      for (const m of activeMods) {
        if (m.damageDiceBonus) {
          const er = rollDiceExpression(m.damageDiceBonus, { rng, isCrit: isD20Roll && isCrit });
          extraDamageRolls.push({ label: m.title, type: m.damageBonusType || "", ...er });
        }
        if (m.damageFlatBonus) damageFlatExtra += Number(m.damageFlatBonus);
      }

      const extraSum = extraDamageRolls.reduce((s, r) => s + r.total, 0);
      damageResult = {
        ...baseRoll,
        damageTypes: rollSpec.damageTypes || [],
        extraDamageRolls,
        damageFlatExtra,
        total: baseRoll.total + extraSum + damageFlatExtra
      };
    }

    const callouts = activeMods.map((m) => m.sayThis).filter(Boolean);
    const parts = [];
    if (d20Result) {
      const tag = d20Result.isCrit ? " (NAT 20 CRIT!)" : d20Result.isFumble ? " (Nat 1)" : "";
      const verb =
        rollSpec.kind === "spell_attack" || rollSpec.kind === "weapon_attack"
          ? "to hit"
          : rollSpec.kind === "initiative"
          ? "Initiative"
          : "";
      parts.push(`I rolled ${d20Result.total} ${verb}${tag} on ${rollSpec.name}`.replace(/\s+/g, " ").trim());
    } else if (rollSpec.saveDc) {
      parts.push(`${rollSpec.name}: DC ${rollSpec.saveDc} ${rollSpec.saveAbility || ""} Save`);
    }
    if (damageResult) {
      const typeLabel = (damageResult.damageTypes || [])[0] || "";
      parts.push(
        `for ${damageResult.total} ${typeLabel} damage${
          damageResult.upgradedCount > 0 ? ` (${damageResult.upgradedCount}× rolled 1 upgraded to 2 via Elemental Adept!)` : ""
        }`.replace(/\s+/g, " ").trim()
      );
    }

    const headlineSay = parts.join(" ") + (parts.length ? "." : "");
    const sayAloudScript = [headlineSay, ...callouts].filter(Boolean).join(" ");

    return {
      rollSpec,
      analysis,
      d20Result,
      damageResult,
      activeMods,
      callouts,
      sayAloudScript,
      timestamp: Date.now()
    };
  }

  function matchLogEntryToCatalog(logEntry, catalog) {
    const raw = `${logEntry?.action || ""} ${logEntry?.rawText || ""}`.toLowerCase();
    const allSpecs = [
      ...(catalog.spellsAndAttacks || []),
      ...(catalog.saves || []),
      ...(catalog.skills || [])
    ];

    // Exact spell/weapon/skill name match first
    for (const sp of allSpecs) {
      const nameLow = sp.name.toLowerCase();
      if (raw.includes(nameLow)) return sp;
      const firstWord = nameLow.replace(/\(.*\)/, "").trim();
      if (firstWord.length >= 4 && raw.includes(firstWord)) return sp;
    }

    // Match ability saving throw ("dexterity save", "wis saving throw", "concentration")
    if (/conc/i.test(raw) && /sav|check/i.test(raw)) {
      return (catalog.saves || []).find((s) => s.id === "save:con-conc") || null;
    }
    if (logEntry?.kind === "save" || /\bsav(e|ing)\b/i.test(raw)) {
      const abilMap = [
        [/\b(str|strength)\b/i, "save:str"],
        [/\b(dex|dexterity)\b/i, "save:dex"],
        [/\b(con|constitution)\b/i, "save:con"],
        [/\b(int|intelligence)\b/i, "save:int"],
        [/\b(wis|wisdom)\b/i, "save:wis"],
        [/\b(cha|charisma)\b/i, "save:cha"]
      ];
      for (const [re, id] of abilMap) {
        if (re.test(raw)) return (catalog.saves || []).find((s) => s.id === id) || null;
      }
      return (catalog.saves || [])[0] || null;
    }

    if (logEntry?.kind === "initiative" || /\binitiative\b/i.test(raw)) {
      return (catalog.skills || []).find((s) => s.id === "skill:initiative") || null;
    }

    if (logEntry?.kind === "attack" || /\b(spell attack|to hit)\b/i.test(raw)) {
      return (
        (catalog.spellsAndAttacks || []).find((s) => s.kind === "spell_attack") ||
        (catalog.spellsAndAttacks || [])[0] ||
        null
      );
    }

    return null;
  }

  function analyzeAboveVttRoll(logEntry, myChar, party = []) {
    if (!logEntry || !myChar) return null;
    const catalog = getRollCatalog(myChar, party);
    const matchedSpec =
      matchLogEntryToCatalog(logEntry, catalog) || {
        id: "generic:roll",
        category: "skills",
        name: logEntry.action || "Roll",
        kind:
          logEntry.kind === "attack"
            ? "spell_attack"
            : logEntry.kind === "save"
            ? "save"
            : logEntry.kind === "initiative"
            ? "initiative"
            : "skill",
        attackBonus: 0,
        damageTypes: []
      };

    const analysis = analyzeRollPotential(matchedSpec, myChar, party);
    const reminders = analysis.modifiers
      .filter((m) => m.sayThis || m.flatBonus || m.diceBonus || m.grantsAdvantage || m.minDieValue)
      .map((m) => {
        let extraNote = m.badge || "";
        if (m.flatBonus && logEntry.total != null) {
          extraNote = `${logEntry.total} → ${Number(logEntry.total) + m.flatBonus} (${m.badge})`;
        }
        return {
          id: m.id,
          title: m.title,
          badge: m.badge,
          extraNote,
          sayThis: m.sayThis,
          defaultOn: m.defaultOn
        };
      });

    return {
      logEntry,
      matchedSpec,
      analysis,
      reminders,
      timestamp: Date.now()
    };
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.RollMaximizer = {
    getPaladinAuraBonus,
    getPartySupportBuffs,
    parseDiceTerms,
    rollDiceExpression,
    getRollCatalog,
    analyzeRollPotential,
    executeRoll,
    analyzeAboveVttRoll
  };
})(window);
