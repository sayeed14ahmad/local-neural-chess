import { useState, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

export default function App() {
  const [game, setGame] = useState(new Chess());
  const [elo, setElo] = useState(1100);
  const [isThinking, setIsThinking] = useState(false);
  
  // Refs to prevent async race conditions
  const abortControllerRef = useRef(null);
  const moveTimeoutRef = useRef(null);
  const requestIdRef = useRef(0);

  async function fetchMaiaMove(currentFen) {
    setIsThinking(true);
    const requestId = ++requestIdRef.current;
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    const currentController = new AbortController();
    abortControllerRef.current = currentController;

    try {
      const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
      
      const response = await fetch(`${apiUrl}/get-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen: currentFen, elo: Number(elo) }),
        signal: currentController.signal,
      });

      if (!response.ok) throw new Error("Engine network error");

      const data = await response.json();
      
      const validationGame = new Chess(currentFen);
      try {
        validationGame.move(data.best_move);
      } catch {
        throw new Error(`Backend returned an invalid chess move: ${data.best_move}`);
      }

      if (requestId !== requestIdRef.current) return;

      setGame((currentGame) => {
        const nextGame = new Chess(currentGame.fen());
        nextGame.move(data.best_move);
        return nextGame;
      });
      
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Maia calculation aborted.");
      } else {
        console.error("Error fetching move:", error);
        alert("Maia engine failed to respond. Check the FastAPI terminal.");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsThinking(false);
      }
    }
  }

  // Updated to v5 signature: destructured object
  function onDrop({ sourceSquare, targetSquare }) {
    if (
      !targetSquare ||
      isThinking ||
      game.isGameOver() ||
      game.turn() !== "w"
    ) {
      return false;
    }

    const nextGame = new Chess(game.fen());
    try {
      nextGame.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });
    } catch {
      return false;
    }

    setGame(nextGame);
    
    moveTimeoutRef.current = setTimeout(() => {
      moveTimeoutRef.current = null;
      fetchMaiaMove(nextGame.fen());
    }, 250);

    return true;
  }

  function resetBoard() {
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
    setIsThinking(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: "40px", fontFamily: "sans-serif" }}>
      <h1>Maia Chess Centaur</h1>
      
      <div style={{ marginBottom: "20px" }}>
        <label style={{ marginRight: "10px", fontWeight: "bold" }}>Opponent Skill (Elo): </label>
        <select value={elo} onChange={(e) => setElo(e.target.value)} disabled={isThinking}>
          <option value={1100}>1100 (Beginner)</option>
          <option value={1500}>1500 (Intermediate)</option>
          <option value={1900}>1900 (Advanced)</option>
        </select>
        
        <button 
          onClick={resetBoard} 
          style={{ marginLeft: "20px", padding: "6px 12px", cursor: "pointer" }}
        >
          Reset Board
        </button>
      </div>

      <div style={{ width: "500px", maxWidth: "100%", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", borderRadius: "4px" }}>
        {/* Updated to v5 options object */}
        <Chessboard 
          options={{
            position: game.fen(),
            onPieceDrop: onDrop,
            boardStyle: {
              borderRadius: "4px",
            },
            animationDurationInMs: 300,
          }}
        />
      </div>
      
      <div style={{ marginTop: "20px", height: "30px" }}>
        {isThinking && <p style={{ color: "#555", fontStyle: "italic", margin: 0 }}>Maia is thinking...</p>}
        {game.isGameOver() && <h2 style={{ color: "red", margin: 0 }}>Game Over!</h2>}
      </div>
    </div>
  );
}