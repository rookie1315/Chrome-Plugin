import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

import aiohttp
import numpy as np
import websockets
from faster_whisper import WhisperModel


HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "3000"))
MODEL_SIZE = os.getenv("WHISPER_MODEL", "tiny.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
SAMPLE_RATE = 16000
WINDOW_SECONDS = float(os.getenv("WHISPER_WINDOW_SECONDS", "5"))
STEP_SECONDS = float(os.getenv("WHISPER_STEP_SECONDS", "1"))
RECENT_TEXT_LIMIT = int(os.getenv("WHISPER_RECENT_TEXT_LIMIT", "10"))

model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)


async def handle_client(websocket):
    first_message = await websocket.recv()
    if isinstance(first_message, str):
      try:
          request = json.loads(first_message)
      except json.JSONDecodeError:
          request = {}

      if request.get("type") == "pretranscribe":
          await handle_pretranscribe(websocket, request)
          return

    pcm_buffer = bytearray()
    last_decode_at = time.monotonic()
    stream_offset_seconds = 0.0
    recent_texts = []

    async for message in websocket:
        if isinstance(message, str):
            continue

        pcm_buffer.extend(message)
        now = time.monotonic()

        if now - last_decode_at < STEP_SECONDS:
            continue

        window_bytes = int(SAMPLE_RATE * WINDOW_SECONDS * 2)
        if len(pcm_buffer) < window_bytes:
            continue

        chunk = bytes(pcm_buffer[-window_bytes:])
        window_start = max(0.0, stream_offset_seconds - WINDOW_SECONDS)

        audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=False,
        )

        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue

            normalized = normalize_text(text)
            if not normalized or normalized in recent_texts:
                continue

            recent_texts.append(normalized)
            recent_texts[:] = recent_texts[-RECENT_TEXT_LIMIT:]

            await websocket.send(json.dumps({
                "text": text,
                "start": window_start + float(segment.start),
                "end": window_start + float(segment.end),
                "final": True,
            }))

        keep_bytes = window_bytes
        if len(pcm_buffer) > keep_bytes:
            dropped = len(pcm_buffer) - keep_bytes
            stream_offset_seconds += dropped / 2 / SAMPLE_RATE
            del pcm_buffer[:dropped]

        last_decode_at = now


def normalize_text(text):
    return "".join(character.lower() for character in text if character.isalnum())


async def handle_pretranscribe(websocket, request):
    temp_path = None

    try:
        await send_progress(websocket, "downloading", "audio")
        temp_path = await download_bilibili_audio(request)

        await send_progress(websocket, "transcribing", "0%")
        items = transcribe_file(temp_path, websocket)

        await websocket.send(json.dumps({
            "type": "pretranscribe_result",
            "items": items,
        }))
    except Exception as error:
        await websocket.send(json.dumps({
            "type": "error",
            "message": str(error),
        }))
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


async def download_bilibili_audio(request):
    audio_urls = request.get("audioUrls") or []
    page_url = request.get("pageUrl") or "https://www.bilibili.com/"
    candidates = []

    for item in audio_urls:
        candidates.extend(item.get("urls") or [])

    if not candidates:
        raise RuntimeError("No Bilibili audio URL was provided.")

    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
        "Origin": "https://www.bilibili.com",
        "Referer": page_url,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }

    last_error = None
    timeout = aiohttp.ClientTimeout(total=180)

    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        for url in candidates:
            try:
                suffix = ".m4s" if ".m4s" in url else ".m4a"
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                    temp_path = temp_file.name

                    async with session.get(url) as response:
                        if response.status not in (200, 206):
                            raise RuntimeError(f"HTTP {response.status}")

                        async for chunk in response.content.iter_chunked(1024 * 256):
                            temp_file.write(chunk)

                if Path(temp_path).stat().st_size < 1024:
                    raise RuntimeError("Downloaded audio is empty.")

                return temp_path
            except Exception as error:
                last_error = error
                if "temp_path" in locals():
                    Path(temp_path).unlink(missing_ok=True)

    raise RuntimeError(f"Unable to download Bilibili audio: {last_error}")


def transcribe_file(path, websocket):
    segments, _info = model.transcribe(
        path,
        language="en",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        without_timestamps=False,
    )

    items = []
    seen = set()

    for index, segment in enumerate(segments):
        text = segment.text.strip()
        normalized = normalize_text(text)

        if not text or normalized in seen:
            continue

        seen.add(normalized)
        items.append({
            "text": text,
            "start": float(segment.start),
            "end": float(segment.end),
        })

        if index % 5 == 0:
            # Fire-and-forget progress; the final result is the important payload.
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(send_progress(websocket, "transcribing", f"{len(items)} lines"))
            except RuntimeError:
                pass

    return items


async def send_progress(websocket, stage, detail):
    await websocket.send(json.dumps({
        "type": "progress",
        "stage": stage,
        "detail": detail,
    }))


async def main():
    print(
        f"Local Whisper server listening on ws://{HOST}:{PORT}/stt "
        f"model={MODEL_SIZE} device={DEVICE} compute={COMPUTE_TYPE}"
    )

    async with websockets.serve(handle_client, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
