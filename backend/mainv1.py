# Version 1: Initial FastAPI endpoint with FEN validation, Elo selection,
# local lc0/ Maia weight loading, and one-node move generation.

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import chess
import chess.engine
import os

app = FastAPI(title="Maia Chess Centaur API")

# Enable CORS so our React frontend can talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this to your React app's URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define absolute paths so the script doesn't get lost
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.join(BASE_DIR, "engines", "lc0.exe")

# Define the data structure the frontend will send us
class MoveRequest(BaseModel):
    fen: str
    elo: int = 1100

@app.post("/get-move")
def get_move(request: MoveRequest):
    try:
        board = chess.Board(request.fen)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid FEN string")
        
    # Verify the requested Elo is one we downloaded
    if request.elo not in [1100, 1500, 1900]:
        raise HTTPException(status_code=400, detail="Elo must be 1100, 1500, or 1900")
        
    weight_file = os.path.join(BASE_DIR, "engines", f"maia-{request.elo}.pb.gz")
    
    if not os.path.exists(weight_file):
        raise HTTPException(status_code=500, detail=f"Weight file missing: maia-{request.elo}.pb.gz")

    try:
        # Boot up the lc0 engine
        engine = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
        
        # Inject the specific Maia weights dynamically based on the requested Elo
        engine.configure({"WeightsFile": weight_file})
        
        # CRITICAL MAIA LOGIC: 
        # We limit the engine to exactly 1 node (nodes=1). 
        # If it searches deeper, it becomes a traditional calculating computer. 
        # At 1 node, it outputs its pure, immediate human intuition.
        result = engine.play(board, chess.engine.Limit(nodes=1))
        
        engine.quit()
        
        return {
            "best_move": result.move.uci(),
            "elo_used": request.elo
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine error: {str(e)}")