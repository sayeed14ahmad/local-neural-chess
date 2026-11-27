import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import chess
import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402

FOOLS_MATE_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"


def make_fake_engine(move_uci: str = "e7e5") -> MagicMock:
    engine = MagicMock()
    engine.play.return_value = MagicMock(move=chess.Move.from_uci(move_uci))
    return engine


@pytest.fixture(autouse=True)
def reset_engine_state():
    with main.engine_state["lock"]:
        main.engine_state["process"] = None
        main.engine_state["current_elo"] = None
    yield
    with main.engine_state["lock"]:
        main.engine_state["process"] = None
        main.engine_state["current_elo"] = None


def test_health_endpoint_returns_ok():
    client = TestClient(main.app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "Maia Chess Centaur API",
    }


def test_ready_endpoint_returns_503_when_engine_is_uninitialized():
    client = TestClient(main.app)
    response = client.get("/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["ready"] is False
    assert body["status"] == "not_ready"
    assert body["engine_initialized"] is False


def test_startup_fails_when_lc0_executable_is_missing():
    with patch.object(main.os.path, "isfile", return_value=False):
        with pytest.raises(RuntimeError, match="Engine executable missing"):
            with TestClient(main.app):
                pass


def test_startup_fails_when_all_maia_weights_are_missing():
    def isfile_with_engine_only(path):
        return path == main.ENGINE_PATH

    with (
        patch.object(main.os.path, "isfile", side_effect=isfile_with_engine_only),
        patch.object(main.chess.engine.SimpleEngine, "popen_uci") as popen_mock,
    ):
        with pytest.raises(RuntimeError, match="No Maia weight files found on startup"):
            with TestClient(main.app):
                pass

    popen_mock.assert_not_called()


def test_partial_weights_allow_startup_and_report_unavailable_elo():
    original_isfile = os.path.isfile
    missing_1500 = main.get_weight_path(1500)
    fake_engine = make_fake_engine()

    def isfile_with_missing_1500(path):
        if path == missing_1500:
            return False
        return original_isfile(path)

    with (
        patch.object(main.os.path, "isfile", side_effect=isfile_with_missing_1500),
        patch.object(
            main.chess.engine.SimpleEngine,
            "popen_uci",
            return_value=fake_engine,
        ),
    ):
        with TestClient(main.app) as client:
            ready_response = client.get("/ready")
            assert ready_response.status_code == 503
            ready_body = ready_response.json()
            assert ready_body["ready"] is False
            assert ready_body["status"] == "not_ready"
            assert ready_body["missing_weights"] == ["maia-1500.pb.gz"]

            unavailable_move = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1500},
            )
            assert unavailable_move.status_code == 500
            assert unavailable_move.json() == {
                "detail": "Requested Elo weight file is missing on the server."
            }

            available_move = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert available_move.status_code == 200
            assert available_move.json() == {
                "best_move": "e7e5",
                "elo_used": 1100,
            }


def test_get_move_success_uses_default_elo_and_bounded_search():
    fake_engine = make_fake_engine()

    with patch.object(
        main.chess.engine.SimpleEngine,
        "popen_uci",
        return_value=fake_engine,
    ):
        with TestClient(main.app) as client:
            ready_response = client.get("/ready")
            assert ready_response.status_code == 200
            assert ready_response.json()["ready"] is True
            assert ready_response.json()["status"] == "ready"
            assert ready_response.json()["missing_weights"] == []

            first = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN},
            )
            assert first.status_code == 200
            assert first.json() == {"best_move": "e7e5", "elo_used": 1100}
            assert fake_engine.configure.call_count == 1

            limit = fake_engine.play.call_args.args[1]
            assert limit.nodes == main.ENGINE_MOVE_NODES
            assert limit.time == main.ENGINE_MOVE_TIMEOUT_SEC

            second = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert second.status_code == 200
            assert fake_engine.configure.call_count == 1


