import "dotenv/config";
import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 3000);
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const hasDeepgramApiKey = Boolean(
  deepgramApiKey && !deepgramApiKey.includes("put_your_deepgram_api_key_here")
);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stt" });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "deepgram",
    hasApiKey: hasDeepgramApiKey
  });
});

wss.on("connection", (client) => {
  if (!hasDeepgramApiKey) {
    client.send(JSON.stringify({
      text: "Missing DEEPGRAM_API_KEY on local server.",
      start: 0,
      end: 3,
      final: true
    }));
    client.close(1011, "Missing DEEPGRAM_API_KEY");
    return;
  }

  const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen");
  deepgramUrl.searchParams.set("model", "nova-3");
  deepgramUrl.searchParams.set("language", "en-US");
  deepgramUrl.searchParams.set("encoding", "opus");
  deepgramUrl.searchParams.set("container", "webm");
  deepgramUrl.searchParams.set("interim_results", "true");
  deepgramUrl.searchParams.set("smart_format", "true");
  deepgramUrl.searchParams.set("punctuate", "true");

  const deepgram = new WebSocket(deepgramUrl, {
    headers: {
      Authorization: `Token ${deepgramApiKey}`
    }
  });

  deepgram.on("message", (raw) => {
    const transcript = normalizeDeepgramMessage(raw);
    if (!transcript) return;

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(transcript));
    }
  });

  deepgram.on("error", (error) => {
    console.error("Deepgram socket error:", error.message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        text: `Deepgram error: ${error.message}`,
        start: 0,
        end: 3,
        final: true
      }));
    }
  });

  client.on("message", (chunk) => {
    if (deepgram.readyState === WebSocket.OPEN) {
      deepgram.send(chunk);
    }
  });

  client.on("close", () => {
    if (deepgram.readyState === WebSocket.OPEN) {
      deepgram.close();
    }
  });
});

function normalizeDeepgramMessage(raw) {
  const message = JSON.parse(raw.toString());
  const alternative = message.channel?.alternatives?.[0];
  const text = alternative?.transcript?.trim();

  if (!text) return null;

  const words = alternative.words || [];
  const start = Number(words[0]?.start || message.start || 0);
  const lastWord = words[words.length - 1];
  const end = Number(lastWord?.end || start + Math.max(1.4, text.length / 18));

  return {
    text,
    start,
    end,
    final: Boolean(message.is_final)
  };
}

server.listen(port, () => {
  console.log(`Bili live caption STT proxy listening on http://localhost:${port}`);
});
