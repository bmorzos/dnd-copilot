/**
 * Chrome MV3 Background Service Worker for D&D Table Copilot.
 * Opens/focuses the full-screen Dashboard tab and bridges AboveVTT / D&D Beyond tabs.
 */

let latestAboveVttSnapshot = null;
let latestSourceTabId = null;
const registeredTopFrames = new Set();
const registeredFrames = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  registeredTopFrames.delete(tabId);
  for (const key of Array.from(registeredFrames.keys())) {
    if (key.startsWith(`${tabId}:`)) {
      registeredFrames.delete(key);
    }
  }
});

async function fetchLocalServerRollContext() {
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 1800) : null;
    const resp = await fetch(`http://127.0.0.1:8765/api/local-profile?_t=${Date.now()}`, {
      cache: "no-store",
      ...(ctrl ? { signal: ctrl.signal } : {})
    });
    if (timer) clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const prof = data?.exists ? data.profile : null;
    const party = Array.isArray(prof?.state?.party)
      ? prof.state.party.filter((p) => p?.id && !String(p.id).startsWith("demo-"))
      : [];
    if (party.length === 0) return null;
    const myId = prof?.state?.myCharacterId;
    const myChar = party.find((p) => String(p.id) === String(myId)) || party[0];
    return { myChar, party, updatedAt: Date.now() };
  } catch (_) {
    return null;
  }
}

async function openOrFocusDashboard() {
  const dashboardUrl = chrome.runtime.getURL("index.html");
  const existingTabs = await chrome.tabs.query({ url: dashboardUrl });
  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
}

chrome.action.onClicked.addListener(openOrFocusDashboard);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    openOrFocusDashboard();
  }
});

async function findDndBeyondTabs() {
  try {
    return await chrome.tabs.query({ url: "https://www.dndbeyond.com/*" });
  } catch (_) {
    return [];
  }
}

async function getCobaltBearerTokenInBackground() {
  try {
    const resp = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
      method: "POST",
      credentials: "include"
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.token || null;
  } catch (_) {
    return null;
  }
}

