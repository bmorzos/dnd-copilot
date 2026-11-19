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

  const sessionRecorder = new global.DnDCopilot.SessionRecorder((recStatus) => {
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
  });

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
    onSpeechBatchReady: async () => {
      try {
        await gemini.analyzeTableSituation(store);
      } catch (err) {
        showToast(err.message || String(err), true);
      }
    }
  });

  /* ---------------- RENDERING ---------------- */

  function renderTopBar(state, settings) {
    const bridgeBtn = el("btnOpenBridgeModal");
    const bridgeTxt = el("bridgeStatusText");
    const isConnected = state.bridgeStatus.mode !== "disconnected";
    bridgeBtn.classList.toggle("connected", isConnected);
    bridgeTxt.textContent = isConnected ? "AboveVTT Live" : "AboveVTT";

    const isGroq = settings.speechMode === "groq";
    el("btnEngineChrome").classList.toggle("active", !isGroq);
    el("btnEngineGroq").classList.toggle("active", isGroq);
  }

  function renderWhatsGoingOn(state) {
    el("sceneModeBadge").textContent = state.situation.sceneMode || "Exploration";
    el("situationHeadline").textContent =
      state.situation.headline || "Ready to listen to your game.";

    const bullets = state.situation.summaryBullets || [];
    el("situationBullets").innerHTML = bullets
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join("");

    const objs = state.situation.activeObjectives || [];
    const objBox = el("situationObjectives");
    if (objs.length > 0) {
      objBox.classList.remove("hidden");
      objBox.innerHTML = `<strong>Current Goals</strong>${objs
        .map((o) => `<div>• ${escapeHtml(o)}</div>`)
        .join("")}`;
    } else {
      objBox.classList.add("hidden");
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

    // 1. Best Move / Spell Advisor
    const myChar =
      state.party.find((p) => String(p.id) === String(state.myCharacterId)) || state.party[0] || null;
    el("playingAsLabel").textContent = myChar
      ? `Playing as ★ ${myChar.name}`
      : "Select ★ Me on your hero →";

    const concAlert = el("concentrationAlert");
    const concText =
      state.advisor.concentrationWarning ||
      (myChar?.concentratingOn
        ? `Concentrating on ${myChar.concentratingOn} — another Concentration spell will drop it.`
        : "");
    if (concText) {
      concAlert.textContent = concText;
      concAlert.classList.remove("hidden");
    } else {
      concAlert.classList.add("hidden");
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
            <span class="big-card-meta">${escapeHtml(r.slotInfo)}</span>
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

    // 3. Combat & Rolls
    const cmb = state.combat;
    el("combatRoundLabel").textContent = cmb.inCombat
      ? `Round ${cmb.round || 1} (Player-Fair Damage Tracked)`
      : "Out of Combat";

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
      enemyEl.innerHTML = `<p class="muted-p">No enemies tracked yet.</p>`;
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

    const activeEnemy =
      cmb.enemies.find((e) => e.tokenId === cmb.activeTargetTokenId) || cmb.enemies[0] || null;

    const rollsEl = el("gameLogList");
    if (state.gameLog.length === 0) {
      rollsEl.innerHTML = `<p class="muted-p">No AboveVTT rolls yet.</p>`;
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
          : "";

        return `
          <div class="hero-card ${isMe ? "is-me" : ""}">
            <div class="hero-top">
              <div>
                <div class="hero-name">${nameHtml}</div>
                <div class="hero-class">${escapeHtml(pc.classSummary)} · AC ${pc.ac}${
          pc.concentratingOn ? ` · 🔮 ${escapeHtml(pc.concentratingOn)}` : ""
        }</div>
              </div>
              <div class="simple-row">
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

  function renderSavedModal() {
    el("savedCurrentLineCount").textContent = String(store.state.transcript.length);

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
              <div class="simple-row" style="margin-top:8px;">
                <button type="button" class="btn btn-primary" data-dl-audio="${escapeHtml(r.id)}">
                  ⬇ Download Audio (.webm)
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
            <div class="simple-row" style="margin-top:8px;">
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
    await sessionRecorder.refreshSavedList();
    renderSavedModal();
    el("savedModal").classList.remove("hidden");
  }

  function openSettingsModal() {
    el("settingGroqKey").value = store.settings.groqApiKey || "";
    el("settingApiKey").value = store.settings.geminiApiKey || "";
    el("settingAiProvider").value = store.settings.aiProvider || "auto";
    el("settingsModal").classList.remove("hidden");
  }

  function wireEvents() {
    // Mic Listen button
    el("btnToggleMic").addEventListener("click", async () => {
      if (audioListener.isListening && audioListener.activeSourceType === "mic") {
        audioListener.stop();
      } else {
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

    // 1-Click Chrome <-> Groq Switch
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

    // Session Recorder (Crash-safe IndexedDB — also starts Mic transcription if idle so BOTH audio + transcript save!)
    el("btnToggleRecord").addEventListener("click", async () => {
      if (sessionRecorder.isRecording) {
        sessionRecorder.stop();
        showToast("Audio recording saved! Open '💾 Saved' anytime to download.");
      } else {
        try {
          if (!audioListener.isListening) {
            await audioListener.start();
          }
          const partyName =
            store.getActivePartyGroupName() === "__demo__"
              ? "B.U.G.S."
              : store.getActivePartyGroupName();
          await sessionRecorder.start(audioListener.getRecordableStream(), partyName);
          showToast("Recording audio + live transcript (auto-saved every 5s)!");
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

    // 1-Click Whole-File Fast Transcription via Groq Whisper
    el("btnFastTranscribeFile").addEventListener("click", async () => {
      if (!currentLoadedAudioFile) {
        showToast("Load an audio file first.", true);
        return;
      }
      if (!(store.settings.groqApiKey || "").trim()) {
        openSettingsModal();
        showToast("Paste your free Groq API Key once to use Fast Transcribe!");
        return;
      }
      if (currentLoadedAudioFile.size > 25 * 1024 * 1024) {
        showToast(
          "File is over 25 MB — just press Play and Groq will transcribe it live in chunks!",
          false
        );
        if (store.settings.speechMode !== "groq") {
          audioListener.switchSpeechEngine("groq");
        }
        return;
      }

      const btn = el("btnFastTranscribeFile");
      btn.disabled = true;
      btn.textContent = "⚡ Transcribing...";
      try {
        const fullText = await gemini.transcribeWithGroq(
          currentLoadedAudioFile,
          store,
          currentLoadedAudioFile.name
        );
        if (fullText) {
          const sentences = fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [fullText];
          let chunkBuf = "";
          for (const s of sentences) {
            chunkBuf = (chunkBuf + " " + s.trim()).trim();
            if (chunkBuf.length >= 160) {
              store.addTranscriptLine("Recording", chunkBuf, false);
              chunkBuf = "";
            }
          }
          if (chunkBuf) {
            store.addTranscriptLine("Recording", chunkBuf, false);
          }
          await gemini.analyzeTableSituation(store);
          showToast("Whole file transcribed & summarized!");
        } else {
          showToast("No speech detected in audio file.");
        }
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Fast Transcribe (Groq)";
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
      const del = e.target.closest("[data-del-audio]");
      if (del && window.confirm("Delete this saved audio recording?")) {
        await sessionRecorder.deleteRecording(del.getAttribute("data-del-audio"));
        renderSavedModal();
      }
    });

    el("savedTranscriptArchiveList").addEventListener("click", (e) => {
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
        await gemini.analyzeTableSituation(store);
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
        renderCenterFocus(store.state);
      });
    });

    // Best Move Advisor
    async function runAdvisor(question = "") {
      const btn = el("btnRunAdvisor");
      btn.disabled = true;
      btn.textContent = "Thinking...";
      try {
        await gemini.adviseTacticsAndSpells(store, question);
      } catch (err) {
        showToast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Suggest Best Move";
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
    el("btnRefreshParty").addEventListener("click", () => bridge.refreshAllPartySheets(false));

    el("partyList").addEventListener("click", (e) => {
      const me = e.target.closest("[data-set-me]");
      if (me) {
        store.setMyCharacter(me.getAttribute("data-set-me"));
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
        store.toggleSpellSlot(
          slot.getAttribute("data-slot-char"),
          Number(slot.getAttribute("data-slot-idx")),
          e.shiftKey ? -1 : 1
        );
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
    el("btnSaveSettings").addEventListener("click", () => {
      const hadGroqKey = Boolean((store.settings.groqApiKey || "").trim());
      const groqKey = el("settingGroqKey").value.trim();
      const nextSpeech =
        groqKey && !hadGroqKey
          ? "groq"
          : !groqKey
          ? "chrome"
          : store.settings.speechMode;

      store.updateSettings({
        groqApiKey: groqKey,
        geminiApiKey: el("settingApiKey").value.trim(),
        aiProvider: el("settingAiProvider").value,
        speechMode: nextSpeech
      });
      if (audioListener.isListening) {
        audioListener.switchSpeechEngine(nextSpeech);
      }
      el("settingsModal").classList.add("hidden");
      showToast(
        nextSpeech === "groq" ? "Settings saved — Groq Whisper active!" : "Settings saved!"
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
  }

  store.subscribe(renderAll);
  wireEvents();
  renderAll(store.state, store.settings);
})(window);
