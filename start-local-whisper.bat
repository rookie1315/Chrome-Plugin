@echo off
setlocal

cd /d "%~dp0server"
if errorlevel 1 (
  echo Could not enter the server folder.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Please install Python first, then run this file again.
  pause
  exit /b 1
)

python -c "import faster_whisper, aiohttp, websockets" >nul 2>nul
if errorlevel 1 (
  echo Python dependencies are missing. Installing them now...
  python -m pip install -r requirements-local-whisper.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting the local Whisper server...
echo Keep this window open while using the Chrome extension.
echo.

python local_whisper_server.py

echo.
echo Local Whisper server stopped.
pause
