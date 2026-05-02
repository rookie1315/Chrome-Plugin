let mediaStream = null;
let sttSocket = null;
let audioContext = null;
let captureNode = null;
let monitorNode = null;
let silentNode = null;
let tabId = null;
let captureStartedAtVideoTime = 0;
let lastFinalItems = [];

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "START_CAPTURE") {
    startCapture(message).catch((error) => {
      console.error("Failed to start capture:", error);
      sendStatus("error", error.message);
      notifyStopped();
      stopCapture();
    });
  }

  if (message.type === "STOP_CAPTURE") {
    stopCapture();
  }
});

async function startCapture(message) {
  stopCapture();

  tabId = message.tabId;
  captureStartedAtVideoTime = await getVideoTime(tabId);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });

  await startPcmAudioPipeline(mediaStream);
  await connectSttSocket();

  sendStatus("listening");
}

function stopCapture() {
  if (captureNode) {
    captureNode.disconnect();
  }

  if (monitorNode) {
    monitorNode.disconnect();
  }

  if (silentNode) {
    silentNode.disconnect();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (sttSocket) {
    sttSocket.close();
  }

  if (audioContext) {
    audioContext.close();
  }

  mediaStream = null;
  sttSocket = null;
  audioContext = null;
  captureNode = null;
  monitorNode = null;
  silentNode = null;
  tabId = null;
  captureStartedAtVideoTime = 0;
  lastFinalItems = [];
}

async function startPcmAudioPipeline(stream) {
  audioContext = new AudioContext({ sampleRate: 16000 });

  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));

  const source = audioContext.createMediaStreamSource(stream);
  captureNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");

  captureNode.port.onmessage = (event) => {
    if (sttSocket?.readyState === WebSocket.OPEN) {
      sttSocket.send(event.data);
    }
  };

  silentNode = audioContext.createGain();
  silentNode.gain.value = 0;

  monitorNode = audioContext.createGain();
  monitorNode.gain.value = 1;

  source.connect(captureNode);
  captureNode.connect(silentNode);
  silentNode.connect(audioContext.destination);

  source.connect(monitorNode);
  monitorNode.connect(audioContext.destination);
}

function connectSttSocket() {
  return new Promise((resolve, reject) => {
    sttSocket = new WebSocket("ws://localhost:3000/stt");
    sttSocket.binaryType = "arraybuffer";

    sttSocket.onopen = () => {
      sttSocket.send(JSON.stringify({
        type: "start",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        language: "en"
      }));
      resolve();
    };
    sttSocket.onerror = () => reject(new Error("Cannot connect to ws://localhost:3000/stt"));
    sttSocket.onmessage = (event) => handleSttMessage(event.data);
  });
}

function handleSttMessage(raw) {
  if (!tabId) return;

  const data = JSON.parse(raw);
  if (!data.text) return;

  const item = {
    text: data.text,
    start: captureStartedAtVideoTime + Number(data.start || 0),
    end: captureStartedAtVideoTime + Number(data.end || data.start || 0) + 0.3,
    final: Boolean(data.final)
  };

  sendToTab({
    type: "CAPTION_RESULT",
    payload: item
  });

  if (item.final) {
    lastFinalItems.push({
      text: item.text,
      start: item.start,
      end: item.end
    });

    sendToTab({
      type: "CAPTION_CACHE_APPEND",
      payload: lastFinalItems.slice(-20)
    });
  }
}

async function getVideoTime(targetTabId) {
  const response = await chrome.runtime.sendMessage({
    type: "GET_VIDEO_TIME",
    tabId: targetTabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Cannot read video time");
  }

  return Number(response.time || 0);
}

function sendStatus(status, detail = "") {
  if (!tabId) return;

  sendToTab({
    type: "CAPTION_INTERNAL_STATUS",
    status,
    detail
  });
}

function sendToTab(payload) {
  return chrome.runtime.sendMessage({
    type: "SEND_TO_TAB",
    tabId,
    payload
  });
}

function notifyStopped() {
  if (!tabId) return;

  chrome.runtime.sendMessage({
    type: "CAPTURE_FAILED",
    tabId
  });
}
