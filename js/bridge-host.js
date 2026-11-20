/**
 * 3-Way AboveVTT & D&D Beyond Bridge Host (Mac & Windows Safe).
 *
 * Works whether or not corporate IT allows unpacked Chrome extensions:
 *  1. Unpacked Extension Mode: uses chrome.runtime messaging to content-script.js & background.js.
 *  2. Zero-Extension Bookmarklet Mode: generates a player-fair 1-click bookmarklet that links
 *     D&D Beyond / AboveVTT to this Dashboard via window.open + cross-origin postMessage (zero CORS/CSP blocks).
 *  3. Tab Screen-Share Mode: uses getDisplayMedia() so Gemini Flash-Lite can read an AboveVTT tab visually.
 */
(function (global) {
  class AboveVttBridgeHost {
    constructor(store, callbacks = {}) {
      this.store = store;
      this.onToast = callbacks.onToast || (() => {});
      this.onNewAboveVttRolls = callbacks.onNewAboveVttRolls || (() => {});
      this.remoteWindow = window.opener || null;
      this.pendingCharRequests = new Map();
      this.tabShareStream = null;
      this.tabShareTimer = null;
      this.syncedCharacterIds = new Set();
      this.lastRollSyncHash = "";

      this.#initExtensionListeners();
      this.#initPostMessageListeners();

      // Periodic character sheet refresh every 30s in Extension, Bookmarklet, and Local Server modes
      setInterval(() => {
        const canRefresh =
          this.isExtensionContext() ||
          this.isLocalServerContext() ||
          (this.remoteWindow && !this.remoteWindow.closed);
        if (
          canRefresh &&
          this.store.settings.autoSyncPartySheets &&
          this.store.state.party.length > 0
        ) {
          this.refreshAllPartySheets(true);
        }
      }, 30000);
    }

    isExtensionContext() {
      return Boolean(
        typeof chrome !== "undefined" &&
          chrome.runtime &&
          chrome.runtime.id &&
          window.location.protocol === "chrome-extension:"
      );
    }

    isLocalServerContext() {
      const host = String(window.location?.hostname || "");
      return Boolean(
        (host === "localhost" || host === "127.0.0.1") &&
          window.location?.protocol === "http:"
      );
    }

    #initExtensionListeners() {
      if (!this.isExtensionContext()) return;

      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "BRIDGE_ABOVEVTT_SNAPSHOT" && msg.payload) {
          this.#handleIncomingSnapshot(msg.payload, "extension");
        } else if (msg?.type === "BRIDGE_GAMELOG_ROLLS" && Array.isArray(msg.rolls)) {
          const added = this.store.ingestGameLogRolls(msg.rolls, true);
          if (Array.isArray(added) && added.length > 0) {
            this.onNewAboveVttRolls(added);
          }
        }
      });

      // Request immediate snapshot on startup
      this.requestAboveVttSync();
    }

    #initPostMessageListeners() {
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.source !== "dnd-copilot-bookmarklet") return;

        if (event.source) {
          this.remoteWindow = event.source;
        }

        if (data.type === "BOOKMARKLET_HELLO" || data.type === "ABOVEVTT_SNAPSHOT") {
          if (data.payload) {
            this.#handleIncomingSnapshot(data.payload, "bookmarklet");
          }
          if (data.type === "BOOKMARKLET_HELLO") {
            this.onToast("Connected to AboveVTT / D&D Beyond via Bookmarklet Bridge!");
          }
        } else if (data.type === "CHARACTER_JSON_RESPONSE") {
          const pending = this.pendingCharRequests.get(String(data.requestId));
          if (pending) {
            this.pendingCharRequests.delete(String(data.requestId));
            if (data.ok && data.json) {
              pending.resolve(data.json);
            } else {
              pending.reject(new Error(data.error || "Bookmarklet failed to fetch character sheet"));
            }
          }
        }
      });

      // If opened by the bookmarklet (window.opener exists), announce readiness immediately
      if (window.opener) {
        try {
          window.opener.postMessage({ source: "dnd-copilot-dashboard", type: "DASHBOARD_READY" }, "*");
        } catch (_) {}
      }
    }

    async #handleIncomingSnapshot(snapshot, modeLabel) {
      const seenBefore = new Set((this.store.state.gameLog || []).map((r) => r.fingerprint));
      const discoveredParty = this.store.syncAboveVttSnapshot(snapshot, modeLabel);
      const addedRolls = (snapshot?.recentLog || []).filter(
        (r) => r?.fingerprint && !seenBefore.has(r.fingerprint)
      );
      if (addedRolls.length > 0) {
        this.onNewAboveVttRolls(addedRolls);
      }
      if (this.store.settings.autoSyncPartySheets && discoveredParty.length > 0) {
        for (const pc of discoveredParty) {
          if (this.store.isCharacterExcluded(pc.id, pc.name)) continue;
          if (pc.id && !this.syncedCharacterIds.has(String(pc.id))) {
            this.syncedCharacterIds.add(String(pc.id));
            this.syncCharacterById(pc.id, true, false).catch(() => {});
          }
        }
      }
    }

    syncRollContextToAboveVtt() {
      const st = this.store?.state;
      if (!st) return;
      const myChar =
        st.party.find((p) => String(p.id) === String(st.myCharacterId)) || st.party[0] || null;
      const hash = JSON.stringify({
        myId: myChar?.id || "",
        insp: myChar?.inspiration,
        conds: myChar?.conditions,
        partyIds: (st.party || []).map((p) => `${p.id}:${p.level}:${p.lastSyncedAt || 0}`)
      });
      if (hash === this.lastRollSyncHash) return;
      this.lastRollSyncHash = hash;

      if (this.isExtensionContext()) {
        chrome.runtime
          .sendMessage({ type: "SYNC_ROLL_CONTEXT", myChar, party: st.party })
          .catch(() => {});
      }
      if (this.remoteWindow && !this.remoteWindow.closed) {
        try {
          this.remoteWindow.postMessage(
            { source: "dnd-copilot-dashboard", type: "SYNC_ROLL_CONTEXT", myChar, party: st.party },
            "*"
          );
        } catch (_) {}
      }
    }

    broadcastRollCoachToast(title, sayScript) {
      if (this.isExtensionContext()) {
        chrome.runtime
          .sendMessage({ type: "SHOW_ROLL_COACH_ON_TABS", title, sayScript })
          .catch(() => {});
      }
      if (this.remoteWindow && !this.remoteWindow.closed) {
        try {
          this.remoteWindow.postMessage(
            { source: "dnd-copilot-dashboard", type: "SHOW_ROLL_COACH", title, sayScript },
            "*"
          );
        } catch (_) {}
      }
    }

    async requestAboveVttSync() {
      if (this.isExtensionContext()) {
        try {
          const resp = await chrome.runtime.sendMessage({ type: "REQUEST_ABOVEVTT_SYNC" });
          if (resp?.snapshot) {
            await this.#handleIncomingSnapshot(resp.snapshot, "extension");
            return true;
          }
        } catch (_) {}
      }

      if (this.remoteWindow) {
        try {
          this.remoteWindow.postMessage(
            { source: "dnd-copilot-dashboard", type: "REQUEST_SNAPSHOT" },
            "*"
          );
          return true;
        } catch (_) {}
      }
      return false;
    }

    extractCharacterId(inputStr) {
      const clean = String(inputStr || "").trim();
      const urlMatch = clean.match(/characters\/(\d{4,12})/i);
      if (urlMatch) return urlMatch[1];
      const digitsOnly = clean.match(/^(\d{4,12})$/);
      return digitsOnly ? digitsOnly[1] : null;
    }

    async syncCharacterById(idOrUrl, silent = false, manualAdd = false, forceRemote = false) {
      const charId = this.extractCharacterId(idOrUrl);
      if (!charId) {
        throw new Error("Enter a valid D&D Beyond character URL or numeric ID (e.g. 98765432).");
      }

      let rawJson = null;

      // 1. Extension authenticated/background fetch
      if (this.isExtensionContext()) {
        const resp = await chrome.runtime.sendMessage({
          type: "FETCH_DDB_CHARACTER",
          characterId: charId
        });
        if (resp?.ok && resp.json) {
          rawJson = resp.json;
        } else if (!this.remoteWindow) {
          throw new Error(resp?.error || `Could not fetch character ${charId}`);
        }
      }

      // 2. Bookmarklet cross-window authenticated fetch (works on locked-down work Macs!)
      if (!rawJson && this.remoteWindow) {
        try {
          rawJson = await this.#fetchViaBookmarkletBridge(charId);
        } catch (_) {
          rawJson = null;
        }
      }

      // 2b. Local proxy fallback when running via start-windows.bat / start-mac.command (avoids CORS on public DDB sheets)
      if (!rawJson && this.isLocalServerContext()) {
        try {
          const proxyResp = await fetch(`/api/ddb-character/${charId}?_t=${Date.now()}`, {
            cache: "no-store",
            headers: { Accept: "application/json" }
          });
          if (proxyResp.ok) {
            rawJson = await proxyResp.json();
          }
        } catch (_) {
          rawJson = null;
        }
      }

      // 3. Direct browser fetch (works if CORS permits or via local proxy)
      if (!rawJson) {
        const url = `https://character-service.dndbeyond.com/character/v5/character/${charId}?includeCustomItems=true&_t=${Date.now()}`;
        try {
          const directResp = await fetch(url, {
            cache: "no-store",
            headers: { Accept: "application/json" }
          });
          if (directResp.ok) {
            rawJson = await directResp.json();
          } else {
            throw new Error(`HTTP ${directResp.status}`);
          }
        } catch (err) {
          throw new Error(
            `Browser blocked direct D&D Beyond fetch (${err.message}). Click the 1-Click Bookmarklet on your D&D Beyond tab (or keep a logged-in D&D Beyond tab open)!`
          );
        }
      }

      const parsed = global.DnDCopilot.DDBParser.parseCharacterJson(rawJson);
      if (!manualAdd && this.store.isCharacterExcluded(parsed.id, parsed.name)) {
        return null;
      }
      this.store.upsertCharacter(parsed, { manualAdd, forceRemote });
      if (!silent) {
        this.onToast(`Synced ${parsed.name} (${parsed.classSummary})!`);
      }
      return parsed;
    }

    async refreshAllPartySheets(silent = true, forceRemote = false) {
      await this.requestAboveVttSync().catch(() => false);

      const seenIds = new Set();
      const ids = [];
      for (const p of this.store.state.party || []) {
        if (String(p?.id || "").startsWith("demo-")) continue;
        const cid = this.extractCharacterId(p.sheetUrl) || this.extractCharacterId(p.id);
        if (cid && !seenIds.has(cid)) {
          seenIds.add(cid);
          ids.push(cid);
        }
      }

      if (ids.length === 0) {
        if (!silent) {
          this.onToast(
            "No D&D Beyond character links found on your party cards — click + Hero or 🔗 Link on a character first."
          );
        }
        return { updated: 0, total: 0, error: "No character IDs" };
      }

      let updated = 0;
      let lastError = "";
      for (const id of ids) {
        try {
          const res = await this.syncCharacterById(id, true, false, forceRemote);
          if (res) updated += 1;
        } catch (err) {
          lastError = err?.message || String(err);
        }
      }

      if (!silent) {
        if (updated > 0 && updated === ids.length) {
          this.onToast(`Updated ${updated}/${ids.length} character sheet(s) from D&D Beyond!`);
        } else if (updated > 0 && updated < ids.length) {
          const privateCount = ids.length - updated;
          this.onToast(
            `Updated ${updated}/${ids.length} public sheet(s) from D&D Beyond! (${privateCount} private sheet(s) need the Extension or Bookmarklet)`
          );
        } else if (!this.isExtensionContext() && (!this.remoteWindow || this.remoteWindow.closed)) {
          this.onToast(
            "To update sheets in web mode, click your ⚔️ Sync AboveVTT bookmarklet on your D&D Beyond tab once!"
          );
        } else {
          this.onToast(
            `Could not refresh sheets: ${
              lastError || "Keep a logged-in D&D Beyond tab open and reload it once."
            }`
          );
        }
      }

      return { updated, total: ids.length, error: lastError };
    }

    #fetchViaBookmarkletBridge(charId) {
      return new Promise((resolve, reject) => {
        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timer = setTimeout(() => {
          this.pendingCharRequests.delete(requestId);
          reject(new Error("Timed out waiting for D&D Beyond tab response."));
        }, 7000);

        this.pendingCharRequests.set(requestId, {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        });

        this.remoteWindow.postMessage(
          {
            source: "dnd-copilot-dashboard",
            type: "FETCH_CHARACTER",
            requestId,
            characterId: charId
          },
          "*"
        );
      });
    }

    /**
     * Mode 3 Fallback: Share AboveVTT Chrome Tab visually via getDisplayMedia (zero extension & zero bookmarklet).
     */
    async startTabScreenShare() {
      if (this.tabShareStream) {
        this.stopTabScreenShare();
        return false;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false
      });
      this.tabShareStream = stream;
      this.store.state.bridgeStatus = {
        mode: "tab-share",
        connectedPage: "Shared Chrome Tab (Visual Sync)",
        isAboveVttActive: true,
        lastHeartbeat: Date.now()
      };
      this.store.save();

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.stopTabScreenShare();
      });

      await this.captureTabFrameNow();
      return true;
    }

    stopTabScreenShare() {
      if (this.tabShareTimer) {
        clearInterval(this.tabShareTimer);
        this.tabShareTimer = null;
      }
      if (this.tabShareStream) {
        this.tabShareStream.getTracks().forEach((t) => t.stop());
        this.tabShareStream = null;
      }
      if (this.store.state.bridgeStatus.mode === "tab-share") {
        this.store.state.bridgeStatus.mode = "disconnected";
        this.store.save();
      }
    }

    async captureTabFrameNow() {
      if (!this.tabShareStream) {
        throw new Error("Share your AboveVTT tab first.");
      }
      const video = document.createElement("video");
      video.srcObject = this.tabShareStream;
      video.muted = true;
      await video.play();

      const maxW = 1280;
      const scale = Math.min(1, maxW / Math.max(1, video.videoWidth));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      video.pause();
      video.srcObject = null;

      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      const base64 = dataUrl.split(",")[1];
      const parsed = await global.DnDCopilot.GeminiClient.analyzeTabScreenshot(base64, this.store);

      const snapshot = {
        pageTitle: "Shared AboveVTT Tab",
        isAboveVttActive: true,
        partyCharacters: [],
        combat: {
          inCombat: Boolean(parsed.inCombat),
          round: parsed.round || this.store.state.combat.round || 1,
          combatants: (parsed.visibleEnemies || []).map((e, i) => ({
            tokenId: `vis-enemy-${e.name.toLowerCase().replace(/\W+/g, "-") || i}`,
            name: e.name,
            isNameRevealed: true,
            isPlayer: false,
            isCurrentTurn: Boolean(e.isCurrentTurn),
            initiative: null,
            conditions: e.isBloodied ? ["Bloodied"] : [],
            isBloodied: Boolean(e.isBloodied),
            visibleHealthPercent: null
          }))
        },
        recentLog: (parsed.visibleRolls || []).map((r) => ({
          fingerprint: `vis-roll-${r.actor}-${r.action}-${r.total}`,
          timestamp: Date.now(),
          actor: r.actor,
          action: r.action,
          kind: (r.kind || "roll").toLowerCase(),
          total: r.total,
          formula: "",
          isCrit: false,
          isFumble: false,
          rawText: `${r.actor} rolled ${r.action}: ${r.total}`
        }))
      };

      await this.#handleIncomingSnapshot(snapshot, "tab-share");
      this.onToast("Synced visible rolls & enemies from shared AboveVTT tab!");
    }

    /**
     * Generates a self-contained, player-fair Bookmarklet URL that links any D&D Beyond / AboveVTT tab
     * to this Dashboard URL without requiring Chrome Extension permissions!
     */
    buildBookmarkletCode(dashboardUrl) {
      const targetUrl = dashboardUrl || window.location.href.split("#")[0];
      const script = `(function(){
        var DASH=${JSON.stringify(targetUrl)};
        var win=window.__dndCopilotWin;
        if(!win||win.closed){win=window.open(DASH,'dnd_copilot_dashboard');window.__dndCopilotWin=win;}
        function vis(el){if(!el)return false;var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity||'1')>0;}
        function cid(s){var m=String(s||'').match(/characters\\/(\\d{4,12})/i)||String(s||'').match(/(?:^|\\/)(\\d{6,12})(?:$|[/?#])/);return m?m[1]:null;}
        function snap(){
          var pcs=[];var seen={};
          document.querySelectorAll('.player-card[data-player-id],a[href*="/characters/"]').forEach(function(el){
            var ref=el.getAttribute('data-player-id')||el.getAttribute('href')||'';
            var id=cid(ref);if(!id||seen[id])return;seen[id]=1;
            var nm=(el.querySelector&&el.querySelector('.player-name')?.textContent||el.textContent||'').trim().slice(0,40);
            pcs.push({id:id,name:nm||('Hero '+id)});
          });
          var rows=document.querySelectorAll('#combat_area tr.CTToken,#combat_area tr[data-target]');
          var combs=[];var u=0;
          rows.forEach(function(r){
            if(r.getAttribute('ishidden')==='true'||!vis(r))return;
            var img=r.querySelector('img,video');if(img&&getComputedStyle(img).opacity==='0.5')return;
            var tid=r.getAttribute('data-target')||'';if(!tid)return;
            var isP=tid.indexOf('/profile')>=0||tid.indexOf('/characters/')>=0||!!cid(tid);
            var nm=(r.getAttribute('data-name')||'').trim();var rev=!!nm;
            if(!nm){u++;nm=isP?('Ally #'+u):('Unidentified Foe #'+u);}
            var conds=[];r.querySelectorAll('.conditions [id]').forEach(function(c){conds.push(c.id);});
            var initEl=r.querySelector('input.init');
            combs.push({tokenId:tid,name:nm,isNameRevealed:rev,isPlayer:isP,isCurrentTurn:r.getAttribute('data-current')==='1',initiative:initEl&&vis(initEl)?parseFloat(initEl.value)||null:null,conditions:conds,isBloodied:conds.some(function(x){return /bloodied/i.test(x);}),visibleHealthPercent:null});
          });
          var logs=[];
          document.querySelectorAll('.ct-game-log-pane li,[class*="styles_gameLogPane"] li,[class*="GameLog"] li').forEach(function(li){
            if(!vis(li))return;
            var tx=(li.innerText||'').replace(/\\s+/g,' ').trim();if(!tx)return;
            var totEl=li.querySelector('[class*="total"],.dice_result__total-result,[class*="resultTotal"]');
            var tot=totEl?parseInt(totEl.textContent.replace(/[^\\d-]/g,''),10):null;
            var act=(li.querySelector('[class*="sender"],[class*="characterName"],strong,b')?.textContent||'Table').trim();
            var rn=(li.querySelector('[class*="action"],[class*="rollName"],.dice_result__info__title')?.textContent||'Roll').trim();
            var low=(rn+' '+tx).toLowerCase();
            var kind=tot===null?'chat':/heal/.test(low)?'heal':/damage/.test(low)?'damage':/to hit|attack/.test(low)?'attack':/save|saving/.test(low)?'save':'check';
            logs.push({fingerprint:act+'|'+rn+'|'+tot+'|'+tx.slice(0,90),timestamp:Date.now(),actor:act,action:rn,kind:kind,total:isFinite(tot)?tot:null,rawText:tx.slice(0,220)});
          });
          var rnEl=document.getElementById('round_number');
          return {pageTitle:document.title,pageUrl:location.href,isAboveVttActive:!!(document.getElementById('combat_tracker')||document.getElementById('tokens')),partyCharacters:pcs,combat:{inCombat:combs.length>0,round:rnEl?parseInt(rnEl.value,10)||1:1,combatants:combs},recentLog:logs.slice(-35)};
        }
        function send(t,p){if(win&&!win.closed)win.postMessage({source:'dnd-copilot-bookmarklet',type:t,payload:p},'*');}
        if(!window.__dndCopilotHooked){
          window.__dndCopilotHooked=true;
          window.addEventListener('message',async function(ev){
            var d=ev.data;if(!d||d.source!=='dnd-copilot-dashboard')return;
            if(ev.source)win=ev.source;
            if(d.type==='DASHBOARD_READY'||d.type==='REQUEST_SNAPSHOT'){send('ABOVEVTT_SNAPSHOT',snap());}
            if(d.type==='SHOW_ROLL_COACH'){
              var card=document.getElementById('dnd-copilot-bm-coach');
              if(!card){card=document.createElement('div');card.id='dnd-copilot-bm-coach';card.style.cssText='position:fixed;bottom:52px;right:14px;z-index:2147483647;max-width:380px;background:#171d2b;color:#f3f6fc;border:1.5px solid #f0c46c;border-radius:10px;padding:12px 14px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.7);';document.body.appendChild(card);}
              card.textContent='';
              var hd=document.createElement('div');hd.style.cssText='font-weight:700;color:#f0c46c;margin-bottom:4px;display:flex;justify-content:space-between;gap:8px;';
              var sp=document.createElement('span');sp.textContent='🎲 '+(d.title||'Full Potential');
              var xb=document.createElement('button');xb.textContent='✕';xb.style.cssText='background:none;border:none;color:#cbd5e8;cursor:pointer;font-size:15px;';xb.onclick=function(){card.remove();};
              hd.appendChild(sp);hd.appendChild(xb);
              var bd=document.createElement('div');bd.textContent=d.sayScript||'';
              card.appendChild(hd);card.appendChild(bd);
            }
            if(d.type==='FETCH_CHARACTER'){
              try{
                var tokRes=await fetch('https://auth-service.dndbeyond.com/v1/cobalt-token',{method:'POST',credentials:'include'}).catch(function(){return null;});
                var tok=tokRes&&tokRes.ok?(await tokRes.json()).token:null;
                var hdrs={Accept:'application/json'};if(tok)hdrs.Authorization='Bearer '+tok;
                var r=await fetch('https://character-service.dndbeyond.com/character/v5/character/'+d.characterId+'?includeCustomItems=true&_t='+Date.now(),{headers:hdrs,cache:'no-store'});
                var j=await r.json();
                win.postMessage({source:'dnd-copilot-bookmarklet',type:'CHARACTER_JSON_RESPONSE',requestId:d.requestId,ok:r.ok,json:j},'*');
              }catch(e){
                win.postMessage({source:'dnd-copilot-bookmarklet',type:'CHARACTER_JSON_RESPONSE',requestId:d.requestId,ok:false,error:String(e)},'*');
              }
            }
          });
          setInterval(function(){send('ABOVEVTT_SNAPSHOT',snap());},2500);
          var badge=document.createElement('div');
          badge.textContent='⚔️ Copilot Linked';
          badge.style.cssText='position:fixed;bottom:10px;left:10px;z-index:999999;background:#131826;color:#f3c969;border:1px solid #d9a441;padding:4px 10px;border-radius:999px;font:600 12px system-ui;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.5);';
          document.body.appendChild(badge);
        }
        setTimeout(function(){send('BOOKMARKLET_HELLO',snap());},700);
      })();`;

      return "javascript:" + encodeURIComponent(script.replace(/\s+/g, " ").trim());
    }
  }

  global.DnDCopilot = global.DnDCopilot || {};
  global.DnDCopilot.AboveVttBridgeHost = AboveVttBridgeHost;
})(window);
