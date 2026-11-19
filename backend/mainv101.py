# Version 1.01: Keeps lc0 running through the FastAPI lifespan, validates
# supported Elo values, restricts local CORS, and swaps Maia weights on demand.

import os
from typing import Literal
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import chess
import chess.engine

# Define absolute paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.join(BASE_DIR, "engines", "lc0.exe")

# Global state to keep the engine alive and track which weights are currently loaded
engine_state = {
    "process": None, 
    "current_elo": None
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- STARTUP LIFECYCLE ---
    if not os.path.exists(ENGINE_PATH):
        raise RuntimeError(f"Engine executable missing. Check path: {ENGINE_PATH}")
    
    print("Booting lc0 engine process...")
    engine_state["process"] = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    
    yield # The FastAPI server is now running and accepting requests
    
    # --- SHUTDOWN LIFECYCLE ---
    if engine_state["process"]:
        print("Shutting down lc0 engine cleanly...")
        engine_state["process"].quit()

app = FastAPI(title="Maia Chess Centaur API", lifespan=lifespan)

# Restrict CORS to standard Vite local development ports
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic Literal automatically validates that ONLY 1100, 1500, or 1900 are accepted (returns 422 otherwise)
class MoveRequest(BaseModel):
    fen: str
    elo: Literal[1100, 1500, 1900] = 1100

@app.post("/get-move")
def get_move(request: MoveRequest):
    try:
        board = chess.Board(request.fen)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid FEN string provided.")
        
    weight_file = os.path.join(BASE_DIR, "engines", f"maia-{request.elo}.pb.gz")
    if not os.path.exists(weight_file):
        raise HTTPException(status_code=500, detail="Requested Elo weight file is missing on the server.")

    engine = engine_state["process"]

    try:
        # PERFORMANCE BOOST: Only trigger a heavy disk I/O weight swap if the user actually changed the Elo
        if engine_state["current_elo"] != request.elo:
            engine.configure({"WeightsFile": weight_file})
            engine_state["current_elo"] = request.elo
        
        # Limit to 1 node to extract raw Maia intuition rather than deep calculated search
        result = engine.play(board, chess.engine.Limit(nodes=1))
        
        return {
            "best_move": result.move.uci(),
            "elo_used": request.elo
        }
        
    except Exception as e:
        # Secure error handling: Log the raw error to the terminal, but return a safe string to the web client
        print(f"Engine processing error: {e}") 
        raise HTTPException(status_code=500, detail="Internal engine error during move calculation.")