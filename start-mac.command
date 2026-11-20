#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "Starting D&D Table Copilot on http://localhost:$PORT ..."
(sleep 1 && open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT") &
python3 local-server.py $PORT
