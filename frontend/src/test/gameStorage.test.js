import { describe, it, expect, vi } from "vitest";
import { Chess } from "chess.js";
import {
  STORAGE_KEY,
  SCHEMA_VERSION,
  serializeSavedGame,
  validateSavedGame,
  saveGame,
  loadSavedGame,
  clearSavedGameStorage,
} from "../utils/gameStorage.js";

function createMemoryStorage(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn((key, value) => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key) => {
      store.delete(key);
    }),
    _dump: () => Object.fromEntries(store.entries()),
  };
}

describe("gameStorage persistence helpers", () => {
  describe("validateSavedGame", () => {
    it("accepts a valid active payload", () => {
      const chess = new Chess();
      chess.move("e4");

      const payload = serializeSavedGame({
        game: chess,
        elo: 1500,
        selectedColorPref: "white",
        playerColor: "white",
        gamePhase: "active",
      });

      const result = validateSavedGame(payload);
      expect(result.valid).toBe(true);
      expect(result.state.elo).toBe(1500);
      expect(result.state.playerColor).toBe("white");
      expect(result.state.gamePhase).toBe("active");
      expect(result.state.game.history()).toEqual(["e4"]);
    });

    it("rejects invalid schema fields or unsupported Elo/colors", () => {
      expect(validateSavedGame(null)).toEqual({
        valid: false,
        reason: "invalid_schema",
      });

      expect(
        validateSavedGame({
          schemaVersion: SCHEMA_VERSION + 1,
          pgn: "",
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      ).toEqual({ valid: false, reason: "invalid_schema" });

      expect(
        validateSavedGame({
          schemaVersion: SCHEMA_VERSION,
          pgn: "",
          elo: 9999,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      ).toEqual({ valid: false, reason: "invalid_schema" });

      expect(
        validateSavedGame({
          schemaVersion: SCHEMA_VERSION,
          pgn: 123,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      ).toEqual({ valid: false, reason: "invalid_schema" });

      expect(
        validateSavedGame({
          schemaVersion: SCHEMA_VERSION,
          pgn: "",
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "purple",
          gamePhase: "active",
        })
      ).toEqual({ valid: false, reason: "invalid_schema" });

      expect(
        validateSavedGame({
          schemaVersion: SCHEMA_VERSION,
          pgn: "",
          elo: 1100,
          selectedColorPref: "purple",
          playerColor: "white",
          gamePhase: "active",
        })
      ).toEqual({ valid: false, reason: "invalid_schema" });
    });

    it("rejects corrupted PGN strings", () => {
      const result = validateSavedGame({
        schemaVersion: SCHEMA_VERSION,
        pgn: "1. e4 e5 2. Nf3 Nc6 3. Qh5?? [invalid move token #999]",
        elo: 1100,
        selectedColorPref: "white",
        playerColor: "white",
        gamePhase: "active",
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_pgn");
    });
  });

  describe("loadSavedGame recovery and turn restoration", () => {
    it("recovers from invalid JSON, clears storage, and returns warning", () => {
      const storage = createMemoryStorage({
        [STORAGE_KEY]: "{broken-json",
      });
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("setup");
      expect(restored.game.history()).toEqual([]);
      expect(restored.needsMaiaResume).toBe(false);
      expect(restored.storageWarning).toBe("Game could not be saved locally.");
      expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
      expect(storage._dump()[STORAGE_KEY]).toBeUndefined();

      consoleErrorSpy.mockRestore();
    });

    it("recovers from invalid PGN and clears storage", () => {
      const storage = createMemoryStorage({
        [STORAGE_KEY]: JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          pgn: "1. e4 e5 2. not-a-real-move",
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        }),
      });

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("setup");
      expect(restored.needsMaiaResume).toBe(false);
      expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
      expect(storage._dump()[STORAGE_KEY]).toBeUndefined();
    });

    it("restores White turn without setting needsMaiaResume", () => {
      const chess = new Chess();
      chess.move("e4");
      chess.move("e5");

      const storage = createMemoryStorage({
        [STORAGE_KEY]: JSON.stringify(
          serializeSavedGame({
            game: chess,
            elo: 1900,
            selectedColorPref: "white",
            playerColor: "white",
            gamePhase: "active",
          })
        ),
      });

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("active");
      expect(restored.playerColor).toBe("white");
      expect(restored.elo).toBe(1900);
      expect(restored.game.history()).toEqual(["e4", "e5"]);
      expect(restored.needsMaiaResume).toBe(false);
    });

    it("restores Maia turn after White moves with needsMaiaResume = true", () => {
      const chess = new Chess();
      chess.move("e4");

      const storage = createMemoryStorage({
        [STORAGE_KEY]: JSON.stringify(
          serializeSavedGame({
            game: chess,
            elo: 1100,
            selectedColorPref: "white",
            playerColor: "white",
            gamePhase: "active",
          })
        ),
      });

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("active");
      expect(restored.playerColor).toBe("white");
      expect(restored.game.history()).toEqual(["e4"]);
      expect(restored.needsMaiaResume).toBe(true);
    });

    it("restores Black opening state cleanly when Maia already played White's first move", () => {
      const chess = new Chess();
      chess.move("e4");

      const storage = createMemoryStorage({
        [STORAGE_KEY]: JSON.stringify(
          serializeSavedGame({
            game: chess,
            elo: 1500,
            selectedColorPref: "random",
            playerColor: "black",
            gamePhase: "active",
          })
        ),
      });

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("active");
      expect(restored.playerColor).toBe("black");
      expect(restored.selectedColorPref).toBe("random");
      expect(restored.game.history()).toEqual(["e4"]);
      expect(restored.needsMaiaResume).toBe(false);
    });

    it("sets needsMaiaResume = true when player is Black at move 0 before Maia's opening", () => {
      const chess = new Chess();

      const storage = createMemoryStorage({
        [STORAGE_KEY]: JSON.stringify(
          serializeSavedGame({
            game: chess,
            elo: 1100,
            selectedColorPref: "black",
            playerColor: "black",
            gamePhase: "active",
          })
        ),
      });

      const restored = loadSavedGame(storage);

      expect(restored.gamePhase).toBe("active");
      expect(restored.playerColor).toBe("black");
      expect(restored.needsMaiaResume).toBe(true);
    });

    it("does not request a Maia resume for checkmate or draw positions", () => {
      const checkmateGame = new Chess();
      checkmateGame.move("f3");
      checkmateGame.move("e5");
      checkmateGame.move("g4");
      checkmateGame.move("Qh4#");

      const drawGame = new Chess();
      drawGame.move("Nf3");
      drawGame.move("Nf6");
      drawGame.move("Ng1");
      drawGame.move("Ng8");
      drawGame.move("Nf3");
      drawGame.move("Nf6");
      drawGame.move("Ng1");
      drawGame.move("Ng8");

      const checkmateResult = validateSavedGame(
        serializeSavedGame({
          game: checkmateGame,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      );
      const drawResult = validateSavedGame(
        serializeSavedGame({
          game: drawGame,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      );

      expect(checkmateResult.valid).toBe(true);
      expect(checkmateResult.state.needsMaiaResume).toBe(false);
      expect(drawResult.valid).toBe(true);
      expect(drawResult.state.needsMaiaResume).toBe(false);
    });
  });

  describe("saveGame and clearSavedGameStorage", () => {
    it("saves and clears snapshot cleanly", () => {
      const storage = createMemoryStorage();
      const chess = new Chess();
      chess.move("d4");

      const saveResult = saveGame(
        {
          game: chess,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        },
        storage
      );

      expect(saveResult.ok).toBe(true);
      expect(storage._dump()[STORAGE_KEY]).toBeTruthy();

      const clearResult = clearSavedGameStorage(storage);
      expect(clearResult.ok).toBe(true);
      expect(storage._dump()[STORAGE_KEY]).toBeUndefined();
    });

    it("handles storage write/remove errors gracefully without throwing", () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const throwingStorage = {
        getItem: () => {
          throw new Error("Blocked");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("Blocked");
        },
      };

      const chess = new Chess();
      const saveResult = saveGame(
        {
          game: chess,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        },
        throwingStorage
      );
      const clearResult = clearSavedGameStorage(throwingStorage);

      expect(saveResult.ok).toBe(false);
      expect(clearResult.ok).toBe(false);
      consoleErrorSpy.mockRestore();
    });
  });
});
