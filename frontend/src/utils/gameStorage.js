import { Chess } from "chess.js";

export const STORAGE_KEY = "maia_chess_saved_game_v1";
export const SCHEMA_VERSION = 1;
export const VALID_ELOS = [1100, 1500, 1900];
export const VALID_COLOR_PREFS = ["white", "black", "random"];
export const VALID_PLAYER_COLORS = ["white", "black"];

export function createDefaultGameState(storageWarning = null) {
  return {
    game: new Chess(),
    elo: 1100,
    selectedColorPref: "white",
    playerColor: "white",
    gamePhase: "setup",
    needsMaiaResume: false,
    storageWarning,
  };
}

export function clearSavedGameStorage(storage = window.localStorage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    console.error("Failed to clear saved game:", error);
    return { ok: false, error };
  }
}

export function serializeSavedGame({
  game,
  elo,
  selectedColorPref,
  playerColor,
  gamePhase,
  savedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    pgn: typeof game === "string" ? game : game.pgn(),
    elo: Number(elo),
    selectedColorPref,
    playerColor,
    gamePhase,
    savedAt,
  };
}

export function validateSavedGame(parsed) {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    parsed.gamePhase !== "active" ||
    !VALID_ELOS.includes(Number(parsed.elo)) ||
    !VALID_COLOR_PREFS.includes(parsed.selectedColorPref) ||
    !VALID_PLAYER_COLORS.includes(parsed.playerColor) ||
    typeof parsed.pgn !== "string"
  ) {
    return { valid: false, reason: "invalid_schema" };
  }

  try {
    const restoredGame = new Chess();
    if (parsed.pgn.trim().length > 0) {
      restoredGame.loadPgn(parsed.pgn);
    }

    const playerTurnCode = parsed.playerColor === "white" ? "w" : "b";
    const needsMaiaResume =
      !restoredGame.isGameOver() && restoredGame.turn() !== playerTurnCode;

    return {
      valid: true,
      state: {
        game: restoredGame,
        elo: Number(parsed.elo),
        selectedColorPref: parsed.selectedColorPref,
        playerColor: parsed.playerColor,
        gamePhase: "active",
        needsMaiaResume,
        storageWarning: null,
      },
    };
  } catch (error) {
    return { valid: false, reason: "invalid_pgn", error };
  }
}

export function saveGame(gameState, storage = window.localStorage) {
  try {
    const payload = serializeSavedGame(gameState);
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, payload };
  } catch (error) {
    console.error("Failed to save game to localStorage:", error);
    return { ok: false, error };
  }
}

export function loadSavedGame(storage = window.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultGameState();

    const parsed = JSON.parse(raw);
    const validation = validateSavedGame(parsed);

    if (!validation.valid) {
      const clearResult = clearSavedGameStorage(storage);
      return createDefaultGameState(
        clearResult.ok ? null : "Game could not be saved locally."
      );
    }

    return validation.state;
  } catch (error) {
    console.error("Failed to restore saved game:", error);
    const clearResult = clearSavedGameStorage(storage);
    return createDefaultGameState(
      clearResult.ok
        ? "Game could not be saved locally."
        : "Game could not be saved locally."
    );
  }
}
