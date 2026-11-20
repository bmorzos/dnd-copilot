@echo off
cd /d "%~dp0"
set PORT=8765
echo Starting D^&D Table Copilot on http://localhost:%PORT% ...
start "" "http://localhost:%PORT%"
python -B local-server.py %PORT%
