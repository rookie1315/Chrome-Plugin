async function getActiveBilibiliTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !tab.url?.startsWith("https://www.bilibili.com/video/")) {
    throw new Error("Open a Bilibili video page before starting captions.");
  }

  return tab;
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script may not be ready after a fresh navigation. Inject once.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"]
    });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.action.onClicked.addListener(async () => {
  try {
    const tab = await getActiveBilibiliTab();
    const media = await extractBilibiliMedia(tab.id);

    await sendToTab(tab.id, {
      type: "PRETRANSCRIBE_START",
      payload: {
        ...media,
        pageUrl: tab.url,
        title: tab.title || media.title || "Bilibili video"
      }
    });

    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#00a1d6" });
    chrome.action.setBadgeText({ tabId: tab.id, text: "PRE" });
  } catch (error) {
    console.error(error);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.action.setBadgeText({ tabId, text: "" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_VIDEO_TIME") {
    getVideoTime(message.tabId)
      .then((time) => sendResponse({ ok: true, time }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SEND_TO_TAB") {
    sendToTab(message.tabId, message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CAPTURE_FAILED") {
    chrome.storage.session.remove("activeTabId");
    chrome.action.setBadgeText({ tabId: message.tabId, text: "" });
    sendToTab(message.tabId, { type: "CAPTION_STATUS", enabled: false }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PRETRANSCRIBE_DONE") {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) chrome.action.setBadgeText({ tabId, text: "OK" });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PRETRANSCRIBE_FAILED") {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) chrome.action.setBadgeText({ tabId, text: "" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function getVideoTime(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.querySelector("video")?.currentTime || 0
  });

  return Number(result?.result || 0);
}

async function extractBilibiliMedia(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const playInfo = window.__playinfo__ || readPlayInfoFromScripts();
      const initialState = window.__INITIAL_STATE__ || {};
      const dash = playInfo?.data?.dash || playInfo?.dash;
      const audioItems = dash?.audio || [];
      const audioUrls = audioItems
        .map((item) => ({
          id: item.id,
          bandwidth: item.bandwidth || 0,
          codecs: item.codecs || "",
          urls: [
            item.baseUrl,
            item.base_url,
            ...(item.backupUrl || []),
            ...(item.backup_url || [])
          ].filter(Boolean)
        }))
        .filter((item) => item.urls.length > 0)
        .sort((left, right) => right.bandwidth - left.bandwidth);

      return {
        bvid: initialState.bvid || location.pathname.match(/\/video\/([^/?#]+)/)?.[1] || "",
        cid: String(initialState.cid || new URLSearchParams(location.search).get("cid") || "default"),
        title: initialState.videoData?.title || document.title || "",
        duration: Number(dash?.duration || playInfo?.data?.timelength / 1000 || 0),
        audioUrls
      };

      function readPlayInfoFromScripts() {
        for (const script of document.scripts) {
          const text = script.textContent || "";
          const marker = "window.__playinfo__=";
          const start = text.indexOf(marker);
          if (start === -1) continue;

          const jsonText = extractJsonObject(text.slice(start + marker.length));
          try {
            return JSON.parse(jsonText);
          } catch {
            return null;
          }
        }

        return null;
      }

      function extractJsonObject(text) {
        const firstBrace = text.indexOf("{");
        if (firstBrace === -1) return "";

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = firstBrace; index < text.length; index += 1) {
          const char = text[index];

          if (escaped) {
            escaped = false;
            continue;
          }

          if (char === "\\") {
            escaped = true;
            continue;
          }

          if (char === "\"") {
            inString = !inString;
            continue;
          }

          if (inString) continue;

          if (char === "{") depth += 1;
          if (char === "}") depth -= 1;

          if (depth === 0) {
            return text.slice(firstBrace, index + 1);
          }
        }

        return "";
      }
    }
  });

  const media = result?.result;
  if (!media?.audioUrls?.length) {
    throw new Error("Cannot find Bilibili DASH audio URL. Refresh the video page and try again.");
  }

  return media;
}
