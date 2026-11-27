# Current version: Adds structured logging, fail-fast engine startup, safe
# shutdown/reset, thread-safe engine operations, game-over checks, and safe
# client-facing errors on top of version 1.01.

import os
import logging
import threading
from dataclasses import dataclass
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
ENGINES_DIR = os.path.join(BASE_DIR, "engines")
ENGINE_PATH = os.path.join(ENGINES_DIR, "lc0.exe")
EloRating = Literal[1100, 1500, 1900]
SUPPORTED_ELOS: tuple[EloRating, ...] = (1100, 1500, 1900)
ENGINE_MOVE_NODES = 1
ENGINE_MOVE_TIMEOUT_SEC = 5.0

# 2. Add threading Lock to global state
engine_state = {
    "process": None, 
    "current_elo": None,
    "lock": threading.Lock()
}


@dataclass(frozen=True)
class EngineResourceDiagnostics:
    engine_path_exists: bool
    available_elos: list[EloRating]
    missing_weights: list[str]
    missing_weight_paths: list[str]
    detail: str


def get_weight_path(elo: EloRating) -> str:
    return os.path.join(ENGINES_DIR, f"maia-{elo}.pb.gz")


def inspect_engine_resources(engine_initialized: bool) -> EngineResourceDiagnostics:
    engine_path_exists = os.path.isfile(ENGINE_PATH)
    available_elos: list[EloRating] = []
    missing_weights: list[str] = []
    missing_weight_paths: list[str] = []

    for elo in SUPPORTED_ELOS:
        weight_path = get_weight_path(elo)
        if os.path.isfile(weight_path):
            available_elos.append(elo)
        else:
            missing_weights.append(os.path.basename(weight_path))
            missing_weight_paths.append(weight_path)

    if not engine_path_exists:
        detail = (
            f"Engine executable missing at {ENGINE_PATH}. "
            f"Place lc0.exe in {ENGINES_DIR}."
        )
    elif not engine_initialized:
        detail = "Chess engine process is not initialized."
    elif missing_weights:
        detail = (
            f"Missing Maia weight files in {ENGINES_DIR}: "
            f"{', '.join(missing_weights)}."
        )
    else:
        detail = "Engine and all Maia weights are ready."

    return EngineResourceDiagnostics(
        engine_path_exists=engine_path_exists,
        available_elos=available_elos,
        missing_weights=missing_weights,
        missing_weight_paths=missing_weight_paths,
        detail=detail,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine_state["process"] = None
    engine_state["current_elo"] = None

    diagnostics = inspect_engine_resources(engine_initialized=False)
    if not diagnostics.engine_path_exists:
        logger.error(diagnostics.detail)
        raise RuntimeError(diagnostics.detail)

    if not diagnostics.available_elos:
        missing_list = ", ".join(diagnostics.missing_weight_paths)
        message = (
            "Critical failure: No Maia weight files found on startup. "
            f"Expected at least one weight file in {ENGINES_DIR}. Missing: {missing_list}"
        )
        logger.error(message)
        raise RuntimeError(message)

    if diagnostics.missing_weights:
        logger.warning(
            "Partial Maia weight setup detected. Missing weight files: %s",
            ", ".join(diagnostics.missing_weight_paths),
        )

    logger.info(
        "Booting lc0 engine process from %s (available Elos: %s)...",
        ENGINE_PATH,
        diagnostics.available_elos,
    )
    try:
        engine_state["process"] = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    except Exception as e:
        logger.exception("Failed to start lc0 engine process at %s", ENGINE_PATH)
        raise RuntimeError(
            f"Critical failure: Could not start chess engine at {ENGINE_PATH}."
        ) from e
        
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
    diagnostics = inspect_engine_resources(engine_initialized=engine_initialized)
    is_ready = (
        engine_initialized
        and diagnostics.engine_path_exists
        and not diagnostics.missing_weights
    )

    payload = ReadyResponse(
        ready=is_ready,
        status="ready" if is_ready else "not_ready",
        engine_initialized=engine_initialized,
        engine_path_exists=diagnostics.engine_path_exists,
        current_elo=engine_state["current_elo"],
        available_elos=diagnostics.available_elos,
        missing_weights=diagnostics.missing_weights,
        detail=diagnostics.detail,
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
        504: {
            "model": ErrorResponse,
            "description": "Engine timed out during move calculation.",
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
        
    weight_file = get_weight_path(request.elo)
    if not os.path.isfile(weight_file):
        logger.error("Requested Elo %s weight file missing at %s", request.elo, weight_file)
        raise HTTPException(status_code=500, detail="Requested Elo weight file is missing on the server.")

    # 5. Fast guard for an uninitialized engine
    engine = engine_state["process"]
    if engine is None:
        logger.error("Engine process is None during request.")
        raise HTTPException(status_code=503, detail="Chess engine is currently unavailable.")

    # 6. Thread-safe bounded engine operations
    with engine_state["lock"]:
        engine = engine_state["process"]
        if engine is None:
            logger.error("Engine process became None while waiting for lock.")
            raise HTTPException(status_code=503, detail="Chess engine is currently unavailable.")

        try:
            if engine_state["current_elo"] != request.elo:
                logger.info("Swapping engine weights to Elo %s...", request.elo)
                try:
                    engine.configure({"WeightsFile": weight_file})
                except Exception:
                    engine_state["current_elo"] = None
                    raise
                engine_state["current_elo"] = request.elo

            search_limit = chess.engine.Limit(
                nodes=ENGINE_MOVE_NODES,
                time=ENGINE_MOVE_TIMEOUT_SEC,
            )
            result = engine.play(board, search_limit)
            
            if result.move is None:
                raise HTTPException(status_code=500, detail="Engine failed to return a move.")
            
            return MoveResponse(
                best_move=result.move.uci(),
                elo_used=request.elo,
            )
            
        except HTTPException:
            raise
        except TimeoutError:
            logger.exception("Engine timed out after %.1f seconds", ENGINE_MOVE_TIMEOUT_SEC)
            raise HTTPException(
                status_code=504,
                detail="Engine timed out during move calculation.",
            )
        except chess.engine.EngineTerminatedError:
            logger.exception("Chess engine process terminated during move calculation.")
            engine_state["process"] = None
            engine_state["current_elo"] = None
            raise HTTPException(
                status_code=503,
                detail="Chess engine is currently unavailable.",
            )
        except Exception:
            logger.exception("Engine processing error")
            raise HTTPException(
                status_code=500,
                detail="Internal engine error during move calculation."
            )