/**
 * Player-Fair Content Script for D&D Beyond + AboveVTT.
 *
 * FAIRNESS GUARANTEE:
 * - Runs in Chrome's isolated content-script world (cannot access internal JS state like window.TOKEN_OBJECTS).
 * - Never inspects hidden tokens (ishidden="true", opacity 0.5, or display:none).
 * - Never inspects hidden DM game-log rolls (display:none).
 * - Never reads monster statblock IDs (data-monster / data-stat) or DM-only HP inputs.
 * - Only reads player-visible initiative rows, revealed names, visible condition badges (e.g. bloodied),
 *   visible game-log dice results, and campaign party character links.
 */
(function () {
  if (window.__DND_COPILOT_CONTENT_ACTIVE__) return;
  window.__DND_COPILOT_CONTENT_ACTIVE__ = true;

  let cobaltToken = null;
  let cobaltTokenExpiresAt = 0;
  const seenRollFingerprints = new Set();
  let hasBaselineGameLog = false;
  let lastSnapshotHash = "";
  let rollContext = { myChar: null, party: [] };
  let coachFilterQuery = "";
  let coachDrawerOpen = false;
  let coachToastTimer = null;
  let suppressClickCoachUntil = 0;
  let activeCoachState = null;

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) {
      return false;
    }
    return true;
  }

  function extractCharacterIdFromString(str) {
    if (!str) return null;
    const match = String(str).match(/characters\/(\d{4,12})/i);
    if (match) return match[1];
    const trailingDigits = String(str).match(/(?:^|\/)(\d{6,12})(?:$|[/?#])/);
    return trailingDigits ? trailingDigits[1] : null;
  }

  function discoverPartyCharacters() {
    const found = new Map();

    // 1. AboveVTT player panel cards (.player-card[data-player-id])
    document.querySelectorAll(".player-card[data-player-id]").forEach((card) => {
      const sheetRef = card.getAttribute("data-player-id") || "";
      const id = extractCharacterIdFromString(sheetRef);
      const name = card.querySelector(".player-name")?.textContent?.trim() || "";
      const avatar = card.querySelector(".player-token img")?.getAttribute("src") || "";
      if (id) {
        found.set(id, { id, name: name || `Character ${id}`, avatar, sheetUrl: sheetRef });
      }
    });

    // 2. D&D Beyond campaign page character cards
    document.querySelectorAll("a[href*='/characters/']").forEach((link) => {
      const href = link.getAttribute("href") || "";
      const id = extractCharacterIdFromString(href);
      if (!id || found.has(id)) return;
      const card = link.closest("[class*='character'], .ddb-campaigns-character-card, li, div");
      const nameEl = card?.querySelector(
        ".ddb-campaigns-character-card-header-upper-character-info-primary, [class*='characterName'], h3, h4"
      );
      const name = (nameEl?.textContent || link.textContent || "").trim();
      if (name && !/^(view|edit|create|claim)/i.test(name) && name.length < 60) {
        found.set(id, { id, name, avatar: "", sheetUrl: href });
      }
    });

    // 3. Direct character sheet URL if user currently has a sheet open
    const currentSheetId = extractCharacterIdFromString(window.location.pathname);
    if (currentSheetId && !found.has(currentSheetId)) {
      const sheetName =
        document.querySelector("[class*='characterName'], .ddbc-character-name")?.textContent?.trim() ||
        `Character ${currentSheetId}`;
      found.set(currentSheetId, {
        id: currentSheetId,
        name: sheetName,
        avatar: "",
        sheetUrl: window.location.href
      });
    }

    return Array.from(found.values());
  }

  function collectPlayerFairCombatTracker() {
    const roundInput = document.getElementById("round_number");
    const round = roundInput ? parseInt(roundInput.value, 10) || 1 : null;
    const rows = Array.from(document.querySelectorAll("#combat_area tr.CTToken, #combat_area tr[data-target]"));

    const combatants = [];
    let unnamedCounter = 0;

    for (const row of rows) {
      // Strictly skip hidden DM tokens
      if (row.getAttribute("ishidden") === "true") continue;
      if (!isElementVisible(row)) continue;

      const targetId = row.getAttribute("data-target") || "";
      if (!targetId) continue;

      const portrait = row.querySelector("img, video");
      if (portrait && window.getComputedStyle(portrait).opacity === "0.5") {
        continue;
      }

      const isPlayer =
        targetId.includes("/profile") ||
        targetId.includes("/characters/") ||
        Boolean(extractCharacterIdFromString(targetId));

      // AboveVTT only populates data-name on tr.CTToken when isPlayer() or DM enabled revealname
      const revealedAttrName = row.getAttribute("data-name")?.trim() || "";
      const visibleLabel =
        row.querySelector(".token-name, .ct-name, .name")?.textContent?.trim() || "";
      let displayName = revealedAttrName || visibleLabel;
      const isNameRevealed = Boolean(displayName);
      if (!displayName) {
        unnamedCounter += 1;
        displayName = isPlayer ? `Party Member #${unnamedCounter}` : `Unidentified Foe #${unnamedCounter}`;
      }

      const isCurrentTurn = row.getAttribute("data-current") === "1" || row.classList.contains("current-turn");
      const initInput = row.querySelector("input.init");
      const initiative =
        initInput && isElementVisible(initInput) && initInput.value !== ""
          ? parseFloat(initInput.value)
          : null;

      // Collect strictly player-visible condition icons (e.g., bloodied, concentrating, blessed)
      const conditions = new Set();
      row.querySelectorAll(".conditions [id], .conditions img[title], .conditions img[alt]").forEach((el) => {
        const label = el.getAttribute("id") || el.getAttribute("title") || el.getAttribute("alt") || "";
        if (label.trim()) conditions.add(label.trim());
      });

      // Also check visible map token for bloodied/condition overlays if rendered to players
      const safeSelectorId = CSS.escape ? CSS.escape(targetId) : targetId.replace(/['"\\]/g, "");
      const mapToken = document.querySelector(`#tokens .token[data-id="${safeSelectorId}"]`);
      if (mapToken && isElementVisible(mapToken)) {
        mapToken.querySelectorAll("img[src*='bloodied'], .conditions [id]").forEach((el) => {
          if (el.getAttribute("src")?.includes("bloodied")) {
            conditions.add("Bloodied");
          } else if (el.getAttribute("id")) {
            conditions.add(el.getAttribute("id").trim());
          }
        });
      }

      // Check if DM explicitly opted to show a player-visible health bar (% width only, never hidden inputs)
      let visibleHealthPercent = null;
      const visibleBar =
        row.querySelector(".hp-bar-fill, .health-bar-fill, progress") ||
        (mapToken && isElementVisible(mapToken)
          ? mapToken.querySelector(".hp-bar-fill, .health-bar-fill, progress")
          : null);
      if (visibleBar && isElementVisible(visibleBar)) {
        if (visibleBar.tagName === "PROGRESS" && visibleBar.max > 0) {
          visibleHealthPercent = Math.round((visibleBar.value / visibleBar.max) * 100);
        } else if (visibleBar.style?.width?.endsWith("%")) {
          const pct = parseFloat(visibleBar.style.width);
          if (!Number.isNaN(pct)) visibleHealthPercent = Math.round(pct);
        }
      }

      const avatarSrc = portrait?.getAttribute("src") || "";
      const borderColor = portrait?.style?.borderColor || "";

      combatants.push({
        tokenId: targetId,
        name: displayName,
        isNameRevealed,
        isPlayer,
        characterId: extractCharacterIdFromString(targetId),
        isCurrentTurn,
        initiative: Number.isFinite(initiative) ? initiative : null,
        conditions: Array.from(conditions),
        isBloodied: Array.from(conditions).some((c) => /bloodied/i.test(c)),
        visibleHealthPercent,
        avatar: avatarSrc.startsWith("http") ? avatarSrc : "",
        color: borderColor
      });
    }

    return {
      inCombat: combatants.length > 0,
      round: combatants.length > 0 ? round || 1 : null,
      combatants
    };
  }

  function classifyRollKind(rawText, rollTypeText) {
    const combined = `${rollTypeText} ${rawText}`.toLowerCase();
    if (/\bheal(ing)?\b/.test(combined)) return "heal";
    if (/\binitiative\b/.test(combined)) return "initiative";
    if (/\bdamage\b/.test(combined)) return "damage";
    if (/\b(to hit|attack)\b/.test(combined)) return "attack";
    if (/\bsav(e|ing throw)\b/.test(combined)) return "save";
    if (/\b(check|perception|stealth|investigation|insight|arcana|athletics|acrobatics|persuasion|deception|intimidation|history|nature|religion|medicine|survival|sleight|performance)\b/.test(combined)) {
      return "check";
    }
    return "roll";
  }

  function parseGameLogEntry(li) {
    // Strictly skip DM-only hidden game log entries and our own coach UI
    if (!isElementVisible(li)) return null;
    if (li.closest("#dnd-copilot-roll-toast, #dnd-copilot-roll-drawer, #dnd-copilot-roll-pill, #dnd-copilot-cross-tab-alert")) {
      return null;
    }

    const rawText = (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText || rawText.length < 2) return null;

    // Extract structured segments from DDB / AboveVTT / Noty game log markup
    const actionLabel =
      li.querySelector(
        "[class*='action'], [class*='rollName'], [class*='title'], .dice_result__info__title, [class*='RollName'], [class*='Source']"
      )?.textContent?.trim() || "";

    let sender =
      li.querySelector(
        "[class*='sender'], [class*='characterName'], [class*='playerName'], .gamelog-character-name, .dice_result__info__rolldetail-character"
      )?.textContent?.trim() || "";

    if (!sender) {
      const strongText = li.querySelector("strong, b")?.textContent?.trim() || "";
      if (
        strongText &&
        strongText !== actionLabel &&
        !/^\d+$/.test(strongText) &&
        !/\b(to hit|damage|saving throw|ability check|critical)\b/i.test(strongText) &&
        strongText.length <= 36
      ) {
        sender = strongText;
      }
    }

    const myId = rollContext?.myChar?.id ? String(rollContext.myChar.id) : "";
    const isMyCharSheet = Boolean(myId && window.location.pathname.includes(`/characters/${myId}`));
    if ((!sender || /^(table|roll|message)$/i.test(sender) || (isMyCharSheet && !li.querySelector("[class*='sender'], [class*='characterName'], [class*='playerName'], .gamelog-character-name"))) && isMyCharSheet) {
      sender = rollContext.myChar.name || sender;
    } else if (!sender && rollContext?.myChar?.name && (li.matches(".noty_body, .dice_result") || li.closest(".noty_body, [class*='DiceNotification']"))) {
      sender = rollContext.myChar.name;
    }

    const rollTypeLabel =
      li.querySelector(
        "[class*='rollType'], .dice_result__rolltype, [class*='subTitle'], .dice_result__info__breakdown"
      )?.textContent?.trim() || "";

    const totalEl = li.querySelector(
      ".dice_result__total-result, [class*='resultTotal'], [class*='finalResult'], [class*='totalResult'], [class*='Total'], [class*='total']"
    );

    let total = null;
    if (totalEl) {
      const parsed = parseInt(totalEl.textContent.replace(/[^\d-]/g, ""), 10);
      if (Number.isFinite(parsed)) total = parsed;
    }

    const formulaMatch = rawText.match(/\b(\d+d\d+(?:\s*[+-]\s*\d+)?)\b/i);
    const formula = formulaMatch ? formulaMatch[1].replace(/\s+/g, "") : "";

    // Fallback numeric extraction for AboveVTT / DDB dice toast cards
    if (total === null && (formula || li.matches(".noty_body, .dice_result, [class*='DiceResult'], [class*='DiceNotification']"))) {
      const numbers =
        rawText.match(/(?:=|:|\bresult\b|\btotal\b)\s*(-?\d{1,4})\b/i) ||
        rawText.match(/\b(-?\d{1,3})\s*$/);
      if (numbers) {
        const parsed = parseInt(numbers[1], 10);
        if (Number.isFinite(parsed)) total = parsed;
      }
    }

    const isCrit =
      Boolean(li.querySelector("[class*='crit'], [class*='critical'], .nat20")) ||
      /\b(critical hit|nat(?:ural)? 20)\b/i.test(rawText);
    const isFumble =
      Boolean(li.querySelector("[class*='fumble'], [class*='fail'], .nat1")) ||
      /\b(critical miss|nat(?:ural)? 1)\b/i.test(rawText);

    const timeLabel = li.querySelector("time")?.textContent?.trim() || "";
    const kind = total !== null ? classifyRollKind(rawText, `${actionLabel} ${rollTypeLabel}`) : "chat";

    const fingerprint = `${sender}|${actionLabel}|${kind}|${total}|${rawText.slice(0, 120)}|${timeLabel}`;

    return {
      fingerprint,
      timestamp: Date.now(),
      actor: sender || "Table",
      action: actionLabel || rollTypeLabel || (kind === "chat" ? "Message" : "Roll"),
      kind,
      total,
      formula,
      isCrit,
      isFumble,
      rawText: rawText.slice(0, 280)
    };
  }

  function collectVisibleGameLog(onlyNew = false) {
    const candidates = [];
    const containers = document.querySelectorAll(
      ".ct-game-log-pane, [class*='styles_gameLog'], [class*='GameLog'], #gamelog_panel, #gamelog"
    );
    containers.forEach((container) => {
      container.querySelectorAll("li, [class*='GameLogEntry'], [class*='gameLogEntry'], [class*='entry']").forEach((el) => {
        candidates.push(el);
      });
    });
    document
      .querySelectorAll(".noty_body, .dice_result, [class*='DiceNotification'], [class*='DiceResult'], [class*='RollResult']")
      .forEach((el) => {
        candidates.push(el);
      });

    // Dedupe nested elements so outer card & inner dice_result aren't parsed twice
    const candidateSet = new Set(candidates);
    const topNodes = candidates.filter((node) => {
      let p = node.parentElement;
      while (p) {
        if (candidateSet.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });

    const entries = [];
    const seenInPass = new Set();

    topNodes.forEach((node) => {
      const parsed = parseGameLogEntry(node);
      if (!parsed || seenInPass.has(parsed.fingerprint)) return;
      seenInPass.add(parsed.fingerprint);

      const isNew = !seenRollFingerprints.has(parsed.fingerprint);
      if (isNew) {
        seenRollFingerprints.add(parsed.fingerprint);
      }
      if (!onlyNew || isNew) {
        entries.push(parsed);
      }
    });

    return entries.slice(-40);
  }

  function buildSnapshot() {
    const isAboveVttActive = Boolean(
      document.getElementById("combat_tracker") ||
        document.getElementById("tokens") ||
        document.querySelector(".player-card[data-player-id]") ||
        document.querySelector("[id*='abovevtt']")
    );

    const partyCharacters = discoverPartyCharacters();
    const combat = collectPlayerFairCombatTracker();
    const recentLog = collectVisibleGameLog(false);

    return {
      capturedAt: Date.now(),
      pageTitle: document.title,
      pageUrl: window.location.href,
      isAboveVttActive,
      partyCharacters,
      combat,
      recentLog
    };
  }

  function normalizeRollLookupName(raw) {
    return String(raw || "")
      .replace(/['’`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function findVisibleNativeDdbRollButton(rollSpec, part = "tohit") {
    if (!rollSpec || !document.body) return null;

    if (rollSpec.kind === "save" && rollSpec.ability) {
      const row = document.querySelector(`.ddbc-saving-throws-summary__ability--${rollSpec.ability}`);
      const btn = row?.querySelector("button.integrated-dice__container");
      if (btn && isElementVisible(btn)) return btn;
    }

    if (rollSpec.kind === "initiative") {
      const initLbl = document.querySelector("[data-testid='combat-initiative-label']");
      const box = initLbl?.closest("[class*='box']") || initLbl?.parentElement;
      const btn = box?.querySelector("button.integrated-dice__container");
      if (btn && isElementVisible(btn)) return btn;
    }

    if (rollSpec.kind === "skill") {
      const targetNorm = normalizeRollLookupName(rollSpec.name);
      const rows = document.querySelectorAll(".ct-skills__item");
      for (const row of rows) {
        if (!isElementVisible(row)) continue;
        const skillName = normalizeRollLookupName(
          row.querySelector(".ct-skills__col--skill")?.textContent
        );
        if (skillName === targetNorm) {
          const btn = row.querySelector(".ct-skills__col--modifier button.integrated-dice__container");
          if (btn && isElementVisible(btn)) return btn;
        }
      }
    }

    if (rollSpec.isSpell || rollSpec.kind === "weapon_attack" || rollSpec.kind === "spell_attack" || rollSpec.kind === "spell_save" || rollSpec.kind === "spell_check") {
      const targetNorm = normalizeRollLookupName(rollSpec.name);
      const attackRows = document.querySelectorAll(".ddbc-combat-attack");
      for (const row of attackRows) {
        if (!isElementVisible(row)) continue;
        const rowName = normalizeRollLookupName(
          row.querySelector(".styles_spellName__wX3ll, .ddbc-combat-attack__label, .ddbc-combat-attack__name")?.textContent
        );
        if (rowName && (rowName === targetNorm || rowName.includes(targetNorm) || targetNorm.includes(rowName))) {
          const dmgBtn = row.querySelector(".ddbc-combat-attack__damage button.integrated-dice__container");
          const hitBtn = row.querySelector(".ddbc-combat-attack__tohit button.integrated-dice__container");
          const picked = part === "damage" ? dmgBtn || hitBtn : hitBtn || dmgBtn;
          if (picked && isElementVisible(picked)) return picked;
        }
      }

      const spellRows = document.querySelectorAll(".ct-spells-spell");
      for (const row of spellRows) {
        if (!isElementVisible(row)) continue;
        const rowName = normalizeRollLookupName(
          row.querySelector(".styles_spellName__wX3ll, .ct-spells-spell__label, .ct-spells-spell__name")?.textContent
        );
        if (rowName && (rowName === targetNorm || rowName.includes(targetNorm) || targetNorm.includes(rowName))) {
          const dmgBtn = row.querySelector(".ct-spells-spell__damage button.integrated-dice__container");
          const hitBtn = row.querySelector(".ct-spells-spell__tohit button.integrated-dice__container");
          const picked = part === "damage" ? dmgBtn || hitBtn : hitBtn || dmgBtn;
          if (picked && isElementVisible(picked)) return picked;
        }
      }
    }

    return null;
  }

  async function triggerNativeDdbRoll(rollSpec, part = "tohit") {
    let btn = findVisibleNativeDdbRollButton(rollSpec, part);
    if (!btn && (rollSpec.isSpell || rollSpec.kind === "weapon_attack" || rollSpec.kind === "spell_attack" || rollSpec.kind === "spell_save")) {
      const desiredTestId = rollSpec.isSpell ? "SPELLS" : "ACTIONS";
      let tabBtn = document.querySelector(`button[data-testid='${desiredTestId}']`);
      if (tabBtn && tabBtn.getAttribute("aria-checked") !== "true") {
        tabBtn.click();
        await new Promise((r) => setTimeout(r, 170));
        btn = findVisibleNativeDdbRollButton(rollSpec, part);
      }
      if (!btn && rollSpec.isSpell) {
        tabBtn = document.querySelector("button[data-testid='ACTIONS']");
        if (tabBtn && tabBtn.getAttribute("aria-checked") !== "true") {
          tabBtn.click();
          await new Promise((r) => setTimeout(r, 170));
          btn = findVisibleNativeDdbRollButton(rollSpec, part);
        }
      }
    }

    if (!btn) return { triggered: false };
    suppressClickCoachUntil = Date.now() + 300;
    btn.click();
    return { triggered: true, part };
  }

  function renderRollCoachToast() {
    const st = activeCoachState;
    if (!st) {
      document.getElementById("dnd-copilot-roll-toast")?.remove();
      return;
    }

    let card = document.getElementById("dnd-copilot-roll-toast");
    if (!card) {
      card = document.createElement("div");
      card.id = "dnd-copilot-roll-toast";
      Object.assign(card.style, {
        position: "fixed",
        bottom: "64px",
        right: "16px",
        zIndex: "2147483646",
        width: "390px",
        maxWidth: "calc(100vw - 32px)",
        background: "#171d2b",
        border: "1.5px solid #f0c46c",
        borderRadius: "12px",
        padding: "12px 14px",
        color: "#f3f6fc",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13.5px",
        lineHeight: "1.45",
        boxShadow: "0 14px 36px rgba(0,0,0,0.75)"
      });
      document.body.appendChild(card);
    }
    card.textContent = "";

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "6px",
      marginBottom: "6px"
    });
    const titleEl = document.createElement("strong");
    titleEl.style.color = "#f0c46c";
    titleEl.style.flex = "1";
    const totalSuffix =
      st.rolledTotal != null
        ? st.appliedAddonBonus
          ? ` (${st.rolledTotal} → ${st.rolledTotal + st.appliedAddonBonus})`
          : ` (Rolled ${st.rolledTotal})`
        : "";
    titleEl.textContent = `🎲 ${st.title}${totalSuffix}`;

    const actionBtns = document.createElement("div");
    Object.assign(actionBtns.style, { display: "flex", alignItems: "center", gap: "4px" });

    if (st.sayScript) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "📋";
      copyBtn.title = "Copy Say-Aloud script";
      Object.assign(copyBtn.style, {
        background: "#1f273a",
        border: "1px solid #2c3752",
        borderRadius: "5px",
        color: "#f3f6fc",
        cursor: "pointer",
        fontSize: "12px",
        padding: "2px 6px"
      });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard?.writeText(st.sayScript).catch(() => {});
        copyBtn.textContent = "✓";
        setTimeout(() => {
          copyBtn.textContent = "📋";
        }, 1200);
      });
      actionBtns.appendChild(copyBtn);
    }

    const openDrawerBtn = document.createElement("button");
    openDrawerBtn.type = "button";
    openDrawerBtn.textContent = "🎲";
    openDrawerBtn.title = "Open 1-Click Quick Roll bar";
    Object.assign(openDrawerBtn.style, {
      background: "#1f273a",
      border: "1px solid #2c3752",
      borderRadius: "5px",
      color: "#f0c46c",
      cursor: "pointer",
      fontSize: "12px",
      padding: "2px 6px"
    });
    openDrawerBtn.addEventListener("click", () => {
      coachDrawerOpen = true;
      renderFloatingRollDrawer();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent",
      border: "none",
      color: "#cbd5e8",
      cursor: "pointer",
      fontSize: "15px"
    });
    closeBtn.addEventListener("click", () => {
      activeCoachState = null;
      card.remove();
    });
    actionBtns.append(openDrawerBtn, closeBtn);
    header.append(titleEl, actionBtns);
    card.appendChild(header);

    if (st.sayScript) {
      const sayBox = document.createElement("div");
      Object.assign(sayBox.style, {
        padding: "7px 10px",
        borderLeft: "3px solid #f0c46c",
        borderRadius: "0 8px 8px 0",
        background: "rgba(240, 196, 108, 0.13)",
        color: "#fef3c7",
        marginBottom: "6px"
      });
      sayBox.textContent = `🗣️ Say: “${st.sayScript}”`;
      card.appendChild(sayBox);
    }

    if (st.bullets && st.bullets.length > 0) {
      const ul = document.createElement("ul");
      Object.assign(ul.style, { margin: "4px 0 6px 16px", padding: "0", color: "#cbd5e8" });
      for (const b of st.bullets.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    // 1-click VTT follow-ups & situational bonus math right inside the popup
    const followRow = document.createElement("div");
    Object.assign(followRow.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
      marginTop: "4px"
    });

    const rm = window.DnDCopilot?.RollMaximizer;
    if (st.matchedSpec && st.part !== "damage" && (st.matchedSpec.damageFormula || st.matchedSpec.kind === "spell_attack" || st.matchedSpec.kind === "weapon_attack")) {
      const dmgFollowBtn = document.createElement("button");
      dmgFollowBtn.type = "button";
      dmgFollowBtn.textContent = `💥 Roll ${st.matchedSpec.damageFormula || "Damage"} → VTT`;
      Object.assign(dmgFollowBtn.style, {
        padding: "4px 9px",
        borderRadius: "6px",
        border: "1px solid #3ecf8e",
        background: "rgba(62, 207, 142, 0.16)",
        color: "#6ee7b7",
        fontSize: "12px",
        fontWeight: "700",
        cursor: "pointer"
      });
      dmgFollowBtn.addEventListener("click", async () => {
        const res = await triggerNativeDdbRoll(st.matchedSpec, "damage");
        if (res.triggered) {
          showAnalyzedRollCoach(st.matchedSpec, "damage", null);
        }
      });
      followRow.appendChild(dmgFollowBtn);
    }

    if (st.matchedSpec && st.part !== "damage" && st.matchedSpec.kind !== "spell_save" && st.matchedSpec.kind !== "item_save") {
      const advBtn = document.createElement("button");
      advBtn.type = "button";
      advBtn.textContent = st.hasAdvantageFeature ? "⚡ Roll 2nd d20 (Adv) → VTT" : "⚡ 2nd d20 → VTT";
      Object.assign(advBtn.style, {
        padding: "4px 9px",
        borderRadius: "6px",
        border: "1px solid #5b8af5",
        background: "rgba(91, 138, 245, 0.18)",
        color: "#bfdbfe",
        fontSize: "12px",
        fontWeight: "700",
        cursor: "pointer"
      });
      advBtn.addEventListener("click", async () => {
        await triggerNativeDdbRoll(st.matchedSpec, "tohit");
      });
      followRow.appendChild(advBtn);
    }

    for (const addon of st.addons || []) {
      const applied = st.appliedAddonIds?.has(addon.id);
      const aBtn = document.createElement("button");
      aBtn.type = "button";
      aBtn.textContent = applied ? `✓ ${addon.shortLabel}` : `+ ${addon.shortLabel}`;
      Object.assign(aBtn.style, {
        padding: "4px 8px",
        borderRadius: "6px",
        border: applied ? "1px solid #f0c46c" : "1px solid #2c3752",
        background: applied ? "rgba(240, 196, 108, 0.22)" : "#1f273a",
        color: applied ? "#fde68a" : "#cbd5e8",
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer"
      });
      aBtn.addEventListener("click", () => {
        if (!st.appliedAddonIds) st.appliedAddonIds = new Set();
        if (st.appliedAddonIds.has(addon.id)) {
          st.appliedAddonIds.delete(addon.id);
        } else {
          let val = Number(addon.flatBonus || 0);
          if (addon.diceBonus && rm?.rollDiceExpression) {
            val += rm.rollDiceExpression(addon.diceBonus).total;
          }
          addon.rolledValue = val;
          st.appliedAddonIds.add(addon.id);
        }
        st.appliedAddonBonus = (st.addons || [])
          .filter((a) => st.appliedAddonIds.has(a.id))
          .reduce((sum, a) => sum + Number(a.rolledValue || 0), 0);
        renderRollCoachToast();
      });
      followRow.appendChild(aBtn);
    }

    if (followRow.children.length > 0) {
      card.appendChild(followRow);
    }

    if (coachToastTimer) clearTimeout(coachToastTimer);
    coachToastTimer = setTimeout(() => {
      activeCoachState = null;
      document.getElementById("dnd-copilot-roll-toast")?.remove();
    }, 20000);
  }

  function showAnalyzedRollCoach(matchedSpec, part = "tohit", rolledTotal = null, rawActionLabel = "") {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !matchedSpec) return;

    const analysis = rm.analyzeRollPotential(matchedSpec, myChar, rollContext.party || []);
    const activeMods = (analysis.modifiers || []).filter((m) => m.sayThis || m.flatBonus || m.diceBonus || m.grantsAdvantage || m.minDieValue);
    const sayLines = activeMods
      .filter((m) => m.defaultOn || m.flatBonus || m.diceBonus || m.id === "gnome_cunning")
      .map((m) => m.sayThis)
      .filter(Boolean)
      .slice(0, 3);
    const bullets = activeMods.slice(0, 4).map((m) => {
      const note = m.flatBonus && rolledTotal != null ? `${rolledTotal} → ${rolledTotal + m.flatBonus} (${m.badge})` : m.badge;
      return `${m.title}${note ? ` — ${note}` : ""}`;
    });

    const addons = activeMods
      .filter((m) => m.flatBonus || m.diceBonus)
      .map((m) => ({
        id: m.id,
        shortLabel: m.badge || m.title.slice(0, 18),
        flatBonus: m.flatBonus || 0,
        diceBonus: m.diceBonus || ""
      }));

    activeCoachState = {
      matchedSpec,
      part,
      rolledTotal,
      title: `${myChar.name} · ${matchedSpec.name || rawActionLabel || "Roll"}${part === "damage" ? " Damage" : ""}`,
      sayScript: sayLines.join(" "),
      bullets,
      hasAdvantageFeature: activeMods.some((m) => m.grantsAdvantage),
      addons,
      appliedAddonIds: new Set(),
      appliedAddonBonus: 0
    };
    renderRollCoachToast();
  }

  function showRollCoachToast(title, bullets = [], sayScript = "") {
    activeCoachState = {
      matchedSpec: null,
      part: "tohit",
      rolledTotal: null,
      title: title || "Full Potential Coach",
      sayScript,
      bullets,
      hasAdvantageFeature: false,
      addons: [],
      appliedAddonIds: new Set(),
      appliedAddonBonus: 0
    };
    renderRollCoachToast();
  }

  function coachNewAboveVttRolls(newRolls) {
    if (!hasBaselineGameLog) return;
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !Array.isArray(newRolls) || newRolls.length === 0) return;

    const myFirst = String(myChar.name || "").trim().split(/\s+/)[0].toLowerCase();
    for (const roll of newRolls) {
      if (!roll || roll.kind === "chat") continue;
      const actorLow = String(roll.actor || "").toLowerCase();
      if (actorLow !== String(myChar.name || "").toLowerCase() && !(myFirst.length >= 3 && actorLow.includes(myFirst))) {
        continue;
      }
      const res = rm.analyzeAboveVttRoll(roll, myChar, rollContext.party || []);
      if (!res) continue;

      const part = roll.kind === "damage" ? "damage" : "tohit";
      if (
        activeCoachState &&
        activeCoachState.matchedSpec?.id === res.matchedSpec?.id &&
        Date.now() - (activeCoachState.updatedAt || 0) < 4000 &&
        roll.total != null
      ) {
        activeCoachState.rolledTotal = roll.total;
        activeCoachState.updatedAt = Date.now();
        renderRollCoachToast();
        continue;
      }

      if (res.matchedSpec) {
        showAnalyzedRollCoach(res.matchedSpec, part, roll.total, roll.action);
        if (activeCoachState) activeCoachState.updatedAt = Date.now();
      }
    }
  }

  function shouldShowFloatingRollUi() {
    if (!document.body) return false;
    if (window.innerWidth < 280 || window.innerHeight < 200) return false;
    if (window.top === window) {
      return (
        /\/(?:characters|campaigns|games)\//i.test(window.location.pathname) ||
        Boolean(
          document.getElementById("combat_tracker") ||
            document.getElementById("tokens") ||
            document.querySelector(".player-card[data-player-id], .ct-character-sheet")
        )
      );
    }
    return (
      /\/characters\/\d+/i.test(window.location.pathname) ||
      /abovevtt=true/i.test(window.location.search) ||
      Boolean(document.querySelector(".ct-character-sheet"))
    );
  }

  function makeQuickChipBtn(label, sub, isAccent = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    Object.assign(btn.style, {
      padding: "5px 8px",
      borderRadius: "7px",
      border: isAccent ? "1px solid #3ecf8e" : "1px solid #2c3752",
      background: isAccent ? "rgba(62, 207, 142, 0.14)" : "#1f273a",
      color: isAccent ? "#6ee7b7" : "#f3f6fc",
      fontSize: "12.5px",
      fontWeight: "600",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      textAlign: "left"
    });
    const t = document.createElement("span");
    t.textContent = label;
    btn.appendChild(t);
    if (sub) {
      const s = document.createElement("span");
      s.style.cssText = "color:#f0c46c;font-weight:700;font-size:12px;";
      s.textContent = sub;
      btn.appendChild(s);
    }
    return btn;
  }

  function renderFloatingRollDrawer() {
    if (!shouldShowFloatingRollUi()) return;
    let pill = document.getElementById("dnd-copilot-roll-pill");
    if (!pill && document.body) {
      pill = document.createElement("button");
      pill.id = "dnd-copilot-roll-pill";
      pill.type = "button";
      pill.textContent = "🎲 Quick Roll";
      Object.assign(pill.style, {
        position: "fixed",
        bottom: "16px",
        right: "16px",
        zIndex: "2147483646",
        padding: "8px 14px",
        borderRadius: "999px",
        background: "#171d2b",
        border: "1.5px solid #f0c46c",
        color: "#f0c46c",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13.5px",
        fontWeight: "700",
        cursor: "pointer",
        boxShadow: "0 8px 24px rgba(0,0,0,0.65)"
      });
      pill.addEventListener("click", () => {
        coachDrawerOpen = !coachDrawerOpen;
        renderFloatingRollDrawer();
      });
      document.body.appendChild(pill);
    }

    let drawer = document.getElementById("dnd-copilot-roll-drawer");
    if (!coachDrawerOpen) {
      if (drawer) drawer.style.display = "none";
      return;
    }

    if (!drawer && document.body) {
      drawer = document.createElement("div");
      drawer.id = "dnd-copilot-roll-drawer";
      Object.assign(drawer.style, {
        position: "fixed",
        bottom: "62px",
        right: "16px",
        zIndex: "2147483647",
        width: "400px",
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "74vh",
        overflowY: "auto",
        background: "#131824",
        border: "1.5px solid #f0c46c",
        borderRadius: "12px",
        padding: "11px 13px",
        color: "#f3f6fc",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13px",
        lineHeight: "1.4",
        boxShadow: "0 16px 42px rgba(0,0,0,0.8)"
      });
      document.body.appendChild(drawer);
    }
    if (!drawer) return;
    drawer.style.display = "block";
    drawer.textContent = "";

    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    const party = rollContext?.party || [];

    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      marginBottom: "8px"
    });
    const hTitle = document.createElement("strong");
    hTitle.style.color = "#f0c46c";
    hTitle.textContent = myChar ? `🎲 1-Click Roll → VTT (${myChar.name})` : "🎲 1-Click Roll";
    const hClose = document.createElement("button");
    hClose.type = "button";
    hClose.textContent = "✕";
    Object.assign(hClose.style, {
      background: "transparent",
      border: "none",
      color: "#cbd5e8",
      cursor: "pointer",
      fontSize: "15px"
    });
    hClose.addEventListener("click", () => {
      coachDrawerOpen = false;
      renderFloatingRollDrawer();
    });
    head.append(hTitle, hClose);
    drawer.appendChild(head);

    if (!rm || !myChar) {
      const msg = document.createElement("div");
      msg.style.color = "#cbd5e8";
      msg.textContent = "Open your character sheet or http://localhost:8765 once to sync your sheet.";
      drawer.appendChild(msg);
      return;
    }

    const searchInp = document.createElement("input");
    searchInp.type = "text";
    searchInp.placeholder = "Filter any spell, save, or skill (1 click rolls to VTT)...";
    searchInp.value = coachFilterQuery;
    Object.assign(searchInp.style, {
      width: "100%",
      boxSizing: "border-box",
      padding: "6px 9px",
      borderRadius: "7px",
      border: "1px solid #2c3752",
      background: "#1b2232",
      color: "#f3f6fc",
      marginBottom: "8px",
      fontSize: "12.5px"
    });
    searchInp.addEventListener("input", () => {
      coachFilterQuery = searchInp.value;
      renderFloatingRollDrawer();
      const reopenedInp = document.querySelector("#dnd-copilot-roll-drawer input[type='text']");
      reopenedInp?.focus();
    });
    drawer.appendChild(searchInp);

    const catalog = rm.getRollCatalog(myChar, party);
    const q = coachFilterQuery.trim().toLowerCase();

    const triggerQuickItem = async (spec, part = "tohit") => {
      coachDrawerOpen = false;
      renderFloatingRollDrawer();
      const vttRes = await triggerNativeDdbRoll(spec, part);
      if (vttRes.triggered) {
        showAnalyzedRollCoach(spec, part, null);
        if (activeCoachState) activeCoachState.updatedAt = Date.now();
        return;
      }
      // Fallback for items with no native DDB button (e.g. Necklace of Fireballs)
      const fallbackRoll = rm.executeRoll(spec, myChar, party);
      const rolledNum = fallbackRoll.d20Result
        ? fallbackRoll.d20Result.total
        : fallbackRoll.damageResult
        ? fallbackRoll.damageResult.total
        : null;
      showRollCoachToast(
        `${myChar.name} · ${spec.name}${rolledNum != null ? ` (${rolledNum})` : ""}`,
        fallbackRoll.activeMods.slice(0, 3).map((m) => `${m.title}${m.badge ? ` — ${m.badge}` : ""}`),
        fallbackRoll.sayAloudScript
      );
      chrome.runtime
        .sendMessage({
          type: "GAMELOG_ROLLS",
          rolls: [
            {
              fingerprint: `avtt-quick-${Date.now()}-${spec.id}`,
              timestamp: Date.now(),
              actor: myChar.name,
              action: spec.name,
              kind: spec.kind === "save" ? "save" : "attack",
              total: rolledNum,
              formula: spec.damageFormula || "",
              rawText: fallbackRoll.sayAloudScript
            }
          ]
        })
        .catch(() => {});
    };

    const addSectionLabel = (txt) => {
      const lbl = document.createElement("div");
      lbl.textContent = txt;
      lbl.style.cssText = "font-size:11.5px;font-weight:700;color:#8b9bb8;text-transform:uppercase;letter-spacing:0.04em;margin:6px 0 4px;";
      drawer.appendChild(lbl);
    };

    // 1. Spells & Attacks (1-click direct + optional damage pill right beside it!)
    const combatItems = (catalog.spellsAndAttacks || []).filter((s) =>
      !q || `${s.name} ${s.subLabel}`.toLowerCase().includes(q)
    );
    if (combatItems.length > 0) {
      addSectionLabel("✨ Spells & Attacks (Rolls into VTT Log)");
      const grid = document.createElement("div");
      Object.assign(grid.style, { display: "flex", flexWrap: "wrap", gap: "5px" });
      for (const sp of (q ? combatItems : combatItems.slice(0, 8))) {
        const wrap = document.createElement("div");
        Object.assign(wrap.style, { display: "inline-flex", gap: "2px" });
        const mainSub =
          sp.kind === "spell_attack" || sp.kind === "weapon_attack" || sp.kind === "spell_check"
            ? `+${Number(sp.attackBonus || 0)}`
            : sp.damageFormula || (sp.saveDc ? `DC ${sp.saveDc}` : "");
        const mainPart = sp.kind === "spell_save" ? "damage" : "tohit";
        const bMain = makeQuickChipBtn(sp.name, mainSub);
        bMain.addEventListener("click", () => triggerQuickItem(sp, mainPart));
        wrap.appendChild(bMain);

        if ((sp.kind === "spell_attack" || sp.kind === "weapon_attack") && sp.damageFormula) {
          const bDmg = makeQuickChipBtn("", sp.damageFormula, true);
          bDmg.title = `Roll ${sp.name} damage straight into VTT`;
          bDmg.addEventListener("click", () => triggerQuickItem(sp, "damage"));
          wrap.appendChild(bDmg);
        }
        grid.appendChild(wrap);
      }
      drawer.appendChild(grid);
    }

    // 2. Saving Throws (1 tight single row)
    const saveItems = (catalog.saves || []).filter((s) =>
      s.id !== "save:death" && (!q || `${s.name} ${s.ability}`.toLowerCase().includes(q))
    );
    if (saveItems.length > 0) {
      addSectionLabel("🛡️ Saving Throws");
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", flexWrap: "wrap", gap: "5px" });
      for (const sv of saveItems) {
        const shortNm = sv.isConcentration ? "Conc" : (sv.ability || sv.name).toUpperCase();
        const b = makeQuickChipBtn(shortNm, sv.subLabel);
        b.addEventListener("click", () => triggerQuickItem(sv, "tohit"));
        row.appendChild(b);
      }
      drawer.appendChild(row);
    }

    // 3. Initiative & Skills
    const allSkills = (catalog.skills || []).filter((sk) =>
      !q
        ? sk.kind === "initiative" || sk.tier === "proficiency" || sk.tier === "expertise"
        : `${sk.name} ${sk.ability}`.toLowerCase().includes(q)
    );
    if (allSkills.length > 0) {
      addSectionLabel("🔎 Init & Skills");
      const skRow = document.createElement("div");
      Object.assign(skRow.style, { display: "flex", flexWrap: "wrap", gap: "5px" });
      for (const sk of (q ? allSkills : allSkills.slice(0, 10))) {
        const shortMod = sk.subLabel.split("·")[0].trim();
        const b = makeQuickChipBtn(sk.name === "Initiative" ? "Init" : sk.name, shortMod);
        b.addEventListener("click", () => triggerQuickItem(sk, "tohit"));
        skRow.appendChild(b);
      }
      drawer.appendChild(skRow);
    }
  }

  function pushUpdatesIfChanged() {
    try {
      const newRolls = collectVisibleGameLog(true);
      if (newRolls.length > 0) {
        chrome.runtime.sendMessage({ type: "GAMELOG_ROLLS", rolls: newRolls }).catch(() => {});
        coachNewAboveVttRolls(newRolls);
      }
      hasBaselineGameLog = true;

      const snapshot = buildSnapshot();
      const compactHash = JSON.stringify({
        avtt: snapshot.isAboveVttActive,
        pcs: snapshot.partyCharacters.map((p) => p.id),
        combat: snapshot.combat,
        logCount: snapshot.recentLog.length,
        lastFinger: snapshot.recentLog[snapshot.recentLog.length - 1]?.fingerprint || ""
      });

      if (compactHash !== lastSnapshotHash) {
        lastSnapshotHash = compactHash;
        chrome.runtime.sendMessage({ type: "ABOVEVTT_SNAPSHOT", payload: snapshot }).catch(() => {});
      }
    } catch (_) {
      // Ignore transient DOM mutation states
    }
  }

  async function getCobaltBearerToken() {
    if (cobaltToken && Date.now() < cobaltTokenExpiresAt) {
      return cobaltToken;
    }
    const resp = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
      method: "POST",
      credentials: "include"
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.token) {
      cobaltToken = data.token;
      cobaltTokenExpiresAt = Date.now() + Math.max(30, (data.ttl || 300) - 30) * 1000;
      return cobaltToken;
    }
    return null;
  }

  async function fetchCharacterJsonInPageContext(characterId) {
    const url = `https://character-service.dndbeyond.com/character/v5/character/${characterId}?includeCustomItems=true`;
    let token = null;
    try {
      token = await getCobaltBearerToken();
    } catch (_) {
      token = null;
    }

    if (token) {
      const authedResp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      });
      if (authedResp.ok) {
        return await authedResp.json();
      }
    }

    const publicResp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!publicResp.ok) {
      throw new Error(`HTTP ${publicResp.status} fetching character ${characterId}`);
    }
    return await publicResp.json();
  }

  function showInPageHealthAlert(msgText) {
    let banner = document.getElementById("dnd-copilot-cross-tab-alert");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "dnd-copilot-cross-tab-alert";
      Object.assign(banner.style, {
        position: "fixed",
        top: "14px",
        right: "14px",
        zIndex: "2147483647",
        maxWidth: "420px",
        padding: "12px 16px",
        borderRadius: "10px",
        background: "#7f1d1d",
        border: "2px solid #f87171",
        color: "#ffffff",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "15px",
        fontWeight: "600",
        boxShadow: "0 12px 32px rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        gap: "12px"
      });
      document.body.appendChild(banner);
    }
    banner.innerHTML = "";
    const textSpan = document.createElement("span");
    textSpan.style.flex = "1";
    textSpan.textContent = msgText;

    const openBtn = document.createElement("button");
    openBtn.textContent = "Check Copilot";
    Object.assign(openBtn.style, {
      background: "#ffffff",
      color: "#7f1d1d",
      border: "none",
      borderRadius: "6px",
      padding: "6px 10px",
      fontWeight: "700",
      cursor: "pointer",
      whiteSpace: "nowrap"
    });
    openBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD_TAB" }).catch(() => {});
      banner.remove();
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent",
      color: "#fecaca",
      border: "none",
      fontSize: "16px",
      cursor: "pointer"
    });
    closeBtn.addEventListener("click", () => banner.remove());

    banner.append(textSpan, openBtn, closeBtn);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_COPILOT_ALERT") {
      showInPageHealthAlert(message.message || "D&D Copilot needs attention!");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "CLEAR_COPILOT_ALERT") {
      document.getElementById("dnd-copilot-cross-tab-alert")?.remove();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "COLLECT_SNAPSHOT_NOW") {
      sendResponse({ ok: true, snapshot: buildSnapshot() });
      return false;
    }
    if (message?.type === "CONTENT_FETCH_CHARACTER") {
      fetchCharacterJsonInPageContext(message.characterId)
        .then((json) => sendResponse({ ok: true, json }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    if (message?.type === "ROLL_CONTEXT_UPDATE") {
      rollContext = {
        myChar: message.myChar || null,
        party: Array.isArray(message.party) ? message.party : []
      };
      renderFloatingRollDrawer();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "SHOW_ROLL_COACH") {
      showRollCoachToast(message.title || "Full Potential", [], message.sayScript || "");
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function extractClickedDdbRollInfo(clickable) {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !clickable) return null;
    const catalog = rm.getRollCatalog(myChar, rollContext.party || []);

    // 1. Saving Throw (.ddbc-saving-throws-summary__ability--wis)
    const saveRow = clickable.closest(".ddbc-saving-throws-summary__ability");
    if (saveRow) {
      const clsMatch = String(saveRow.getAttribute("class") || "").match(/--([a-z]{3})\b/);
      const abil = clsMatch
        ? clsMatch[1]
        : String(saveRow.querySelector("abbr")?.textContent || "").trim().toLowerCase();
      const matchedSpec = (catalog.saves || []).find((s) => s.id === `save:${abil}`);
      if (matchedSpec) return { matchedSpec, part: "tohit" };
    }

    // 2. Skill (.ct-skills__item)
    const skillRow = clickable.closest(".ct-skills__item");
    if (skillRow) {
      const skName = normalizeRollLookupName(
        skillRow.querySelector(".ct-skills__col--skill")?.textContent
      );
      const matchedSpec = (catalog.skills || []).find(
        (sk) => normalizeRollLookupName(sk.name) === skName
      );
      if (matchedSpec) return { matchedSpec, part: "tohit" };
    }

    // 3. Initiative ([data-testid="combat-initiative-label"])
    const initBox = clickable.closest("[class*='box']") || clickable.parentElement?.parentElement;
    if (initBox?.querySelector("[data-testid='combat-initiative-label']")) {
      const matchedSpec = (catalog.skills || []).find((sk) => sk.id === "skill:initiative");
      if (matchedSpec) return { matchedSpec, part: "tohit" };
    }

    // 4. Actions Tab Attack / Spell (.ddbc-combat-attack)
    const atkRow = clickable.closest(".ddbc-combat-attack");
    if (atkRow) {
      const atkName = normalizeRollLookupName(
        atkRow.querySelector(".styles_spellName__wX3ll, .ddbc-combat-attack__label, .ddbc-combat-attack__name")?.textContent
      );
      const part = clickable.closest(".ddbc-combat-attack__damage") ? "damage" : "tohit";
      const matchedSpec = (catalog.spellsAndAttacks || []).find((sp) => {
        const spNorm = normalizeRollLookupName(sp.name);
        return spNorm && (atkName === spNorm || atkName.includes(spNorm) || spNorm.includes(atkName));
      });
      if (matchedSpec) return { matchedSpec, part };
    }

    // 5. Spells Tab Spell (.ct-spells-spell)
    const spellRow = clickable.closest(".ct-spells-spell");
    if (spellRow) {
      const spName = normalizeRollLookupName(
        spellRow.querySelector(".styles_spellName__wX3ll, .ct-spells-spell__label, .ct-spells-spell__name")?.textContent
      );
      const part = clickable.closest(".ct-spells-spell__damage") ? "damage" : "tohit";
      const matchedSpec = (catalog.spellsAndAttacks || []).find((sp) => {
        const spNorm = normalizeRollLookupName(sp.name);
        return spNorm && (spName === spNorm || spName.includes(spNorm) || spNorm.includes(spName));
      });
      if (matchedSpec) return { matchedSpec, part };
    }

    return null;
  }

  function initSheetRollClickListener() {
    if (window.__dndCopilotClickListenerBound) return;
    window.__dndCopilotClickListenerBound = true;
    document.addEventListener(
      "click",
      (ev) => {
        try {
          if (Date.now() < suppressClickCoachUntil) return;
          const target = ev.target;
          if (!target || typeof target.closest !== "function") return;
          if (target.closest("#dnd-copilot-roll-pill, #dnd-copilot-roll-drawer, #dnd-copilot-roll-toast")) return;
          const rm = window.DnDCopilot?.RollMaximizer;
          const myChar = rollContext?.myChar;
          if (!rm || !myChar) return;

          const clickable = target.closest(
            "button.integrated-dice__container, .integrated-dice__container, [class*='integrated-dice'], [class*='rollable'], [class*='dice-button'], [data-dice-notation], button, [role='button']"
          );
          if (!clickable) return;

          const exactMatch = extractClickedDdbRollInfo(clickable);
          if (exactMatch?.matchedSpec) {
            showAnalyzedRollCoach(exactMatch.matchedSpec, exactMatch.part, null);
            if (activeCoachState) activeCoachState.updatedAt = Date.now();
            return;
          }

          const btnText = (clickable.innerText || clickable.textContent || "").replace(/\s+/g, " ").trim();
          const clsAttr = String(clickable.getAttribute("class") || "");
          const hasDiceCls = /dice|rollable/i.test(clsAttr) || clickable.hasAttribute("data-dice-notation");
          const looksLikeRollText = /^[+-]\s*\d+$|^\d+d\d+|^DC\s*\d+|\broll\b/i.test(btnText);
          if (!hasDiceCls && !looksLikeRollText) return;

          const contextEl =
            clickable.closest(
              ".ct-spells-spell, .ddbc-combat-attack, .ct-skills__item, .ddbc-saving-throws-summary__ability, [class*='spell'], [class*='attack'], [class*='skill'], [class*='saving-throw'], [class*='initiative'], tr, [role='row'], li"
            ) || clickable.parentElement;
          const ctxText = ((contextEl?.innerText || contextEl?.textContent || btnText) || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          if (!ctxText) return;

          const clickKind = classifyRollKind(ctxText, btnText);
          const analyzed = rm.analyzeAboveVttRoll(
            {
              actor: myChar.name,
              action: ctxText.slice(0, 48),
              kind: clickKind === "chat" ? "roll" : clickKind,
              total: null,
              rawText: `${ctxText} ${btnText}`
            },
            myChar,
            rollContext.party || []
          );
          if (analyzed?.matchedSpec) {
            showAnalyzedRollCoach(
              analyzed.matchedSpec,
              clickKind === "damage" ? "damage" : "tohit",
              null,
              ctxText.slice(0, 48)
            );
            if (activeCoachState) activeCoachState.updatedAt = Date.now();
          }
        } catch (_) {
          // Never interfere with host DDB click handlers
        }
      },
      true
    );
  }

  async function ensureRollContextLoaded() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_ROLL_CONTEXT" });
      if (resp?.myChar) {
        rollContext = { myChar: resp.myChar, party: resp.party || [] };
      }
    } catch (_) {}

    if (!rollContext?.myChar && window.DnDCopilot?.DDBParser) {
      const cid = extractCharacterIdFromString(window.location.href);
      if (cid) {
        try {
          const json = await fetchCharacterJsonInPageContext(cid);
          const parsed = window.DnDCopilot.DDBParser.parseCharacterJson(json);
          rollContext = { myChar: parsed, party: [parsed] };
        } catch (_) {}
      }
    }
    renderFloatingRollDrawer();
  }

  ensureRollContextLoaded();
  initSheetRollClickListener();
  setInterval(ensureRollContextLoaded, 60000);
  window.addEventListener("resize", () => renderFloatingRollDrawer());

  // Observe DOM updates cleanly with debounce
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(pushUpdatesIfChanged, 350);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-current", "data-name", "ishidden", "style", "class", "value"]
  });

  // Periodic gentle heartbeat for input.value updates that don't fire DOM attribute mutations
  setInterval(pushUpdatesIfChanged, 2500);
  setTimeout(pushUpdatesIfChanged, 900);
})();
