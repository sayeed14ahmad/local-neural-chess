# Maia Chess Centaur

A local, offline full-stack chess application that lets you play against the Maia Chess neural network.

The application uses:

- React and Vite for the frontend.
- `react-chessboard` for the board UI.
- `chess.js` for frontend move validation.
- FastAPI for the backend API.
- `python-chess` for backend chess and UCI communication.
- A local Leela Chess Zero (`lc0`) executable.
- Local Maia neural-network weights.

No Stockfish or external chess APIs are used.

## Project structure

```text
maia-chess-app/
├── backend/
│   ├── engines/
│   │   ├── lc0.exe
│   │   ├── maia-1100.pb.gz
│   │   ├── maia-1500.pb.gz
│   │   └── maia-1900.pb.gz
│   ├── main.py
│   ├── requirements.txt
│   └── venv/
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── package.json
│   └── package-lock.json
└── README.md
```

The files ending in `v1`, `v101`, or `v2` are historical versions and are not used by the active application.

## Requirements

Install these before running the project:

- Windows
- Python 3.11 or newer
- Node.js 20 or newer
- npm
- A local `lc0.exe` executable
- Maia weight files

The application itself is offline at runtime. The backend and frontend communicate only through `localhost`.

## Required engine files

The following files must exist:

```text
backend/engines/lc0.exe
backend/engines/maia-1100.pb.gz
backend/engines/maia-1500.pb.gz
backend/engines/maia-1900.pb.gz
```

The backend will stop during startup if `lc0.exe` is missing.

## First-time backend setup

Open PowerShell in the project directory:

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\backend
```

Create a virtual environment if one does not already exist:

```powershell
python -m venv venv
```

Activate it:

```powershell
.\venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\venv\Scripts\Activate.ps1
```

Install backend dependencies:

```powershell
python -m pip install -r requirements.txt
```

## Start the backend

With the virtual environment activated:

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\backend
.\venv\Scripts\Activate.ps1
uvicorn main:app --reload
```

The backend runs at:

```text
http://127.0.0.1:8000
```

FastAPI's local API documentation is available at:

```text
http://127.0.0.1:8000/docs
```

Keep this terminal open while playing.

## First-time frontend setup

Open a second PowerShell terminal:

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\frontend
npm install
```

`package-lock.json` records the frontend dependency versions.

## Start the frontend

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\frontend
npm run dev
```

Open the URL printed by Vite, normally:

```text
http://localhost:5173
```

The frontend expects the backend at:

```text
http://127.0.0.1:8000
```

## Normal startup

Every time you want to run the application:

### Terminal 1: backend

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\backend
.\venv\Scripts\Activate.ps1
uvicorn main:app --reload
```

### Terminal 2: frontend

```powershell
cd C:\Spartan\vs_code\Projects\maia-chess-app\frontend
npm run dev
```

Then open:

```text
http://localhost:5173
```

## How the application works

1. The user selects White, Black, or Random and starts a game.
2. The user drags their piece on the React chessboard.
3. `chess.js` validates the move.
4. The frontend creates the new FEN.
5. The frontend sends the FEN and selected Maia Elo to FastAPI.
6. FastAPI validates the FEN.
7. FastAPI loads the requested local Maia weights into `lc0`.
8. `lc0` searches one node.
9. The backend returns a UCI move such as `e7e5`.
10. The frontend validates and applies Maia's move.
11. The move history and board update.

When the user selects Black, Maia makes the opening move automatically. The board
orientation follows the player's color, and Undo removes the appropriate player
and Maia moves together.

## Supported Maia profiles

The current Elo selector supports:

```text
1100
1500
1900
```

The corresponding files must exist in `backend/engines/`.

## Frontend validation commands

Run these from the `frontend` directory:

```powershell
npm run lint
npm run build
```

## Backend validation

Run this from the project root:

```powershell
python -m py_compile backend\main.py
```

## Troubleshooting

### Backend cannot start

Check that these files exist:

```text
backend/engines/lc0.exe
backend/engines/maia-1100.pb.gz
backend/engines/maia-1500.pb.gz
backend/engines/maia-1900.pb.gz
```

Also confirm that the virtual environment is activated.

### Frontend shows an old interface

Check [frontend/src/main.jsx](frontend/src/main.jsx). It must import:

```js
import App from './App.jsx'
```

Then stop and restart Vite:

```powershell
Ctrl+C
npm run dev
```

Refresh the browser with `Ctrl+F5`.

### Board moves but Maia does not respond

Check:

1. The backend terminal is still running.
2. The backend is listening on `http://127.0.0.1:8000`.
3. `lc0.exe` and the Maia weight files exist.
4. The browser console does not show a CORS or network error.

### Port already in use

Backend:

```powershell
uvicorn main:app --reload --port 8001
```

If the backend port changes, update the frontend API URL before starting Vite.

## Current limitations

- Games are not yet saved across browser refreshes.
- Tailwind CSS has not been added.
- The Humanity Profiler has not been implemented.
- The live evaluation bar has not been implemented.
- The current backend returns Maia's selected move, not the full probability distribution.

## Planned future work

Future phases may add:

- Offline game persistence.
- Tailwind-based styling.
- Dark mode.
- More advanced game history controls.
- Humanity Profiler analytics.
- Maia probability distributions.
- Evaluation visualization.
- Additional game configuration options.

These features should preserve the local-only architecture.