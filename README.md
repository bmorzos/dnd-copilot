# D&D Table Copilot — Clean Live Session, Puzzle & AboveVTT Dashboard

A **zero-install, cross-platform (Mac & Windows)** D&D 5e companion built to run right inside Google Chrome at an in-person game table—even on a locked-down work MacBook.

## Key Capabilities

- **Clean, High-Legibility Layout**
  - Designed for quick glances at the game table with larger fonts (`16.5px`–`22px`), a prominent **"What's Going On"** panel on the left, a **minimized Live Transcript drawer** at the bottom, and single-tab focus (`🪄 Best Move` | `🧩 Puzzle` | `⚔️ Combat`) in the center.
- **1-Click `Chrome` ↔ `Groq` Speech Toggle + Crash-Safe Session Recording**
  - **`Chrome` (`$0` built-in)**: Instant browser speech-to-text with zero API keys.
  - **`Groq` (`whisper-large-v3-turbo`)**: High-accuracy room-microphone & past-recording transcription with automatic silence skipping (`~8 hrs/day` free tier or `~$0.04/hr` paid at `https://console.groq.com/keys`—no Google Cloud project needed).
  - **`⏺ Record` / `⬇ Save Audio`**: Crash-safe session recorder that flushes voice-grade Opus audio (`~21 MB/hr`) to IndexedDB every 10 seconds and saves as `.webm`, plus **`📂 Audio File`** to replay and analyze past recordings.
- **Tactical Spell Advisor, Puzzle Solver & Player-Fair Encounter Tracker**
  - **Best Move Advisor**: Uses your `★ Me` character's prepared spells, remaining spell slots, concentration status, teammates' HP, and enemy observations to recommend your top 3 moves (works for `$0` locally, with **Groq `llama-3.3-70b-versatile`**, or with **Gemini**).
  - **Puzzle & Riddle Solver**: Collects spoken riddles, inscriptions, and clues, generates ranked solution ideas, and suggests what checks/questions to try next.
  - **Player-Fair AboveVTT Combat Tracker**: Syncs round/initiative order, visible enemies, `Bloodied` cues, cumulative damage dealt, and hit/miss AC bounds (`14 missed · 16 hit`) while **strictly ignoring hidden DM tokens, hidden monster statblocks, and DM-only rolls**.
- **Party HUD (D&D Beyond Character Sheets)**
  - Auto-discovers campaign party sheets from AboveVTT or syncs from pasted D&D Beyond character URLs/IDs with large, readable HP, AC, Save DC, Spell Slot pips (`L1`–`L9` + Warlock `Pact`), and prepared spells.

---

## Two Ways to Run (Mac & Windows)

### Option A: Unpacked Chrome Extension (Best if Chrome Developer Mode is allowed)
1. Copy or clone this `dnd-copilot` folder onto your Mac or Windows laptop.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right), click **Load unpacked**, and select the `dnd-copilot` folder. *(If updating, click the `↻` reload icon on **D&D Table Copilot**.)*
4. Click the **D&D Table Copilot** icon in your Chrome toolbar to open the dashboard—it automatically connects to any open D&D Beyond / AboveVTT tab.

### Option B: Locked-Down Work Mac Mode (Zero Extensions & Zero Installs!)
If corporate IT disables unpacked Chrome extensions:
1. Host on GitHub Pages (safe: API keys stay only in your browser's `localStorage`), **OR** double-click `start-mac.command` (Mac) / `start-windows.bat` (Windows) to open `http://localhost:8765`.
2. Click **AboveVTT** in the top bar and drag the **`⚔️ Sync AboveVTT → Copilot`** button to your Chrome Bookmarks Bar.
3. Open your D&D Beyond / AboveVTT tab and click that bookmark once to stream visible rolls, initiative, and party character sheets with zero extensions.
