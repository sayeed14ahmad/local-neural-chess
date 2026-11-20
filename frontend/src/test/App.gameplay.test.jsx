import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Chess } from "chess.js";
import App from "../App.jsx";
import { STORAGE_KEY, serializeSavedGame } from "../utils/gameStorage.js";

let latestBoardOptions = null;

vi.mock("react-chessboard", () => ({
  Chessboard: ({ options }) => {
    latestBoardOptions = options;
    return (
      <div
        data-testid="mock-chessboard"
        data-position={options.position}
        data-orientation={options.boardOrientation}
      />
    );
  },
}));

function triggerDrop(sourceSquare, targetSquare) {
  let accepted = false;
  act(() => {
    accepted = latestBoardOptions.onPieceDrop({ sourceSquare, targetSquare });
  });
  return accepted;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("App gameplay regression tests", () => {
  beforeEach(() => {
    localStorage.clear();
    latestBoardOptions = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels in-flight Maia request and reverts board when Undo is clicked while Maia is thinking", async () => {
    const deferred = createDeferred();
    let capturedSignal = null;

    const fetchMock = vi.fn((_url, init) => {
      capturedSignal = init.signal;
      return deferred.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Start Game" }));
    expect(screen.getByText("Your turn (White)")).toBeInTheDocument();

    const moveAccepted = triggerDrop("e2", "e4");
    expect(moveAccepted).toBe(true);
    expect(screen.getByText("Maia is preparing a move...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal.aborted).toBe(false);

    const undoBtn = screen.getByRole("button", { name: /Cancel & Undo/i });
    fireEvent.click(undoBtn);

    expect(capturedSignal.aborted).toBe(true);
    expect(screen.getByText("Your turn (White)")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-position",
      new Chess().fen()
    );

    await act(async () => {
      deferred.resolve({
        ok: true,
        json: async () => ({ best_move: "e7e5", elo_used: 1100 }),
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-position",
      new Chess().fen()
    );
  });

  it("assigns White or Black properly when Play as Random is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ best_move: "e2e4", elo_used: 1100 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.8);
    const { unmount } = render(<App />);

    fireEvent.change(screen.getByLabelText("Play as"), {
      target: { value: "random" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Game" }));

    expect(screen.getByText("Your turn (White)")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-orientation",
      "white"
    );
    expect(fetchMock).not.toHaveBeenCalled();

    unmount();
    localStorage.clear();

    randomSpy.mockReturnValue(0.2);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Play as"), {
      target: { value: "random" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Game" }));

    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-orientation",
      "black"
    );
    expect(screen.getByText("Maia is preparing a move...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Your turn (Black)")).toBeInTheDocument();
    expect(screen.getByText("e4")).toBeInTheDocument();
  });

  it("supports pawn promotion choice and cancellation for White", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ best_move: "h2h1", elo_used: 1100 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const promoChess = new Chess("8/P7/8/8/8/8/7k/K7 w - - 0 1");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        serializeSavedGame({
          game: promoChess,
          elo: 1100,
          selectedColorPref: "white",
          playerColor: "white",
          gamePhase: "active",
        })
      )
    );

    render(<App />);

    const accepted = triggerDrop("a7", "a8");
    expect(accepted).toBe(false);
    expect(screen.getByText("Choose Promotion")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Choose Promotion")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-position",
      promoChess.fen()
    );

    triggerDrop("a7", "a8");
    fireEvent.click(screen.getByRole("button", { name: "♘" }));

    expect(screen.queryByText("Choose Promotion")).not.toBeInTheDocument();
    expect(screen.getByText("a8=N")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports pawn promotion choice for Black", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ best_move: "h7h8", elo_used: 1100 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const promoChess = new Chess("k7/7K/8/8/8/8/p7/8 b - - 0 1");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        serializeSavedGame({
          game: promoChess,
          elo: 1100,
          selectedColorPref: "black",
          playerColor: "black",
          gamePhase: "active",
        })
      )
    );

    render(<App />);

    const accepted = triggerDrop("a2", "a1");
    expect(accepted).toBe(false);
    expect(screen.getByText("Choose Promotion")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "♕" }));

    expect(screen.queryByText("Choose Promotion")).not.toBeInTheDocument();
    expect(screen.getByText("a1=Q")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores stale engine responses that arrive after clicking New Game", async () => {
    const deferred = createDeferred();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Start Game" }));
    triggerDrop("e2", "e4");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "New Game" }));

    expect(screen.getByRole("button", { name: "Start Game" })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    await act(async () => {
      deferred.resolve({
        ok: true,
        json: async () => ({ best_move: "e7e5", elo_used: 1100 }),
      });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Start Game" })).toBeInTheDocument();
    expect(screen.getByTestId("mock-chessboard")).toHaveAttribute(
      "data-position",
      new Chess().fen()
    );
    expect(screen.queryByText("e7e5")).not.toBeInTheDocument();
  });
});
