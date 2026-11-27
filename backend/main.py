# Current version: Adds structured logging, fail-fast engine startup, safe
# shutdown/reset, thread-safe engine operations, game-over checks, and safe
# client-facing errors on top of version 1.01.

import os
import logging
import threading
from typing import Literal
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import chess
import chess.engine

# 1. Setup standard logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.join(BASE_DIR, "engines", "lc0.exe")
EloRating = Literal[1100, 1500, 1900]
SUPPORTED_ELOS: tuple[EloRating, ...] = (1100, 1500, 1900)

# 2. Add threading Lock to global state
engine_state = {
    "process": None, 
    "current_elo": None,
    "lock": threading.Lock()
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.path.exists(ENGINE_PATH):
        raise RuntimeError(f"Engine executable missing. Check path: {ENGINE_PATH}")
    
    engine_state["process"] = None
    engine_state["current_elo"] = None
    logger.info("Booting lc0 engine process...")
    try:
        engine_state["process"] = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    except Exception as e:
        logger.exception("Failed to start engine")
        raise RuntimeError("Critical failure: Could not start chess engine.") from e
        
    yield 
    
    # 3. Safe Shutdown Tolerance
    if engine_state["process"]:
        logger.info("Shutting down lc0 engine cleanly...")
        try:
            engine_state["process"].quit()
        except Exception:
            logger.warning("Ignored engine cleanup error", exc_info=True)
        finally:
            engine_state["process"] = None
            engine_state["current_elo"] = None

app = FastAPI(title="Maia Chess Centaur API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class MoveRequest(BaseModel):
    fen: str
    elo: Literal[1100, 1500, 1900] = 1100


class MoveResponse(BaseModel):
    best_move: str
    elo_used: Literal[1100, 1500, 1900]


class ErrorResponse(BaseModel):
    detail: str
    code: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "Maia Chess Centaur API"


class ReadyResponse(BaseModel):
    ready: bool
    status: Literal["ready", "not_ready"]
    engine_initialized: bool
    engine_path_exists: bool
    current_elo: EloRating | None
    available_elos: list[EloRating]
    missing_weights: list[str]
    detail: str


@app.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    return HealthResponse()


@app.get(
    "/ready",
    response_model=ReadyResponse,
    responses={
        200: {
            "model": ReadyResponse,
            "description": "Engine and all Maia weights are ready.",
        },
        503: {
            "model": ReadyResponse,
            "description": "Engine or required Maia weights are not ready.",
        },
    },
)
def readiness_check() -> ReadyResponse | JSONResponse:
    engine_initialized = engine_state["process"] is not None
    engine_path_exists = os.path.exists(ENGINE_PATH)

    available_elos: list[EloRating] = []
    missing_weights: list[str] = []
    for elo in SUPPORTED_ELOS:
        weight_path = os.path.join(BASE_DIR, "engines", f"maia-{elo}.pb.gz")
        if os.path.exists(weight_path):
            available_elos.append(elo)
        else:
            missing_weights.append(os.path.basename(weight_path))

    is_ready = engine_initialized and engine_path_exists and not missing_weights

    if is_ready:
        detail = "Engine and all Maia weights are ready."
    elif not engine_path_exists:
        detail = f"Engine executable missing at {ENGINE_PATH}."
    elif not engine_initialized:
        detail = "Chess engine process is not initialized."
    else:
        detail = f"Missing Maia weight files: {', '.join(missing_weights)}."

    payload = ReadyResponse(
        ready=is_ready,
        status="ready" if is_ready else "not_ready",
        engine_initialized=engine_initialized,
        engine_path_exists=engine_path_exists,
        current_elo=engine_state["current_elo"],
        available_elos=available_elos,
        missing_weights=missing_weights,
        detail=detail,
    )

    if not is_ready:
        return JSONResponse(status_code=503, content=payload.model_dump())

    return payload


@app.post(
    "/get-move",
    response_model=MoveResponse,
    responses={
        400: {
            "model": ErrorResponse,
            "description": "Invalid FEN or game already over.",
        },
        500: {
            "model": ErrorResponse,
            "description": "Missing weight file or engine failure.",
        },
        503: {
            "model": ErrorResponse,
            "description": "Chess engine unavailable.",
        },
    },
)
def get_move(request: MoveRequest) -> MoveResponse:
    # 4. Handle Finished Games Before Execution
    try:
        board = chess.Board(request.fen)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid FEN string provided.")
        
    if board.is_game_over():
        raise HTTPException(status_code=400, detail="Game is over; no legal moves available.")
        
    weight_file = os.path.join(BASE_DIR, "engines", f"maia-{request.elo}.pb.gz")
    if not os.path.exists(weight_file):
        raise HTTPException(status_code=500, detail="Requested Elo weight file is missing on the server.")

    # 5. Guard for Uninitialized Engine
    engine = engine_state["process"]
    if engine is None:
        logger.error("Engine process is None during request.")
        raise HTTPException(status_code=503, detail="Chess engine is currently unavailable.")

    # 6. Thread-Safe Engine Operations
    with engine_state["lock"]:
        try:
            if engine_state["current_elo"] != request.elo:
                logger.info(f"Swapping engine weights to Elo {request.elo}...")
                engine.configure({"WeightsFile": weight_file})
                engine_state["current_elo"] = request.elo
            
            result = engine.play(board, chess.engine.Limit(nodes=1))
            
            if result.move is None:
                raise HTTPException(status_code=500, detail="Engine failed to return a move.")
            
            return MoveResponse(
                best_move=result.move.uci(),
                elo_used=request.elo,
            )
            
        except HTTPException:
            # Re-raise explicit HTTP exceptions (like the move=None check above)
            raise
        except Exception:
            # Use logger.exception to automatically capture the full stack trace
            logger.exception("Engine processing error")
            raise HTTPException(
                status_code=500,
                detail="Internal engine error during move calculation."
            )