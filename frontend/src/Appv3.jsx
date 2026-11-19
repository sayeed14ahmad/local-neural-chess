import { useState, useRef, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

const PROMOTION_PIECES = ["q", "r", "b", "n"];

function assignPlayerColor(colorPreference) {
  if (colorPreference !== "random") return colorPreference;
  return Math.random() > 0.5 ? "white" : "black";
}

export default function App() {
  const [game, setGame] = useState(new Chess());
  const [elo, setElo] = useState(1100);
  const [isThinking, setIsThinking] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [gamePhase, setGamePhase] = useState("setup");
  const [selectedColorPref, setSelectedColorPref] = useState("white");
  const [playerColor, setPlayerColor] = useState("white");
  
  const abortControllerRef = useRef(null);
  const moveTimeoutRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  function cloneGame(currentGame) {
    const clone = new Chess();
    clone.loadPgn(currentGame.pgn());
    return clone;
  }

  function getStatus() {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return { text: `Checkmate! ${winner} wins.`, type: "error" };
    }
    if (game.isDraw()) return { text: "Draw! Game Over.", type: "error" };
    if (isThinking) return { text: "Maia is preparing a move...", type: "info" };
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

    setGame(new Chess());
    setGamePhase("setup");
    setPlayerColor("white");
    setIsThinking(false);
    setPendingPromotion(null);
    setErrorMessage(null);
  }

  function retryMaiaMove() {
    requestIdRef.current += 1;
    setErrorMessage(null);
    setIsThinking(true);
    moveTimeoutRef.current = setTimeout(() => {
      moveTimeoutRef.current = null;
      fetchMaiaMove(game);
    }, 250);
  }

  async function fetchMaiaMove(currentGameState) {
    setIsThinking(true);
    setErrorMessage(null);
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
    const playerTurnCode = playerColor === "white" ? "w" : "b";

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

    const nextGame = cloneGame(game);
    if (nextGame.history().length === 0) return;

    const playerTurnCode = playerColor === "white" ? "w" : "b";
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
  let statusBg = "#e3f2fd"; 
  let statusColor = "#1565c0";
  if (status.type === "error") {
    statusBg = "#ffebee";
    statusColor = "#c62828";
  } else if (status.type === "warning") {
    statusBg = "#fff3e0";
    statusColor = "#e65100";
  }

  const movePairs = getMovePairs(game.history());
  const isSetup = gamePhase === "setup";
  const displayOrientation = isSetup
    ? (selectedColorPref === "random" ? "white" : selectedColorPref)
    : playerColor;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: "40px", fontFamily: "sans-serif", padding: "0 15px" }}>
      <h1>Maia Chess Centaur</h1>
      
      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <div style={{ padding: "10px", backgroundColor: "#f0f0f0", borderRadius: "6px", display: "flex", gap: "15px", alignItems: "center" }}>
          <div>
            <label style={{ marginRight: "10px", fontWeight: "bold" }}>Opponent Skill: </label>
            <select value={elo} onChange={(e) => setElo(e.target.value)} disabled={!isSetup}>
              <option value={1100}>1100 (Beginner)</option>
              <option value={1500}>1500 (Intermediate)</option>
              <option value={1900}>1900 (Advanced)</option>
            </select>
          </div>
          <div>
            <label style={{ marginRight: "10px", fontWeight: "bold" }}>Play as: </label>
            <select value={selectedColorPref} onChange={(e) => setSelectedColorPref(e.target.value)} disabled={!isSetup}>
              <option value="white">White</option>
              <option value="black">Black</option>
              <option value="random">Random</option>
            </select>
          </div>
        </div>
        
        {isSetup ? (
          <button onClick={startGame} style={{ padding: "8px 16px", cursor: "pointer", backgroundColor: "#4CAF50", color: "white", border: "none", borderRadius: "4px", fontWeight: "bold" }}>
            Start Game
          </button>
        ) : (
          <>
            <button
              onClick={undoMove}
              style={{ padding: "6px 12px", cursor: "pointer" }}
              disabled={game.history().length === 0 || pendingPromotion !== null}
            >
              {isThinking ? "⮌ Cancel & Undo" : "⮌ Undo Move"}
            </button>
            <button onClick={newGame} style={{ padding: "6px 12px", cursor: "pointer" }}>
              New Game
            </button>
          </>
        )}
      </div>

      {errorMessage && (
        <div style={{ marginBottom: "15px", padding: "10px 20px", borderRadius: "4px", backgroundColor: "#ffebee", color: "#c62828", fontWeight: "bold", width: "100%", maxWidth: "500px", textAlign: "center", border: "1px solid #ef9a9a" }}>
          {errorMessage}
          {!isThinking && !game.isGameOver() && game.turn() !== (playerColor === "white" ? "w" : "b") && (
            <button onClick={retryMaiaMove} style={{ display: "block", margin: "10px auto 0", padding: "6px 12px", cursor: "pointer" }}>
              Retry Maia Move
            </button>
          )}
        </div>
      )}

      {!isSetup && (
        <div style={{ marginBottom: "15px", padding: "10px 20px", borderRadius: "4px", backgroundColor: statusBg, color: statusColor, fontWeight: "bold", fontSize: "16px", minWidth: "250px", textAlign: "center", boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}>
          {status.text}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: "20px", maxWidth: "100%", alignItems: "flex-start" }}>
        
        <div style={{ position: "relative", width: "100%", maxWidth: "500px", flexShrink: 0, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", borderRadius: "4px", opacity: isSetup ? 0.6 : 1, pointerEvents: isSetup ? "none" : "auto" }}>
          
          {pendingPromotion && (
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(255,255,255,0.85)", zIndex: 10, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", borderRadius: "4px" }}>
              <h3 style={{ marginBottom: "20px" }}>Choose Promotion:</h3>
              <div style={{ display: "flex", gap: "10px" }}>
                {PROMOTION_PIECES.map((p) => (
                  <button 
                    key={p}
                    onClick={() => {
                      executePlayerMove(pendingPromotion.source, pendingPromotion.target, p);
                      setPendingPromotion(null);
                    }}
                    style={{ padding: "10px 20px", fontSize: "18px", cursor: "pointer", textTransform: "uppercase" }}
                  >
                    {p === "q" ? "♕" : p === "r" ? "♖" : p === "b" ? "♗" : "♘"}
                  </button>
                ))}
              </div>
              <button onClick={() => setPendingPromotion(null)} style={{ marginTop: "20px", padding: "5px 10px", cursor: "pointer" }}>Cancel</button>
            </div>
          )}

          <Chessboard 
            options={{
              position: game.fen(),
              onPieceDrop: onDrop,
              boardOrientation: displayOrientation,
              boardStyle: { borderRadius: "4px" },
              animationDurationInMs: 300,
              squareStyles: getHighlightStyles(),
            }}
          />
        </div>

        <div style={{ width: "100%", maxWidth: "250px", height: "500px", backgroundColor: "#f9f9f9", border: "1px solid #ddd", borderRadius: "4px", display: "flex", flexDirection: "column", opacity: isSetup ? 0.6 : 1 }}>
          <h3 style={{ margin: 0, padding: "12px", textAlign: "center", borderBottom: "1px solid #ddd", backgroundColor: "#eee", fontSize: "16px" }}>
            Move History
          </h3>
          
          <div style={{ overflowY: "auto", flexGrow: 1, padding: "10px" }}>
            {movePairs.map((pair) => (
              <div key={pair.turn} style={{ display: "flex", padding: "4px 0", borderBottom: "1px solid #eee", fontSize: "14px" }}>
                <span style={{ width: "40px", color: "#888" }}>{pair.turn}.</span>
                <span style={{ width: "90px", fontWeight: "bold", color: "#333" }}>{pair.white}</span>
                <span style={{ width: "90px", color: "#555" }}>
                  {pair.black ? pair.black : (isThinking ? <span style={{ fontStyle: "italic", color: "#888" }}>...</span> : "")}
                </span>
              </div>
            ))}
            {movePairs.length === 0 && (
              <div style={{ color: "#aaa", textAlign: "center", marginTop: "20px", fontStyle: "italic" }}>
                {isSetup ? "Choose your color and start the game" : "Make a move to start"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}