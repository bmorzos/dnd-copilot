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
  let coachCategory = "spells";
  let coachSelectedId = "";
  const coachToggleMap = new Map();
  let coachLastResult = null;
  let coachDrawerOpen = false;
  let coachToastTimer = null;

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
    // Strictly skip DM-only hidden game log entries
    if (!isElementVisible(li)) return null;

    const rawText = (li.innerText || li.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText || rawText.length < 2) return null;

    // Extract structured segments from DDB / AboveVTT game log markup
    const sender =
      li.querySelector(
        "[class*='sender'], [class*='characterName'], [class*='playerName'], .gamelog-character-name, strong, b"
      )?.textContent?.trim() || "";

    const actionLabel =
      li.querySelector(
        "[class*='action'], [class*='rollName'], [class*='title'], .dice_result__info__title"
      )?.textContent?.trim() || "";

    const rollTypeLabel =
      li.querySelector(
        "[class*='rollType'], .dice_result__rolltype, [class*='subTitle']"
      )?.textContent?.trim() || "";

    const totalEl = li.querySelector(
      "[class*='total'], .dice_result__total-result, [class*='resultTotal'], [class*='finalResult']"
    );

    let total = null;
    if (totalEl) {
      const parsed = parseInt(totalEl.textContent.replace(/[^\d-]/g, ""), 10);
      if (Number.isFinite(parsed)) total = parsed;
    }

    const formulaMatch = rawText.match(/\b(\d+d\d+(?:\s*[+-]\s*\d+)?)\b/i);
    const formula = formulaMatch ? formulaMatch[1].replace(/\s+/g, "") : "";

    // Fallback numeric extraction for AboveVTT custom injected dice cards
    if (total === null && formula) {
      const numbers = rawText.match(/(?:=|:|\bresult\b)\s*(-?\d{1,4})\b/i) || rawText.match(/\b(-?\d{1,3})\s*$/);
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
    const containers = document.querySelectorAll(
      ".ct-game-log-pane, [class*='styles_gameLogPane'], [class*='GameLog'], #gamelog_panel"
    );
    const entries = [];
    const seenInPass = new Set();

    containers.forEach((container) => {
      container.querySelectorAll("li").forEach((li) => {
        const parsed = parseGameLogEntry(li);
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

  function showRollCoachToast(title, bullets = [], sayScript = "") {
    let card = document.getElementById("dnd-copilot-roll-toast");
    if (!card) {
      card = document.createElement("div");
      card.id = "dnd-copilot-roll-toast";
      Object.assign(card.style, {
        position: "fixed",
        bottom: "64px",
        right: "16px",
        zIndex: "2147483646",
        width: "375px",
        maxWidth: "calc(100vw - 32px)",
        background: "#171d2b",
        border: "1.5px solid #f0c46c",
        borderRadius: "12px",
        padding: "12px 14px",
        color: "#f3f6fc",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13.5px",
        lineHeight: "1.45",
        boxShadow: "0 14px 36px rgba(0,0,0,0.72)"
      });
      document.body.appendChild(card);
    }
    card.textContent = "";

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      marginBottom: "6px"
    });
    const titleEl = document.createElement("strong");
    titleEl.style.color = "#f0c46c";
    titleEl.textContent = `🎲 ${title || "Full Potential Coach"}`;
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
    closeBtn.addEventListener("click", () => card.remove());
    header.append(titleEl, closeBtn);
    card.appendChild(header);

    if (sayScript) {
      const sayBox = document.createElement("div");
      Object.assign(sayBox.style, {
        padding: "7px 10px",
        borderLeft: "3px solid #f0c46c",
        borderRadius: "0 8px 8px 0",
        background: "rgba(240, 196, 108, 0.13)",
        color: "#fef3c7",
        marginBottom: bullets.length ? "6px" : "0"
      });
      sayBox.textContent = `🗣️ Say: “${sayScript}”`;
      card.appendChild(sayBox);
    }

    if (bullets.length > 0) {
      const ul = document.createElement("ul");
      Object.assign(ul.style, { margin: "4px 0 0 16px", padding: "0", color: "#cbd5e8" });
      for (const b of bullets.slice(0, 4)) {
        const li = document.createElement("li");
        li.textContent = b;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (coachToastTimer) clearTimeout(coachToastTimer);
    coachToastTimer = setTimeout(() => {
      document.getElementById("dnd-copilot-roll-toast")?.remove();
    }, 18000);
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
      if (!res || res.reminders.length === 0) continue;
      const sayLines = res.reminders.map((r) => r.sayThis).filter(Boolean).slice(0, 3);
      const bullets = res.reminders.slice(0, 4).map((r) => `${r.title}${r.extraNote ? ` (${r.extraNote})` : ""}`);
      showRollCoachToast(
        `${myChar.name} · ${roll.action}${roll.total != null ? ` (${roll.total})` : ""}`,
        bullets,
        sayLines.join(" ")
      );
    }
  }

  function renderFloatingRollDrawer() {
    let pill = document.getElementById("dnd-copilot-roll-pill");
    if (!pill && document.body) {
      pill = document.createElement("button");
      pill.id = "dnd-copilot-roll-pill";
      pill.type = "button";
      pill.textContent = "🎲 Roll Coach";
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
        width: "380px",
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "75vh",
        overflowY: "auto",
        background: "#131824",
        border: "1.5px solid #2c3752",
        borderRadius: "12px",
        padding: "12px 14px",
        color: "#f3f6fc",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13.5px",
        lineHeight: "1.45",
        boxShadow: "0 16px 42px rgba(0,0,0,0.78)"
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
      marginBottom: "8px"
    });
    const hTitle = document.createElement("strong");
    hTitle.style.color = "#f0c46c";
    hTitle.textContent = myChar ? `🎲 ${myChar.name} (${myChar.classSummary})` : "🎲 Roll Coach";
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
      msg.textContent = "Open D&D Copilot dashboard once to sync your party character sheet into AboveVTT.";
      drawer.appendChild(msg);
      return;
    }

    const tabs = document.createElement("div");
    Object.assign(tabs.style, { display: "flex", gap: "6px", marginBottom: "8px" });
    for (const [key, lbl] of [["spells", "✨ Spells/Atk"], ["saves", "🛡️ Saves"], ["skills", "🔎 Skills"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = lbl;
      Object.assign(b.style, {
        flex: "1",
        padding: "5px 6px",
        borderRadius: "7px",
        border: "1px solid #2c3752",
        background: coachCategory === key ? "#5b8af5" : "#1f273a",
        color: "#ffffff",
        fontSize: "12.5px",
        fontWeight: "600",
        cursor: "pointer"
      });
      b.addEventListener("click", () => {
        coachCategory = key;
        coachSelectedId = "";
        coachLastResult = null;
        renderFloatingRollDrawer();
      });
      tabs.appendChild(b);
    }
    drawer.appendChild(tabs);

    const catalog = rm.getRollCatalog(myChar, party);
    const items =
      coachCategory === "saves"
        ? catalog.saves
        : coachCategory === "skills"
        ? catalog.skills
        : catalog.spellsAndAttacks;

    if (!items.some((i) => i.id === coachSelectedId)) {
      coachSelectedId = items[0]?.id || "";
    }

    const sel = document.createElement("select");
    Object.assign(sel.style, {
      width: "100%",
      padding: "7px 9px",
      borderRadius: "7px",
      border: "1px solid #2c3752",
      background: "#1f273a",
      color: "#f3f6fc",
      marginBottom: "8px",
      fontSize: "13px"
    });
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.id;
      opt.textContent = `${it.name} (${it.subLabel || ""})`;
      opt.selected = it.id === coachSelectedId;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      coachSelectedId = sel.value;
      coachLastResult = null;
      renderFloatingRollDrawer();
    });
    drawer.appendChild(sel);

    const picked = items.find((i) => i.id === coachSelectedId);
    if (!picked) return;

    const analysis = rm.analyzeRollPotential(picked, myChar, party);
    if (!coachToggleMap.has(picked.id)) {
      coachToggleMap.set(
        picked.id,
        new Set(analysis.modifiers.filter((m) => m.defaultOn).map((m) => m.id))
      );
    }
    const activeSet = coachToggleMap.get(picked.id);

    const listWrap = document.createElement("div");
    Object.assign(listWrap.style, { display: "flex", flexDirection: "column", gap: "5px", marginBottom: "9px" });
    for (const mod of analysis.modifiers) {
      const row = document.createElement("label");
      Object.assign(row.style, {
        display: "flex",
        gap: "7px",
        alignItems: "flex-start",
        padding: "6px 8px",
        borderRadius: "7px",
        background: "#1f273a",
        border: "1px solid #2c3752",
        cursor: "pointer"
      });
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = activeSet.has(mod.id);
      cb.style.marginTop = "3px";
      cb.addEventListener("change", () => {
        if (cb.checked) activeSet.add(mod.id);
        else activeSet.delete(mod.id);
      });
      const txtWrap = document.createElement("div");
      const topLine = document.createElement("div");
      topLine.style.fontWeight = "600";
      topLine.textContent = `${mod.title}${mod.badge ? ` [${mod.badge}]` : ""}`;
      txtWrap.appendChild(topLine);
      if (mod.sayThis) {
        const sub = document.createElement("div");
        sub.style.cssText = "font-size:12px;color:#cbd5e8;";
        sub.textContent = `💬 ${mod.sayThis}`;
        txtWrap.appendChild(sub);
      }
      row.append(cb, txtWrap);
      listWrap.appendChild(row);
    }
    drawer.appendChild(listWrap);

    const actRow = document.createElement("div");
    Object.assign(actRow.style, { display: "flex", gap: "7px", marginBottom: "8px" });
    const runDrawerRoll = (forceAdv) => {
      const res = rm.executeRoll(picked, myChar, party, { activeToggleIds: activeSet, forceAdvantage: forceAdv });
      coachLastResult = res;
      const primaryTotal = res.d20Result ? res.d20Result.total : res.damageResult ? res.damageResult.total : null;
      chrome.runtime
        .sendMessage({
          type: "GAMELOG_ROLLS",
          rolls: [
            {
              fingerprint: `avtt-coach-${Date.now()}-${picked.id}`,
              timestamp: Date.now(),
              actor: myChar.name,
              action: picked.name,
              kind: picked.kind === "save" ? "save" : picked.kind === "initiative" ? "initiative" : "attack",
              total: primaryTotal,
              formula: picked.damageFormula || "",
              isCrit: Boolean(res.d20Result?.isCrit),
              isFumble: Boolean(res.d20Result?.isFumble),
              rawText: res.sayAloudScript
            }
          ]
        })
        .catch(() => {});
      renderFloatingRollDrawer();
    };

    const btnRoll = document.createElement("button");
    btnRoll.type = "button";
    btnRoll.textContent = "🎲 Roll Now";
    Object.assign(btnRoll.style, {
      flex: "1",
      padding: "7px 10px",
      borderRadius: "7px",
      border: "none",
      background: "#f0c46c",
      color: "#111622",
      fontWeight: "700",
      cursor: "pointer"
    });
    btnRoll.addEventListener("click", () => runDrawerRoll(false));

    const btnAdv = document.createElement("button");
    btnAdv.type = "button";
    btnAdv.textContent = "⚡ Advantage";
    Object.assign(btnAdv.style, {
      padding: "7px 10px",
      borderRadius: "7px",
      border: "1px solid #2c3752",
      background: "#1f273a",
      color: "#f3f6fc",
      fontWeight: "600",
      cursor: "pointer"
    });
    btnAdv.addEventListener("click", () => runDrawerRoll(true));
    actRow.append(btnRoll, btnAdv);
    drawer.appendChild(actRow);

    if (coachLastResult && coachLastResult.rollSpec?.id === picked.id) {
      const box = document.createElement("div");
      Object.assign(box.style, {
        padding: "9px 10px",
        borderRadius: "8px",
        background: "rgba(62, 207, 142, 0.12)",
        border: "1px solid rgba(62, 207, 142, 0.5)"
      });
      const resBits = [];
      if (coachLastResult.d20Result) resBits.push(`Roll: ${coachLastResult.d20Result.total}`);
      if (coachLastResult.damageResult) resBits.push(`Dmg: ${coachLastResult.damageResult.total}`);
      const headRes = document.createElement("strong");
      headRes.style.color = "#f0c46c";
      headRes.textContent = resBits.join(" · ") || picked.name;
      const sayEl = document.createElement("div");
      sayEl.style.cssText = "margin-top:5px;color:#fef3c7;";
      sayEl.textContent = `🗣️ Say: “${coachLastResult.sayAloudScript}”`;
      box.append(headRes, sayEl);
      drawer.appendChild(box);
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

  chrome.runtime
    .sendMessage({ type: "GET_ROLL_CONTEXT" })
    .then((resp) => {
      if (resp?.myChar) {
        rollContext = { myChar: resp.myChar, party: resp.party || [] };
      }
      renderFloatingRollDrawer();
    })
    .catch(() => {
      renderFloatingRollDrawer();
    });

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
