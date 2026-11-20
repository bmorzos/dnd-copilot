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
  let shadowUiRoot = null;
  let hasTopFrameCoach = false;
  let lastFrameRegKey = "";

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

  async function triggerNativeDdbRollLocal(rollSpec, part = "tohit") {
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
    return { triggered: true, part, via: "ddb-sheet" };
  }

  async function tryAboveVttChatRoll(rollSpec, part = "tohit", mode = "normal") {
    const rm = window.DnDCopilot?.RollMaximizer;
    if (!rm?.buildAboveVttSlashCommand) return { triggered: false };
    const cmd = rm.buildAboveVttSlashCommand(rollSpec, part, mode);
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

  async function triggerVttRollLocal(rollSpec, part = "tohit", mode = "normal") {
    if (!rollSpec) return { triggered: false };
    if (mode === "adv" || mode === "dis") {
      const chatRes = await tryAboveVttChatRoll(rollSpec, part, mode);
      if (chatRes.triggered) return chatRes;
      return await triggerNativeDdbRollLocal(rollSpec, part);
    }
    const nativeRes = await triggerNativeDdbRollLocal(rollSpec, part);
    if (nativeRes.triggered) return nativeRes;
    return await tryAboveVttChatRoll(rollSpec, part, mode);
  }

  async function triggerSharedVttRoll(rollSpec, part = "tohit", mode = "normal") {
    const localRes = await triggerVttRollLocal(rollSpec, part, mode);
    if (localRes?.triggered) return localRes;

    try {
      const relayRes = await chrome.runtime.sendMessage({
        type: "RELAY_TRIGGER_SHEET_ROLL",
        rollSpec,
        part,
        mode,
        characterId: rollContext?.myChar?.id || ""
      });
      if (relayRes?.triggered) return relayRes;
    } catch (_) {}

    return { triggered: false };
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

    const header = document.createElement("div");
    header.className = "dc-head";
    const titleEl = document.createElement("strong");
    titleEl.className = "dc-head-title";
    const totalSuffix =
      st.rolledTotal != null
        ? st.appliedAddonBonus
          ? ` (${st.rolledTotal} → ${st.rolledTotal + st.appliedAddonBonus})`
          : ` (Rolled ${st.rolledTotal})`
        : "";
    titleEl.textContent = `🎲 ${st.title}${totalSuffix}`;

    const actionBtns = document.createElement("div");
    actionBtns.className = "dc-actions";

    if (st.sayScript) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "dc-icon-btn";
      copyBtn.textContent = "📋";
      copyBtn.title = "Copy Say-Aloud script";
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
    openDrawerBtn.className = "dc-icon-btn is-gold";
    openDrawerBtn.textContent = "🎲";
    openDrawerBtn.title = "Open 1-Click Quick Roll bar";
    openDrawerBtn.addEventListener("click", () => {
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

    if (st.vttStatus === "sent") {
      const stBox = document.createElement("div");
      stBox.className = "dc-vtt-status is-sent";
      stBox.textContent = "✓ Posted to AboveVTT Game Log (visible to DM & party)";
      card.appendChild(stBox);
    } else if (st.vttStatus === "save_dc_only") {
      const stBox = document.createElement("div");
      stBox.className = "dc-vtt-status is-info";
      stBox.textContent = `ℹ️ Enemy Save DC ${st.matchedSpec?.saveDc || ""} (${st.matchedSpec?.saveAbility || "Save"}) — announce this DC to the DM!`;
      card.appendChild(stBox);
    } else if (st.vttStatus === "local_only") {
      const stBox = document.createElement("div");
      stBox.className = "dc-vtt-status is-warn";
      stBox.textContent = "⚠️ Not posted to VTT Log yet — open Raine's sheet once inside AboveVTT (or open the Game Log sidebar) so 1-click rolls post straight to the table!";
      card.appendChild(stBox);
    }

    if (st.sayScript) {
      const sayBox = document.createElement("div");
      sayBox.className = "dc-say-box";
      sayBox.textContent = `🗣️ Say: “${st.sayScript}”`;
      card.appendChild(sayBox);
    }

    if (st.bullets && st.bullets.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "dc-bullets";
      for (const b of st.bullets.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    // 1-click VTT follow-ups & situational bonus math right inside the popup
    const followRow = document.createElement("div");
    followRow.className = "dc-follow-row";

    const rm = window.DnDCopilot?.RollMaximizer;
    if (st.matchedSpec && st.part !== "damage" && (st.matchedSpec.damageFormula || st.matchedSpec.kind === "spell_attack" || st.matchedSpec.kind === "weapon_attack")) {
      const dmgFollowBtn = document.createElement("button");
      dmgFollowBtn.type = "button";
      dmgFollowBtn.className = "dc-follow-btn is-dmg";
      dmgFollowBtn.textContent = `💥 Roll ${st.matchedSpec.damageFormula || "Damage"} → VTT`;
      dmgFollowBtn.addEventListener("click", async () => {
        const res = await triggerSharedVttRoll(st.matchedSpec, "damage", "normal");
        showAnalyzedRollCoach(st.matchedSpec, "damage", null, "", res?.triggered ? "sent" : "local_only");
      });
      followRow.appendChild(dmgFollowBtn);
    }

    if (st.matchedSpec && st.part !== "damage" && st.matchedSpec.kind !== "spell_save" && st.matchedSpec.kind !== "item_save") {
      const advBtn = document.createElement("button");
      advBtn.type = "button";
      advBtn.className = "dc-follow-btn is-adv";
      advBtn.textContent = st.hasAdvantageFeature ? "⚡ Roll Adv (2d20) → VTT" : "⚡ 2d20 Adv → VTT";
      advBtn.addEventListener("click", async () => {
        const res = await triggerSharedVttRoll(st.matchedSpec, "tohit", "adv");
        st.vttStatus = res?.triggered ? "sent" : "local_only";
        st.updatedAt = Date.now();
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
      getShadowEl("dnd-copilot-roll-toast")?.remove();
    }, 20000);
  }

  function renderAnalyzedRollCoachLocal(matchedSpec, part = "tohit", rolledTotal = null, rawActionLabel = "", vttStatus = "") {
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
      vttStatus,
      updatedAt: Date.now(),
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

  function showAnalyzedRollCoach(matchedSpec, part = "tohit", rolledTotal = null, rawActionLabel = "", vttStatus = "") {
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
            renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus);
          }
        })
        .catch(() => {
          renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus);
        });
      return;
    }
    renderAnalyzedRollCoachLocal(matchedSpec, part, rolledTotal, rawActionLabel, vttStatus);
  }

  function showRollCoachToast(title, bullets = [], sayScript = "", vttStatus = "") {
    activeCoachState = {
      matchedSpec: null,
      part: "tohit",
      rolledTotal: null,
      vttStatus,
      updatedAt: Date.now(),
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
        activeCoachState.vttStatus = "sent";
        activeCoachState.updatedAt = Date.now();
        renderRollCoachToast();
        continue;
      }

      if (res.matchedSpec) {
        showAnalyzedRollCoach(res.matchedSpec, part, roll.total, roll.action, "sent");
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
        renderFloatingRollDrawer();
      });
      root.appendChild(pill);
    }

    let drawer = getShadowEl("dnd-copilot-roll-drawer");
    if (!coachDrawerOpen) {
      if (drawer) drawer.style.display = "none";
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

    const rm = window.DnDCopilot?.RollMaximizer;
    const myChar = rollContext?.myChar;
    const party = rollContext?.party || [];

    const head = document.createElement("div");
    head.className = "dc-head";
    const hTitle = document.createElement("strong");
    hTitle.className = "dc-head-title";
    hTitle.textContent = myChar ? `🎲 1-Click Roll → VTT (${myChar.name})` : "🎲 1-Click Roll";
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

    if (!rm || !myChar) {
      const msg = document.createElement("div");
      msg.style.color = "#cbd5e8";
      msg.textContent = "Open your character sheet or http://localhost:8765 once to sync your sheet.";
      drawer.appendChild(msg);
      return;
    }

    const searchInp = document.createElement("input");
    searchInp.type = "text";
    searchInp.className = "dc-search";
    searchInp.placeholder = "Filter any spell, save, or skill (1 click rolls to VTT)...";
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

    const triggerQuickItem = async (spec, part = "tohit") => {
      coachDrawerOpen = false;
      renderFloatingRollDrawer();

      if ((spec.kind === "spell_save" || spec.kind === "item_save") && !spec.damageFormula) {
        showAnalyzedRollCoach(spec, part, null, "", "save_dc_only");
        return;
      }

      const vttRes = await triggerSharedVttRoll(spec, part, "normal");
      if (vttRes?.triggered) {
        showAnalyzedRollCoach(spec, part, null, "", "sent");
        return;
      }

      // Local fallback preview when neither native sheet nor VTT chat box is open
      const fallbackRoll = rm.executeRoll(spec, myChar, party);
      const rolledNum =
        part === "damage"
          ? fallbackRoll.damageResult?.total ?? fallbackRoll.d20Result?.total ?? null
          : fallbackRoll.d20Result?.total ?? fallbackRoll.damageResult?.total ?? null;
      showAnalyzedRollCoach(spec, part, rolledNum, "", "local_only");
    };

    const addSectionLabel = (txt) => {
      const lbl = document.createElement("div");
      lbl.className = "dc-sec-label";
      lbl.textContent = txt;
      drawer.appendChild(lbl);
    };

    // 1. Spells & Attacks (1-click direct + optional damage pill right beside it!)
    const combatItems = (catalog.spellsAndAttacks || []).filter((s) =>
      !q || `${s.name} ${s.subLabel}`.toLowerCase().includes(q)
    );
    if (combatItems.length > 0) {
      addSectionLabel("✨ Spells & Attacks (Rolls into VTT Log)");
      const grid = document.createElement("div");
      grid.className = "dc-grid";
      for (const sp of (q ? combatItems : combatItems.slice(0, 8))) {
        const wrap = document.createElement("div");
        wrap.className = "dc-chip-wrap";
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
      row.className = "dc-grid";
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
      skRow.className = "dc-grid";
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
      triggerVttRollLocal(message.rollSpec, message.part || "tohit", message.mode || "normal")
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
    document.addEventListener(
      "click",
      (ev) => {
        try {
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
      },
      true
    );
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
  window.addEventListener("resize", () => renderFloatingRollDrawer());

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
