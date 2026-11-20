import { useState, useRef, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  loadSavedGame,
  saveGame,
  clearSavedGameStorage,
} from "./utils/gameStorage.js";

const PROMOTION_PIECES = ["q", "r", "b", "n"];

function assignPlayerColor(colorPreference) {
  if (colorPreference !== "random") return colorPreference;
  return Math.random() > 0.5 ? "white" : "black";
}

export default function App() {
  const [initialState] = useState(() => loadSavedGame());

  const [game, setGame] = useState(initialState.game);
  const [elo, setElo] = useState(initialState.elo);
  const [isThinking, setIsThinking] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [gamePhase, setGamePhase] = useState(initialState.gamePhase);
  const [selectedColorPref, setSelectedColorPref] = useState(initialState.selectedColorPref);
  const [playerColor, setPlayerColor] = useState(initialState.playerColor);
  const [needsMaiaResume, setNeedsMaiaResume] = useState(initialState.needsMaiaResume);
  const [storageFeedback, setStorageFeedback] = useState(
    initialState.storageWarning
      ? { text: initialState.storageWarning, type: "warning" }
      : null
  );

  const abortControllerRef = useRef(null);
  const moveTimeoutRef = useRef(null);
  const requestIdRef = useRef(0);
  const moveHistoryRef = useRef(null);
  const hasMountedAutosaveRef = useRef(false);

  useEffect(() => {
    return () => {
      if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // Auto-scroll Move History to the latest move
  useEffect(() => {
    if (moveHistoryRef.current) {
      moveHistoryRef.current.scrollTop = moveHistoryRef.current.scrollHeight;
    }
  }, [game]);

  // Auto-save active games after initial state restoration.
  useEffect(() => {
    if (!hasMountedAutosaveRef.current) {
      hasMountedAutosaveRef.current = true;
      return;
    }

    if (gamePhase !== "active") return;

    const result = saveGame({
      game,
      elo,
      selectedColorPref,
      playerColor,
      gamePhase,
    });

    if (!result.ok) {
      const timerId = setTimeout(() => {
        setStorageFeedback({
          text: "Game could not be saved locally.",
          type: "warning",
        });
      }, 0);
      return () => clearTimeout(timerId);
    }
  }, [game, elo, selectedColorPref, playerColor, gamePhase]);

  function cloneGame(currentGame) {
    const clone = new Chess();
    clone.loadPgn(currentGame.pgn());
    return clone;
  }

  const playerTurnCode = playerColor === "white" ? "w" : "b";
  const isMaiaTurn = gamePhase === "active" && !game.isGameOver() && game.turn() !== playerTurnCode;

  function getStatus() {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return { text: `Checkmate! ${winner} wins.`, type: "error" };
    }
    if (game.isDraw()) return { text: "Draw! Game Over.", type: "error" };
    if (isThinking) return { text: "Maia is preparing a move...", type: "info" };
    if (needsMaiaResume && isMaiaTurn) {
      return { text: "Game restored — waiting for Maia's move.", type: "warning" };
    }
    if (game.isCheck()) return { text: "Check! Your turn.", type: "warning" };
    return { text: `Your turn (${playerColor === "white" ? "White" : "Black"})`, type: "info" };
  }

  function getHighlightStyles() {
    const history = game.history({ verbose: true });
    if (history.length === 0) return {};

    const lastMove = history[history.length - 1];
    return {
      [lastMove.from]: { backgroundColor: "rgba(255, 255, 0, 0.4)" },
      [lastMove.to]: { backgroundColor: "rgba(255, 255, 0, 0.4)" },
    };
  }

  function getMovePairs(history) {
    const pairs = [];
    for (let i = 0; i < history.length; i += 2) {
      pairs.push({
        turn: Math.floor(i / 2) + 1,
        white: history[i],
        black: history[i + 1] || null,
      });
    }
    return pairs;
  }

  function clearSavedGame() {
    const result = clearSavedGameStorage();
    setStorageFeedback(
      result.ok
        ? { text: "Saved game cleared.", type: "info" }
        : { text: "Could not clear saved game from local storage.", type: "warning" }
    );
  }

  function startGame() {
    const assignedColor = assignPlayerColor(selectedColorPref);
    const newGameState = new Chess();

    requestIdRef.current += 1;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);

    setPlayerColor(assignedColor);
    setGamePhase("active");
    setGame(newGameState);
    setErrorMessage(null);
    setPendingPromotion(null);
    setNeedsMaiaResume(false);
    setStorageFeedback(null);

    if (assignedColor === "black") {
      setIsThinking(true);
      moveTimeoutRef.current = setTimeout(() => {
        moveTimeoutRef.current = null;
        fetchMaiaMove(newGameState);
      }, 250);
    } else {
      setIsThinking(false);
    }
  }

  function newGame() {
    requestIdRef.current += 1;
    if (moveTimeoutRef.current) {
      clearTimeout(moveTimeoutRef.current);
      moveTimeoutRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const clearResult = clearSavedGameStorage();
    setGame(new Chess());
    setGamePhase("setup");
    setPlayerColor("white");
    setIsThinking(false);
    setPendingPromotion(null);
    setErrorMessage(null);
    setNeedsMaiaResume(false);
    setStorageFeedback(
      clearResult.ok
        ? null
        : { text: "Could not clear saved game from local storage.", type: "warning" }
    );
  }

  function retryMaiaMove() {
    requestIdRef.current += 1;
    setErrorMessage(null);
    setNeedsMaiaResume(false);
    setIsThinking(true);
    moveTimeoutRef.current = setTimeout(() => {
      moveTimeoutRef.current = null;
      fetchMaiaMove(game);
    }, 250);
  }

  async function fetchMaiaMove(currentGameState) {
    setIsThinking(true);
    setErrorMessage(null);
    setNeedsMaiaResume(false);
    const requestId = ++requestIdRef.current;

    if (abortControllerRef.current) abortControllerRef.current.abort();

    const currentController = new AbortController();
    abortControllerRef.current = currentController;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
      const response = await fetch(`${apiUrl}/get-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen: currentGameState.fen(), elo: Number(elo) }),
        signal: currentController.signal,
      });

      if (!response.ok) throw new Error("Engine network error");

      const data = await response.json();

      const validationGame = new Chess(currentGameState.fen());
      try {
        validationGame.move(data.best_move);
      } catch {
        throw new Error(`Backend returned an invalid chess move: ${data.best_move}`);
      }

      if (requestId !== requestIdRef.current) return;

      setGame((prevGame) => {
        const nextGame = cloneGame(prevGame);
        nextGame.move(data.best_move);
        return nextGame;
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Error fetching move:", error);
        setErrorMessage("Maia engine failed to respond. Check backend connection.");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsThinking(false);
        abortControllerRef.current = null;
      }
    }
  }

  function executePlayerMove(source, target, promotionPiece = "q") {
    setErrorMessage(null);
    setNeedsMaiaResume(false);
    const nextGame = cloneGame(game);
    try {
      nextGame.move({ from: source, to: target, promotion: promotionPiece });
    } catch {
      return false;
    }

    setGame(nextGame);
    setIsThinking(true);
    if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);
    moveTimeoutRef.current = setTimeout(() => {
      moveTimeoutRef.current = null;
      fetchMaiaMove(nextGame);
    }, 250);
    return true;
  }

  function onDrop({ sourceSquare, targetSquare }) {
    if (!targetSquare || isThinking || game.isGameOver() || game.turn() !== playerTurnCode) {
      return false;
    }

    const piece = game.get(sourceSquare);
    const promotionRank = playerColor === "white" ? "8" : "1";
    if (piece && piece.type === "p" && targetSquare[1] === promotionRank) {
      setPendingPromotion({ source: sourceSquare, target: targetSquare });
      return false;
    }

    return executePlayerMove(sourceSquare, targetSquare);
  }

  function undoMove() {
    requestIdRef.current += 1;
    if (moveTimeoutRef.current) {
      clearTimeout(moveTimeoutRef.current);
      moveTimeoutRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsThinking(false);
    setPendingPromotion(null);
    setErrorMessage(null);
    setNeedsMaiaResume(false);

    const nextGame = cloneGame(game);
    if (nextGame.history().length === 0) return;

    const movesToUndo = nextGame.turn() === playerTurnCode ? 2 : 1;
    for (let i = 0; i < movesToUndo && nextGame.history().length > 0; i += 1) {
      nextGame.undo();
    }

    setGame(nextGame);

    if (playerColor === "black" && nextGame.history().length === 0) {
      setIsThinking(true);
      moveTimeoutRef.current = setTimeout(() => {
        moveTimeoutRef.current = null;
        fetchMaiaMove(nextGame);
      }, 250);
    }
  }

  const status = getStatus();
  const statusStyles = {
    info: "bg-sky-950/70 border-sky-800/80 text-sky-200",
    warning: "bg-amber-950/70 border-amber-800/80 text-amber-200",
    error: "bg-red-950/70 border-red-800/80 text-red-200",
  };

  const movePairs = getMovePairs(game.history());
  const isSetup = gamePhase === "setup";
  const displayOrientation = isSetup
    ? (selectedColorPref === "random" ? "white" : selectedColorPref)
    : playerColor;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center px-4 py-8">
      {/* Header */}
      <header className="text-center mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-50">
          Maia Chess Centaur
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Local Neural Chess Engine
        </p>
      </header>

      {/* Control Bar */}
      <div className="w-full max-w-4xl bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 mb-5 shadow-lg flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="elo-select" className="text-sm font-medium text-slate-300">
              Opponent Skill
            </label>
            <select
              id="elo-select"
              value={elo}
              onChange={(e) => setElo(Number(e.target.value))}
              disabled={!isSetup}
              className="bg-slate-800 text-slate-100 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value={1100}>1100 (Beginner)</option>
              <option value={1500}>1500 (Intermediate)</option>
              <option value={1900}>1900 (Advanced)</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="color-select" className="text-sm font-medium text-slate-300">
              Play as
            </label>
            <select
              id="color-select"
              value={selectedColorPref}
              onChange={(e) => setSelectedColorPref(e.target.value)}
              disabled={!isSetup}
              className="bg-slate-800 text-slate-100 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="white">White</option>
              <option value="black">Black</option>
              <option value="random">Random</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isSetup ? (
            <button
              onClick={startGame}
              className="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition cursor-pointer shadow-sm"
            >
              Start Game
            </button>
          ) : (
            <>
              <button
                onClick={undoMove}
                disabled={game.history().length === 0 || pendingPromotion !== null}
                className="bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 text-sm font-medium px-3.5 py-1.5 rounded-lg transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isThinking ? "⮌ Cancel & Undo" : "⮌ Undo Move"}
              </button>
              <button
                onClick={clearSavedGame}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-sm font-medium px-3.5 py-1.5 rounded-lg transition cursor-pointer"
              >
                Clear Saved Game
              </button>
              <button
                onClick={newGame}
                className="bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 text-sm font-medium px-3.5 py-1.5 rounded-lg transition cursor-pointer"
              >
                New Game
              </button>
            </>
          )}
        </div>
      </div>

      {storageFeedback && (
        <div
          className={`w-full max-w-4xl mb-4 px-4 py-2 rounded-xl border text-center text-xs sm:text-sm font-medium shadow-sm flex items-center justify-between gap-3 ${
            storageFeedback.type === "warning"
              ? "bg-amber-950/70 border-amber-800/80 text-amber-200"
              : "bg-emerald-950/60 border-emerald-800/70 text-emerald-200"
          }`}
        >
          <span className="mx-auto">{storageFeedback.text}</span>
          <button
            onClick={() => setStorageFeedback(null)}
            aria-label="Dismiss storage message"
            className="text-current opacity-70 hover:opacity-100 text-xs px-1.5 py-0.5 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <div className="w-full max-w-4xl mb-4 px-4 py-3 rounded-xl bg-red-950/80 border border-red-800/80 text-red-200 text-sm font-medium text-center shadow-md">
          <p>{errorMessage}</p>
          {!isThinking && isMaiaTurn && (
            <button
              onClick={retryMaiaMove}
              className="mt-2.5 bg-red-800 hover:bg-red-700 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition cursor-pointer"
            >
              Retry Maia Move
            </button>
          )}
        </div>
      )}

      {/* Status Banner */}
      {!isSetup && (
        <div
          className={`w-full max-w-4xl mb-5 px-4 py-2.5 rounded-xl border text-center text-sm font-semibold shadow-sm flex flex-wrap items-center justify-center gap-3 ${statusStyles[status.type]}`}
        >
          <span>{status.text}</span>
          {!isThinking && needsMaiaResume && isMaiaTurn && !errorMessage && (
            <button
              onClick={retryMaiaMove}
              className="bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold px-3.5 py-1 rounded-lg transition cursor-pointer shadow-sm"
            >
              Resume Maia Move
            </button>
          )}
        </div>
      )}

      {/* Main Workspace: Board + Move History */}
      <main className="w-full max-w-4xl flex flex-col lg:flex-row items-center lg:items-start justify-center gap-6">
        {/* Chessboard Container */}
        <div
          className={`relative w-full max-w-[520px] shrink-0 rounded-xl overflow-hidden shadow-2xl ring-1 ring-slate-800 transition-opacity ${
            isSetup ? "opacity-60 pointer-events-none" : "opacity-100"
          }`}
        >
          {pendingPromotion && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/85 backdrop-blur-sm">
              <h3 className="text-lg font-semibold text-slate-100 mb-4">
                Choose Promotion
              </h3>
              <div className="flex gap-3">
                {PROMOTION_PIECES.map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      executePlayerMove(pendingPromotion.source, pendingPromotion.target, p);
                      setPendingPromotion(null);
                    }}
                    className="w-14 h-14 flex items-center justify-center rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-3xl text-slate-100 transition cursor-pointer shadow-md"
                  >
                    {p === "q" ? "♕" : p === "r" ? "♖" : p === "b" ? "♗" : "♘"}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setPendingPromotion(null)}
                className="mt-5 text-sm text-slate-400 hover:text-slate-200 px-3 py-1 rounded-md transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          )}

          <Chessboard
            options={{
              position: game.fen(),
              onPieceDrop: onDrop,
              boardOrientation: displayOrientation,
              boardStyle: { borderRadius: "8px" },
              animationDurationInMs: 300,
              squareStyles: getHighlightStyles(),
            }}
          />
        </div>

        {/* Move History Panel */}
        <aside
          className={`w-full max-w-[520px] lg:w-72 h-[320px] lg:h-[520px] bg-slate-900/90 border border-slate-800 rounded-xl shadow-xl flex flex-col overflow-hidden transition-opacity ${
            isSetup ? "opacity-60" : "opacity-100"
          }`}
        >
          <div className="px-4 py-3 border-b border-slate-800 bg-slate-900 text-center">
            <h2 className="text-sm font-semibold tracking-wide text-slate-200 uppercase">
              Move History
            </h2>
          </div>

          <div ref={moveHistoryRef} className="overflow-y-auto flex-1 p-3">
            {movePairs.length > 0 ? (
              <div className="divide-y divide-slate-800/60">
                {movePairs.map((pair) => (
                  <div
                    key={pair.turn}
                    className="grid grid-cols-[2.5rem_1fr_1fr] items-center py-1.5 px-2 text-sm hover:bg-slate-800/40 rounded"
                  >
                    <span className="text-slate-500 font-mono text-xs">
                      {pair.turn}.
                    </span>
                    <span className="font-semibold text-slate-100">
                      {pair.white}
                    </span>
                    <span className="text-slate-300">
                      {pair.black ? (
                        pair.black
                      ) : isThinking ? (
                        <span className="italic text-slate-500">...</span>
                      ) : (
                        ""
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-center text-sm text-slate-500 italic px-4">
                {isSetup ? "Choose your color and start the game" : "Make a move to start"}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}