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
  let prepRollState = null;
  let shadowUiRoot = null;
  let hasTopFrameCoach = false;
  let lastFrameRegKey = "";
  let lastUiRightOffset = 16;

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

  function inferCatalogActionFromText(rawText) {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !rawText) return "";
    const low = String(rawText).toLowerCase();
    const cat = rm.getRollCatalog(myChar, rollContext.party || []);
    const allSpecs = [
      ...(cat.spellsAndAttacks || []),
      ...(cat.skills || []),
      ...(cat.saves || [])
    ].sort((a, b) => String(b.name || "").length - String(a.name || "").length);
    for (const sp of allSpecs) {
      const nm = String(sp?.name || "").trim();
      if (nm.length >= 3 && low.includes(nm.toLowerCase())) {
        return nm;
      }
    }
    return "";
  }

  function parseGameLogEntry(li) {
    // Strictly skip DM-only hidden game log entries and our own coach UI
    if (!isElementVisible(li)) return null;
    if (li.closest("#dnd-copilot-ui-host, #dnd-copilot-roll-toast, #dnd-copilot-roll-drawer, #dnd-copilot-roll-pill, #dnd-copilot-cross-tab-alert")) {
      return null;
    }

    const rawText = (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText || rawText.length < 2) return null;

    // Extract structured segments from DDB / AboveVTT / Noty game log markup
    let actionLabel =
      li.querySelector(
        "[class*='action'], [class*='rollName'], [class*='title'], .dice_result__info__title, .dice_result__info__rolldetail, [class*='RollName'], [class*='ActionName'], [class*='RollTitle'], [class*='GameLogEntry_Action'], [class*='Source']"
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

    const totalEl =
      li.querySelector(
        ".aboveDiceTotal, .dice_result__total-result, [class*='resultTotal'], [class*='finalResult'], [class*='totalResult']"
      ) ||
      li.querySelector("[class*='Total-Other'], [class*='-Total-']") ||
      Array.from(li.querySelectorAll("[class*='Total'], [class*='total']")).find(
        (el) => !/container/i.test(String(el.className || "")) && el.children.length === 0
      );

    let total = null;
    if (totalEl) {
      const numMatch = String(totalEl.textContent || "")
        .trim()
        .match(/-?\d+/);
      if (numMatch) {
        const parsed = parseInt(numMatch[0], 10);
        if (Number.isFinite(parsed)) total = parsed;
      }
    }

    const titleAttr =
      li.querySelector(".abovevtt-roll-container[title]")?.getAttribute("title") ||
      li.getAttribute("title") ||
      "";
    const breakdownEl = li.querySelector(
      ".dice_result__info__breakdown, [class*='breakdown'], [class*='Notation'], [class*='Values']"
    );
    const cleanedBreakdown = (titleAttr || breakdownEl?.textContent || "")
      .replace(/<br\s*\/?>/gi, " · ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const upgradedOnes = (String(titleAttr).match(/\b2\^/g) || []).length;
    const rawDiceValues = [];
    if (cleanedBreakdown) {
      const afterColon = cleanedBreakdown.includes(":")
        ? cleanedBreakdown.split(":").slice(1).join(":")
        : cleanedBreakdown;
      const beforeEq = afterColon.split("=")[0];
      const grpRe = /\[([^\]]+)\]|\(([^)]+)\)/g;
      let gm;
      while ((gm = grpRe.exec(beforeEq)) !== null) {
        const inner = gm[1] || gm[2] || "";
        for (const tok of inner.split(/[,+]/)) {
          const dm = tok.trim().match(/^(\d+)(?:\^)?$/);
          if (dm) rawDiceValues.push(parseInt(dm[1], 10));
        }
      }
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
    if (!actionLabel || /^roll$/i.test(actionLabel)) {
      const inferred = inferCatalogActionFromText(rawText);
      if (inferred) actionLabel = inferred;
    }

    const fingerprint = `${sender}|${actionLabel}|${kind}|${total}|${rawText.slice(0, 120)}|${timeLabel}`;

    return {
      fingerprint,
      timestamp: Date.now(),
      actor: sender || "Table",
      action: actionLabel || rollTypeLabel || (kind === "chat" ? "Message" : "Roll"),
      kind,
      total,
      formula,
      breakdown: cleanedBreakdown,
      upgradedOnes,
      rawDiceValues,
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

  function ensureShadowUiRoot() {
    if (shadowUiRoot && shadowUiRoot.host && shadowUiRoot.host.isConnected) {
      return shadowUiRoot;
    }
    const mountParent = document.body || document.documentElement;
    if (!mountParent) return null;

    let host = document.getElementById("dnd-copilot-ui-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "dnd-copilot-ui-host";
      mountParent.appendChild(host);
    } else if (!host.isConnected) {
      mountParent.appendChild(host);
    }

    host.style.cssText =
      "all: initial !important; position: fixed !important; inset: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; pointer-events: none !important; z-index: 2147483647 !important;";

    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    if (!root.getElementById("dnd-copilot-shadow-styles")) {
      const style = document.createElement("style");
      style.id = "dnd-copilot-shadow-styles";
      style.textContent = `
        *, *::before, *::after { box-sizing: border-box; }
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        button {
          appearance: none;
          -webkit-appearance: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          margin: 0;
          line-height: 1.2;
          vertical-align: middle;
          background: transparent;
          border: none;
          color: inherit;
        }
        input {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          margin: 0;
        }
        .dc-pill {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 2147483646;
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 38px;
          padding: 0 15px;
          border-radius: 999px;
          background: #171d2b;
          border: 1.5px solid #f0c46c;
          color: #f0c46c;
          font-size: 13.5px;
          font-weight: 700;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
          transition: transform 0.12s ease, background 0.12s ease;
        }
        .dc-pill:hover {
          background: #20293e;
          transform: translateY(-1px);
        }
        .dc-drawer {
          position: fixed;
          bottom: 62px;
          right: 16px;
          z-index: 2147483647;
          pointer-events: auto;
          width: 410px;
          max-width: calc(100vw - 32px);
          max-height: 74vh;
          overflow-y: auto;
          background: #131824;
          border: 1.5px solid #f0c46c;
          border-radius: 12px;
          padding: 12px 14px;
          color: #f3f6fc;
          font-size: 13px;
          line-height: 1.4;
          box-shadow: 0 16px 42px rgba(0, 0, 0, 0.82);
        }
        .dc-toast {
          position: fixed;
          bottom: 64px;
          right: 16px;
          z-index: 2147483646;
          pointer-events: auto;
          width: 400px;
          max-width: calc(100vw - 32px);
          background: #171d2b;
          border: 1.5px solid #f0c46c;
          border-radius: 12px;
          padding: 12px 14px;
          color: #f3f6fc;
          font-size: 13.5px;
          line-height: 1.45;
          box-shadow: 0 14px 36px rgba(0, 0, 0, 0.78);
        }
        .dc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .dc-head-title {
          color: #f0c46c;
          font-weight: 700;
          flex: 1;
          font-size: 13.5px;
        }
        .dc-actions {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .dc-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 24px;
          padding: 0 7px;
          background: #1f273a;
          border: 1px solid #2c3752;
          border-radius: 5px;
          color: #f3f6fc;
          cursor: pointer;
          font-size: 12px;
        }
        .dc-icon-btn.is-gold { color: #f0c46c; }
        .dc-close-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          background: transparent;
          border: none;
          color: #cbd5e8;
          cursor: pointer;
          font-size: 15px;
        }
        .dc-search {
          width: 100%;
          padding: 7px 10px;
          border-radius: 7px;
          border: 1px solid #2c3752;
          background: #1b2232;
          color: #f3f6fc;
          margin-bottom: 8px;
          font-size: 12.5px;
          outline: none;
        }
        .dc-search:focus { border-color: #f0c46c; }
        .dc-sec-label {
          font-size: 11px;
          font-weight: 700;
          color: #8b9bb8;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 7px 0 4px;
        }
        .dc-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }
        .dc-chip-wrap {
          display: inline-flex;
          gap: 2px;
          align-items: center;
        }
        .dc-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 9px;
          min-height: 28px;
          border-radius: 7px;
          border: 1px solid #2c3752;
          background: #1f273a;
          color: #f3f6fc;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
        }
        .dc-chip:hover { border-color: #f0c46c; background: #26314a; }
        .dc-chip.is-accent {
          border-color: #3ecf8e;
          background: rgba(62, 207, 142, 0.14);
          color: #6ee7b7;
        }
        .dc-chip-sub {
          color: #f0c46c;
          font-weight: 700;
          font-size: 12px;
        }
        .dc-chip.is-accent .dc-chip-sub { color: #6ee7b7; }
        .dc-say-box {
          padding: 7px 10px;
          border-left: 3px solid #f0c46c;
          border-radius: 0 8px 8px 0;
          background: rgba(240, 196, 108, 0.13);
          color: #fef3c7;
          margin-bottom: 6px;
        }
        .dc-vtt-status {
          font-size: 12px;
          font-weight: 600;
          padding: 5px 8px;
          border-radius: 6px;
          margin-bottom: 6px;
        }
        .dc-vtt-status.is-sent {
          background: rgba(62, 207, 142, 0.14);
          border: 1px solid rgba(62, 207, 142, 0.45);
          color: #6ee7b7;
        }
        .dc-vtt-status.is-info {
          background: rgba(91, 138, 245, 0.15);
          border: 1px solid rgba(91, 138, 245, 0.45);
          color: #bfdbfe;
        }
        .dc-vtt-status.is-warn {
          background: rgba(245, 158, 11, 0.16);
          border: 1px solid rgba(245, 158, 11, 0.55);
          color: #fde68a;
        }
        .dc-bullets {
          margin: 4px 0 6px 16px;
          padding: 0;
          color: #cbd5e8;
        }
        .dc-bullets li { margin-bottom: 2px; }
        .dc-follow-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 4px;
        }
        .dc-follow-btn {
          display: inline-flex;
          align-items: center;
          padding: 4px 9px;
          min-height: 26px;
          border-radius: 6px;
          border: 1px solid #2c3752;
          background: #1f273a;
          color: #cbd5e8;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .dc-follow-btn.is-dmg {
          border-color: #3ecf8e;
          background: rgba(62, 207, 142, 0.16);
          color: #6ee7b7;
          font-weight: 700;
        }
        .dc-follow-btn.is-adv {
          border-color: #5b8af5;
          background: rgba(91, 138, 245, 0.18);
          color: #bfdbfe;
          font-weight: 700;
        }
        .dc-follow-btn.is-active {
          border-color: #f0c46c;
          background: rgba(240, 196, 108, 0.22);
          color: #fde68a;
        }
        .dc-prep-row {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-bottom: 8px;
        }
        .dc-seg-btn {
          display: inline-flex;
          align-items: center;
          padding: 4px 9px;
          min-height: 26px;
          border-radius: 6px;
          border: 1px solid #2c3752;
          background: #1b2232;
          color: #cbd5e8;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .dc-seg-btn:hover { border-color: #f0c46c; }
        .dc-seg-btn.is-selected {
          border-color: #f0c46c;
          background: rgba(240, 196, 108, 0.2);
          color: #fde68a;
          font-weight: 700;
        }
        .dc-seg-btn.is-empty { opacity: 0.55; }
        .dc-check-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 8px;
        }
        .dc-check-row {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 5px 8px;
          border-radius: 7px;
          background: #1b2232;
          border: 1px solid #26314a;
          font-size: 12.5px;
          color: #f3f6fc;
          cursor: pointer;
        }
        .dc-check-row input[type='checkbox'] {
          margin: 0;
          accent-color: #f0c46c;
          cursor: pointer;
          flex-shrink: 0;
        }
        .dc-check-lbl { flex: 1; }
        .dc-tag-in {
          font-size: 10.5px;
          font-weight: 700;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(62, 207, 142, 0.16);
          color: #6ee7b7;
          border: 1px solid rgba(62, 207, 142, 0.35);
          white-space: nowrap;
        }
        .dc-tag-note {
          font-size: 10.5px;
          font-weight: 700;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(245, 158, 11, 0.15);
          color: #fde68a;
          border: 1px solid rgba(245, 158, 11, 0.35);
          white-space: nowrap;
        }
        .dc-formula-bar {
          padding: 6px 9px;
          border-radius: 7px;
          background: #0d111a;
          border: 1px solid #2c3752;
          color: #93c5fd;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11.5px;
          margin-bottom: 8px;
          word-break: break-word;
        }
        .dc-cta-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .dc-roll-primary {
          flex: 1;
          min-width: 160px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 8px 12px;
          min-height: 34px;
          border-radius: 8px;
          background: #f0c46c;
          color: #131824;
          font-size: 13px;
          font-weight: 800;
          cursor: pointer;
        }
        .dc-roll-primary:hover { background: #fbd38d; }
        .dc-roll-secondary {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 6px 10px;
          min-height: 34px;
          border-radius: 8px;
          border: 1px solid #2c3752;
          background: #1f273a;
          color: #f3f6fc;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .dc-roll-secondary:hover { border-color: #f0c46c; }
        .dc-result-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 8px;
          margin-bottom: 7px;
        }
        .dc-result-box {
          padding: 7px 10px;
          border-radius: 8px;
          background: #101521;
          border: 1px solid #2c3752;
        }
        .dc-result-box.is-dmg { border-color: rgba(62, 207, 142, 0.5); }
        .dc-result-box.is-hit { border-color: rgba(240, 196, 108, 0.55); }
        .dc-result-box.is-dc { border-color: rgba(91, 138, 245, 0.5); }
        .dc-result-lbl {
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #94a3b8;
        }
        .dc-result-val {
          font-size: 22px;
          font-weight: 800;
          line-height: 1.15;
          color: #f0c46c;
          margin: 2px 0;
        }
        .dc-result-box.is-dmg .dc-result-val { color: #6ee7b7; }
        .dc-result-box.is-dc .dc-result-val { color: #93c5fd; font-size: 18px; }
        .dc-result-sub {
          font-size: 11px;
          color: #94a3b8;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .dc-crit-pill {
          display: inline-block;
          margin-left: 6px;
          padding: 1px 6px;
          border-radius: 4px;
          background: rgba(240, 196, 108, 0.22);
          border: 1px solid #f0c46c;
          color: #fde68a;
          font-size: 10.5px;
          font-weight: 800;
          vertical-align: middle;
        }
        .dc-note-group {
          margin-bottom: 5px;
        }
        .dc-note-title {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin-bottom: 2px;
        }
        .dc-note-title.is-in { color: #6ee7b7; }
        .dc-note-title.is-out { color: #fde68a; }
        .dc-note-list {
          margin: 0 0 0 15px;
          padding: 0;
          font-size: 12px;
          line-height: 1.35;
          color: #cbd5e8;
        }
        .dc-note-list li { margin-bottom: 1px; }
        .dc-alert {
          position: fixed;
          top: 14px;
          right: 14px;
          z-index: 2147483647;
          pointer-events: auto;
          max-width: 420px;
          padding: 12px 16px;
          border-radius: 10px;
          background: #7f1d1d;
          border: 2px solid #f87171;
          color: #ffffff;
          font-size: 14.5px;
          font-weight: 600;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .dc-alert-open {
          background: #ffffff;
          color: #7f1d1d;
          border: none;
          border-radius: 6px;
          padding: 6px 10px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .dc-alert-close {
          background: transparent;
          color: #fecaca;
          border: none;
          font-size: 16px;
          cursor: pointer;
        }
      `;
      root.appendChild(style);
    }
    shadowUiRoot = root;
    return shadowUiRoot;
  }

  function getShadowEl(id) {
    return shadowUiRoot && shadowUiRoot.host?.isConnected ? shadowUiRoot.getElementById(id) : null;
  }

  function getUiRightOffsetPx() {
    if (window.top !== window || window.innerWidth < 760) return 16;
    const sidebarEl =
      document.getElementById("chat-text")?.closest(".sidebar__pane-content, .sidebar-panel-content, .glc-game-log, .sidebar, .ct-sidebar, [class*='sidebar'], [class*='GameLog']") ||
      document.querySelector(".sidebar__pane-content, .glc-game-log, .GameLog_GameLog__2z_HZ, #gamelog_panel, .ct-sidebar") ||
      document.getElementById("chat-text");
    if (!sidebarEl || !isElementVisible(sidebarEl)) return 16;
    const rect = sidebarEl.getBoundingClientRect();
    if (rect.width > 120 && rect.right >= window.innerWidth - 80) {
      const occupiedRight = Math.ceil(window.innerWidth - rect.left);
      if (occupiedRight >= 220 && occupiedRight <= Math.floor(window.innerWidth * 0.6)) {
        return occupiedRight + 14;
      }
    }
    return 16;
  }

  function applyUiRightOffset() {
    const offset = getUiRightOffsetPx();
    lastUiRightOffset = offset;
    const maxAvailWidth = Math.max(260, window.innerWidth - offset - 16);
    const pill = getShadowEl("dnd-copilot-roll-pill");
    if (pill) pill.style.right = `${offset}px`;
    const drawer = getShadowEl("dnd-copilot-roll-drawer");
    if (drawer) {
      drawer.style.right = `${offset}px`;
      drawer.style.maxWidth = `${Math.min(410, maxAvailWidth)}px`;
    }
    const toast = getShadowEl("dnd-copilot-roll-toast");
    if (toast) {
      toast.style.right = `${offset}px`;
      toast.style.maxWidth = `${Math.min(400, maxAvailWidth)}px`;
    }
    return offset;
  }

  async function waitForNativeRollButton(rollSpec, part, maxMs = 420) {
    const deadline = Date.now() + maxMs;
    while (Date.now() <= deadline) {
      const btn = findVisibleNativeDdbRollButton(rollSpec, part);
      if (btn) return btn;
      await new Promise((r) => setTimeout(r, 60));
    }
    return findVisibleNativeDdbRollButton(rollSpec, part);
  }

  async function triggerNativeDdbRollLocal(rollSpec, part = "tohit", mode = "normal") {
    let btn = findVisibleNativeDdbRollButton(rollSpec, part);
    if (!btn && (rollSpec.isSpell || rollSpec.kind === "weapon_attack" || rollSpec.kind === "spell_attack" || rollSpec.kind === "spell_save")) {
      const desiredTestId = rollSpec.isSpell ? "SPELLS" : "ACTIONS";
      let tabBtn = document.querySelector(`button[data-testid='${desiredTestId}']`);
      if (tabBtn && tabBtn.getAttribute("aria-checked") !== "true") {
        tabBtn.click();
        btn = await waitForNativeRollButton(rollSpec, part, 420);
      }
      if (!btn && rollSpec.isSpell) {
        tabBtn = document.querySelector("button[data-testid='ACTIONS']");
        if (tabBtn && tabBtn.getAttribute("aria-checked") !== "true") {
          tabBtn.click();
          btn = await waitForNativeRollButton(rollSpec, part, 420);
        }
      }
    }

    if (!btn) return { triggered: false };

    const isAboveVttPage = Boolean(
      document.getElementById("chat-text") ||
        document.getElementById("combat_tracker") ||
        document.getElementById("tokens") ||
        /abovevtt=true/i.test(window.location.search)
    );

    suppressClickCoachUntil = Date.now() + 400;
    const ptrEv = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      pointerType: "mouse",
      shiftKey: mode === "adv",
      ctrlKey: mode === "dis"
    });
    const notPrevented = btn.dispatchEvent(ptrEv);
    if (!notPrevented) {
      return { triggered: true, part, via: "abovevtt-pointerdown" };
    }
    if (isAboveVttPage) {
      return { triggered: false };
    }
    btn.click();
    return { triggered: true, part, via: "ddb-sheet" };
  }

  async function tryAboveVttChatRoll(rollSpec, part = "tohit", mode = "normal", cmdOptions = {}) {
    const rm = window.DnDCopilot?.RollMaximizer;
    if (!rm?.buildAboveVttSlashCommand) return { triggered: false };
    const cmd = rm.buildAboveVttSlashCommand(rollSpec, part, mode, cmdOptions);
    if (!cmd) return { triggered: false };

    let chatInput = document.getElementById("chat-text");
    if (!chatInput) {
      const logTabBtn = document.getElementById("switch_gamelog");
      if (logTabBtn) {
        logTabBtn.click();
        await new Promise((r) => setTimeout(r, 250));
        chatInput = document.getElementById("chat-text");
      }
    }
    if (!chatInput) return { triggered: false };

    const prevVal = chatInput.value || "";
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(chatInput, cmd);
    } else {
      chatInput.value = cmd;
    }
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    chatInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );

    if (chatInput.value === "") {
      return { triggered: true, part, via: "abovevtt-chat", command: cmd };
    }
    if (nativeSetter) {
      nativeSetter.call(chatInput, prevVal);
    } else {
      chatInput.value = prevVal;
    }
    return { triggered: false };
  }

  function hasCustomRollOptions(rollSpec, cmdOptions) {
    if (!cmdOptions || typeof cmdOptions !== "object") return false;
    return Boolean(
      Number(cmdOptions.minDieValue || 1) > 1 ||
        cmdOptions.setD20To != null ||
        Number(cmdOptions.flatBonus || 0) !== 0 ||
        cmdOptions.diceBonus ||
        cmdOptions.extraDamageDice ||
        Number(cmdOptions.damageFlatBonus || 0) !== 0 ||
        (cmdOptions.castLevel && rollSpec?.baseLevel != null && Number(cmdOptions.castLevel) > Number(rollSpec.baseLevel))
    );
  }

  async function triggerVttRollLocal(rollSpec, part = "tohit", mode = "normal", cmdOptions = {}) {
    if (!rollSpec) return { triggered: false };
    const hasChatHost = Boolean(document.getElementById("chat-text") || document.getElementById("switch_gamelog"));
    if (hasChatHost || mode === "adv" || mode === "dis" || hasCustomRollOptions(rollSpec, cmdOptions)) {
      const chatRes = await tryAboveVttChatRoll(rollSpec, part, mode, cmdOptions);
      if (chatRes.triggered) return chatRes;
    }
    const nativeRes = await triggerNativeDdbRollLocal(rollSpec, part, mode);
    if (nativeRes.triggered) return nativeRes;
    return await tryAboveVttChatRoll(rollSpec, part, mode, cmdOptions);
  }

  async function triggerSharedVttRoll(rollSpec, part = "tohit", mode = "normal", cmdOptions = {}) {
    const localRes = await triggerVttRollLocal(rollSpec, part, mode, cmdOptions);
    if (localRes?.triggered) return localRes;

    try {
      const relayRes = await chrome.runtime.sendMessage({
        type: "RELAY_TRIGGER_SHEET_ROLL",
        rollSpec,
        part,
        mode,
        cmdOptions,
        characterId: rollContext?.myChar?.id || ""
      });
      if (relayRes?.triggered) return relayRes;
    } catch (_) {}

    return { triggered: false };
  }

  function computeColdAdeptOutcomeLines(st) {
    if (!st?.coldAdeptMod) return { inLine: "", outLine: "" };
    const typeMatch = String(st.coldAdeptMod.title || "").match(/\((cold|fire|lightning|acid|thunder)\)/i);
    const typeCap = typeMatch
      ? typeMatch[1].charAt(0).toUpperCase() + typeMatch[1].slice(1).toLowerCase()
      : "Cold";

    if (st.usedMin2) {
      if (st.upgradedOnes > 0) {
        return {
          inLine: `+${st.upgradedOnes} dmg for ${typeCap} Adept (${st.upgradedOnes}× 1→2)`,
          outLine: `Ignores ${typeCap.toLowerCase()} resistance`
        };
      }
      if (st.damageTotal != null && st.damageBreakdown) {
        return {
          inLine: `${typeCap} Adept 1s→2s active (0 ones rolled)`,
          outLine: `Ignores ${typeCap.toLowerCase()} resistance`
        };
      }
      return {
        inLine: `${typeCap} Adept 1s→2s active (in VTT)`,
        outLine: `Ignores ${typeCap.toLowerCase()} resistance`
      };
    }

    // Not baked into VTT (e.g. rolled from native sheet or unchecked in Prep)
    if (st.rawOnes > 0 && st.damageTotal != null) {
      return {
        inLine: "",
        outLine: `+${st.rawOnes} dmg for ${typeCap} Adept → Total ${st.damageTotal + st.rawOnes} (ignores resist)`
      };
    }
    if (st.damageTotal != null && st.rawDiceCount > 0) {
      return {
        inLine: "",
        outLine: `${typeCap} Adept: 0 ones rolled · ignores ${typeCap.toLowerCase()} resist`
      };
    }
    return {
      inLine: "",
      outLine: `+1 dmg per 1 rolled for ${typeCap} Adept (not in VTT) · ignores resist`
    };
  }

  function renderRollCoachToast() {
    const st = activeCoachState;
    if (!st) {
      getShadowEl("dnd-copilot-roll-toast")?.remove();
      return;
    }

    const root = ensureShadowUiRoot();
    if (!root) return;

    let card = getShadowEl("dnd-copilot-roll-toast");
    if (!card) {
      card = document.createElement("div");
      card.id = "dnd-copilot-roll-toast";
      card.className = "dc-toast";
      root.appendChild(card);
    }
    card.textContent = "";
    applyUiRightOffset();

    const rm = window.DnDCopilot?.RollMaximizer;
    const header = document.createElement("div");
    header.className = "dc-head";
    const titleEl = document.createElement("strong");
    titleEl.className = "dc-head-title";
    titleEl.textContent = `🎲 ${st.title}`;
    if (st.hitIsCrit) {
      const critBadge = document.createElement("span");
      critBadge.className = "dc-crit-pill";
      critBadge.textContent = "NAT 20 CRIT";
      titleEl.appendChild(critBadge);
    }

    const actionBtns = document.createElement("div");
    actionBtns.className = "dc-actions";

    if (st.matchedSpec && !String(st.matchedSpec.id || "").startsWith("generic:")) {
      const prepAgainBtn = document.createElement("button");
      prepAgainBtn.type = "button";
      prepAgainBtn.className = "dc-icon-btn";
      prepAgainBtn.textContent = "↻ Prep";
      prepAgainBtn.title = "Change spell level / enhancements & re-roll";
      prepAgainBtn.addEventListener("click", () => {
        openRollPrep(st.matchedSpec);
      });
      actionBtns.appendChild(prepAgainBtn);
    }

    const openDrawerBtn = document.createElement("button");
    openDrawerBtn.type = "button";
    openDrawerBtn.className = "dc-icon-btn is-gold";
    openDrawerBtn.textContent = "🎲";
    openDrawerBtn.title = "Open Quick Roll picker";
    openDrawerBtn.addEventListener("click", () => {
      prepRollState = null;
      coachDrawerOpen = true;
      renderFloatingRollDrawer();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dc-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      activeCoachState = null;
      card.remove();
    });
    actionBtns.append(openDrawerBtn, closeBtn);
    header.append(titleEl, actionBtns);
    card.appendChild(header);

    if (st.vttStatus === "local_only") {
      const stBox = document.createElement("div");
      stBox.className = "dc-vtt-status is-warn";
      stBox.textContent = "⚠️ Local preview only — open AboveVTT Game Log or Raine's sheet to post to table.";
      card.appendChild(stBox);
    }

    // Outcome Total Grid (Hit / Save DC / Damage — big readable final numbers!)
    const hitAddonExtra = !st.wantsDamage || st.wantsHit ? Number(st.appliedHitAddonBonus || 0) : 0;
    const dmgAddonExtra = Number(st.appliedDmgAddonBonus || 0);
    const manualColdBonus = !st.usedMin2 && st.rawOnes > 0 && st.damageTotal != null ? st.rawOnes : 0;

    if (st.wantsHit || st.isSaveSpell || st.wantsDamage) {
      const grid = document.createElement("div");
      grid.className = "dc-result-grid";

      if (st.wantsHit) {
        const box = document.createElement("div");
        box.className = "dc-result-box is-hit";
        const lbl = document.createElement("div");
        lbl.className = "dc-result-lbl";
        const kindTag =
          st.matchedSpec?.kind === "save"
            ? `${(st.matchedSpec.ability || "").toUpperCase()} Save`
            : st.matchedSpec?.kind === "spell_attack" || st.matchedSpec?.kind === "weapon_attack"
            ? "To Hit"
            : st.matchedSpec?.name || "Total";
        lbl.textContent = kindTag;

        const val = document.createElement("div");
        val.className = "dc-result-val";
        if (st.hitTotal != null) {
          const finalHit = st.hitTotal + hitAddonExtra;
          val.textContent = hitAddonExtra ? `${st.hitTotal} → ${finalHit}` : `${finalHit}`;
        } else {
          val.style.fontSize = "14px";
          val.style.color = "#94a3b8";
          val.textContent = "Rolling…";
        }

        const sub = document.createElement("div");
        sub.className = "dc-result-sub";
        if (st.hatCheck && st.hitTotal != null) {
          const finalHit = st.hitTotal + hitAddonExtra;
          sub.textContent = finalHit >= 10 ? "✓ PASS DC 10 (Hat of Wizardry)" : "✕ FAIL DC 10 (Hat of Wizardry)";
          sub.style.color = finalHit >= 10 ? "#6ee7b7" : "#fca5a5";
        } else if (st.hitBreakdown) {
          sub.textContent = st.hitBreakdown;
          sub.title = st.hitBreakdown;
        } else if (st.rollMode === "adv") {
          sub.textContent = "2d20 keep highest";
        } else if (st.rollMode === "dis") {
          sub.textContent = "2d20 keep lowest";
        } else if (st.vttStatus === "sent" && st.hitTotal != null) {
          sub.textContent = "In AboveVTT Game Log";
        }
        box.append(lbl, val);
        if (sub.textContent) box.appendChild(sub);
        grid.appendChild(box);
      } else if (st.isSaveSpell && st.matchedSpec?.saveDc) {
        const box = document.createElement("div");
        box.className = "dc-result-box is-dc";
        const lbl = document.createElement("div");
        lbl.className = "dc-result-lbl";
        lbl.textContent = "Enemy Save";
        const val = document.createElement("div");
        val.className = "dc-result-val";
        val.textContent = `DC ${st.matchedSpec.saveDc} ${st.matchedSpec.saveAbility || ""}`.trim();
        const sub = document.createElement("div");
        sub.className = "dc-result-sub";
        sub.textContent = st.matchedSpec.upcastNote || "Targets roll save";
        box.append(lbl, val, sub);
        grid.appendChild(box);
      }

      if (st.wantsDamage) {
        const dmgType = (st.matchedSpec?.damageTypes || [])[0] || "";
        const box = document.createElement("div");
        box.className = "dc-result-box is-dmg";
        const lbl = document.createElement("div");
        lbl.className = "dc-result-lbl";
        lbl.textContent = dmgType ? `Damage (${dmgType})` : "Damage";
        const val = document.createElement("div");
        val.className = "dc-result-val";
        if (st.damageTotal != null) {
          const totalExtra = dmgAddonExtra + manualColdBonus;
          const finalDmg = st.damageTotal + totalExtra;
          val.textContent = totalExtra > 0 ? `${st.damageTotal} → ${finalDmg}` : `${finalDmg}`;
        } else {
          val.style.fontSize = "14px";
          val.style.color = "#94a3b8";
          val.textContent = "Rolling…";
        }
        const sub = document.createElement("div");
        sub.className = "dc-result-sub";
        if (st.damageBreakdown) {
          sub.textContent = st.damageBreakdown;
          sub.title = st.damageBreakdown;
        } else if (st.matchedSpec?.damageFormula) {
          sub.textContent = st.matchedSpec.damageFormula;
        }
        box.append(lbl, val);
        if (sub.textContent) box.appendChild(sub);
        grid.appendChild(box);
      }

      card.appendChild(grid);
    }

    // Compact split: What's ALREADY in VTT total vs What's NOT in VTT
    const coldLines = computeColdAdeptOutcomeLines(st);
    const inItems = [...(st.inVttNotes || [])];
    if (coldLines.inLine && !inItems.includes(coldLines.inLine)) inItems.push(coldLines.inLine);

    const outItems = [...(st.tellDmNotes || [])];
    if (coldLines.outLine && !outItems.includes(coldLines.outLine)) outItems.push(coldLines.outLine);
    for (const a of st.addons || []) {
      if (st.appliedAddonIds?.has(a.id)) {
        const baseTarget = st.hitTotal != null ? st.hitTotal : st.damageTotal;
        const valTxt = Number(a.rolledValue || 0);
        outItems.push(
          baseTarget != null
            ? `+${valTxt} ${a.shortLabel} → Total ${baseTarget + hitAddonExtra}`
            : `+${valTxt} ${a.shortLabel}`
        );
      }
    }

    if (inItems.length > 0) {
      const grp = document.createElement("div");
      grp.className = "dc-note-group";
      const nt = document.createElement("div");
      nt.className = "dc-note-title is-in";
      nt.textContent = st.vttStatus === "sent" ? "✓ In VTT total:" : "✓ Included:";
      const ul = document.createElement("ul");
      ul.className = "dc-note-list";
      for (const line of inItems.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      grp.append(nt, ul);
      card.appendChild(grp);
    }

    if (outItems.length > 0) {
      const grp = document.createElement("div");
      grp.className = "dc-note-group";
      const nt = document.createElement("div");
      nt.className = "dc-note-title is-out";
      nt.textContent = "⚡ Not in VTT — tell DM / add:";
      const ul = document.createElement("ul");
      ul.className = "dc-note-list";
      for (const line of outItems.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      grp.append(nt, ul);
      card.appendChild(grp);
    } else if (st.bullets && st.bullets.length > 0 && inItems.length === 0) {
      const ul = document.createElement("ul");
      ul.className = "dc-note-list";
      for (const b of st.bullets.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    // 1-click follow-ups (missing Damage, Crit extra dice, Adv re-roll, or post-roll optional buffs)
    const followRow = document.createElement("div");
    followRow.className = "dc-follow-row";

    if (st.matchedSpec && !st.wantsDamage && (st.matchedSpec.damageFormula || st.matchedSpec.kind === "spell_attack" || st.matchedSpec.kind === "weapon_attack")) {
      const dmgFollowBtn = document.createElement("button");
      dmgFollowBtn.type = "button";
      dmgFollowBtn.className = "dc-follow-btn is-dmg";
      dmgFollowBtn.textContent = `💥 Roll ${st.matchedSpec.damageFormula || "Damage"} → VTT`;
      dmgFollowBtn.addEventListener("click", async () => {
        st.wantsDamage = true;
        st.damageTotal = null;
        st.damageBreakdown = "";
        st.updatedAt = Date.now();
        renderRollCoachToast();
        const res = await triggerSharedVttRoll(st.matchedSpec, "damage", "normal", st.cmdOptions || {});
        st.vttStatus = res?.triggered ? "sent" : "local_only";
        if (!res?.triggered && rm?.executeRoll && rollContext?.myChar) {
          const fb = rm.executeRoll(st.matchedSpec, rollContext.myChar, rollContext.party || []);
          st.damageTotal = fb.damageResult?.total ?? null;
        }
        renderRollCoachToast();
      });
      followRow.appendChild(dmgFollowBtn);
    }

    if (st.hitIsCrit && st.matchedSpec?.damageFormula) {
      const critBtn = document.createElement("button");
      critBtn.type = "button";
      critBtn.className = "dc-follow-btn is-dmg";
      critBtn.textContent = `💥 Roll Crit Dice (${st.matchedSpec.damageFormula}) → VTT`;
      critBtn.addEventListener("click", async () => {
        await triggerSharedVttRoll(st.matchedSpec, "damage", "normal", st.cmdOptions || {});
      });
      followRow.appendChild(critBtn);
    }

    if (st.matchedSpec && st.wantsHit && st.matchedSpec.kind !== "spell_save" && st.matchedSpec.kind !== "item_save") {
      const advBtn = document.createElement("button");
      advBtn.type = "button";
      advBtn.className = "dc-follow-btn is-adv";
      advBtn.textContent = st.hasAdvantageFeature ? "⚡ Re-roll 2d20 Adv → VTT" : "⚡ 2nd d20 → VTT";
      advBtn.addEventListener("click", async () => {
        st.rollMode = st.hasAdvantageFeature ? "adv" : st.rollMode;
        st.updatedAt = Date.now();
        const res = await triggerSharedVttRoll(st.matchedSpec, "tohit", st.hasAdvantageFeature ? "adv" : "normal", st.cmdOptions || {});
        st.vttStatus = res?.triggered ? "sent" : "local_only";
        renderRollCoachToast();
      });
      followRow.appendChild(advBtn);
    }

    for (const addon of st.addons || []) {
      const applied = st.appliedAddonIds?.has(addon.id);
      const aBtn = document.createElement("button");
      aBtn.type = "button";
      aBtn.className = applied ? "dc-follow-btn is-active" : "dc-follow-btn";
      aBtn.textContent = applied ? `✓ ${addon.shortLabel}` : `+ ${addon.shortLabel}`;
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
        st.appliedHitAddonBonus = (st.addons || [])
          .filter((a) => st.appliedAddonIds.has(a.id) && !a.isDamage)
          .reduce((sum, a) => sum + Number(a.rolledValue || 0), 0);
        st.appliedDmgAddonBonus = (st.addons || [])
          .filter((a) => st.appliedAddonIds.has(a.id) && a.isDamage)
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
      getShadowEl("dnd-copilot-roll-toast")?.remove();
    }, 45000);
  }

  function formatCoachAddonLabel(m) {
    if (m.id === "party_guidance") return "Guidance (+1d4)";
    if (m.id === "party_bless") return "Bless (+1d4)";
    if (m.id === "paladin_aura") return `Aura (+${m.flatBonus})`;
    if (m.id === "artificers_lore") return `Artificer's Lore (+${m.flatBonus})`;
    if (m.id === "stonecunning") return `Stonecunning (+${m.flatBonus})`;
    const baseName = String(m.title || "").split("(")[0].trim().slice(0, 18);
    const bonusTxt = m.badge || (m.flatBonus ? `+${m.flatBonus}` : m.diceBonus ? `+${m.diceBonus}` : "");
    return bonusTxt ? `${baseName} (${bonusTxt})` : baseName;
  }

  function buildCoachNotesFromAnalysis(scaledSpec, activeMods, includedSet, cmdOptions = {}, upcastLabel = "") {
    const rm = window.DnDCopilot?.RollMaximizer;
    const inVttNotes = [];
    const tellDmNotes = [];
    let coldAdeptMod = null;

    if (upcastLabel) {
      inVttNotes.push(upcastLabel);
    } else if (scaledSpec.upcastNote) {
      inVttNotes.push(scaledSpec.upcastNote);
    }
    if (cmdOptions?.setD20To != null) {
      inVttNotes.push(`Clockwork Amulet: d20 = ${cmdOptions.setD20To}`);
    }

    for (const m of activeMods) {
      if (m.id === "help_advantage" || m.id === "heroic_inspiration") continue;
      if (m.id.startsWith("elemental_adept_")) {
        coldAdeptMod = m;
        continue;
      }
      if (m.id === "clockwork_amulet") continue;

      const compactTxt = rm?.formatCompactModifierNote
        ? rm.formatCompactModifierNote(m, { upcastNote: scaledSpec.upcastNote })
        : m.title;
      if (!compactTxt) continue;

      const isMathIncluded =
        includedSet?.has(m.id) &&
        Boolean(m.flatBonus || m.diceBonus || m.damageDiceBonus || m.damageFlatBonus || m.grantsAdvantage);

      if (isMathIncluded) {
        inVttNotes.push(compactTxt);
      } else if (m.defaultOn || includedSet?.has(m.id) || m.id.startsWith("rider_")) {
        tellDmNotes.push(compactTxt);
      }
    }

    return { inVttNotes, tellDmNotes, coldAdeptMod };
  }

  function renderAnalyzedRollCoachLocal(matchedSpec, part = "tohit", rolledTotal = null, rawActionLabel = "", vttStatus = "", rollMeta = null) {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !matchedSpec) return;

    const analysis = rm.analyzeRollPotential(matchedSpec, myChar, rollContext.party || []);
    const activeMods = (analysis.modifiers || []).filter(
      (m) => m.sayThis || m.flatBonus || m.diceBonus || m.grantsAdvantage || m.minDieValue || m.damageDiceBonus || m.damageFlatBonus
    );

    const isDamagePart = part === "damage";
    const isSaveSpell = matchedSpec.kind === "spell_save" || matchedSpec.kind === "item_save";
    const isD20Roll = !isSaveSpell && matchedSpec.kind !== "spell_auto";

    const bakedIds = rollMeta?.bakedIds instanceof Set ? rollMeta.bakedIds : new Set();
    const { inVttNotes, tellDmNotes, coldAdeptMod } = buildCoachNotesFromAnalysis(
      matchedSpec,
      activeMods,
      bakedIds,
      rollMeta?.cmdOptions || {},
      rollMeta?.upcastLabel || ""
    );

    if (matchedSpec.kind === "spell_attack" && Number(myChar.spellAttackBonus || 0) > 0 && !rollMeta?.skipBaseInNote) {
      inVttNotes.unshift(`+${Number(myChar.spellAttackBonus)} to hit (incl. Wand +${Number(myChar.spellAttackItemBonus || 0)})`);
    }

    const addons = activeMods
      .filter((m) => (m.flatBonus || m.diceBonus) && !bakedIds.has(m.id))
      .map((m) => ({
        id: m.id,
        shortLabel: formatCoachAddonLabel(m),
        flatBonus: m.flatBonus || 0,
        diceBonus: m.diceBonus || "",
        isDamage: Boolean(m.damageDiceBonus || m.damageFlatBonus)
      }));

    const wantsHit = rollMeta?.wantsHit !== undefined ? rollMeta.wantsHit : !isDamagePart && isD20Roll;
    const wantsDamage = rollMeta?.wantsDamage !== undefined ? rollMeta.wantsDamage : isDamagePart;

    activeCoachState = {
      matchedSpec,
      part,
      wantsHit,
      wantsDamage,
      isSaveSpell,
      rollMode: rollMeta?.rollMode || "normal",
      cmdOptions: rollMeta?.cmdOptions || {},
      usedMin2: Boolean(rollMeta?.usedMin2),
      hatCheck: Boolean(rollMeta?.hatCheck || matchedSpec.slug === "arcana"),
      hitTotal: wantsHit && !isDamagePart ? (rollMeta?.initialHitTotal ?? rolledTotal) : null,
      hitBreakdown: rollMeta?.initialHitBreakdown || (!isDamagePart ? rollMeta?.breakdown || "" : ""),
      hitIsCrit: Boolean(!isDamagePart && rollMeta?.isCrit),
      damageTotal: isDamagePart ? rolledTotal : rollMeta?.initialDamageTotal ?? null,
      damageBreakdown: isDamagePart ? rollMeta?.breakdown || "" : "",
      upgradedOnes: isDamagePart ? Number(rollMeta?.upgradedOnes || 0) : 0,
      rawOnes: isDamagePart ? Number(rollMeta?.rawOnes || 0) : 0,
      rawDiceCount: isDamagePart ? Number(rollMeta?.rawDiceCount || 0) : 0,
      vttStatus,
      updatedAt: Date.now(),
      title: `${myChar.name} · ${matchedSpec.name || rawActionLabel || "Roll"}${rollMeta?.upcastTag ? ` (${rollMeta.upcastTag})` : ""}`,
      inVttNotes,
      tellDmNotes,
      coldAdeptMod,
      bullets: [],
      hasAdvantageFeature: activeMods.some((m) => m.grantsAdvantage),
      addons,
      appliedAddonIds: new Set(),
      appliedHitAddonBonus: 0,
      appliedDmgAddonBonus: 0
    };
    renderRollCoachToast();
  }

  function showAnalyzedRollCoach(matchedSpec, part = "tohit", rolledTotal = null, rawActionLabel = "", vttStatus = "", rollMeta = null) {
    if (window.top !== window && hasTopFrameCoach) {
      chrome.runtime
        .sendMessage({
          type: "FORWARD_ROLL_COACH_TO_TOP",
          matchedSpec,
          part,
          rolledTotal,
          rawActionLabel,
          vttStatus
        })
        .then((resp) => {
          if (!resp?.forwarded) {
            renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus, rollMeta);
          }
        })
        .catch(() => {
          renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus, rollMeta);
        });
      return;
    }
    renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus, rollMeta);
  }

  function showRollCoachToast(title, bullets = [], sayScript = "", vttStatus = "") {
    activeCoachState = {
      matchedSpec: null,
      part: "tohit",
      wantsHit: false,
      wantsDamage: false,
      isSaveSpell: false,
      hitTotal: null,
      damageTotal: null,
      vttStatus,
      updatedAt: Date.now(),
      title: title || "Roll Summary",
      sayScript,
      bullets,
      inVttNotes: [],
      tellDmNotes: bullets,
      hasAdvantageFeature: false,
      addons: [],
      appliedAddonIds: new Set(),
      appliedHitAddonBonus: 0,
      appliedDmgAddonBonus: 0
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
      const rawDice = Array.isArray(roll.rawDiceValues) ? roll.rawDiceValues : [];
      const rawOnes = rawDice.filter((v) => v === 1).length;
      const sameSpecActive =
        activeCoachState &&
        activeCoachState.matchedSpec?.id === res.matchedSpec?.id &&
        Date.now() - (activeCoachState.updatedAt || 0) < 12000;

      if (sameSpecActive && roll.total != null) {
        if (part === "damage" || (activeCoachState.wantsDamage && !activeCoachState.wantsHit)) {
          activeCoachState.damageTotal = roll.total;
          activeCoachState.damageBreakdown = roll.breakdown || "";
          activeCoachState.upgradedOnes = Number(roll.upgradedOnes || 0);
          activeCoachState.rawOnes = rawOnes;
          activeCoachState.rawDiceCount = rawDice.length;
        } else {
          activeCoachState.hitTotal = roll.total;
          activeCoachState.hitBreakdown = roll.breakdown || "";
          activeCoachState.hitIsCrit = Boolean(roll.isCrit);
        }
        activeCoachState.vttStatus = "sent";
        activeCoachState.updatedAt = Date.now();
        renderRollCoachToast();
        continue;
      }

      if (res.matchedSpec) {
        showAnalyzedRollCoach(res.matchedSpec, part, roll.total, roll.action, "sent", {
          breakdown: roll.breakdown || "",
          upgradedOnes: Number(roll.upgradedOnes || 0),
          rawOnes,
          rawDiceCount: rawDice.length,
          isCrit: Boolean(roll.isCrit)
        });
      }
    }
  }

  function shouldShowFloatingRollUi() {
    if (!document.body) return false;
    if (window.top !== window && hasTopFrameCoach) return false;
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
    btn.className = isAccent ? "dc-chip is-accent" : "dc-chip";
    if (label) {
      const t = document.createElement("span");
      t.textContent = label;
      btn.appendChild(t);
    }
    if (sub) {
      const s = document.createElement("span");
      s.className = "dc-chip-sub";
      s.textContent = sub;
      btn.appendChild(s);
    }
    return btn;
  }

  function openRollPrep(spec) {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    if (!rm || !myChar || !spec) return;

    const baseLvl =
      spec.kind === "item_save" && /necklace/i.test(spec.name || "")
        ? 1
        : Number(spec.baseLevel ?? spec.level ?? 0);
    const baseSpec = { ...spec, baseLevel: baseLvl };
    const analysis = rm.analyzeRollPotential(baseSpec, myChar, rollContext.party || []);
    const activeToggleIds = new Set();
    let defaultAdv = false;

    for (const m of analysis.modifiers || []) {
      if (m.id === "gnome_cunning") continue; // Conditional vs magic — let player check if needed
      if (m.defaultOn) {
        activeToggleIds.add(m.id);
        if (m.grantsAdvantage) defaultAdv = true;
      }
    }

    prepRollState = {
      baseSpec,
      castLevel: Number(spec.castLevel ?? baseLvl),
      rollMode: defaultAdv ? "adv" : "normal",
      activeToggleIds
    };
    coachDrawerOpen = true;
    renderFloatingRollDrawer();
  }

  function buildCmdOptionsFromPrep(scaledSpec, prep, activeMods) {
    let flatBonus = 0;
    const diceBonuses = [];
    let setD20To = null;
    let minDieValue = 1;
    let extraDamageDice = "";
    let damageFlatBonus = 0;
    const bakedIds = new Set();
    const dmgTypesLow = (scaledSpec.damageTypes || []).map((t) => String(t).toLowerCase());

    for (const m of activeMods) {
      if (!prep.activeToggleIds.has(m.id)) continue;
      if (m.flatBonus) {
        flatBonus += Number(m.flatBonus);
        bakedIds.add(m.id);
      }
      if (m.diceBonus) {
        diceBonuses.push(m.diceBonus);
        bakedIds.add(m.id);
      }
      if (m.setD20To != null) {
        setD20To = Number(m.setD20To);
        bakedIds.add(m.id);
      }
      if (
        m.minDieValue > 1 &&
        (!m.minDieDamageTypes?.length ||
          m.minDieDamageTypes.some((t) => dmgTypesLow.includes(String(t).toLowerCase())))
      ) {
        minDieValue = Math.max(minDieValue, Number(m.minDieValue));
        bakedIds.add(m.id);
      }
      if (m.damageDiceBonus && !extraDamageDice) {
        extraDamageDice = m.damageDiceBonus;
        bakedIds.add(m.id);
      }
      if (m.damageFlatBonus) {
        damageFlatBonus += Number(m.damageFlatBonus);
        bakedIds.add(m.id);
      }
      if (m.grantsAdvantage && prep.rollMode === "adv") {
        bakedIds.add(m.id);
      }
    }

    return {
      cmdOptions: {
        flatBonus,
        diceBonus: diceBonuses[0] || "",
        setD20To,
        minDieValue,
        extraDamageDice,
        damageFlatBonus,
        castLevel: prep.castLevel
      },
      bakedIds
    };
  }

  async function executePreparedRoll(prep, whichParts = ["tohit"]) {
    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    const party = rollContext?.party || [];
    if (!rm || !myChar || !prep?.baseSpec) return;

    const scaledSpec = rm.applyUpcastToRollSpec
      ? rm.applyUpcastToRollSpec(prep.baseSpec, prep.castLevel)
      : prep.baseSpec;
    const analysis = rm.analyzeRollPotential(scaledSpec, myChar, party);
    const activeMods = analysis.modifiers || [];
    const { cmdOptions, bakedIds } = buildCmdOptionsFromPrep(scaledSpec, prep, activeMods);

    const isSaveSpell = scaledSpec.kind === "spell_save" || scaledSpec.kind === "item_save";
    const wantsHit = whichParts.includes("tohit") && !isSaveSpell && scaledSpec.kind !== "spell_auto";
    const wantsDamage = whichParts.includes("damage") && Boolean(scaledSpec.damageFormula);

    coachDrawerOpen = false;
    prepRollState = null;
    renderFloatingRollDrawer();

    const isUpcast = prep.castLevel > Number(prep.baseSpec.baseLevel ?? prep.baseSpec.level ?? 0);
    const upcastTag = isUpcast
      ? scaledSpec.kind === "item_save" && /necklace/i.test(scaledSpec.name || "")
        ? `${prep.castLevel} beads`
        : `L${prep.castLevel}`
      : "";
    const upcastLabel = isUpcast
      ? `${upcastTag} upcast (${scaledSpec.upcastNote || scaledSpec.damageFormula || ""})`.trim()
      : "";

    const deterministicHit =
      wantsHit && cmdOptions.setD20To != null && !cmdOptions.diceBonus
        ? Number(cmdOptions.setD20To) + Number(scaledSpec.attackBonus || 0) + Number(cmdOptions.flatBonus || 0)
        : null;

    if (isSaveSpell && !scaledSpec.damageFormula) {
      showAnalyzedRollCoach(scaledSpec, "tohit", null, "", "save_dc_only", {
        wantsHit: false,
        wantsDamage: false,
        rollMode: prep.rollMode,
        cmdOptions,
        bakedIds,
        upcastTag,
        upcastLabel,
        hatCheck: prep.activeToggleIds.has("hat_of_wizardry")
      });
      return;
    }

    // Create the live outcome card before firing rolls so fast Game Log entries never race ahead
    showAnalyzedRollCoach(scaledSpec, wantsDamage && !wantsHit ? "damage" : "tohit", null, "", "sent", {
      wantsHit,
      wantsDamage,
      rollMode: prep.rollMode,
      cmdOptions,
      bakedIds,
      usedMin2: cmdOptions.minDieValue > 1,
      upcastTag,
      upcastLabel,
      hatCheck: prep.activeToggleIds.has("hat_of_wizardry") || scaledSpec.slug === "arcana",
      initialHitTotal: deterministicHit,
      initialHitBreakdown:
        cmdOptions.setD20To != null
          ? `Clockwork ${cmdOptions.setD20To} + ${Number(scaledSpec.attackBonus || 0) + Number(cmdOptions.flatBonus || 0)}`
          : "",
      initialDamageTotal: null
    });

    let anySent = false;
    if (wantsHit) {
      const hitRes = await triggerSharedVttRoll(scaledSpec, "tohit", prep.rollMode, cmdOptions);
      if (hitRes?.triggered) anySent = true;
    }
    if (wantsHit && wantsDamage) {
      await new Promise((r) => setTimeout(r, 240));
    }
    if (wantsDamage) {
      const dmgRes = await triggerSharedVttRoll(scaledSpec, "damage", "normal", cmdOptions);
      if (dmgRes?.triggered) anySent = true;
    }

    if (!anySent && activeCoachState) {
      const fb = rm.executeRoll(scaledSpec, myChar, party, {
        activeToggleIds: prep.activeToggleIds,
        forceAdvantage: prep.rollMode === "adv"
      });
      activeCoachState.vttStatus = "local_only";
      if (wantsHit && activeCoachState.hitTotal == null) {
        activeCoachState.hitTotal = fb.d20Result?.total ?? null;
      }
      if (wantsDamage && activeCoachState.damageTotal == null) {
        activeCoachState.damageTotal = fb.damageResult?.total ?? null;
      }
      renderRollCoachToast();
    }
  }

  function renderFloatingRollDrawer() {
    if (!shouldShowFloatingRollUi()) {
      getShadowEl("dnd-copilot-roll-pill")?.remove();
      getShadowEl("dnd-copilot-roll-drawer")?.remove();
      return;
    }

    const root = ensureShadowUiRoot();
    if (!root) return;

    let pill = getShadowEl("dnd-copilot-roll-pill");
    if (!pill) {
      pill = document.createElement("button");
      pill.id = "dnd-copilot-roll-pill";
      pill.type = "button";
      pill.className = "dc-pill";
      pill.textContent = "🎲 Quick Roll";
      pill.addEventListener("click", () => {
        coachDrawerOpen = !coachDrawerOpen;
        if (!coachDrawerOpen) prepRollState = null;
        renderFloatingRollDrawer();
      });
      root.appendChild(pill);
    }

    let drawer = getShadowEl("dnd-copilot-roll-drawer");
    if (!coachDrawerOpen) {
      if (drawer) drawer.style.display = "none";
      applyUiRightOffset();
      return;
    }

    if (!drawer) {
      drawer = document.createElement("div");
      drawer.id = "dnd-copilot-roll-drawer";
      drawer.className = "dc-drawer";
      root.appendChild(drawer);
    }
    drawer.style.display = "block";
    drawer.textContent = "";
    applyUiRightOffset();

    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    const party = rollContext?.party || [];

    if (!rm || !myChar) {
      const head = document.createElement("div");
      head.className = "dc-head";
      const hTitle = document.createElement("strong");
      hTitle.className = "dc-head-title";
      hTitle.textContent = "🎲 Quick Roll";
      const hClose = document.createElement("button");
      hClose.type = "button";
      hClose.className = "dc-close-btn";
      hClose.textContent = "✕";
      hClose.addEventListener("click", () => {
        coachDrawerOpen = false;
        renderFloatingRollDrawer();
      });
      head.append(hTitle, hClose);
      drawer.appendChild(head);

      const msg = document.createElement("div");
      msg.style.color = "#cbd5e8";
      msg.textContent = "Open your character sheet or http://localhost:8765 once to sync your sheet.";
      drawer.appendChild(msg);
      return;
    }

    // STEP 2: Prep View (Upcast Level + Roll Mode + Enhancements Checklist + Roll Button)
    if (prepRollState?.baseSpec) {
      const prep = prepRollState;
      const scaledSpec = rm.applyUpcastToRollSpec
        ? rm.applyUpcastToRollSpec(prep.baseSpec, prep.castLevel)
        : prep.baseSpec;
      const analysis = rm.analyzeRollPotential(scaledSpec, myChar, party);
      const isSaveSpell = scaledSpec.kind === "spell_save" || scaledSpec.kind === "item_save";
      const isD20Roll = !isSaveSpell && scaledSpec.kind !== "spell_auto";
      const hasClockwork = prep.activeToggleIds.has("clockwork_amulet");

      const head = document.createElement("div");
      head.className = "dc-head";
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "dc-icon-btn";
      backBtn.textContent = "← Back";
      backBtn.addEventListener("click", () => {
        prepRollState = null;
        renderFloatingRollDrawer();
      });
      const hTitle = document.createElement("strong");
      hTitle.className = "dc-head-title";
      hTitle.textContent = scaledSpec.name;
      const hClose = document.createElement("button");
      hClose.type = "button";
      hClose.className = "dc-close-btn";
      hClose.textContent = "✕";
      hClose.addEventListener("click", () => {
        coachDrawerOpen = false;
        prepRollState = null;
        renderFloatingRollDrawer();
      });
      head.append(backBtn, hTitle, hClose);
      drawer.appendChild(head);

      const addSectionLabel = (txt) => {
        const lbl = document.createElement("div");
        lbl.className = "dc-sec-label";
        lbl.textContent = txt;
        drawer.appendChild(lbl);
      };

      // Upcast / Beads selector
      const upcastOpts = rm.getUpcastOptions ? rm.getUpcastOptions(prep.baseSpec, myChar) : [];
      if (upcastOpts.length > 1) {
        addSectionLabel(scaledSpec.kind === "item_save" ? "💎 Beads to Throw" : "✨ Cast Level");
        const upRow = document.createElement("div");
        upRow.className = "dc-prep-row";
        for (const opt of upcastOpts) {
          const b = document.createElement("button");
          b.type = "button";
          const isSel = Number(prep.castLevel) === Number(opt.level);
          b.className = `dc-seg-btn${isSel ? " is-selected" : ""}${opt.remaining === 0 ? " is-empty" : ""}`;
          b.textContent = opt.remaining != null ? `${opt.label} (${opt.remaining})` : opt.label;
          b.addEventListener("click", () => {
            prep.castLevel = opt.level;
            renderFloatingRollDrawer();
          });
          upRow.appendChild(b);
        }
        drawer.appendChild(upRow);
      }

      // Advantage / Normal / Disadvantage selector
      if (isD20Roll && !hasClockwork) {
        addSectionLabel("🎯 Roll Mode");
        const modeRow = document.createElement("div");
        modeRow.className = "dc-prep-row";
        for (const [modeVal, modeLbl] of [
          ["normal", "Normal"],
          ["adv", "Adv (2d20)"],
          ["dis", "Disadv"]
        ]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `dc-seg-btn${prep.rollMode === modeVal ? " is-selected" : ""}`;
          b.textContent = modeLbl;
          b.addEventListener("click", () => {
            prep.rollMode = modeVal;
            renderFloatingRollDrawer();
          });
          modeRow.appendChild(b);
        }
        drawer.appendChild(modeRow);
      }

      // Enhancements Checklist (only actionable toggles; omit generic help_advantage & auto riders)
      const checkMods = (analysis.modifiers || []).filter(
        (m) => m.id !== "help_advantage" && !m.id.startsWith("rider_")
      );
      if (checkMods.length > 0) {
        addSectionLabel("⚡ Enhancements");
        const list = document.createElement("div");
        list.className = "dc-check-list";
        for (const m of checkMods) {
          const row = document.createElement("label");
          row.className = "dc-check-row";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = prep.activeToggleIds.has(m.id);
          cb.addEventListener("change", () => {
            if (cb.checked) {
              prep.activeToggleIds.add(m.id);
              if (m.grantsAdvantage) prep.rollMode = "adv";
            } else {
              prep.activeToggleIds.delete(m.id);
              if (m.grantsAdvantage) {
                const stillHasAdv = checkMods.some((x) => x.grantsAdvantage && prep.activeToggleIds.has(x.id));
                if (!stillHasAdv && prep.rollMode === "adv") prep.rollMode = "normal";
              }
            }
            renderFloatingRollDrawer();
          });

          const lblSpan = document.createElement("span");
          lblSpan.className = "dc-check-lbl";
          const shortTitle = String(m.title || "").split("—")[0].trim();
          lblSpan.textContent = m.badge && !shortTitle.toLowerCase().includes(m.badge.toLowerCase())
            ? `${shortTitle} · ${m.badge}`
            : shortTitle;

          const isVttCalc = Boolean(
            m.flatBonus || m.diceBonus || m.setD20To != null || m.minDieValue > 1 || m.damageDiceBonus || m.damageFlatBonus || m.grantsAdvantage
          );
          const tag = document.createElement("span");
          tag.className = isVttCalc ? "dc-tag-in" : "dc-tag-note";
          tag.textContent = isVttCalc ? "In VTT" : "Note";

          row.append(cb, lblSpan, tag);
          list.appendChild(row);
        }
        drawer.appendChild(list);
      }

      // Live Formula Preview
      const { cmdOptions } = buildCmdOptionsFromPrep(scaledSpec, prep, checkMods);
      const previewParts = [];
      if (isD20Roll) {
        const hitCmd = rm.buildAboveVttSlashCommand(scaledSpec, "tohit", prep.rollMode, cmdOptions);
        if (hitCmd) previewParts.push(`Roll: ${hitCmd}`);
      } else if (isSaveSpell && scaledSpec.saveDc) {
        previewParts.push(`Save: DC ${scaledSpec.saveDc} ${scaledSpec.saveAbility || ""}`);
      }
      if (scaledSpec.damageFormula) {
        const dmgCmd = rm.buildAboveVttSlashCommand(scaledSpec, "damage", "normal", cmdOptions);
        if (dmgCmd) previewParts.push(`Dmg: ${dmgCmd}`);
      }
      if (previewParts.length > 0) {
        const fBar = document.createElement("div");
        fBar.className = "dc-formula-bar";
        fBar.textContent = previewParts.join("  ·  ");
        drawer.appendChild(fBar);
      }

      // Primary Roll Action Row
      const ctaRow = document.createElement("div");
      ctaRow.className = "dc-cta-row";
      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "dc-roll-primary";

      if (isD20Roll && scaledSpec.damageFormula) {
        mainBtn.textContent = "🎲 Roll Hit + Damage → VTT";
        mainBtn.addEventListener("click", () => executePreparedRoll(prep, ["tohit", "damage"]));
        ctaRow.appendChild(mainBtn);

        const hitOnly = document.createElement("button");
        hitOnly.type = "button";
        hitOnly.className = "dc-roll-secondary";
        hitOnly.textContent = "Hit only";
        hitOnly.addEventListener("click", () => executePreparedRoll(prep, ["tohit"]));

        const dmgOnly = document.createElement("button");
        dmgOnly.type = "button";
        dmgOnly.className = "dc-roll-secondary";
        dmgOnly.textContent = "Dmg only";
        dmgOnly.addEventListener("click", () => executePreparedRoll(prep, ["damage"]));
        ctaRow.append(hitOnly, dmgOnly);
      } else if (isSaveSpell && scaledSpec.damageFormula) {
        mainBtn.textContent = `🎲 Roll ${scaledSpec.damageFormula} Damage → VTT`;
        mainBtn.addEventListener("click", () => executePreparedRoll(prep, ["damage"]));
        ctaRow.appendChild(mainBtn);
      } else if (isSaveSpell) {
        mainBtn.textContent = `📢 Show DC ${scaledSpec.saveDc || ""} Summary`;
        mainBtn.addEventListener("click", () => executePreparedRoll(prep, ["tohit"]));
        ctaRow.appendChild(mainBtn);
      } else {
        mainBtn.textContent = "🎲 Roll → VTT";
        mainBtn.addEventListener("click", () => executePreparedRoll(prep, ["tohit"]));
        ctaRow.appendChild(mainBtn);
      }
      drawer.appendChild(ctaRow);
      return;
    }

    // STEP 1: Picker View
    const head = document.createElement("div");
    head.className = "dc-head";
    const hTitle = document.createElement("strong");
    hTitle.className = "dc-head-title";
    hTitle.textContent = `🎲 Pick Spell / Check (${myChar.name})`;
    const hClose = document.createElement("button");
    hClose.type = "button";
    hClose.className = "dc-close-btn";
    hClose.textContent = "✕";
    hClose.addEventListener("click", () => {
      coachDrawerOpen = false;
      renderFloatingRollDrawer();
    });
    head.append(hTitle, hClose);
    drawer.appendChild(head);

    const searchInp = document.createElement("input");
    searchInp.type = "text";
    searchInp.className = "dc-search";
    searchInp.placeholder = "Filter any spell, save, or skill...";
    searchInp.value = coachFilterQuery;
    ["keydown", "keyup", "keypress"].forEach((evtName) => {
      searchInp.addEventListener(evtName, (ev) => ev.stopPropagation());
    });
    searchInp.addEventListener("input", () => {
      coachFilterQuery = searchInp.value;
      renderFloatingRollDrawer();
      const reopenedInp = shadowUiRoot?.querySelector("#dnd-copilot-roll-drawer input[type='text']");
      if (reopenedInp) {
        reopenedInp.focus();
        const len = reopenedInp.value.length;
        reopenedInp.setSelectionRange?.(len, len);
      }
    });
    drawer.appendChild(searchInp);

    const catalog = rm.getRollCatalog(myChar, party);
    const q = coachFilterQuery.trim().toLowerCase();

    const addSectionLabel = (txt) => {
      const lbl = document.createElement("div");
      lbl.className = "dc-sec-label";
      lbl.textContent = txt;
      drawer.appendChild(lbl);
    };

    // 1. Spells & Attacks (1 click -> Step 2 Prep & Enhancements)
    const combatItems = (catalog.spellsAndAttacks || []).filter((s) =>
      !q || `${s.name} ${s.subLabel}`.toLowerCase().includes(q)
    );
    if (combatItems.length > 0) {
      addSectionLabel("✨ Spells & Attacks (Pick → Enhance & Roll)");
      const grid = document.createElement("div");
      grid.className = "dc-grid";
      for (const sp of (q ? combatItems : combatItems.slice(0, 10))) {
        const subTxt =
          sp.kind === "spell_attack" || sp.kind === "weapon_attack"
            ? `+${Number(sp.attackBonus || 0)}${sp.damageFormula ? ` · ${sp.damageFormula}` : ""}`
            : sp.kind === "spell_check"
            ? `+${Number(sp.attackBonus || 0)}`
            : sp.damageFormula || (sp.saveDc ? `DC ${sp.saveDc}` : "");
        const bMain = makeQuickChipBtn(sp.name, subTxt);
        bMain.addEventListener("click", () => openRollPrep(sp));
        grid.appendChild(bMain);
      }
      drawer.appendChild(grid);
    }

    // 2. Saving Throws
    const saveItems = (catalog.saves || []).filter((s) =>
      s.id !== "save:death" && (!q || `${s.name} ${s.ability}`.toLowerCase().includes(q))
    );
    if (saveItems.length > 0) {
      addSectionLabel("🛡️ Saving Throws");
      const row = document.createElement("div");
      row.className = "dc-grid";
      for (const sv of saveItems) {
        const shortNm = sv.isConcentration ? "Conc" : (sv.ability || sv.name).toUpperCase();
        const b = makeQuickChipBtn(shortNm, sv.subLabel);
        b.addEventListener("click", () => openRollPrep(sv));
        row.appendChild(b);
      }
      drawer.appendChild(row);
    }

    // 3. Initiative & Skills
    const allSkills = (catalog.skills || []).filter((sk) =>
      !q
        ? sk.kind === "initiative" || sk.tier === "proficiency" || sk.tier === "expertise" || sk.slug === "arcana"
        : `${sk.name} ${sk.ability}`.toLowerCase().includes(q)
    );
    if (allSkills.length > 0) {
      addSectionLabel("🔎 Init & Skills");
      const skRow = document.createElement("div");
      skRow.className = "dc-grid";
      for (const sk of (q ? allSkills : allSkills.slice(0, 10))) {
        const shortMod = sk.subLabel.split("·")[0].trim();
        const b = makeQuickChipBtn(sk.name === "Initiative" ? "Init" : sk.name, shortMod);
        b.addEventListener("click", () => openRollPrep(sk));
        skRow.appendChild(b);
      }
      drawer.appendChild(skRow);
    }
  }

  function pushUpdatesIfChanged() {
    try {
      const nextRightOffset = getUiRightOffsetPx();
      if (nextRightOffset !== lastUiRightOffset) {
        applyUiRightOffset();
      }
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
    const root = ensureShadowUiRoot();
    if (!root) return;
    let banner = getShadowEl("dnd-copilot-cross-tab-alert");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "dnd-copilot-cross-tab-alert";
      banner.className = "dc-alert";
      root.appendChild(banner);
    }
    banner.textContent = "";
    const textSpan = document.createElement("span");
    textSpan.style.flex = "1";
    textSpan.textContent = msgText;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "dc-alert-open";
    openBtn.textContent = "Check Copilot";
    openBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD_TAB" }).catch(() => {});
      banner.remove();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dc-alert-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => banner.remove());

    banner.append(textSpan, openBtn, closeBtn);
  }

  async function registerCurrentFrame(force = false) {
    const isTop = window.top === window;
    const characterId =
      extractCharacterIdFromString(window.location.href) ||
      String(rollContext?.myChar?.id || "");
    const hasChatInput = Boolean(document.getElementById("chat-text"));
    const hasSheet = Boolean(
      document.querySelector(".ct-character-sheet, .ddbc-saving-throws-summary__ability, .ct-skills__item")
    );
    const key = `${isTop}|${characterId}|${hasChatInput}|${hasSheet}`;
    if (!force && key === lastFrameRegKey) return;
    lastFrameRegKey = key;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "REGISTER_FRAME",
        isTop,
        characterId,
        hasChatInput,
        hasSheet
      });
      if (!isTop && resp?.hasTopFrameCoach) {
        hasTopFrameCoach = true;
        getShadowEl("dnd-copilot-roll-pill")?.remove();
        getShadowEl("dnd-copilot-roll-drawer")?.remove();
      }
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_COPILOT_ALERT") {
      showInPageHealthAlert(message.message || "D&D Copilot needs attention!");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "CLEAR_COPILOT_ALERT") {
      getShadowEl("dnd-copilot-cross-tab-alert")?.remove();
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
      registerCurrentFrame(false);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "SHOW_ROLL_COACH") {
      showRollCoachToast(message.title || "Full Potential", [], message.sayScript || "");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "EXECUTE_VTT_ROLL_LOCAL") {
      triggerVttRollLocal(
        message.rollSpec,
        message.part || "tohit",
        message.mode || "normal",
        message.cmdOptions || {}
      )
        .then((res) => sendResponse({ ok: true, ...(res || { triggered: false }) }))
        .catch(() => sendResponse({ ok: false, triggered: false }));
      return true;
    }
    if (message?.type === "SHOW_ANALYZED_COACH_FROM_FRAME") {
      if (message.matchedSpec) {
        renderAnalyzedRollCoachLocal(
          message.matchedSpec,
          message.part || "tohit",
          message.rolledTotal ?? null,
          message.rawActionLabel || "",
          message.vttStatus || ""
        );
      }
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

    const handleNativeSheetInteraction = (ev) => {
      try {
        if (ev.type === "pointerdown" && ev.button === 2) return;
        if (Date.now() < suppressClickCoachUntil) return;
        const target = ev.target;
        if (!target || typeof target.closest !== "function") return;
        if (target.id === "dnd-copilot-ui-host" || target.closest("#dnd-copilot-ui-host, #dnd-copilot-roll-pill, #dnd-copilot-roll-drawer, #dnd-copilot-roll-toast")) return;
        const rm = window.DnDCopilot?.RollMaximizer;
        const myChar = rollContext?.myChar;
        if (!rm || !myChar) return;

        const clickable = target.closest(
          "button.integrated-dice__container, .integrated-dice__container, [class*='integrated-dice'], [class*='rollable'], [class*='dice-button'], [data-dice-notation], button, [role='button']"
        );
        if (!clickable) return;

        const exactMatch = extractClickedDdbRollInfo(clickable);
        if (exactMatch?.matchedSpec) {
          suppressClickCoachUntil = Date.now() + 350;
          showAnalyzedRollCoach(exactMatch.matchedSpec, exactMatch.part, null, "", "sent");
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
          suppressClickCoachUntil = Date.now() + 350;
          showAnalyzedRollCoach(
            analyzed.matchedSpec,
            clickKind === "damage" ? "damage" : "tohit",
            null,
            ctxText.slice(0, 48),
            "sent"
          );
        }
      } catch (_) {
        // Never interfere with host DDB click handlers
      }
    };

    window.addEventListener("pointerdown", handleNativeSheetInteraction, true);
    document.addEventListener("click", handleNativeSheetInteraction, true);
  }

  async function ensureRollContextLoaded(forceReg = false) {
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
    await registerCurrentFrame(forceReg);
    renderFloatingRollDrawer();
  }

  registerCurrentFrame(true);
  ensureRollContextLoaded(true);
  initSheetRollClickListener();
  setInterval(() => ensureRollContextLoaded(true), 60000);
  window.addEventListener("resize", () => {
    renderFloatingRollDrawer();
    applyUiRightOffset();
  });

  // Observe DOM updates cleanly with debounce
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      registerCurrentFrame(false);
      pushUpdatesIfChanged();
    }, 350);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-current", "data-name", "ishidden", "style", "class", "value"]
  });

  // Periodic gentle heartbeat for input.value updates that don't fire DOM attribute mutations
  setInterval(() => {
    registerCurrentFrame(false);
    pushUpdatesIfChanged();
  }, 2500);
  setTimeout(() => {
    registerCurrentFrame(false);
    pushUpdatesIfChanged();
  }, 900);
})();
