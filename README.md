# Maia Chess Centaur

Maia Chess Centaur is a local, offline chess web application for playing against
the Maia Chess neural network. It uses local Maia profiles at 1100, 1500, and 1900
Elo through a FastAPI backend, `python-chess`, and a local Leela Chess Zero (`lc0`)
engine.

The frontend uses React, Vite, Tailwind CSS v4, `chess.js`, and
`react-chessboard`. Runtime communication is limited to the local frontend and
backend. The application does not use Stockfish, cloud services, external APIs, or
online accounts.

## Current features

- Play as White, Black, or Random.
- Automatic board orientation based on the player's color.
- Maia automatically makes the opening move when the player chooses Black.
- Legal move validation through `chess.js`.
- Undo that removes the appropriate player/Maia turn pair.
- Queen, rook, bishop, and knight promotion selection.
- Responsive Tailwind CSS v4 dark interface.
- Side-by-side board and move history on larger screens.
- Auto-scrolling move history.
- Last-move highlighting.
- Local game persistence under the versioned key
  `maia_chess_saved_game_v1`.
- Automatic saving of active-game PGN, Elo, color preference, player color, game
  phase, and save timestamp.
- Safe restoration of saved games after a page reload.
- Explicit **Resume Maia Move** recovery when a reload occurs during Maia's turn.
- **New Game** cancels active timers/requests, clears saved data, and returns to
  setup.

The standalone **Clear Saved Game** action that keeps the active board visible and
shows a confirmation is planned for Step 2.1.3. Currently, New Game performs the
reset and clearing behavior.

## Project structure

```text
maia-chess-app/
├── backend/
│   ├── engines/              # Local-only engine files; ignored by Git
│   │   ├── lc0.exe
│   │   ├── maia-1100.pb.gz
│   │   ├── maia-1500.pb.gz
│   │   └── maia-1900.pb.gz
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── package.json
│   └── package-lock.json
└── README.md
```

Legacy `Appv*.jsx` files are historical backups and are not active entry points.
The active frontend entry point is [frontend/src/App.jsx](frontend/src/App.jsx),
loaded by [frontend/src/main.jsx](frontend/src/main.jsx).

## Requirements

- Windows
- Python 3.14.6 (verified with the current backend requirements)
- Node.js 20 or newer
- npm
- A local `lc0` executable
- Local Maia weight files

The direct backend dependencies are listed in
[backend/requirements.txt](backend/requirements.txt):

```text
fastapi==0.163.1
uvicorn[standard]==0.54.0
python-chess==1.999
```

## Engine and Maia weight setup

The engine executable and Maia `.pb.gz` files are local-only resources. They are
ignored by Git and must be obtained and placed manually. They are not included in
the source repository.

The expected local paths are:

```text
backend/engines/lc0.exe
backend/engines/maia-1100.pb.gz
backend/engines/maia-1500.pb.gz
backend/engines/maia-1900.pb.gz
```

Use a compatible local Windows build of `lc0` and obtain the Maia weights
separately. Do not commit engine binaries, DLLs, or weight files.

## First-time setup

### Backend

From the project root:

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\backend
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

If PowerShell blocks activation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\venv\Scripts\Activate.ps1
```

### Frontend

Open a second PowerShell terminal:

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\frontend
npm install
```

## Run locally

### Terminal 1: backend

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\backend
.\venv\Scripts\Activate.ps1
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The backend runs at `http://127.0.0.1:8000`. FastAPI's local documentation is
available at `http://127.0.0.1:8000/docs`.

### Terminal 2: frontend

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\frontend
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`.

The frontend defaults to `http://127.0.0.1:8000` for the backend. To override it,
create a local environment file such as `frontend/.env.local`:

```text
VITE_API_URL=http://127.0.0.1:8000
```

Environment files are ignored by Git.

## How a move works

1. The player selects White, Black, or Random and starts a game.
2. The player makes a move on the React chessboard.
3. `chess.js` validates the move.
4. The frontend sends the resulting FEN and selected Elo to FastAPI.
5. FastAPI validates the FEN and selects the requested local Maia weights.
6. `lc0` searches one node and returns a UCI move such as `e7e5`.
7. The frontend validates and applies Maia's move.
8. The board, status, and move history update.

## Persistence and recovery

Active games are saved in browser `localStorage` as a versioned object containing:

```text
schemaVersion
pgn
elo
selectedColorPref
playerColor
gamePhase
savedAt
```

Transient request state, timers, abort controllers, and thinking state are not
stored. When a saved game is restored during Maia's turn, the app waits for an
explicit **Resume Maia Move** action to avoid duplicate requests.

## Validation commands

Frontend, from `frontend/`:

```powershell
npm run lint
npm run build
```

Backend, from the project root:

```powershell
python -m py_compile backend\main.py
```

## Troubleshooting

### Backend does not start

Confirm that the virtual environment is activated and that all required local
engine files exist:

```text
backend/engines/lc0.exe
backend/engines/maia-1100.pb.gz
backend/engines/maia-1500.pb.gz
backend/engines/maia-1900.pb.gz
```

### The frontend shows an old interface

Confirm [frontend/src/main.jsx](frontend/src/main.jsx) imports:

```js
import App from './App.jsx'
```

Stop and restart Vite, then refresh with `Ctrl+F5`.

### Maia does not respond

Check that:

1. The backend terminal is still running.
2. The backend is listening on `http://127.0.0.1:8000`.
3. `lc0.exe` and all Maia weights exist in `backend/engines/`.
4. The browser console has no CORS or network error.

### Port already in use

Start the backend on another port:

```powershell
uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

Then update `VITE_API_URL` before starting the frontend.

## Current limitations: Phase 2.1 snapshot

- A dedicated Clear Saved Game button is pending Step 2.1.3. New Game currently
  performs the reset and storage-clearing behavior.
- Storage serialization, validation, loading, and clearing still live in
  `frontend/src/App.jsx`; extraction is planned for Step 2.1.4.
- Vitest, React Testing Library, and pytest test suites are not yet installed.
- Backend `/health` and `/ready` endpoints are not yet implemented.
- Startup resource validation, bounded engine watchdogs, and crash recovery are
  planned for Phase 2.2.
- A one-command offline launcher is planned for Phase 2.4.
- PGN import/export, clocks, sound effects, move analytics, and the Humanity
  Profiler are Phase 3 features.
- The backend currently returns Maia's selected move, not a verified full policy
  probability distribution.

All future features must preserve the local-only architecture and must not add
Stockfish or external runtime services.