async function fetchCharacterDirectly(characterId) {
  const cleanId = String(characterId).replace(/\D/g, "");
  if (!cleanId) {
    throw new Error("Invalid D&D Beyond character ID.");
  }
  const url = `https://character-service.dndbeyond.com/character/v5/character/${cleanId}?includeCustomItems=true&_t=${Date.now()}`;
  const token = await getCobaltBearerTokenInBackground();

  if (token) {
    const authedResp = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    });
    if (authedResp.ok) {
      return await authedResp.json();
    }
    if (authedResp.status !== 401 && authedResp.status !== 403) {
      throw new Error(`D&D Beyond returned HTTP ${authedResp.status}.`);
    }
  }

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(
      `D&D Beyond returned HTTP ${response.status}. Make sure you are signed into D&D Beyond or keep a D&D Beyond tab open.`
    );
  }
  return await response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "OPEN_DASHBOARD_TAB") {
    openOrFocusDashboard();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "HEALTH_ALERT") {
    const alertText = String(message.message || "Transcript or audio recording needs attention!");
    try {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } catch (_) {}
    try {
      chrome.notifications?.create("dnd-copilot-health-alert", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "D&D Copilot — Recording/Transcript Alert",
        message: alertText,
        priority: 2
      });
    } catch (_) {}
    // Also show an in-page alert banner on any open D&D Beyond / AboveVTT tab!
    findDndBeyondTabs().then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs
          .sendMessage(tab.id, { type: "SHOW_COPILOT_ALERT", message: alertText })
          .catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "HEALTH_CLEAR") {
    try {
      chrome.action.setBadgeText({ text: "" });
      chrome.notifications?.clear("dnd-copilot-health-alert");
    } catch (_) {}
    findDndBeyondTabs().then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "CLEAR_COPILOT_ALERT" }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "ABOVEVTT_SNAPSHOT") {
    latestAboveVttSnapshot = message.payload;
    if (sender?.tab?.id) {
      latestSourceTabId = sender.tab.id;
    }
    // Forward to any open dashboard tabs (ignore error if dashboard is closed)
    chrome.runtime.sendMessage({
      type: "BRIDGE_ABOVEVTT_SNAPSHOT",
      payload: message.payload,
      tabUrl: sender?.tab?.url || ""
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GAMELOG_ROLLS") {
    chrome.runtime.sendMessage({
      type: "BRIDGE_GAMELOG_ROLLS",
      rolls: message.rolls || []
    }).catch(() => {});
    fetch("http://127.0.0.1:8765/api/abovevtt-rolls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rolls: Array.isArray(message.rolls) ? message.rolls : [],
        sourcePage: sender?.tab?.url || ""
      })
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SYNC_ROLL_CONTEXT") {
    const payload = {
      myChar: message.myChar || null,
      party: Array.isArray(message.party) ? message.party : [],
      updatedAt: Date.now()
    };
    chrome.storage?.local?.set({ dnd_copilot_roll_context: payload }).catch(() => {});
    findDndBeyondTabs().then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "ROLL_CONTEXT_UPDATE", ...payload }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SHOW_ROLL_COACH_ON_TABS") {
    findDndBeyondTabs().then((tabs) => {
      for (const tab of tabs) {
        chrome.tabs
          .sendMessage(tab.id, {
            type: "SHOW_ROLL_COACH",
            title: message.title || "",
            sayScript: message.sayScript || ""
          })
          .catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "REGISTER_FRAME") {
    const tabId = sender?.tab?.id;
    const frameId = typeof sender?.frameId === "number" ? sender.frameId : 0;
    const isTop = Boolean(message.isTop || frameId === 0);
    if (tabId != null) {
      registeredFrames.set(`${tabId}:${frameId}`, {
        tabId,
        frameId,
        isTop,
        characterId: String(message.characterId || ""),
        hasChatInput: Boolean(message.hasChatInput),
        hasSheet: Boolean(message.hasSheet),
        updatedAt: Date.now()
      });
      if (isTop) {
        registeredTopFrames.add(tabId);
      }
    }
    sendResponse({
      ok: true,
      hasTopFrameCoach: tabId != null ? registeredTopFrames.has(tabId) : false,
      frameId
    });
    return false;
  }

  if (message.type === "RELAY_TRIGGER_SHEET_ROLL") {
    (async () => {
      const senderTabId = sender?.tab?.id ?? null;
      const senderFrameId = typeof sender?.frameId === "number" ? sender.frameId : 0;
      const targetCharId = String(message.characterId || "");
      const rollMsg = {
        type: "EXECUTE_VTT_ROLL_LOCAL",
        rollSpec: message.rollSpec || null,
        part: message.part || "tohit",
        mode: message.mode || "normal"
      };

      const allFrames = Array.from(registeredFrames.values()).filter(
        (f) => !(f.tabId === senderTabId && f.frameId === senderFrameId)
      );
      const charScore = (f) => (targetCharId && f.characterId === targetCharId ? 0 : 1);

      const candidates = [];
      const seenKeys = new Set();
      const pushCandidate = (tabId, frameId) => {
        if (tabId == null) return;
        const key = `${tabId}:${frameId}`;
        if (seenKeys.has(key)) return;
        if (tabId === senderTabId && frameId === senderFrameId) return;
        seenKeys.add(key);
        candidates.push({ tabId, frameId });
      };

      if (senderTabId != null) {
        allFrames
          .filter((f) => f.tabId === senderTabId && f.hasSheet)
          .sort((a, b) => charScore(a) - charScore(b) || b.updatedAt - a.updatedAt)
          .forEach((f) => pushCandidate(f.tabId, f.frameId));
        allFrames
          .filter((f) => f.tabId === senderTabId && (f.hasChatInput || f.frameId === 0))
          .sort((a, b) => (b.hasChatInput ? 1 : 0) - (a.hasChatInput ? 1 : 0) || b.updatedAt - a.updatedAt)
          .forEach((f) => pushCandidate(f.tabId, f.frameId));
        if (senderFrameId !== 0) {
          pushCandidate(senderTabId, 0);
        }
      }

      allFrames
        .filter((f) => f.tabId !== senderTabId && f.hasSheet)
        .sort((a, b) => charScore(a) - charScore(b) || b.updatedAt - a.updatedAt)
        .forEach((f) => pushCandidate(f.tabId, f.frameId));

      allFrames
        .filter((f) => f.tabId !== senderTabId && f.hasChatInput)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .forEach((f) => pushCandidate(f.tabId, f.frameId));

      const triedTabIds = new Set();
      for (const c of candidates) {
        triedTabIds.add(c.tabId);
        try {
          const resp = await chrome.tabs.sendMessage(c.tabId, rollMsg, { frameId: c.frameId });
          if (resp?.triggered) {
            sendResponse({ ok: true, triggered: true, via: resp.via || "relayed-frame" });
            return;
          }
        } catch (_) {}
      }

      const tabs = await findDndBeyondTabs();
      for (const tab of tabs) {
        if (tab.id === senderTabId) continue;
        if (triedTabIds.has(tab.id)) continue;
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, rollMsg);
          if (resp?.triggered) {
            sendResponse({ ok: true, triggered: true, via: resp.via || "relayed-tab" });
            return;
          }
        } catch (_) {}
      }

      sendResponse({ ok: true, triggered: false });
    })();
    return true;
  }

  if (message.type === "FORWARD_ROLL_COACH_TO_TOP") {
    (async () => {
      const senderTabId = sender?.tab?.id ?? null;
      const senderFrameId = typeof sender?.frameId === "number" ? sender.frameId : 0;
      if (senderTabId != null && senderFrameId !== 0 && registeredTopFrames.has(senderTabId)) {
        try {
          const resp = await chrome.tabs.sendMessage(
            senderTabId,
            {
              type: "SHOW_ANALYZED_COACH_FROM_FRAME",
              matchedSpec: message.matchedSpec || null,
              part: message.part || "tohit",
              rolledTotal: message.rolledTotal ?? null,
              rawActionLabel: message.rawActionLabel || "",
              vttStatus: message.vttStatus || ""
            },
            { frameId: 0 }
          );
          sendResponse({ ok: true, forwarded: Boolean(resp?.ok) });
          return;
        } catch (_) {}
      }
      sendResponse({ ok: true, forwarded: false });
    })();
    return true;
  }

  if (message.type === "GET_ROLL_CONTEXT") {
    (async () => {
      try {
        const localCtx = await fetchLocalServerRollContext();
        if (localCtx?.myChar) {
          chrome.storage?.local?.set({ dnd_copilot_roll_context: localCtx }).catch(() => {});
          sendResponse({ ok: true, ...localCtx });
          return;
        }
        const stored = await chrome.storage?.local?.get("dnd_copilot_roll_context");
        sendResponse({ ok: true, ...(stored?.dnd_copilot_roll_context || {}) });
      } catch (_) {
        sendResponse({ ok: true, myChar: null, party: [] });
      }
    })();
    return true;
  }

  if (message.type === "DASHBOARD_READY" || message.type === "REQUEST_ABOVEVTT_SYNC") {
    (async () => {
      const tabs = await findDndBeyondTabs();
      let freshSnapshot = latestAboveVttSnapshot;
      for (const tab of tabs) {
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_SNAPSHOT_NOW" });
          if (resp?.snapshot) {
            freshSnapshot = resp.snapshot;
            latestAboveVttSnapshot = freshSnapshot;
            latestSourceTabId = tab.id;
            if (freshSnapshot.isAboveVttActive) break;
          }
        } catch (_) {
          // Content script may need reload if tab was opened prior to extension install
        }
      }
      sendResponse({
        ok: true,
        connectedTabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        snapshot: freshSnapshot
      });
    })();
    return true;
  }

  if (message.type === "FETCH_DDB_CHARACTER") {
    (async () => {
      const cleanId = String(message.characterId || "").replace(/\D/g, "");
      if (!cleanId) {
        sendResponse({ ok: false, error: "Missing character ID" });
        return;
      }

      // First try authenticated fetch through an open D&D Beyond tab (supports campaign/private sheets)
      const tabs = await findDndBeyondTabs();
      if (latestSourceTabId) {
        tabs.sort((a, b) => (a.id === latestSourceTabId ? -1 : b.id === latestSourceTabId ? 1 : 0));
      }

      for (const tab of tabs) {
        try {
          const tabResult = await chrome.tabs.sendMessage(tab.id, {
            type: "CONTENT_FETCH_CHARACTER",
            characterId: cleanId
          });
          if (tabResult?.ok && tabResult.json) {
            sendResponse({ ok: true, json: tabResult.json, via: "authenticated-tab" });
            return;
          }
        } catch (_) {
          // Fall through to next tab or public endpoint
        }
      }

      // Fallback: direct fetch (works for public sheets even with zero DDB tabs open)
      try {
        const json = await fetchCharacterDirectly(cleanId);
        sendResponse({ ok: true, json, via: "public-api" });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
