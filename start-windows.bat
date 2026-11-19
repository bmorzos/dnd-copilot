@echo off
cd /d "%~dp0"
set PORT=8765
echo Starting D^&D Table Copilot on http://localhost:%PORT% ...
start "" "http://localhost:%PORT%"
python -m http.server %PORT% --bind 127.0.0.1
