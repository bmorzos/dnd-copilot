/**
 * Chrome MV3 Background Service Worker for D&D Table Copilot.
 * Opens/focuses the full-screen Dashboard tab and bridges AboveVTT / D&D Beyond tabs.
 */

let latestAboveVttSnapshot = null;
let latestSourceTabId = null;

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

async function fetchCharacterDirectly(characterId) {
  const cleanId = String(characterId).replace(/\D/g, "");
  if (!cleanId) {
    throw new Error("Invalid D&D Beyond character ID.");
  }
  const url = `https://character-service.dndbeyond.com/character/v5/character/${cleanId}?includeCustomItems=true`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`D&D Beyond returned HTTP ${response.status}. Make sure the sheet is Public or keep a logged-in D&D Beyond tab open.`);
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
    sendResponse({ ok: true });
    return false;
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
