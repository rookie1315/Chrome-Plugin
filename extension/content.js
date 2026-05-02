(() => {
  if (window.__biliLiveCaptionInjected) return;
  window.__biliLiveCaptionInjected = true;

  const state = {
    enabled: false,
    captions: [],
    draft: null,
    video: null,
    overlay: null,
    status: null,
    cacheTimer: null,
    preSocket: null,
    pretranscribing: false
  };

  init();

  function init() {
    state.video = document.querySelector("video");
    if (!state.video) {
      setTimeout(init, 800);
      return;
    }

    createOverlay();
    loadCachedCaptions();
    chrome.runtime.onMessage.addListener(handleMessage);
    state.video.addEventListener("seeking", clearDraft);
    requestAnimationFrame(renderLoop);
  }

  function createOverlay() {
    state.overlay = document.createElement("div");
    state.overlay.id = "bili-live-caption-overlay";
    state.overlay.hidden = true;

    state.status = document.createElement("div");
    state.status.id = "bili-live-caption-status";
    state.status.hidden = true;

    document.documentElement.append(state.overlay, state.status);
  }

  function handleMessage(message) {
    if (message.type === "CAPTION_STATUS") {
      state.enabled = Boolean(message.enabled);
      state.overlay.hidden = !state.enabled;
      state.status.hidden = !state.enabled;
      if (!state.enabled) {
        state.overlay.textContent = "";
        state.status.textContent = "";
      }
    }

    if (message.type === "CAPTION_RESULT") {
      receiveCaption(message.payload);
    }

    if (message.type === "CAPTION_INTERNAL_STATUS") {
      showStatus(message.status, message.detail);
    }

    if (message.type === "CAPTION_CACHE_APPEND") {
      scheduleCacheWrite();
    }

    if (message.type === "PRETRANSCRIBE_START") {
      startPretranscribe(message.payload);
    }
  }

  async function startPretranscribe(media) {
    if (state.preSocket) {
      state.preSocket.close();
      state.preSocket = null;
    }

    state.enabled = true;
    state.pretranscribing = true;
    state.captions = [];
    state.draft = null;
    state.overlay.hidden = true;
    showStatus("preparing");

    const cachedItems = await getCachedItems();
    if (cachedItems.length > 0) {
      state.captions = cachedItems;
      state.pretranscribing = false;
      showStatus("ready", `${cachedItems.length} captions`);
      return;
    }

    const socket = new WebSocket("ws://localhost:3000/stt");
    state.preSocket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "pretranscribe",
        pageUrl: media.pageUrl,
        title: media.title,
        bvid: media.bvid,
        cid: media.cid,
        duration: media.duration,
        audioUrls: media.audioUrls
      }));
      showStatus("downloading");
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "progress") {
        showStatus(message.stage || "working", message.detail || "");
        return;
      }

      if (message.type === "pretranscribe_result") {
        state.captions = mergeCaptions(message.items || []);
        state.pretranscribing = false;
        scheduleCacheWrite();
        showStatus("ready", `${state.captions.length} captions`);
        chrome.runtime.sendMessage({ type: "PRETRANSCRIBE_DONE" });
        return;
      }

      if (message.type === "error") {
        state.pretranscribing = false;
        showStatus("error", message.message || "pretranscribe failed");
        chrome.runtime.sendMessage({ type: "PRETRANSCRIBE_FAILED" });
      }
    };

    socket.onerror = () => {
      state.pretranscribing = false;
      showStatus("error", "Cannot connect to local Whisper server");
      chrome.runtime.sendMessage({ type: "PRETRANSCRIBE_FAILED" });
    };

    socket.onclose = () => {
      if (state.preSocket === socket) {
        state.preSocket = null;
      }
    };
  }

  function receiveCaption(item) {
    const videoTime = state.video?.currentTime || 0;
    const originalStart = Number(item.start || videoTime);
    const originalEnd = Math.max(Number(item.end || originalStart), originalStart + 1);
    let start = originalStart;
    let end = originalEnd;

    if (item.final && originalEnd < videoTime - 0.4) {
      const readableSeconds = Math.min(5.5, Math.max(2.2, item.text.length / 14));
      start = videoTime;
      end = videoTime + readableSeconds;
    }

    if (item.final) {
      state.captions.push({
        text: item.text,
        start,
        end,
        originalStart,
        originalEnd
      });
      state.draft = null;
      scheduleCacheWrite();
      return;
    }

    state.draft = {
      ...item,
      start,
      end
    };
  }

  function renderLoop() {
    const video = document.querySelector("video");
    if (video && video !== state.video) {
      state.video = video;
      state.video.addEventListener("seeking", clearDraft);
    }

    if (state.enabled && state.video && state.overlay) {
      const now = state.video.currentTime;
      const active = findActiveCaption(now);
      const draftText = state.draft?.text || "";

      state.overlay.textContent = active?.text || draftText;
      state.overlay.hidden = !state.overlay.textContent;
    }

    requestAnimationFrame(renderLoop);
  }

  function findActiveCaption(time) {
    for (let index = state.captions.length - 1; index >= 0; index -= 1) {
      const item = state.captions[index];
      if (time >= item.start && time <= item.end + 0.6) return item;
      if (item.start < time - 30) break;
    }

    return null;
  }

  function clearDraft() {
    state.draft = null;
  }

  function showStatus(status, detail) {
    if (!state.status) return;

    const label = {
      listening: "Live captions on",
      preparing: "Preparing captions",
      downloading: "Downloading audio",
      transcribing: detail ? `Transcribing ${detail}` : "Transcribing",
      ready: detail ? `Captions ready: ${detail}` : "Captions ready",
      error: `Caption error: ${detail || "unknown"}`
    }[status] || status;

    state.status.textContent = label;
    state.status.hidden = false;
  }

  function getCacheKey() {
    const match = location.pathname.match(/\/video\/([^/?#]+)/);
    const bvid = match?.[1] || location.pathname;
    const cid = new URLSearchParams(location.search).get("cid") || "default";
    return `bili-pretranscribe-caption:v1:${bvid}:${cid}:en-US`;
  }

  async function loadCachedCaptions() {
    const items = await getCachedItems();

    if (Array.isArray(items)) {
      state.captions = items;
    }
  }

  async function getCachedItems() {
    const key = getCacheKey();
    const cached = await chrome.storage.local.get(key);
    const items = cached[key]?.items;
    return Array.isArray(items) ? items : [];
  }

  function mergeCaptions(items) {
    return items
      .map((item) => ({
        text: String(item.text || "").trim(),
        start: Number(item.start || 0),
        end: Math.max(Number(item.end || 0), Number(item.start || 0) + 1)
      }))
      .filter((item) => item.text)
      .sort((left, right) => left.start - right.start);
  }

  function scheduleCacheWrite() {
    clearTimeout(state.cacheTimer);
    state.cacheTimer = setTimeout(async () => {
      const key = getCacheKey();
      await chrome.storage.local.set({
        [key]: {
          version: 1,
          language: "en-US",
          updatedAt: Date.now(),
          items: state.captions.slice(-1500)
        }
      });
    }, 500);
  }
})();
