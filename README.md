# Bilibili Live English Captions

Chrome MV3 extension that captures audio from a Bilibili video tab, streams it to a local STT proxy, and overlays generated English captions on the video page.

## Free Local Whisper Run

This mode does not need a Deepgram API key. It runs Whisper locally on your computer.

1. Install Python dependencies:

   ```powershell
   cd server
   python -m pip install -r requirements-local-whisper.txt
   ```

2. Start the local Whisper server:

   ```powershell
   python local_whisper_server.py
   ```

   The first run downloads the `tiny.en` model. For better accuracy, use `small.en`:

   ```powershell
   $env:WHISPER_MODEL="small.en"
   python local_whisper_server.py
   ```

3. Open Chrome and load the extension:

   - Go to `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select the `extension` folder in this project

4. Open a Bilibili video page like `https://www.bilibili.com/video/...`, then click the extension icon. The extension will try to extract the Bilibili DASH audio URL, download the audio locally, transcribe it with Whisper, cache the generated subtitles, and display them while the video plays.

## Deepgram Run

1. Install server dependencies:

   ```powershell
   cd server
   npm install
   ```

2. Create the server environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `server/.env` and set `DEEPGRAM_API_KEY`.

4. Start the local STT proxy:

   ```powershell
   npm start
   ```

5. Open Chrome and load the extension:

   - Go to `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select the `extension` folder in this project

6. Open a Bilibili video page like `https://www.bilibili.com/video/...`, start playback, then click the extension icon. Click again to stop.

To stop the background server started during testing:

```powershell
cd server
if (Test-Path .server.pid) { Stop-Process -Id (Get-Content .server.pid) -Force }
```

## Notes

- The current MVP uses `chrome.tabCapture` plus `MediaRecorder` with WebM/Opus chunks.
- The local proxy uses Deepgram streaming recognition. You can swap the server implementation for AssemblyAI or Google Speech-to-Text later.
- `/health` returns `hasApiKey:false` until `server/.env` contains a real Deepgram key.
- Generated final captions are cached in `chrome.storage.local` by Bilibili video id and language.
- If captions drift after seeking, stop and start the extension again. A production version should restart capture automatically on seeking.

## About Prebuffering

The current default mode is pretranscription. The extension reads the Bilibili DASH audio URL from the page, sends it to the local Whisper server, downloads the audio, transcribes it, caches the generated subtitles, then renders them against `video.currentTime`.

This is more accurate than live tab capture, and it no longer captures or reroutes your headphone audio. It can still fail if Bilibili changes its page data, if the audio URL requires cookies the local server cannot access, or if the video is restricted.
