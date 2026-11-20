/**
 * Clean, Large-Font UI Controller for D&D Copilot.
 * Features 1-click Chrome <-> Groq toggle, large What's Going On view,
 * minimized transcript drawer, tabbed center focus, and crash-safe session recording.
 */
(function (global) {
  const store = global.DnDCopilot.Store;
  const gemini = global.DnDCopilot.GeminiClient;

  let activeTab = "advisor"; // "advisor" | "puzzle" | "combat"
  let toastTimeout = null;
  let currentRecordingObjectUrl = null;
  let currentLoadedAudioFile = null;
  let isUpdatingIdeas = false;
  let lastCustomAdvisorQuestionAt = 0;
  let driveArchiveStatus = null;
  let driveMysteriesData = null;
  let mysteryFilter = "all";
  let fastPlayCancelled = false;
  let isFastPlaying = false;
  let liveIdeasDebounceTimer = null;

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function showToast(msg, isError = false) {
    const banner = el("toastBanner");
    if (!banner) return;
    banner.textContent = msg;
    banner.style.borderColor = isError ? "#ef4444" : "#f0c46c";
    banner.classList.remove("hidden");
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => banner.classList.add("hidden"), 4000);
  }

  const bridge = new global.DnDCopilot.AboveVttBridgeHost(store, {
    onToast: (m) => showToast(m, false)
  });

  function playSoftAlertChime() {
    try {
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      gain.connect(ctx.destination);

      const osc1 = ctx.createOscillator();
      osc1.frequency.value = 440;
      osc1.connect(gain);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.16);

      const osc2 = ctx.createOscillator();
      osc2.frequency.value = 330;
      osc2.connect(gain);
      osc2.start(ctx.currentTime + 0.18);
      osc2.stop(ctx.currentTime + 0.38);
      setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch (_) {}
  }

  let lastAlertSentAt = 0;

  function triggerHealthWarning(msg) {
    const bar = el("healthAlertBanner");
    const txt = el("healthAlertText");
    if (bar && txt) {
      txt.textContent = msg;
      bar.classList.remove("hidden");
    }

    // Throttle audible chime & OS notifications so repeated retries don't spam every 8s
    if (Date.now() - lastAlertSentAt < 25000) return;
    lastAlertSentAt = Date.now();

    playSoftAlertChime();

    if (bridge.isExtensionContext()) {
      chrome.runtime.sendMessage({ type: "HEALTH_ALERT", message: msg }).catch(() => {});
    } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("D&D Copilot — Recording/Transcript Alert", { body: msg });
      } catch (_) {}
    }
  }

  function clearHealthWarning() {
    el("healthAlertBanner")?.classList.add("hidden");
    if (bridge.isExtensionContext()) {
      chrome.runtime.sendMessage({ type: "HEALTH_CLEAR" }).catch(() => {});
    }
  }

  const sessionRecorder = new global.DnDCopilot.SessionRecorder(
    (recStatus) => {
      const recBtn = el("btnToggleRecord");
      const recLbl = el("recordBtnLabel");
      if (recBtn && recLbl) {
        recBtn.classList.toggle("recording", recStatus.isRecording);
        recLbl.textContent = recStatus.isRecording
          ? `⏹ ${recStatus.elapsedLabel}`
          : "⏺ Record";
      }
      if (!el("savedModal")?.classList.contains("hidden")) {
        renderSavedModal();
      }
    },
    (alertMsg) => triggerHealthWarning(alertMsg)
  );

  const audioListener = new global.DnDCopilot.TableAudioListener(store, {
    onInterimText: (text) => {
      const box = el("interimSpeechBanner");
      if (!box) return;
      if (text) {
        box.textContent = text;
        box.classList.remove("hidden");
      } else {
        box.classList.add("hidden");
      }
    },
    onStatusChange: ({ listening, source }) => {
      const micBtn = el("btnToggleMic");
      const micLbl = el("micBtnLabel");
      if (micBtn) micBtn.classList.toggle("listening", listening && source === "mic");
      if (micLbl) micLbl.textContent = listening && source === "mic" ? "⏹ Stop Mic" : "🎙️ Mic";

      const sysBtn = el("btnSystemAudio");
      const sysLbl = el("sysAudioBtnLabel");
      if (sysBtn) sysBtn.classList.toggle("listening", listening && source === "system");
      if (sysLbl)
        sysLbl.textContent = listening && source === "system" ? "⏹ Stop PC Audio" : "🔊 PC Audio";

      const fileBtn = el("btnLoadAudioFile");
      if (fileBtn) fileBtn.classList.toggle("listening", listening && source === "file");

      renderTopBar(store.state, store.settings);
    },
    onVolumeLevel: (pct) => {
      const bar = el("vuBarFill");
      if (bar) bar.style.width = `${pct}%`;
    },
    onError: (errMsg) => showToast(errMsg, true),
    onHealthAlert: (alertMsg) => triggerHealthWarning(alertMsg),
    onHealthRecovered: () => clearHealthWarning(),
    onSpeechBatchReady: async () => {
      try {
        const res = await gemini.analyzeTableSituation(store);
        if (res?._appliedPartyUpdates?.length > 0) {
          showToast(`Auto-updated sheets: ${res._appliedPartyUpdates.slice(0, 2).join("; ")}`);
        }
        await refreshLiveIdeasSilently();
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    }
  });

  async function refreshLiveIdeasSilently(force = false) {
    if (isUpdatingIdeas || store.settings?.autoUpdateIdeas === false) return;
    if (!force && Date.now() - lastCustomAdvisorQuestionAt < 15000) return;
    isUpdatingIdeas = true;
    try {
      await gemini.adviseTacticsAndSpells(store, "");
      if (store.state.puzzle?.isActive || store.state.situation?.sceneMode === "Puzzle") {
        await gemini.solvePuzzle(store);
      }
    } catch (_) {
      // Keep quiet during background continuous updates
    } finally {
      isUpdatingIdeas = false;
    }
  }

  function scheduleLiveIdeasRefresh() {
    if (liveIdeasDebounceTimer) clearTimeout(liveIdeasDebounceTimer);
    liveIdeasDebounceTimer = setTimeout(() => {
      liveIdeasDebounceTimer = null;
      refreshLiveIdeasSilently(true);
    }, 350);
  }

  function reconcileSlotInfoWithSheet(slotInfo, myChar) {
    const str = String(slotInfo || "");
    if (!myChar?.spellSlots?.length) return str;
    return str.replace(/\b(Pact\s+)?L(\d+)\s+slot\s*\(\d+\/\d+\s+left\)/gi, (full, pactPfx, lvlStr) => {
      const lvl = Number(lvlStr);
      const wantsPact = Boolean(pactPfx);
      const slot =
        myChar.spellSlots.find((s) => Number(s.level) === lvl && Boolean(s.isPact) === wantsPact) ||
        myChar.spellSlots.find((s) => Number(s.level) === lvl);
      if (!slot) return full;
      return `${slot.isPact ? "Pact " : ""}L${slot.level} slot (${slot.remaining}/${slot.max} left)`;
    });
  }

  /* ---------------- RENDERING ---------------- */

  function renderTopBar(state, settings) {
    const bridgeBtn = el("btnOpenBridgeModal");
    const bridgeTxt = el("bridgeStatusText");
    const isConnected = state.bridgeStatus.mode !== "disconnected";
    bridgeBtn.classList.toggle("connected", isConnected);
    bridgeTxt.textContent = isConnected ? "AboveVTT Live" : "AboveVTT";

    const mode =
      settings.speechMode === "groq"
        ? "groq"
        : settings.speechMode === "deepgram"
        ? "deepgram"
        : "chrome";
    el("btnEngineChrome").classList.toggle("active", mode === "chrome");
    el("btnEngineGroq").classList.toggle("active", mode === "groq");
    el("btnEngineDeepgram")?.classList.toggle("active", mode === "deepgram");
  }

  function renderWhatsGoingOn(state) {
    const sit = state.situation || {};
    el("sceneModeBadge").textContent = sit.sceneMode || "Exploration";

    const locEl = el("situationLocation");
    if (locEl) {
      if (sit.location) {
        locEl.textContent = `📍 ${sit.location}`;
        locEl.classList.remove("hidden");
      } else {
        locEl.classList.add("hidden");
      }
    }

    el("situationHeadline").textContent =
      sit.headline || "Ready to listen to your game.";

    const bullets = sit.summaryBullets || [];
    el("situationBullets").innerHTML = bullets
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join("");

    const objs = sit.activeObjectives || [];
    const objBox = el("situationObjectives");
    if (objs.length > 0) {
      objBox.classList.remove("hidden");
      objBox.innerHTML = `<strong>Current Goals</strong>${objs
        .map((o) => `<div>• ${escapeHtml(o)}</div>`)
        .join("")}`;
    } else {
      objBox.classList.add("hidden");
    }

    const moves = sit.suggestedNextMoves || [];
    const movesBox = el("situationNextMoves");
    if (movesBox) {
      if (moves.length > 0) {
        movesBox.classList.remove("hidden");
        movesBox.innerHTML = `<strong>⚡ What You Can Do Right Now</strong>${moves
          .map(
            (m) =>
              `<button type="button" class="next-move-btn" data-try-move="${escapeHtml(m)}">→ ${escapeHtml(
                m
              )}</button>`
          )
          .join("")}`;
      } else {
        movesBox.classList.add("hidden");
      }
    }

    const npcs = sit.notableNpcs || [];
    const npcBox = el("situationNpcs");
    if (npcBox) {
      if (npcs.length > 0) {
        npcBox.classList.remove("hidden");
        npcBox.innerHTML = `<span style="font-size:13px;color:var(--text-muted);font-weight:600;">NPCs / Names:</span>${npcs
          .map(
            (n) =>
              `<button type="button" class="npc-chip" data-search-npc="${escapeHtml(
                n
              )}" title="Search past Drive transcripts for ${escapeHtml(n)}">🔍 ${escapeHtml(n)}</button>`
          )
          .join("")}`;
      } else {
        npcBox.classList.add("hidden");
      }
    }

    const beats = state.sessionBeats || [];
    const tlDrawer = el("sessionTimelineDrawer");
    const tlList = el("sessionTimelineList");
    const beatCount = el("beatCount");
    if (tlDrawer && tlList && beatCount) {
      beatCount.textContent = String(beats.length);
      if (beats.length > 0) {
        tlDrawer.classList.remove("hidden");
        tlList.innerHTML = beats
          .map(
            (b, i) => `
            <div class="timeline-beat">
              <strong>Act ${i + 1} (${escapeHtml(b.sceneMode || "Scene")}${
              b.location ? ` · ${escapeHtml(b.location)}` : ""
            }):</strong> ${escapeHtml(b.headline)}
            </div>
          `
          )
          .join("");
      } else {
        tlDrawer.classList.add("hidden");
      }
    }

    // Minimized Transcript Drawer
    el("transcriptCount").textContent = String(state.transcript.length);
    const listEl = el("transcriptList");
    if (state.transcript.length === 0) {
      listEl.innerHTML = `<div class="muted-p">Nothing transcribed yet.</div>`;
    } else {
      listEl.innerHTML = state.transcript
        .slice(-40)
        .reverse()
        .map(
          (t) => `
          <div class="transcript-line">
            <div class="transcript-line-head">
              <span><strong>${escapeHtml(t.speaker)}</strong> · ${formatTime(t.timestamp)}</span>
              <button class="btn btn-quiet" style="padding:2px 8px;font-size:12.5px;" data-pin-clue="${escapeHtml(
                t.id
              )}">
                ${t.pinnedAsClue ? "✓ Clue" : "+ Clue"}
              </button>
            </div>
            <div>${escapeHtml(t.text)}</div>
          </div>
        `
        )
        .join("");
    }
  }

  function renderCenterFocus(state) {
    el("viewAdvisor").classList.toggle("hidden", activeTab !== "advisor");
    el("viewPuzzle").classList.toggle("hidden", activeTab !== "puzzle");
    el("viewCombat").classList.toggle("hidden", activeTab !== "combat");

    document.querySelectorAll(".focus-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === activeTab);
    });

    // 1. Live Ideas & Best Moves
    const enabledMem = (store.campaignMemory || []).filter((m) => m.enabled !== false);
    const seenMemTitles = new Set(enabledMem.map((m) => String(m.title || "").toLowerCase()));
    const extraArchivedCount = (store.savedTranscripts || []).filter(
      (s) => s && !seenMemTitles.has(String(s.title || "").toLowerCase())
    ).length;
    const driveArchiveCount = Math.max(
      Number(driveArchiveStatus?.cachedTranscriptCount || 0),
      Number(driveArchiveStatus?.cachedSummaryCount || 0)
    );
    const pastBadge = el("pastSessionCount");
    if (pastBadge) {
      pastBadge.textContent = String(enabledMem.length + extraArchivedCount + driveArchiveCount);
    }

    const myChar =
      state.party.find((p) => String(p.id) === String(state.myCharacterId)) || state.party[0] || null;
    if (myChar) {
      el("playingAsLabel").textContent = state.advisor?.lastAdvisedAt
        ? `★ ${myChar.name} · Updated ${formatTime(state.advisor.lastAdvisedAt)}`
        : `★ ${myChar.name} · Auto-updating`;
    } else {
      el("playingAsLabel").textContent = "Select ★ Me on your hero →";
    }

    const concAlert = el("concentrationAlert");
    const rawWarn = String(state.advisor?.concentrationWarning || "").trim();
    const cleanWarn = /concentration\s+is\s+free/i.test(rawWarn) ? "" : rawWarn;
    const concText = myChar?.concentratingOn
      ? cleanWarn || `⚠️ Concentrating on ${myChar.concentratingOn} — another Concentration spell will drop it.`
      : cleanWarn;
    if (concText) {
      concAlert.textContent = concText;
      concAlert.classList.remove("hidden");
    } else {
      concAlert.classList.add("hidden");
    }

    const tieInBox = el("pastSessionTieInBox");
    if (tieInBox) {
      if (state.advisor?.pastSessionConnection) {
        tieInBox.textContent = `🕰️ From Past Sessions: ${state.advisor.pastSessionConnection}`;
        tieInBox.classList.remove("hidden");
      } else {
        tieInBox.classList.add("hidden");
      }
    }

    if (state.advisor.tacticalOverview) {
      el("advisorOverview").textContent = state.advisor.tacticalOverview;
    }

    const customBox = el("advisorCustomAnswer");
    if (state.advisor.customAnswer) {
      customBox.textContent = state.advisor.customAnswer;
      customBox.classList.remove("hidden");
    } else {
      customBox.classList.add("hidden");
    }

    el("advisorRecommendations").innerHTML = (state.advisor.recommendations || [])
      .map(
        (r) => `
        <div class="big-card">
          <div class="big-card-top">
            <span class="big-card-title">${escapeHtml(r.rank)}. ${escapeHtml(r.spellOrAction)}</span>
            <span class="big-card-meta">${escapeHtml(reconcileSlotInfoWithSheet(r.slotInfo, myChar))}</span>
          </div>
          <p class="big-card-desc">${escapeHtml(r.whyBest)}</p>
        </div>
      `
      )
      .join("");

    // 2. Puzzle
    const puz = state.puzzle;
    const insc = el("puzzleInscriptionInput");
    if (document.activeElement !== insc) {
      insc.value = puz.promptOrInscription || "";
    }

    el("puzzleCluesList").innerHTML = (puz.clues || [])
      .map(
        (c, i) => `
        <div class="clue-row">
          <span>• ${escapeHtml(c)}</span>
          <button class="btn btn-quiet" style="padding:3px 9px;" data-remove-clue="${i}">✕</button>
        </div>
      `
      )
      .join("");

    el("puzzleHypothesesList").innerHTML = (puz.hypotheses || [])
      .map(
        (h) => `
        <div class="big-card">
          <div class="big-card-top">
            <span class="big-card-title">${escapeHtml(h.solution)}</span>
            <span class="big-card-meta">${escapeHtml(h.confidence)}</span>
          </div>
          <p class="big-card-desc">${escapeHtml(h.reasoning)}</p>
        </div>
      `
      )
      .join("");

    el("puzzleNextChecks").innerHTML =
      puz.nextChecks && puz.nextChecks.length > 0
        ? `<strong>What to Try Next:</strong><ul>${puz.nextChecks
            .map((n) => `<li>${escapeHtml(n)}</li>`)
            .join("")}</ul>`
        : "";

    renderDriveMysteries();

    // 3. Combat & Rolls
    const cmb = state.combat;
    el("combatRoundLabel").textContent = cmb.inCombat
      ? `Round ${cmb.round || 1} (Player-Fair Combat View)`
      : "Out of Combat";

    const myStatsEl = el("myCombatStatsBar");
    if (myStatsEl) {
      if (myChar) {
        const slotBits = (myChar.spellSlots || [])
          .map((s) => `${s.isPact ? "P" : "L"}${s.level}:${s.remaining}/${s.max}`)
          .join(" ");
        myStatsEl.classList.remove("hidden");
        myStatsEl.textContent = `★ ${myChar.name} · AC ${myChar.ac}${
          myChar.spellSaveDc ? ` · DC ${myChar.spellSaveDc}` : ""
        }${myChar.spellAttackBonus != null ? ` · Atk +${myChar.spellAttackBonus}` : ""}${
          myChar.concentratingOn ? ` · 🔮 ${myChar.concentratingOn}` : ""
        }${slotBits ? ` · [${slotBits}]` : ""}`;
      } else {
        myStatsEl.classList.add("hidden");
      }
    }

    const triageEl = el("combatPartyTriage");
    if (triageEl) {
      const triageItems = (state.party || [])
        .map((p) => {
          const tags = [];
          if (p.hp.current <= Math.floor(p.hp.max * 0.7)) tags.push(`${p.hp.current}/${p.hp.max} HP`);
          if (p.concentratingOn) tags.push(`Conc: ${p.concentratingOn}`);
          if (p.conditions?.length) tags.push(p.conditions.join(", "));
          if (p.inspiration) tags.push("✨ Inspired");
          return tags.length > 0 ? `${p.name} (${tags.join(" · ")})` : "";
        })
        .filter(Boolean);
      if (triageItems.length > 0) {
        triageEl.classList.remove("hidden");
        triageEl.innerHTML = `<strong>Party Status:</strong> ${escapeHtml(triageItems.join("  |  "))}`;
      } else {
        triageEl.classList.add("hidden");
      }
    }

    const initStrip = el("initiativeStrip");
    if (cmb.initiativeOrder && cmb.initiativeOrder.length > 0) {
      initStrip.classList.remove("hidden");
      initStrip.innerHTML = cmb.initiativeOrder
        .map(
          (i) => `
          <span class="init-chip ${i.isCurrentTurn ? "current" : ""}">
            ${i.isCurrentTurn ? "▶ " : ""}${escapeHtml(i.name)}
          </span>
        `
        )
        .join("");
    } else {
      initStrip.classList.add("hidden");
    }

    const enemyEl = el("enemyList");
    if (!cmb.enemies || cmb.enemies.length === 0) {
      enemyEl.innerHTML = `<p class="muted-p">No enemies tracked yet — spoken foes auto-appear here, or click <strong>+ Add</strong> above.</p>`;
    } else {
      enemyEl.innerHTML = cmb.enemies
        .map((e) => {
          const selected = cmb.activeTargetTokenId === e.tokenId;
          const notes = [];
          if (e.isBloodied) notes.push("🩸 Bloodied");
          if (e.highestMissRoll !== null || e.lowestHitRoll !== null) {
            if (e.highestMissRoll !== null && e.lowestHitRoll !== null) {
              notes.push(`AC ${e.highestMissRoll + 1}–${e.lowestHitRoll}`);
            } else if (e.lowestHitRoll !== null) {
              notes.push(`AC ≤ ${e.lowestHitRoll}`);
            } else {
              notes.push(`AC ≥ ${e.highestMissRoll + 1}`);
            }
          }
          if (e.observedTraits?.length) notes.push(...e.observedTraits);

          return `
            <div class="big-card ${selected ? "enemy-card-selected" : ""} ${
            e.isDefeated ? "enemy-card-defeated" : ""
          }">
              <div class="big-card-top">
                <span class="big-card-title" style="cursor:pointer;" data-select-enemy="${escapeHtml(
                  e.tokenId
                )}">
                  ${selected ? "🎯 " : ""}${escapeHtml(e.name)}
                </span>
                <span class="dmg-pill">${e.damageTaken || 0} dmg</span>
              </div>
              ${notes.length ? `<div class="enemy-sub">${escapeHtml(notes.join("  ·  "))}</div>` : ""}
              <div class="simple-row" style="flex-wrap:wrap;">
                <button class="btn btn-quiet" data-enemy-dmg="${escapeHtml(e.tokenId)}" data-amt="5">+5</button>
                <button class="btn btn-quiet" data-enemy-dmg="${escapeHtml(e.tokenId)}" data-amt="10">+10</button>
                <button class="btn btn-quiet" data-enemy-custom-dmg="${escapeHtml(e.tokenId)}">+ Custom</button>
                <button class="btn btn-quiet" data-enemy-miss="${escapeHtml(e.tokenId)}" title="Log an attack roll that missed to narrow AC">Miss AC</button>
                <button class="btn btn-quiet" data-enemy-hit="${escapeHtml(e.tokenId)}" title="Log an attack roll that hit to narrow AC">Hit AC</button>
                <button class="btn btn-quiet" data-enemy-toggle="${escapeHtml(e.tokenId)}" data-field="isBloodied">Bloodied</button>
                <button class="btn btn-quiet" data-enemy-toggle="${escapeHtml(e.tokenId)}" data-field="isDefeated">${
            e.isDefeated ? "Revive" : "Down"
          }</button>
              </div>
            </div>
          `;
        })
        .join("");
    }

    const cevEl = el("combatEventsList");
    const cEvents = cmb.combatEvents || [];
    if (cevEl) {
      if (cEvents.length === 0) {
        cevEl.innerHTML = `<p class="muted-p">No combat beats captured yet — updates automatically from live table speech or Fast Play.</p>`;
      } else {
        cevEl.innerHTML = cEvents
          .slice(-14)
          .reverse()
          .map(
            (ev) => `
            <div class="combat-event-row ${ev.kind === "damage" ? "is-damage" : ""}">
              <span class="combat-event-badge">R${escapeHtml(ev.round || 1)}</span>
              <strong>${escapeHtml(ev.actor || "Table")}</strong>${
              ev.action ? ` · ${escapeHtml(ev.action)}` : ""
            }${ev.target ? ` → ${escapeHtml(ev.target)}` : ""}
              <div style="color:var(--text-soft);margin-top:2px;">${escapeHtml(ev.detail || "")}</div>
            </div>
          `
          )
          .join("");
      }
    }

    const activeEnemy =
      cmb.enemies.find((e) => e.tokenId === cmb.activeTargetTokenId) || cmb.enemies[0] || null;

    const rollsEl = el("gameLogList");
    if (state.gameLog.length === 0) {
      rollsEl.innerHTML = `<p class="muted-p">No AboveVTT rolls yet (or click ↻ Sync VTT).</p>`;
    } else {
      rollsEl.innerHTML = state.gameLog
        .slice(-12)
        .reverse()
        .map((r) => {
          const canApply =
            r.kind === "damage" && r.total != null && activeEnemy && !r.attributedTo;
          return `
            <div class="roll-row">
              <div>
                <strong>${escapeHtml(r.actor)}</strong> — ${escapeHtml(r.action)}
                ${r.attributedTo ? `<span style="color:#f0c46c;"> (${escapeHtml(r.attributedTo)})</span>` : ""}
              </div>
              <div class="simple-row">
                ${
                  canApply
                    ? `<button class="btn btn-action" style="padding:4px 10px;font-size:13.5px;" data-apply-roll="${escapeHtml(
                        r.fingerprint
                      )}">Apply → ${escapeHtml(activeEnemy.name.slice(0, 12))}</button>`
                    : ""
                }
                ${r.total != null ? `<span class="roll-num">${r.total}</span>` : ""}
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  function resolveCharacterSheetUrl(pc) {
    const raw = String(pc?.sheetUrl || "").trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return `https://www.dndbeyond.com${raw}`;
    const cleanId = String(pc?.id || "").trim();
    if (/^\d+$/.test(cleanId)) {
      return `https://www.dndbeyond.com/characters/${cleanId}`;
    }
    return "";
  }

  function renderParty(state) {
    const bannerEl = el("autoSheetBanner");
    const batch = state.lastAutoSheetBatch;
    if (bannerEl) {
      if (batch?.descriptions?.length > 0) {
        bannerEl.classList.remove("hidden");
        bannerEl.innerHTML = `
          <span class="auto-sheet-banner-text">🎙️ <strong>Auto-updated:</strong> ${escapeHtml(
            batch.descriptions.join(" · ")
          )}</span>
          <span class="auto-sheet-banner-actions">
            <button id="btnUndoAutoSheets" type="button" class="btn btn-quiet" style="padding:3px 9px;font-size:12.5px;">↩ Undo</button>
            <button id="btnDismissAutoSheets" type="button" class="btn btn-quiet" style="padding:3px 8px;font-size:12.5px;">✕</button>
          </span>
        `;
      } else {
        bannerEl.classList.add("hidden");
        bannerEl.innerHTML = "";
      }
    }

    const groupSelect = el("partyGroupSelect");
    if (groupSelect) {
      const names = store.getPartyGroupNames();
      const activeGroup = store.getActivePartyGroupName();
      const opts = names.map(
        (n) =>
          `<option value="${escapeHtml(n)}" ${
            n === activeGroup ? "selected" : ""
          }>Party: ${escapeHtml(n)}</option>`
      );
      if (activeGroup === "__demo__") {
        opts.push(`<option value="__demo__" selected>Party: Demo</option>`);
      }
      groupSelect.innerHTML = opts.join("");
    }

    const listEl = el("partyList");
    if (state.party.length === 0) {
      const gLabel =
        store.getActivePartyGroupName() === "__demo__"
          ? "Demo"
          : store.getActivePartyGroupName();
      listEl.innerHTML = `
        <div class="info-block">
          <strong>${escapeHtml(gLabel)} — No Sheets Yet</strong>
          <p class="muted-p">Click <strong>+ Hero</strong> above to sync your D&amp;D Beyond character sheets into <strong>${escapeHtml(
            gLabel
          )}</strong>.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = state.party
      .map((pc) => {
        const isMe = String(pc.id) === String(state.myCharacterId);
        const pct = Math.max(
          0,
          Math.min(100, Math.round((pc.hp.current / Math.max(1, pc.hp.max)) * 100))
        );
        const barColor = pct <= 30 ? "#ef4444" : pct <= 60 ? "#f59e0b" : "#3ecf8e";

        const slotsHtml =
          pc.spellSlots && pc.spellSlots.length > 0
            ? `<div class="slots-wrap">
                ${pc.spellSlots
                  .map((s, idx) => {
                    const full = "●".repeat(Math.max(0, s.remaining));
                    const used = "○".repeat(Math.max(0, s.used));
                    return `
                      <div class="slot-pill" data-slot-char="${escapeHtml(
                        pc.id
                      )}" data-slot-idx="${idx}" title="Click to spend · Shift+Click to restore">
                        <span>${s.isPact ? `Pact ${s.level}` : `L${s.level}`}</span>
                        <span class="slot-dots">${full}${used}</span>
                      </div>
                    `;
                  })
                  .join("")}
               </div>`
            : "";

        const spellsHtml =
          pc.spells && pc.spells.length > 0
            ? `<details class="hero-spells">
                <summary>Spells (${pc.spells.length})</summary>
                <div class="hero-spell-items">
                  ${pc.spells
                    .map(
                      (sp) => `
                      <div class="hero-spell-row" title="${escapeHtml(sp.summary)}">
                        <strong>${sp.level === 0 ? "Cantrip" : `L${sp.level}`} · ${escapeHtml(
                        sp.name
                      )}</strong>
                        <span style="color:#8b9bb8;"> · ${escapeHtml(sp.castingTime)}${
                        sp.concentration ? " · Conc" : ""
                      }</span>
                      </div>
                    `
                    )
                    .join("")}
                </div>
              </details>`
            : "";

        const sheetUrl = resolveCharacterSheetUrl(pc);
        const nameHtml = sheetUrl
          ? `<a class="hero-name-link" href="${escapeHtml(
              sheetUrl
            )}" target="_blank" rel="noopener noreferrer" title="Open D&amp;D Beyond character sheet">${escapeHtml(
              pc.name
            )}</a>`
          : escapeHtml(pc.name);
        const sheetBtnHtml = sheetUrl
          ? `<a class="btn btn-quiet" style="padding:5px 10px;font-size:14px;" href="${escapeHtml(
              sheetUrl
            )}" target="_blank" rel="noopener noreferrer" title="Open D&amp;D Beyond Character Sheet">Sheet ↗</a>`
          : !String(pc.id || "").startsWith("demo-")
          ? `<button type="button" class="btn btn-quiet" style="padding:5px 10px;font-size:14px;" data-link-pc="${escapeHtml(
              pc.id
            )}" title="Link D&amp;D Beyond sheet URL so stats auto-update">🔗 Link</button>`
          : "";
        const inspBtnHtml = `<button type="button" class="btn btn-quiet btn-insp ${
          pc.inspiration ? "active" : ""
        }" data-toggle-insp="${escapeHtml(pc.id)}" title="${
          pc.inspiration
            ? "Heroic Inspiration Active (click to spend)"
            : "Click to grant Heroic Inspiration"
        }">✨ Insp</button>`;
        const syncNote = pc.lastSyncedAt ? ` · Synced ${formatTime(pc.lastSyncedAt)}` : "";
        const autoTagHtml = pc.lastAutoUpdateNote
          ? ` <span class="auto-note-tag">🎙️ ${escapeHtml(pc.lastAutoUpdateNote)}</span>`
          : "";

        const statusChips = [];
        if (pc.concentratingOn) {
          statusChips.push(
            `<button type="button" class="status-chip conc" data-clear-conc="${escapeHtml(
              pc.id
            )}" title="Click to drop Concentration">🔮 Conc: ${escapeHtml(
              pc.concentratingOn
            )} ✕</button>`
          );
        }
        for (const cond of pc.conditions || []) {
          statusChips.push(
            `<button type="button" class="status-chip" data-cond-char="${escapeHtml(
              pc.id
            )}" data-remove-cond="${escapeHtml(
              cond
            )}" title="Click to clear condition">${escapeHtml(cond)} ✕</button>`
          );
        }
        const statusRowHtml =
          statusChips.length > 0 ? `<div class="hero-status-row">${statusChips.join("")}</div>` : "";

        return `
          <div class="hero-card ${isMe ? "is-me" : ""}">
            <div class="hero-top">
              <div>
                <div class="hero-name">${nameHtml}</div>
                <div class="hero-class">${escapeHtml(pc.classSummary)} · AC ${pc.ac}${escapeHtml(
          syncNote
        )}${autoTagHtml}</div>
              </div>
              <div class="simple-row">
                ${inspBtnHtml}
                ${sheetBtnHtml}
                <button class="btn ${isMe ? "btn-action" : "btn-quiet"}" style="padding:5px 10px;font-size:14px;" data-set-me="${escapeHtml(
          pc.id
        )}">
                  ${isMe ? "★ Me" : "☆ Me"}
                </button>
                <button class="btn btn-quiet" style="padding:5px 9px;font-size:14px;" data-remove-pc="${escapeHtml(
                  pc.id
                )}" title="Remove">✕</button>
              </div>
            </div>

            <div class="hp-row">
              <button class="btn btn-quiet" style="padding:4px 11px;" data-hp-char="${escapeHtml(
                pc.id
              )}" data-hp-delta="-1">−</button>
              <div class="hp-bar">
                <div class="hp-fill" style="width:${pct}%;background:${barColor};"></div>
                <div class="hp-text">
                  ${pc.hp.current} / ${pc.hp.max} HP${pc.hp.temp > 0 ? ` (+${pc.hp.temp})` : ""}
                </div>
              </div>
              <button class="btn btn-quiet" style="padding:4px 11px;" data-hp-char="${escapeHtml(
                pc.id
              )}" data-hp-delta="1">+</button>
            </div>

            ${slotsHtml}
            ${statusRowHtml}
            ${spellsHtml}
          </div>
        `;
      })
      .join("");
  }

  function renderAll(state, settings) {
    renderTopBar(state, settings);
    renderWhatsGoingOn(state);
    renderCenterFocus(state);
    renderParty(state);
    if (!el("savedModal")?.classList.contains("hidden")) {
      renderSavedModal();
    }
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function formatMegabytes(bytes) {
    const mb = Number(bytes || 0) / (1024 * 1024);
    return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
  }

  async function refreshDriveArchiveStatus(silent = true) {
    if (!bridge.isLocalServerContext()) {
      driveArchiveStatus = null;
      renderCenterFocus(store.state);
      if (!el("savedModal")?.classList.contains("hidden")) renderDriveArchiveSection();
      return null;
    }
    try {
      const prevTranscriptCount = Number(driveArchiveStatus?.cachedTranscriptCount || 0);
      const prevSummaryCount = Number(driveArchiveStatus?.cachedSummaryCount || 0);
      const hadPrev = driveArchiveStatus !== null;

      const resp = await fetch(`/api/gdrive/status?_t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      driveArchiveStatus = await resp.json();
      renderCenterFocus(store.state);
      if (!el("savedModal")?.classList.contains("hidden")) {
        renderDriveArchiveSection();
      }
      if (
        hadPrev &&
        (Number(driveArchiveStatus.cachedTranscriptCount || 0) > prevTranscriptCount ||
          Number(driveArchiveStatus.cachedSummaryCount || 0) > prevSummaryCount)
      ) {
        loadDriveMysteries();
        showToast("☁️ New episode(s) auto-synced from Google Drive!");
      }
      return driveArchiveStatus;
    } catch (err) {
      if (!silent) showToast(`Drive status check failed: ${err.message || err}`, true);
      return null;
    }
  }

  async function loadDriveMysteries() {
    if (!bridge.isLocalServerContext()) {
      driveMysteriesData = null;
      renderDriveMysteries();
      return null;
    }
    try {
      const resp = await fetch(`/api/campaign-memory/mysteries?_t=${Date.now()}`, {
        cache: "no-store"
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      driveMysteriesData = await resp.json();
      renderDriveMysteries();
      return driveMysteriesData;
    } catch (_) {
      return null;
    }
  }

  function renderDriveMysteries() {
    const listEl = el("driveMysteriesList");
    const countEl = el("mysteryCount");
    if (!listEl || !countEl) return;

    document.querySelectorAll("[data-mystery-filter]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-mystery-filter") === mysteryFilter);
    });

    if (!bridge.isLocalServerContext()) {
      countEl.textContent = "0";
      listEl.innerHTML = `<p class="muted-p">Launch via start-windows.bat / start-mac.command to load Open Mysteries &amp; Past Puzzles from Google Drive.</p>`;
      return;
    }

    const openList = Array.isArray(driveMysteriesData?.openMysteries)
      ? driveMysteriesData.openMysteries
      : [];
    const pastList = Array.isArray(driveMysteriesData?.pastPuzzles)
      ? driveMysteriesData.pastPuzzles
      : [];
    const combined =
      mysteryFilter === "mystery"
        ? openList
        : mysteryFilter === "puzzle"
        ? pastList
        : [...openList, ...pastList];

    countEl.textContent = String(openList.length + pastList.length);
    if (combined.length === 0) {
      listEl.innerHTML = `<p class="muted-p">No synced campaign mysteries found yet — sync Google Drive in 💾 Saved.</p>`;
      return;
    }

    listEl.innerHTML = combined
      .slice(0, 18)
      .map((item) => {
        const badge = item.category === "mystery" ? "🕵️ Open Mystery" : "🧩 Past Puzzle";
        const pinPayload = `[${item.title}] ${item.excerpt}`;
        return `
          <div class="mystery-card">
            <div class="big-card-top">
              <span class="big-card-title" style="font-size:15.5px;">${badge} · ${escapeHtml(
          item.title
        )}</span>
              <button type="button" class="btn btn-quiet" style="padding:3px 9px;font-size:12.5px;" data-pin-mystery="${escapeHtml(
                pinPayload
              )}">+ Pin to Solver</button>
            </div>
            <div>${escapeHtml(item.excerpt)}</div>
          </div>
        `;
      })
      .join("");
  }

  function initColumnResizers() {
    const COL_KEY = "dnd_copilot_col_widths_v1";
    const DEFAULTS = [34, 37, 29];
    const grid = el("mainGrid");
    const sp1 = el("colSplitter1");
    const sp2 = el("colSplitter2");
    if (!grid || !sp1 || !sp2) return;

    let widths = [...DEFAULTS];
    try {
      const saved = JSON.parse(localStorage.getItem(COL_KEY) || "null");
      if (
        Array.isArray(saved) &&
        saved.length === 3 &&
        saved.every((n) => Number.isFinite(Number(n)) && Number(n) >= 16)
      ) {
        widths = saved.map(Number);
      }
    } catch (_) {}

    const applyWidths = (arr, persist = false) => {
      widths = arr;
      grid.style.setProperty("--col1-fr", `${arr[0].toFixed(2)}fr`);
      grid.style.setProperty("--col2-fr", `${arr[1].toFixed(2)}fr`);
      grid.style.setProperty("--col3-fr", `${arr[2].toFixed(2)}fr`);
      if (persist) {
        try {
          localStorage.setItem(COL_KEY, JSON.stringify(arr.map((n) => Number(n.toFixed(2)))));
        } catch (_) {}
      }
    };

    applyWidths(widths, false);

    const attachSplitter = (splitter, leftIdx, rightIdx) => {
      splitter.addEventListener("pointerdown", (e) => {
        if (window.innerWidth <= 1100) return;
        e.preventDefault();
        const rect = grid.getBoundingClientRect();
        const totalAvail = Math.max(300, rect.width - 52);
        const startX = e.clientX;
        const startLeft = widths[leftIdx];
        const startRight = widths[rightIdx];
        const sumPair = startLeft + startRight;

        document.body.classList.add("is-resizing-cols");
        splitter.classList.add("dragging");
        splitter.setPointerCapture?.(e.pointerId);

        const onMove = (mv) => {
          const deltaPct = ((mv.clientX - startX) / totalAvail) * 100;
          const nextLeft = Math.max(18, Math.min(Math.min(64, sumPair - 18), startLeft + deltaPct));
          const nextRight = sumPair - nextLeft;
          const next = [...widths];
          next[leftIdx] = nextLeft;
          next[rightIdx] = nextRight;
          applyWidths(next, false);
        };

        const onUp = () => {
          document.body.classList.remove("is-resizing-cols");
          splitter.classList.remove("dragging");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          applyWidths(widths, true);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      });

      splitter.addEventListener("dblclick", () => {
        applyWidths([...DEFAULTS], true);
        showToast("Reset column widths to default.");
      });
    };

    attachSplitter(sp1, 0, 1);
    attachSplitter(sp2, 1, 2);
  }

  function renderDriveArchiveSection() {
    const statusEl = el("gdriveStatusText");
    const btnConn = el("btnConnectGdrive");
    const btnSync = el("btnSyncGdrive");
    const btnDisc = el("btnDisconnectGdrive");
    const btnExp = el("btnExportDriveArchive");
    const btnSearch = el("btnSearchDriveArchive");
    if (!statusEl) return;

    const isLocal = bridge.isLocalServerContext();
    if (!isLocal) {
      statusEl.textContent =
        "Launch via start-windows.bat / start-mac.command to connect Google Drive directly, or import an exported .json Drive archive bundle below.";
      if (btnConn) btnConn.disabled = true;
      if (btnSync) btnSync.disabled = true;
      if (btnExp) btnExp.disabled = true;
      if (btnSearch) btnSearch.disabled = true;
      btnDisc?.classList.add("hidden");
      return;
    }

    if (btnConn) btnConn.disabled = false;
    if (btnSync) btnSync.disabled = false;
    if (btnExp) btnExp.disabled = false;
    if (btnSearch) btnSearch.disabled = false;

    const st = driveArchiveStatus || {};
    const countPart = `${st.cachedTranscriptCount || 0} transcript(s) · ${
      st.cachedSummaryCount || 0
    } session summaries${st.hasBackstories ? " · Backstories" : ""}`;
    const syncPart = st.lastSyncedAt ? ` · Last synced ${formatTime(st.lastSyncedAt)}` : "";

    const autoNote =
      st.autoSyncEnabled && (st.connected || st.cliAvailable) ? " · Auto-syncs every 10 min" : "";

    if (st.connected) {
      statusEl.textContent = `✅ Google Drive connected — ${countPart}${syncPart}${autoNote}`;
      btnConn?.classList.add("hidden");
      btnDisc?.classList.remove("hidden");
    } else if (st.cachedTranscriptCount > 0 || st.cachedSummaryCount > 0) {
      const cliNote = st.cliAvailable ? "Ready to sync" : "Connect Google Drive for auto-refresh";
      statusEl.textContent = `📁 Local Drive Cache active (${countPart}${syncPart}${autoNote}) — ${cliNote}.`;
      btnConn?.classList.remove("hidden");
      btnDisc?.classList.add("hidden");
    } else if (st.cliAvailable) {
      statusEl.textContent =
        "Ready to sync via local Drive plugin or click Connect Google Drive for 1-click OAuth.";
      btnConn?.classList.remove("hidden");
      btnDisc?.classList.add("hidden");
    } else {
      statusEl.textContent =
        "Click Connect Google Drive to grant read-only access and sync all past session transcripts.";
      btnConn?.classList.remove("hidden");
      btnDisc?.classList.add("hidden");
    }

    const fInp = el("gdriveFolderInput");
    const sInp = el("gdriveSummariesDocInput");
    const bInp = el("gdriveBackstoriesDocInput");
    if (fInp && document.activeElement !== fInp && !fInp.value && st.folderId) {
      fInp.value = st.folderId;
    }
    if (sInp && document.activeElement !== sInp && !sInp.value && st.summariesDocId) {
      sInp.value = st.summariesDocId;
    }
    if (bInp && document.activeElement !== bInp && !bInp.value && st.backstoriesDocId) {
      bInp.value = st.backstoriesDocId;
    }
  }

  function renderSavedModal() {
    el("savedCurrentLineCount").textContent = String(store.state.transcript.length);
    renderDriveArchiveSection();

    // 0. Past Sessions (Campaign Memory)
    const memBox = el("campaignMemoryList");
    if (memBox) {
      const memories = store.campaignMemory || [];
      if (memories.length === 0) {
        memBox.innerHTML = `<p class="muted-p">No past sessions imported yet—import a <code>.txt</code>/<code>.md</code> recap or promote an archived transcript below.</p>`;
      } else {
        memBox.innerHTML = memories
          .map((m) => {
            const npcs = m.keyNpcs?.length ? `NPCs: ${m.keyNpcs.slice(0, 5).join(", ")}` : "";
            const quests = m.openQuests?.length
              ? `Quests: ${m.openQuests.slice(0, 2).join("; ")}`
              : "";
            const metaLine = [npcs, quests].filter(Boolean).join(" · ");
            return `
              <div class="big-card">
                <div class="big-card-top">
                  <span class="big-card-title">${escapeHtml(m.title)}</span>
                  <span class="big-card-meta">${escapeHtml(m.dateLabel || "")}</span>
                </div>
                ${m.summary ? `<p class="big-card-desc" style="font-size:15px;">${escapeHtml(m.summary)}</p>` : ""}
                ${metaLine ? `<p class="muted-p" style="margin:6px 0 0 0;">${escapeHtml(metaLine)}</p>` : ""}
                <div class="simple-row" style="margin-top:8px;justify-content:space-between;">
                  <label class="memory-toggle-row">
                    <input type="checkbox" data-toggle-memory="${escapeHtml(m.id)}" ${
              m.enabled !== false ? "checked" : ""
            } />
                    Active in Live Ideas
                  </label>
                  <button type="button" class="btn btn-danger" style="padding:5px 10px;font-size:13.5px;" data-del-memory="${escapeHtml(
                    m.id
                  )}">Delete</button>
                </div>
              </div>
            `;
          })
          .join("");
      }
    }

    // 1. Saved Audio Recordings (IndexedDB)
    const audioBox = el("savedAudioList");
    const recs = sessionRecorder.getStatus().savedSessions || [];
    if (recs.length === 0) {
      audioBox.innerHTML = `<p class="muted-p">No saved audio recordings yet. Click <strong>⏺ Record</strong> in the top bar during a session.</p>`;
    } else {
      audioBox.innerHTML = recs
        .map((r) => {
          const mins = Math.floor((r.durationSec || 0) / 60);
          const secs = String((r.durationSec || 0) % 60).padStart(2, "0");
          return `
            <div class="big-card">
              <div class="big-card-top">
                <span class="big-card-title">${escapeHtml(r.title)}</span>
                <span class="big-card-meta">${mins}:${secs} · ${formatMegabytes(r.bytes)}</span>
              </div>
              <div class="simple-row" style="margin-top:8px;flex-wrap:wrap;">
                <button type="button" class="btn btn-primary" data-dl-audio="${escapeHtml(r.id)}">
                  ⬇ Download Audio (.webm)
                </button>
                <button type="button" class="btn btn-action" data-transcribe-audio="${escapeHtml(
                  r.id
                )}" title="Re-transcribe this saved audio with Deepgram diarization or chunked Groq Whisper v3">
                  ✨ Re-Transcribe
                </button>
                <button type="button" class="btn btn-danger" data-del-audio="${escapeHtml(r.id)}">
                  Delete
                </button>
              </div>
            </div>
          `;
        })
        .join("");
    }

    // 2. Archived Session Transcripts
    const trBox = el("savedTranscriptArchiveList");
    const archives = store.savedTranscripts || [];
    if (archives.length === 0) {
      trBox.innerHTML = `<p class="muted-p">No archived transcripts yet. Click <strong>📌 Save Snapshot to Archive</strong> above to keep a permanent copy.</p>`;
    } else {
      trBox.innerHTML = archives
        .map(
          (a) => `
          <div class="big-card">
            <div class="big-card-top">
              <span class="big-card-title">${escapeHtml(a.title)}</span>
              <span class="big-card-meta">${(a.lines || []).length} lines</span>
            </div>
            <div class="simple-row" style="margin-top:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-primary" data-promote-transcript="${escapeHtml(a.id)}">
                📚 Use in Live Ideas
              </button>
              <button type="button" class="btn btn-action" data-dl-transcript="${escapeHtml(a.id)}">
                ⬇ Download (.txt)
              </button>
              <button type="button" class="btn btn-danger" data-del-transcript="${escapeHtml(a.id)}">
                Delete
              </button>
            </div>
          </div>
        `
        )
        .join("");
    }
  }

  /* ---------------- EVENTS ---------------- */

  function openBridgeModal() {
    const isExt = bridge.isExtensionContext();
    el("extDetectedText").textContent = isExt ? "Extension Active" : "Browser Mode";
    const activeGroup = store.getActivePartyGroupName();
    el("partyGroupNameInput").value = activeGroup === "__demo__" ? "B.U.G.S." : activeGroup;
    const bmlCode = bridge.buildBookmarkletCode(window.location.href.split("#")[0]);
    const dragLink = el("bookmarkletDragLink");
    if (!isExt) {
      dragLink.setAttribute("href", bmlCode);
    } else {
      dragLink.removeAttribute("href");
    }
    dragLink.dataset.bookmarkletCode = bmlCode;
    el("bridgeModal").classList.remove("hidden");
  }

  async function openSavedModal() {
    await Promise.all([sessionRecorder.refreshSavedList(), refreshDriveArchiveStatus(true)]);
    renderSavedModal();
    el("savedModal").classList.remove("hidden");
  }

  async function populateMicrophoneList() {
    const sel = el("settingMicDevice");
    if (!sel) return;
    const savedId = store.settings.micDeviceId || "";
    const options = [`<option value="">System Default Microphone</option>`];
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === "audioinput");
        let unnamedIdx = 1;
        for (const mic of mics) {
          if (!mic.deviceId) continue;
          const label = mic.label || `Microphone ${unnamedIdx++} (allow mic to see name)`;
          options.push(
            `<option value="${escapeHtml(mic.deviceId)}" ${
              mic.deviceId === savedId ? "selected" : ""
            }>${escapeHtml(label)}</option>`
          );
        }
      }
    } catch (_) {}
    sel.innerHTML = options.join("");
    if (savedId && !Array.from(sel.options).some((o) => o.value === savedId)) {
      const missingOpt = document.createElement("option");
      missingOpt.value = savedId;
      missingOpt.textContent = "Previously Selected Mic (disconnected)";
      missingOpt.selected = true;
      sel.appendChild(missingOpt);
    }
  }

  function openSettingsModal() {
    el("settingGroqKey").value = store.settings.groqApiKey || "";
    if (el("settingGroqWhisperModel")) {
      el("settingGroqWhisperModel").value = store.settings.groqWhisperModel || "whisper-large-v3";
    }
    if (el("settingDeepgramKey")) {
      el("settingDeepgramKey").value = store.settings.deepgramApiKey || "";
    }
    if (el("settingRawRoomAudio")) {
      el("settingRawRoomAudio").checked = store.settings.rawRoomAudio !== false;
    }
    if (el("settingAutoUpdateSheets")) {
      el("settingAutoUpdateSheets").checked = store.settings.autoUpdatePartyFromTranscript !== false;
    }
    if (el("settingRecordingBitrate")) {
      el("settingRecordingBitrate").value = String(store.settings.recordingBitrate || 96000);
    }
    if (el("settingCampaignGlossary")) {
      el("settingCampaignGlossary").value = store.settings.campaignGlossary || "";
    }
    el("settingApiKey").value = store.settings.geminiApiKey || "";
    el("settingAiProvider").value = store.settings.aiProvider || "auto";
    populateMicrophoneList();
    el("settingsModal").classList.remove("hidden");
  }

  function maybeHandleStaleTranscriptBeforeLiveStart() {
    const gap = store.hasStaleTranscriptGap?.();
    if (!gap?.isStale) return;
    const hrs = Math.max(2, Math.round(gap.gapMinutes / 60));
    const shouldArchive = window.confirm(
      `Your current transcript has ${gap.lineCount} line(s) from ~${hrs} hour(s) ago. Archive and start a fresh session transcript first so older tests don't mix into tonight's game?`
    );
    if (shouldArchive) {
      try {
        store.archiveCurrentTranscript();
      } catch (_) {}
      store.resetSession();
      showToast("Previous transcript archived — starting fresh session!");
    }
  }

  function wireEvents() {
    // Mic Listen button
    el("btnToggleMic").addEventListener("click", async () => {
      if (audioListener.isListening && audioListener.activeSourceType === "mic") {
        audioListener.stop();
      } else {
        maybeHandleStaleTranscriptBeforeLiveStart();
        try {
          await audioListener.start();
        } catch (_) {}
      }
    });

    // PC / Tab Audio Capture button (works with headphones, VLC, YouTube, Drive, etc.)
    el("btnSystemAudio").addEventListener("click", async () => {
      if (audioListener.isListening && audioListener.activeSourceType === "system") {
        audioListener.stop();
      } else {
        await audioListener.startSystemOrTabAudio();
      }
    });

    // 1-Click Chrome <-> Groq <-> Deepgram Switch
    el("btnEngineChrome").addEventListener("click", () => {
      audioListener.switchSpeechEngine("chrome");
      showToast("Switched speech to Chrome (Built-in)");
    });

    el("btnEngineGroq").addEventListener("click", () => {
      if (!(store.settings.groqApiKey || "").trim()) {
        openSettingsModal();
        showToast("Paste your free Groq API Key once to enable Groq Whisper!");
        return;
      }
      audioListener.switchSpeechEngine("groq");
      showToast("Switched speech to Groq Whisper!");
    });

    el("btnEngineDeepgram")?.addEventListener("click", () => {
      if (!(store.settings.deepgramApiKey || "").trim()) {
        openSettingsModal();
        showToast("Paste your Deepgram API Key once to enable Nova-3 Diarization!");
        return;
      }
      audioListener.switchSpeechEngine("deepgram");
      showToast("Switched speech to Deepgram Nova-3 (Live Diarization)!");
    });

    el("btnRefreshMics")?.addEventListener("click", async () => {
      await populateMicrophoneList();
      showToast("Microphone list refreshed.");
    });

    el("btnDismissHealthAlert").addEventListener("click", clearHealthWarning);

    // Session Recorder (Crash-safe IndexedDB — clones the active mic track when live so switching speech engines never interrupts backup audio or opens duplicate mic handles!)
    el("btnToggleRecord").addEventListener("click", async () => {
      if (sessionRecorder.isRecording) {
        sessionRecorder.stop();
        showToast("Audio recording saved! Open '💾 Saved' anytime to download.");
      } else {
        try {
          if (
            !bridge.isExtensionContext() &&
            typeof Notification !== "undefined" &&
            Notification.permission === "default"
          ) {
            Notification.requestPermission().catch(() => {});
          }
          if (!audioListener.isListening) {
            maybeHandleStaleTranscriptBeforeLiveStart();
            await audioListener.start();
          }
          const partyName =
            store.getActivePartyGroupName() === "__demo__"
              ? "B.U.G.S."
              : store.getActivePartyGroupName();
          const sharedStream =
            audioListener.activeSourceType === "system" || audioListener.activeSourceType === "file"
              ? audioListener.getRecordableStream()
              : audioListener.getRawMicStream();
          await sessionRecorder.start(sharedStream, partyName, {
            settings: store.settings,
            bitrate: store.settings.recordingBitrate
          });
          showToast("Recording clean audio backup + live transcript!");
        } catch (_) {
          showToast("Allow microphone access to record.", true);
        }
      }
    });

    // Audio File Playback (for testing past session recordings)
    const audioPlayer = el("sessionAudioPlayer");
    const fileInput = el("audioFileInput");

    el("btnLoadAudioFile").addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      currentLoadedAudioFile = file;
      if (currentRecordingObjectUrl) URL.revokeObjectURL(currentRecordingObjectUrl);
      currentRecordingObjectUrl = URL.createObjectURL(file);
      audioPlayer.src = currentRecordingObjectUrl;
      el("recordingFileName").textContent = file.name;
      el("recordingPlayerBar").classList.remove("hidden");
      document.body.classList.add("has-audio-bar");
      try {
        await audioListener.startFromAudioElement(audioPlayer);
      } catch (err) {
        showToast(err.message || String(err), true);
      }
      fileInput.value = "";
    });

    // 1-Click Whole-File Transcription (any size — Deepgram diarized or chunked Groq Whisper)
    el("btnFastTranscribeFile").addEventListener("click", async () => {
      if (!currentLoadedAudioFile) {
        showToast("Load an audio file first.", true);
        return;
      }
      const hasDg = Boolean((store.settings.deepgramApiKey || "").trim());
      const hasGroq = Boolean((store.settings.groqApiKey || "").trim());
      if (!hasDg && !hasGroq) {
        openSettingsModal();
        showToast("Paste a Groq or Deepgram API Key once to use Fast Transcribe!");
        return;
      }

      const btn = el("btnFastTranscribeFile");
      btn.disabled = true;
      btn.textContent = "⚡ Transcribing...";
      try {
        const lines = await gemini.transcribeLongAudioBlob(currentLoadedAudioFile, store, {
          filename: currentLoadedAudioFile.name,
          preferDiarization: true,
          onProgress: (msg) => {
            btn.textContent = `⚡ ${msg.slice(0, 26)}`;
          }
        });
        if (lines.length > 0) {
          for (const l of lines) {
            store.addTranscriptLine(l.speaker, l.text, false);
          }
          await gemini.analyzeTableSituation(store);
          await refreshLiveIdeasSilently();
          await gemini.summarizeFullSession(store);
          showToast(`Transcribed ${lines.length} lines & summarized!`);
        } else {
          showToast("No speech detected in audio file.");
        }
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Fast Transcribe";
      }
    });

    audioPlayer.addEventListener("play", () => {
      if (
        !audioListener._startingFile &&
        (!audioListener.isListening || audioListener.activeSourceType !== "file")
      ) {
        audioListener.startFromAudioElement(audioPlayer).catch(() => {});
      }
    });

    audioPlayer.addEventListener("pause", () => {
      if (audioListener.isListening && audioListener.activeSourceType === "file") {
        audioListener.stop(false);
      }
    });

    el("btnCloseRecording").addEventListener("click", () => {
      audioListener.stop(true);
      currentLoadedAudioFile = null;
      audioPlayer.removeAttribute("src");
      audioPlayer.load();
      el("recordingPlayerBar").classList.add("hidden");
      document.body.classList.remove("has-audio-bar");
    });

    // Demo, Saved, & Modals
    el("btnLoadDemo").addEventListener("click", () => {
      store.loadDemo();
      el("settingsModal").classList.add("hidden");
      showToast("Demo loaded! (Switch Party back to B.U.G.S. anytime)");
    });

    el("btnOpenBridgeModal").addEventListener("click", openBridgeModal);
    el("btnOpenSheetsModal").addEventListener("click", openBridgeModal);
    el("btnOpenSavedModal").addEventListener("click", openSavedModal);
    el("btnOpenPastSessions").addEventListener("click", openSavedModal);
    el("btnOpenSettings").addEventListener("click", openSettingsModal);

    // Party Group (B.U.G.S.) controls
    el("partyGroupSelect").addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "__demo__") {
        store.loadDemo();
      } else {
        store.switchPartyGroup(val);
        showToast(`Loaded party group: ${val}`);
      }
    });

    el("btnSavePartyGroup").addEventListener("click", () => {
      const gName = store.saveCurrentPartyAsGroup(el("partyGroupNameInput").value);
      showToast(`Saved ${store.state.party.length} character sheet(s) into "${gName}"!`);
    });

    // Transcript & Audio Saving controls
    function downloadCurrentTranscriptTxt() {
      if (store.state.transcript.length === 0) {
        showToast("No transcript lines yet to download.", true);
        return;
      }
      const txt = store.formatTranscriptText();
      const stamp = new Date().toISOString().slice(0, 10);
      const grp = store
        .getActivePartyGroupName()
        .replace(/[^a-z0-9_-]+/gi, "")
        .toLowerCase() || "session";
      downloadTextFile(txt, `${grp}-transcript-${stamp}.txt`);
    }

    el("btnDownloadTranscriptQuick").addEventListener("click", downloadCurrentTranscriptTxt);
    el("btnDownloadCurrentTranscript").addEventListener("click", downloadCurrentTranscriptTxt);

    el("btnSummarizeFullSession")?.addEventListener("click", async () => {
      if (store.state.transcript.length === 0 && (store.state.sessionBeats || []).length === 0) {
        showToast("No transcript lines yet to summarize.", true);
        return;
      }
      const btn = el("btnSummarizeFullSession");
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "📝 Summarizing...";
      try {
        const sum = await gemini.summarizeFullSession(store);
        showToast(`Full-session summary updated: ${sum?.headline || "Ready"}`);
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    el("btnArchiveCurrentTranscript").addEventListener("click", () => {
      try {
        const saved = store.archiveCurrentTranscript();
        renderSavedModal();
        showToast(`Saved "${saved.title}"!`);
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    });

    el("savedAudioList").addEventListener("click", async (e) => {
      const dl = e.target.closest("[data-dl-audio]");
      if (dl) {
        try {
          await sessionRecorder.downloadRecording(dl.getAttribute("data-dl-audio"));
        } catch (err) {
          showToast(err.message || String(err), true);
        }
        return;
      }
      const trBtn = e.target.closest("[data-transcribe-audio]");
      if (trBtn) {
        const hasDg = Boolean((store.settings.deepgramApiKey || "").trim());
        const hasGroq = Boolean((store.settings.groqApiKey || "").trim());
        if (!hasDg && !hasGroq) {
          openSettingsModal();
          showToast("Add a Deepgram or Groq API Key in Settings to re-transcribe recordings.");
          return;
        }
        const recId = trBtn.getAttribute("data-transcribe-audio");
        const origText = trBtn.textContent;
        trBtn.disabled = true;
        trBtn.textContent = "⏳ Loading audio...";
        try {
          const { blob, meta } = await sessionRecorder.getRecordingBlob(recId);
          if (store.state.transcript.length > 0) {
            try {
              store.archiveCurrentTranscript();
            } catch (_) {}
          }
          const lines = await gemini.transcribeLongAudioBlob(blob, store, {
            filename: `${meta?.title || "recording"}.webm`,
            preferDiarization: true,
            baseTimestamp: meta?.startedAt || Date.now(),
            onProgress: (msg) => {
              trBtn.textContent = `⏳ ${msg.slice(0, 26)}`;
            }
          });
          if (lines.length === 0) {
            showToast("No speech detected in recording.");
          } else {
            store.replaceTranscriptLines(lines);
            await gemini.summarizeFullSession(store);
            renderSavedModal();
            showToast(`Re-transcribed ${lines.length} lines & generated full-session summary!`);
          }
        } catch (err) {
          showToast(err.message || String(err), true);
        } finally {
          trBtn.disabled = false;
          trBtn.textContent = origText;
        }
        return;
      }
      const del = e.target.closest("[data-del-audio]");
      if (del && window.confirm("Delete this saved audio recording?")) {
        await sessionRecorder.deleteRecording(del.getAttribute("data-del-audio"));
        renderSavedModal();
      }
    });

    // Past Sessions (Campaign Memory) Controls
    const pastFileInput = el("pastSessionFileInput");
    el("btnImportPastSessionFiles").addEventListener("click", () => pastFileInput.click());
    pastFileInput.addEventListener("change", async () => {
      const files = Array.from(pastFileInput.files || []);
      if (files.length === 0) return;
      const btn = el("btnImportPastSessionFiles");
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "📂 Importing...";
      let imported = 0;
      try {
        for (const f of files) {
          const text = await f.text();
          if (!text.trim()) continue;
          if (/\.json$/i.test(f.name)) {
            let parsedJson = null;
            try {
              parsedJson = JSON.parse(text);
            } catch (_) {}
            if (
              parsedJson &&
              (parsedJson.kind === "dnd-copilot-drive-archive" ||
                Array.isArray(parsedJson.transcripts))
            ) {
              if (bridge.isLocalServerContext()) {
                const resp = await fetch("/api/campaign-memory/import-bundle", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(parsedJson)
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                await refreshDriveArchiveStatus(true);
                imported++;
                continue;
              }
              const mdSections = String(parsedJson.summariesMd || "")
                .split(/\n(?=##(?!#)\s+)/)
                .filter((s) => s.trim().startsWith("##"))
                .slice(-6)
                .reverse();
              for (const sec of mdSections) {
                const lines = sec.trim().split(/\r?\n/);
                const titleLine = (lines[0] || "Past Session").replace(/^##\s*/, "").replace(/\*/g, "").trim();
                store.addCampaignMemoryEntry({
                  title: titleLine,
                  summary: lines.slice(1).join(" ").replace(/\*/g, "").slice(0, 600),
                  rawText: sec
                });
                imported++;
              }
              continue;
            }
          }
          const cleanTitle = f.name.replace(/\.[^.]+$/, "");
          const sum = await gemini.summarizePastSession(store, cleanTitle, text);
          store.addCampaignMemoryEntry({ ...sum, rawText: text });
          imported++;
        }
        renderSavedModal();
        if (imported > 0) {
          refreshLiveIdeasSilently();
          showToast(`Added ${imported} past session(s) to Campaign Memory!`);
        }
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        pastFileInput.value = "";
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

    el("btnAddPastSessionText").addEventListener("click", async () => {
      const textEl = el("pastSessionTextInput");
      const titleEl = el("pastSessionTitleInput");
      const rawText = (textEl.value || "").trim();
      if (!rawText) {
        showToast("Paste some past session notes or transcript first.", true);
        return;
      }
      const btn = el("btnAddPastSessionText");
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Saving...";
      try {
        const title = (titleEl.value || "").trim() || `Past Recap (${new Date().toLocaleDateString()})`;
        const sum = await gemini.summarizePastSession(store, title, rawText);
        store.addCampaignMemoryEntry({ ...sum, rawText });
        titleEl.value = "";
        textEl.value = "";
        renderSavedModal();
        refreshLiveIdeasSilently();
        showToast(`Saved "${sum.title}" to Campaign Memory!`);
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

    el("campaignMemoryList").addEventListener("change", (e) => {
      const tog = e.target.closest("[data-toggle-memory]");
      if (tog) {
        store.toggleCampaignMemoryEntry(tog.getAttribute("data-toggle-memory"));
        refreshLiveIdeasSilently();
      }
    });

    el("campaignMemoryList").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del-memory]");
      if (del && window.confirm("Remove this past session from Campaign Memory?")) {
        store.deleteCampaignMemoryEntry(del.getAttribute("data-del-memory"));
        renderSavedModal();
      }
    });

    el("savedTranscriptArchiveList").addEventListener("click", async (e) => {
      const promote = e.target.closest("[data-promote-transcript]");
      if (promote) {
        const id = promote.getAttribute("data-promote-transcript");
        const found = (store.savedTranscripts || []).find((t) => t.id === id);
        if (found) {
          const orig = promote.textContent;
          promote.disabled = true;
          promote.textContent = "Adding...";
          try {
            const txt = store.formatTranscriptText(found);
            const sum = await gemini.summarizePastSession(store, found.title, txt);
            store.addCampaignMemoryEntry({ ...sum, rawText: txt });
            renderSavedModal();
            refreshLiveIdeasSilently();
            showToast(`Added "${found.title}" to Live Ideas memory!`);
          } catch (err) {
            showToast(err.message || String(err), true);
            promote.disabled = false;
            promote.textContent = orig;
          }
        }
        return;
      }
      const dl = e.target.closest("[data-dl-transcript]");
      if (dl) {
        const id = dl.getAttribute("data-dl-transcript");
        const found = (store.savedTranscripts || []).find((t) => t.id === id);
        if (found) {
          const safe = found.title.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
          downloadTextFile(store.formatTranscriptText(found), `${safe}.txt`);
        }
        return;
      }
      const del = e.target.closest("[data-del-transcript]");
      if (del && window.confirm("Delete this archived transcript?")) {
        store.deleteSavedTranscript(del.getAttribute("data-del-transcript"));
        renderSavedModal();
      }
    });

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        el(btn.getAttribute("data-close-modal"))?.classList.add("hidden");
      });
    });

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.classList.add("hidden");
      });
    });

    // What's Going On + Transcript
    el("btnAnalyzeNow").addEventListener("click", async () => {
      const btn = el("btnAnalyzeNow");
      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        const res = await gemini.analyzeTableSituation(store);
        if (res?._appliedPartyUpdates?.length > 0) {
          showToast(`Updated sheets: ${res._appliedPartyUpdates.slice(0, 2).join("; ")}`);
        }
        await refreshLiveIdeasSilently();
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "↻ Update";
      }
    });

    el("manualTranscriptForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = el("manualTranscriptInput");
      if (inp.value.trim()) {
        store.addTranscriptLine("Note", inp.value.trim(), false);
        inp.value = "";
      }
    });

    el("transcriptList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pin-clue]");
      if (btn) store.togglePinTranscriptClue(btn.getAttribute("data-pin-clue"));
    });

    // Center Focus Tabs
    document.querySelectorAll(".focus-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        activeTab = tabBtn.getAttribute("data-tab");
        if (activeTab === "puzzle" && !driveMysteriesData && bridge.isLocalServerContext()) {
          loadDriveMysteries();
        }
        renderCenterFocus(store.state);
      });
    });

    // Clickable What's Going On Moves & NPCs
    el("situationNextMoves")?.addEventListener("click", (e) => {
      const moveBtn = e.target.closest("[data-try-move]");
      if (!moveBtn) return;
      const moveText = moveBtn.getAttribute("data-try-move") || "";
      if (!moveText) return;
      activeTab = "advisor";
      renderCenterFocus(store.state);
      el("advisorQuestionInput").value = moveText;
      runAdvisor(moveText);
    });

    el("situationNpcs")?.addEventListener("click", async (e) => {
      const chip = e.target.closest("[data-search-npc]");
      if (!chip) return;
      const term = chip.getAttribute("data-search-npc") || "";
      if (!term) return;
      await openSavedModal();
      const inp = el("driveArchiveSearchInput");
      if (inp) {
        inp.value = term;
        el("driveArchiveSearchForm")?.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });

    el("driveMysteriesSection")?.addEventListener("click", (e) => {
      const fBtn = e.target.closest("[data-mystery-filter]");
      if (fBtn) {
        mysteryFilter = fBtn.getAttribute("data-mystery-filter") || "all";
        renderDriveMysteries();
        return;
      }
      if (e.target.closest("#btnRefreshMysteries")) {
        loadDriveMysteries();
        showToast("Refreshed mysteries & puzzles from Drive cache!");
        return;
      }
      const pinBtn = e.target.closest("[data-pin-mystery]");
      if (pinBtn) {
        const clueText = pinBtn.getAttribute("data-pin-mystery") || "";
        if (clueText) {
          store.addPuzzleClue(clueText);
          el("viewPuzzle")?.scrollTo({ top: 0, behavior: "smooth" });
          showToast("Pinned to Puzzle clues!");
        }
      }
    });

    // Live Ideas Advisor
    async function runAdvisor(question = "") {
      const btn = el("btnRunAdvisor");
      btn.disabled = true;
      btn.textContent = "Thinking...";
      if (question) lastCustomAdvisorQuestionAt = Date.now();
      try {
        await gemini.adviseTacticsAndSpells(store, question);
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "↻ Ideas Now";
      }
    }

    el("btnRunAdvisor").addEventListener("click", () =>
      runAdvisor(el("advisorQuestionInput").value.trim())
    );
    el("advisorQuestionForm").addEventListener("submit", (e) => {
      e.preventDefault();
      runAdvisor(el("advisorQuestionInput").value.trim());
    });

    // Puzzle
    el("puzzleInscriptionInput").addEventListener("change", (e) => {
      store.state.puzzle.promptOrInscription = e.target.value.trim();
      store.save();
    });

    el("addClueForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = el("newClueInput");
      if (inp.value.trim()) {
        store.addPuzzleClue(inp.value.trim());
        inp.value = "";
      }
    });

    el("puzzleCluesList").addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove-clue]");
      if (rm) store.removePuzzleClue(Number(rm.getAttribute("data-remove-clue")));
    });

    el("btnSolvePuzzle").addEventListener("click", async () => {
      const btn = el("btnSolvePuzzle");
      btn.disabled = true;
      btn.textContent = "Solving...";
      store.state.puzzle.promptOrInscription = el("puzzleInscriptionInput").value.trim();
      try {
        await gemini.solvePuzzle(store);
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "🧠 Solve Puzzle";
      }
    });

    // Combat
    el("btnSyncAboveVttNow").addEventListener("click", async () => {
      const ok = await bridge.requestAboveVttSync();
      showToast(ok ? "Synced with AboveVTT!" : "Open AboveVTT tab to sync.");
    });

    el("addEnemyForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = el("newEnemyNameInput");
      if (inp.value.trim()) {
        store.addManualEnemy(inp.value.trim());
        inp.value = "";
      }
    });

    el("enemyList").addEventListener("click", (e) => {
      const sel = e.target.closest("[data-select-enemy]");
      if (sel) {
        store.state.combat.activeTargetTokenId = sel.getAttribute("data-select-enemy");
        store.save();
        return;
      }
      const dmg = e.target.closest("[data-enemy-dmg]");
      if (dmg) {
        store.applyEnemyDamage(
          dmg.getAttribute("data-enemy-dmg"),
          Number(dmg.getAttribute("data-amt"))
        );
        return;
      }
      const custom = e.target.closest("[data-enemy-custom-dmg]");
      if (custom) {
        const v = window.prompt("Damage amount:", "12");
        if (v !== null && Number.isFinite(Number(v))) {
          store.applyEnemyDamage(custom.getAttribute("data-enemy-custom-dmg"), Number(v));
        }
        return;
      }
      const missBtn = e.target.closest("[data-enemy-miss]");
      if (missBtn) {
        const v = window.prompt("Attack roll total that MISSED this enemy:", "14");
        if (v !== null && Number.isFinite(Number(v))) {
          store.recordEnemyAttackOutcome(missBtn.getAttribute("data-enemy-miss"), Number(v), false);
        }
        return;
      }
      const hitBtn = e.target.closest("[data-enemy-hit]");
      if (hitBtn) {
        const v = window.prompt("Attack roll total that HIT this enemy:", "18");
        if (v !== null && Number.isFinite(Number(v))) {
          store.recordEnemyAttackOutcome(hitBtn.getAttribute("data-enemy-hit"), Number(v), true);
        }
        return;
      }
      const tog = e.target.closest("[data-enemy-toggle]");
      if (tog) {
        store.toggleEnemyFlag(
          tog.getAttribute("data-enemy-toggle"),
          tog.getAttribute("data-field")
        );
      }
    });

    el("gameLogList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-apply-roll]");
      if (btn) {
        const targetId =
          store.state.combat.activeTargetTokenId || store.state.combat.enemies[0]?.tokenId;
        if (targetId) {
          store.attributeRollDamageToEnemy(btn.getAttribute("data-apply-roll"), targetId, 1);
        }
      }
    });

    // Party
    el("btnRefreshParty").addEventListener("click", async () => {
      const btn = el("btnRefreshParty");
      btn.disabled = true;
      btn.textContent = "...";
      try {
        await bridge.refreshAllPartySheets(false, true);
        scheduleLiveIdeasRefresh();
      } finally {
        btn.disabled = false;
        btn.textContent = "↻";
      }
    });

    el("autoSheetBanner")?.addEventListener("click", (e) => {
      if (e.target.closest("#btnUndoAutoSheets")) {
        if (store.undoLastAutoSheetBatch()) {
          showToast("Undid last automatic character sheet update.");
          scheduleLiveIdeasRefresh();
        }
        return;
      }
      if (e.target.closest("#btnDismissAutoSheets")) {
        store.dismissAutoSheetBanner();
      }
    });

    el("partyList").addEventListener("click", (e) => {
      const inspBtn = e.target.closest("[data-toggle-insp]");
      if (inspBtn) {
        store.toggleInspiration(inspBtn.getAttribute("data-toggle-insp"));
        return;
      }
      const clearConcBtn = e.target.closest("[data-clear-conc]");
      if (clearConcBtn) {
        store.setCharacterConcentration(clearConcBtn.getAttribute("data-clear-conc"), "");
        scheduleLiveIdeasRefresh();
        return;
      }
      const rmCondBtn = e.target.closest("[data-remove-cond]");
      if (rmCondBtn) {
        store.removeCharacterCondition(
          rmCondBtn.getAttribute("data-cond-char"),
          rmCondBtn.getAttribute("data-remove-cond")
        );
        return;
      }
      const linkBtn = e.target.closest("[data-link-pc]");
      if (linkBtn) {
        const pcId = linkBtn.getAttribute("data-link-pc");
        const urlInput = window.prompt("Paste this hero's D&D Beyond character URL or ID:");
        if (urlInput && urlInput.trim()) {
          const updated = store.updateCharacterSheetUrl(pcId, urlInput.trim());
          if (updated) {
            bridge
              .syncCharacterById(updated.sheetUrl || updated.id, false, true)
              .catch((err) => showToast(err.message || String(err), true));
          } else {
            showToast("Enter a valid D&D Beyond character URL or numeric ID.", true);
          }
        }
        return;
      }
      const me = e.target.closest("[data-set-me]");
      if (me) {
        store.setMyCharacter(me.getAttribute("data-set-me"));
        if (store.state.transcript.length > 0 || store.state.combat.enemies.length > 0) {
          refreshLiveIdeasSilently();
        }
        return;
      }
      const rm = e.target.closest("[data-remove-pc]");
      if (rm) {
        store.removeCharacter(rm.getAttribute("data-remove-pc"));
        return;
      }
      const hp = e.target.closest("[data-hp-char]");
      if (hp) {
        store.adjustPartyHp(
          hp.getAttribute("data-hp-char"),
          Number(hp.getAttribute("data-hp-delta"))
        );
        return;
      }
      const slot = e.target.closest("[data-slot-char]");
      if (slot) {
        const slotCharId = slot.getAttribute("data-slot-char");
        store.toggleSpellSlot(
          slotCharId,
          Number(slot.getAttribute("data-slot-idx")),
          e.shiftKey ? -1 : 1
        );
        const curMyId = String(store.state.myCharacterId || store.state.party[0]?.id || "");
        if (String(slotCharId) === curMyId) {
          scheduleLiveIdeasRefresh();
        }
      }
    });

    // Bridge Modal
    el("bookmarkletDragLink").addEventListener("click", (e) => {
      e.preventDefault();
      showToast("Drag this gold button to your Chrome Bookmarks Bar!");
    });

    el("btnCopyBookmarklet").addEventListener("click", async () => {
      const code = el("bookmarkletDragLink").dataset.bookmarkletCode || bridge.buildBookmarkletCode();
      try {
        await navigator.clipboard.writeText(code);
        showToast("Bookmark link copied!");
      } catch (_) {}
    });

    el("btnSyncCharacterUrls").addEventListener("click", async () => {
      const lines = el("characterUrlsInput")
        .value.split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!lines.length) return;
      const btn = el("btnSyncCharacterUrls");
      btn.disabled = true;
      btn.textContent = "Syncing...";
      let ok = 0;
      let errText = "";
      for (const line of lines) {
        try {
          await bridge.syncCharacterById(line, true, true);
          ok++;
        } catch (err) {
          errText = err.message || String(err);
        }
      }
      btn.disabled = false;
      btn.textContent = "Sync Character Sheets";
      if (ok > 0) {
        el("characterUrlsInput").value = "";
        el("bridgeModal").classList.add("hidden");
        showToast(`Synced ${ok} character sheet(s)!`);
      } else {
        showToast(errText || "Could not sync character.", true);
      }
    });

    el("btnImportRawJson").addEventListener("click", () => {
      const raw = el("rawCharacterJsonInput").value.trim();
      if (!raw) return;
      try {
        const parsed = global.DnDCopilot.DDBParser.parseCharacterJson(JSON.parse(raw));
        store.upsertCharacter(parsed, { manualAdd: true });
        el("rawCharacterJsonInput").value = "";
        el("bridgeModal").classList.add("hidden");
        showToast(`Added ${parsed.name}!`);
      } catch (err) {
        showToast(`Invalid JSON: ${err.message}`, true);
      }
    });

    // Settings Modal
    el("btnSaveSettings").addEventListener("click", async () => {
      const hadGroqKey = Boolean((store.settings.groqApiKey || "").trim());
      const hadDgKey = Boolean((store.settings.deepgramApiKey || "").trim());
      const prevSpeechMode = store.settings.speechMode || "chrome";
      const prevMic = store.settings.micDeviceId || "";
      const prevRaw = store.settings.rawRoomAudio !== false;

      const groqKey = el("settingGroqKey").value.trim();
      const deepgramKey = el("settingDeepgramKey") ? el("settingDeepgramKey").value.trim() : "";
      const groqWhisperModel = el("settingGroqWhisperModel")?.value || "whisper-large-v3";
      const micDeviceId = el("settingMicDevice")?.value || "";
      const rawRoomAudio = el("settingRawRoomAudio") ? el("settingRawRoomAudio").checked : true;
      const autoUpdatePartyFromTranscript = el("settingAutoUpdateSheets")
        ? el("settingAutoUpdateSheets").checked
        : true;
      const recordingBitrate = Number(el("settingRecordingBitrate")?.value) || 96000;
      const campaignGlossary = el("settingCampaignGlossary")
        ? el("settingCampaignGlossary").value.trim()
        : "";

      let nextSpeech = prevSpeechMode;
      if (deepgramKey && !hadDgKey) {
        nextSpeech = "deepgram";
      } else if (groqKey && !hadGroqKey) {
        nextSpeech = "groq";
      } else if (prevSpeechMode === "deepgram" && !deepgramKey) {
        nextSpeech = groqKey ? "groq" : "chrome";
      } else if (prevSpeechMode === "groq" && !groqKey) {
        nextSpeech = deepgramKey ? "deepgram" : "chrome";
      }

      store.updateSettings({
        groqApiKey: groqKey,
        groqWhisperModel,
        deepgramApiKey: deepgramKey,
        micDeviceId,
        rawRoomAudio,
        autoUpdatePartyFromTranscript,
        recordingBitrate,
        campaignGlossary,
        geminiApiKey: el("settingApiKey").value.trim(),
        aiProvider: el("settingAiProvider").value,
        speechMode: nextSpeech
      });

      const micChanged = prevMic !== micDeviceId || prevRaw !== rawRoomAudio;
      if (audioListener.isListening) {
        if (micChanged && audioListener.activeSourceType === "mic") {
          try {
            await audioListener.start();
          } catch (_) {}
        } else if (nextSpeech !== prevSpeechMode) {
          audioListener.switchSpeechEngine(nextSpeech);
        }
      }
      el("settingsModal").classList.add("hidden");
      showToast(
        nextSpeech === "deepgram"
          ? "Settings saved — Deepgram Nova-3 active!"
          : nextSpeech === "groq"
          ? "Settings saved — Groq Whisper active!"
          : "Settings saved!"
      );
    });

    el("btnExportSession").addEventListener("click", () => {
      const backup = store.exportPortableBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bugs-copilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Exported keys, B.U.G.S. party & session backup!");
    });

    const importBackupInput = el("importBackupFileInput");
    el("btnImportSession").addEventListener("click", () => importBackupInput.click());
    importBackupInput.addEventListener("change", async () => {
      const file = importBackupInput.files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        store.importPortableBackup(JSON.parse(raw));
        el("settingsModal").classList.add("hidden");
        showToast("Imported keys, B.U.G.S. party & session backup!");
      } catch (err) {
        showToast(`Import failed: ${err.message || err}`, true);
      }
      importBackupInput.value = "";
    });

    el("btnResetSession").addEventListener("click", () => {
      if (
        window.confirm(
          "Start a fresh session? (Current transcript will be archived in 💾 Saved, and your B.U.G.S. character sheets will stay loaded.)"
        )
      ) {
        if (store.state.transcript.length > 0) {
          try {
            store.archiveCurrentTranscript();
          } catch (_) {}
        }
        store.resetSession();
        el("settingsModal").classList.add("hidden");
        showToast("New session started — B.U.G.S. party kept & previous transcript archived!");
      }
    });

    // Google Drive Campaign Archive controls
    window.addEventListener("message", (event) => {
      if (event.data?.source === "dnd-copilot-gdrive" && event.data?.type === "GDRIVE_CONNECTED") {
        refreshDriveArchiveStatus(true).then(() => {
          el("btnSyncGdrive")?.click();
        });
        showToast("Google Drive connected! Syncing campaign transcripts...");
      }
    });

    el("btnConnectGdrive")?.addEventListener("click", async () => {
      if (!bridge.isLocalServerContext()) return;
      try {
        const redirectUri = `${window.location.origin}/api/gdrive/oauth-callback`;
        const resp = await fetch(
          `/api/gdrive/auth-url?redirect_uri=${encodeURIComponent(redirectUri)}`,
          { cache: "no-store" }
        );
        const data = await resp.json();
        if (!resp.ok || !data?.authUrl) {
          throw new Error(data?.error || `HTTP ${resp.status}`);
        }
        window.open(data.authUrl, "dndCopilotGdriveAuth", "width=540,height=680");
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    });

    el("btnSyncGdrive")?.addEventListener("click", async () => {
      if (!bridge.isLocalServerContext()) return;
      const btn = el("btnSyncGdrive");
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "⏳ Syncing...";
      try {
        const resp = await fetch("/api/gdrive/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folderId: el("gdriveFolderInput")?.value?.trim() || "",
            summariesDocId: el("gdriveSummariesDocInput")?.value?.trim() || "",
            backstoriesDocId: el("gdriveBackstoriesDocInput")?.value?.trim() || ""
          })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        driveArchiveStatus = data.status || driveArchiveStatus;
        renderDriveArchiveSection();
        renderCenterFocus(store.state);
        loadDriveMysteries();
        refreshLiveIdeasSilently();
        showToast(
          `Synced ${driveArchiveStatus?.cachedTranscriptCount || 0} Drive transcript(s) & ${
            driveArchiveStatus?.cachedSummaryCount || 0
          } summaries!`
        );
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    el("btnDisconnectGdrive")?.addEventListener("click", async () => {
      if (!bridge.isLocalServerContext()) return;
      try {
        await fetch("/api/gdrive/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        await refreshDriveArchiveStatus(true);
        showToast("Disconnected Google Drive OAuth (local cache kept).");
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    });

    el("btnSaveGdriveOauth")?.addEventListener("click", async () => {
      if (!bridge.isLocalServerContext()) return;
      const rawOauth = el("gdriveOauthJsonInput")?.value?.trim() || "";
      try {
        const resp = await fetch("/api/gdrive/oauth-client", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(rawOauth ? { rawJson: rawOauth } : {}),
            folderId: el("gdriveFolderInput")?.value?.trim() || "",
            summariesDocId: el("gdriveSummariesDocInput")?.value?.trim() || "",
            backstoriesDocId: el("gdriveBackstoriesDocInput")?.value?.trim() || ""
          })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        driveArchiveStatus = data.status;
        if (rawOauth) el("gdriveOauthJsonInput").value = "";
        renderDriveArchiveSection();
        showToast("Saved Google Drive configuration!");
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    });

    el("btnExportDriveArchive")?.addEventListener("click", () => {
      if (!bridge.isLocalServerContext()) return;
      const a = document.createElement("a");
      a.href = "/api/campaign-memory/export-bundle";
      a.download = "bugs-drive-archive.json";
      a.click();
      showToast("Downloading portable Drive Archive (.json)...");
    });

    el("driveArchiveSearchForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!bridge.isLocalServerContext()) return;
      const q = (el("driveArchiveSearchInput")?.value || "").trim();
      const box = el("driveArchiveSearchResults");
      if (!q || !box) return;
      box.innerHTML = `<p class="muted-p">Searching Drive transcripts &amp; summaries...</p>`;
      try {
        const resp = await fetch("/api/campaign-memory/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, maxSummaries: 4, maxSnippets: 6 })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
        const hits = [];
        for (const ms of data.matchedSummaries || []) {
          hits.push(`
            <div class="gdrive-search-hit">
              <div class="gdrive-search-hit-head">📘 Summary · ${escapeHtml(ms.title)}</div>
              <div>${escapeHtml(ms.summary)}</div>
            </div>
          `);
        }
        for (const sn of data.matchedSnippets || []) {
          hits.push(`
            <div class="gdrive-search-hit">
              <div class="gdrive-search-hit-head">🎙️ ${escapeHtml(sn.source)}</div>
              <div>"${escapeHtml(sn.text)}"</div>
            </div>
          `);
        }
        for (const bs of data.matchedBackstories || []) {
          hits.push(`
            <div class="gdrive-search-hit">
              <div class="gdrive-search-hit-head">📜 Character Backstory</div>
              <div>${escapeHtml(bs)}</div>
            </div>
          `);
        }
        box.innerHTML =
          hits.length > 0
            ? hits.join("")
            : `<p class="muted-p">No matches found for "${escapeHtml(q)}" across ${
                data.totalTranscripts || 0
              } transcript(s).</p>`;
      } catch (err) {
        box.innerHTML = `<p class="muted-p">Search failed: ${escapeHtml(err.message || err)}</p>`;
      }
    });

    // Fast Play Modal Controls
    async function openFastPlayModal() {
      el("fastPlayModal")?.classList.remove("hidden");
      const sel = el("fastPlayDriveSelect");
      const btnDrive = el("btnFastPlayDrive");
      if (!sel) return;
      if (!bridge.isLocalServerContext()) {
        sel.innerHTML = `<option value="">Launch start-windows / start-mac to replay Drive episodes</option>`;
        if (btnDrive) btnDrive.disabled = true;
        return;
      }
      if (btnDrive) btnDrive.disabled = false;
      sel.innerHTML = `<option value="">Loading synced Drive transcripts...</option>`;
      try {
        const resp = await fetch(`/api/campaign-memory/transcripts?_t=${Date.now()}`, {
          cache: "no-store"
        });
        const data = await resp.json();
        const list = Array.isArray(data?.transcripts) ? data.transcripts : [];
        if (list.length === 0) {
          sel.innerHTML = `<option value="">No Drive transcripts synced yet (sync in 💾 Saved)</option>`;
          if (btnDrive) btnDrive.disabled = true;
        } else {
          sel.innerHTML = list
            .map((t) => {
              const kb = Math.max(1, Math.round((t.charCount || 0) / 1024));
              return `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (~${kb} KB)</option>`;
            })
            .join("");
        }
      } catch (err) {
        sel.innerHTML = `<option value="">Could not load Drive transcripts (${escapeHtml(
          err.message || err
        )})</option>`;
      }
    }

    async function runFastPlay(title, rawText) {
      if (isFastPlaying) return;
      isFastPlaying = true;
      fastPlayCancelled = false;

      const progBox = el("fastPlayProgressBox");
      const progTxt = el("fastPlayProgressText");
      const progFill = el("fastPlayProgressFill");
      const btnDrive = el("btnFastPlayDrive");
      const btnPaste = el("btnFastPlayPaste");
      const btnUpload = el("btnUploadFastPlayFile");
      if (progBox) progBox.classList.remove("hidden");
      if (progFill) progFill.style.width = "6%";
      if (progTxt) progTxt.textContent = `Fast playing ${title}...`;
      if (btnDrive) btnDrive.disabled = true;
      if (btnPaste) btnPaste.disabled = true;
      if (btnUpload) btnUpload.disabled = true;

      try {
        const result = await gemini.fastPlayTranscript(store, rawText, {
          title,
          acts: 5,
          resetFirst: true,
          shouldCancel: () => fastPlayCancelled,
          onProgress: (p) => {
            const total = Math.max(1, Number(p.totalActs) || 5);
            let pct = Math.min(82, Math.round((Number(p.act || 0) / total) * 80));
            if (p.phase === "advisor") pct = 88;
            if (p.phase === "puzzle") pct = 93;
            if (p.phase === "summary") pct = 97;
            if (progFill) progFill.style.width = `${Math.max(8, pct)}%`;
            if (progTxt) {
              progTxt.textContent =
                p.phase === "act"
                  ? `Playing Act ${p.act}/${total}: ${String(p.headline || "").slice(0, 70)}`
                  : String(p.headline || "Finalizing dashboard...");
            }
          }
        });
        if (fastPlayCancelled) {
          showToast("Fast Play canceled.");
        } else {
          if (progFill) progFill.style.width = "100%";
          el("fastPlayModal")?.classList.add("hidden");
          loadDriveMysteries();
          showToast(
            `Fast played ${result.title} (${result.totalLines} lines across ${result.actsProcessed} acts)!`
          );
        }
      } catch (err) {
        showToast(`Fast Play failed: ${err.message || err}`, true);
      } finally {
        isFastPlaying = false;
        if (btnDrive) btnDrive.disabled = false;
        if (btnPaste) btnPaste.disabled = false;
        if (btnUpload) btnUpload.disabled = false;
      }
    }

    el("btnOpenFastPlay")?.addEventListener("click", openFastPlayModal);
    el("btnCancelFastPlay")?.addEventListener("click", () => {
      fastPlayCancelled = true;
    });

    el("btnFastPlayDrive")?.addEventListener("click", async () => {
      const selId = el("fastPlayDriveSelect")?.value;
      if (!selId) {
        showToast("Choose a Drive transcript first.", true);
        return;
      }
      try {
        const resp = await fetch(
          `/api/campaign-memory/transcript/${encodeURIComponent(selId)}?_t=${Date.now()}`,
          { cache: "no-store" }
        );
        const data = await resp.json();
        if (!resp.ok || !data?.text) {
          throw new Error(data?.error || `HTTP ${resp.status}`);
        }
        await runFastPlay(data.name || "Drive Episode", data.text);
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    });

    const fpInput = el("fastPlayFileInput");
    el("btnUploadFastPlayFile")?.addEventListener("click", () => fpInput?.click());
    fpInput?.addEventListener("change", async () => {
      const f = fpInput.files?.[0];
      fpInput.value = "";
      if (!f) return;
      const text = await f.text();
      await runFastPlay(f.name, text);
    });

    el("btnFastPlayPaste")?.addEventListener("click", async () => {
      const raw = (el("fastPlayPasteInput")?.value || "").trim();
      if (!raw) {
        showToast("Paste a transcript first.", true);
        return;
      }
      await runFastPlay("Pasted Transcript", raw);
    });

    initColumnResizers();
    if (bridge.isLocalServerContext()) {
      setInterval(() => refreshDriveArchiveStatus(true), 5 * 60 * 1000);
    }
  }

  store.subscribe(renderAll);
  wireEvents();
  renderAll(store.state, store.settings);
  refreshDriveArchiveStatus(true);
  loadDriveMysteries();
})(window);