def test_failed_weight_switch_resets_current_elo_and_recovers():
    fake_engine = make_fake_engine("c7c5")

    with patch.object(
        main.chess.engine.SimpleEngine,
        "popen_uci",
        return_value=fake_engine,
    ):
        with TestClient(main.app) as client:
            initial = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert initial.status_code == 200
            assert main.engine_state["current_elo"] == 1100

            fake_engine.configure.side_effect = RuntimeError("weight swap failed")
            failed_switch = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1500},
            )
            assert failed_switch.status_code == 500
            assert failed_switch.json() == {
                "detail": "Internal engine error during move calculation."
            }
            assert main.engine_state["current_elo"] is None

            fake_engine.configure.side_effect = None
            recovered = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1500},
            )
            assert recovered.status_code == 200
            assert recovered.json() == {"best_move": "c7c5", "elo_used": 1500}
            assert main.engine_state["current_elo"] == 1500


def test_get_move_validation_and_engine_error_statuses():
    fake_engine = make_fake_engine()

    with patch.object(
        main.chess.engine.SimpleEngine,
        "popen_uci",
        return_value=fake_engine,
    ):
        with TestClient(main.app) as client:
            invalid_fen = client.post(
                "/get-move",
                json={"fen": "not-a-valid-fen", "elo": 1100},
            )
            assert invalid_fen.status_code == 400
            assert invalid_fen.json() == {
                "detail": "Invalid FEN string provided."
            }

            game_over = client.post(
                "/get-move",
                json={"fen": FOOLS_MATE_FEN, "elo": 1100},
            )
            assert game_over.status_code == 400
            assert game_over.json() == {
                "detail": "Game is over; no legal moves available."
            }

            fake_engine.play.return_value = MagicMock(move=None)
            no_move = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert no_move.status_code == 500
            assert no_move.json() == {
                "detail": "Engine failed to return a move."
            }

            fake_engine.play.side_effect = TimeoutError("search timed out")
            timed_out = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert timed_out.status_code == 504
            assert timed_out.json() == {
                "detail": "Engine timed out during move calculation."
            }

            fake_engine.play.side_effect = chess.engine.EngineTerminatedError(
                "lc0 exited"
            )
            terminated = client.post(
                "/get-move",
                json={"fen": chess.STARTING_FEN, "elo": 1100},
            )
            assert terminated.status_code == 503
            assert terminated.json() == {
                "detail": "Chess engine is currently unavailable."
            }
            assert main.engine_state["process"] is None
            assert main.engine_state["current_elo"] is None


def test_get_move_returns_503_when_engine_is_not_initialized():
    client = TestClient(main.app)
    response = client.post(
        "/get-move",
        json={"fen": chess.STARTING_FEN, "elo": 1100},
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Chess engine is currently unavailable."
    }


def test_openapi_contract_schemas_are_present():
    schema = main.app.openapi()
    assert "/health" in schema["paths"]
    assert "/ready" in schema["paths"]
    assert "/get-move" in schema["paths"]

    health_ref = schema["paths"]["/health"]["get"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]["$ref"]
    assert health_ref.endswith("/HealthResponse")

    ready_responses = schema["paths"]["/ready"]["get"]["responses"]
    ready_200_ref = ready_responses["200"]["content"]["application/json"]["schema"][
        "$ref"
    ]
    ready_503_ref = ready_responses["503"]["content"]["application/json"]["schema"][
        "$ref"
    ]
    assert ready_200_ref.endswith("/ReadyResponse")
    assert ready_503_ref.endswith("/ReadyResponse")

    move_operation = schema["paths"]["/get-move"]["post"]
    move_request_ref = move_operation["requestBody"]["content"]["application/json"][
        "schema"
    ]["$ref"]
    move_200_ref = move_operation["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert move_request_ref.endswith("/MoveRequest")
    assert move_200_ref.endswith("/MoveResponse")

    for status_code in ("400", "500", "503", "504"):
        error_ref = move_operation["responses"][status_code]["content"][
            "application/json"
        ]["schema"]["$ref"]
        assert error_ref.endswith("/ErrorResponse")
