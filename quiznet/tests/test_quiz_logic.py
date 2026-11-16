"""Session rules, scoring, timeouts, and SQLite persistence."""

from __future__ import annotations

import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import database
import protocol
import server

QUESTIONS = Path(__file__).resolve().parents[1] / "questions.json"


class PaperTests(unittest.TestCase):
    def test_bank_and_fixed_paper(self) -> None:
        paper, answers, bank_size = server.load_paper(QUESTIONS)
        self.assertGreaterEqual(bank_size, 20)
        self.assertEqual(len(paper), 10)
        self.assertEqual(len(answers), 10)
        ids = [q["id"] for q in paper]
        self.assertEqual(ids, sorted(ids))
        for question in paper:
            self.assertNotIn("answer", question)
            self.assertEqual(set(question["options"]), {"A", "B", "C", "D"})
        self.assertTrue(set(answers.values()) <= {"A", "B", "C", "D"})


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        paper, answers, _bank = server.load_paper(QUESTIONS)
        self.paper = paper
        self.answers = answers
        self.now = 1_000.0
        self.session = server.QuizSession("s1", "Asha", paper, answers, quiz_seconds=120)

    def _start(self) -> None:
        self.session.start(self.now)

    def test_perfect_score_is_100(self) -> None:
        self._start()
        for question in self.paper:
            self.session.submit(question["id"], self.answers[question["id"]], self.now + 1)
        result = self.session.finalize(self.now + 40, "completed")
        assert result is not None
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["correct"], 10)
        self.assertEqual(result["wrong"], 0)
        self.assertEqual(result["unanswered"], 0)
        self.assertEqual(result["percentage"], 100.0)
        self.assertIsNone(self.session.finalize(self.now + 41, "completed"))

    def test_wrong_answer_scores_zero_and_reveals_key_only_after_submit(self) -> None:
        question = self.session.start(self.now)
        self.assertNotIn("answer", question)
        self.assertNotIn("correct_option", question)
        wrong = next(opt for opt in ("A", "B", "C", "D") if opt != self.answers[question["question_id"]])
        feedback = self.session.submit(question["question_id"], wrong, self.now + 2)
        self.assertFalse(feedback["correct"])
        self.assertEqual(feedback["score"], 0)
        self.assertEqual(feedback["correct_option"], self.answers[question["question_id"]])

    def test_duplicate_and_invalid_and_out_of_order(self) -> None:
        question = self.session.start(self.now)
        qid = question["question_id"]
        with self.assertRaises(server.QuizError) as invalid:
            self.session.submit(qid, "Z", self.now + 1)
        self.assertEqual(invalid.exception.code, "INVALID_OPTION")
        self.assertEqual(self.session.index, 0)
        with self.assertRaises(server.QuizError) as order:
            self.session.submit(qid + 99, "A", self.now + 1)
        self.assertEqual(order.exception.code, "OUT_OF_ORDER")
        self.session.submit(qid, "A", self.now + 1)
        with self.assertRaises(server.QuizError) as duplicate:
            self.session.submit(qid, "A", self.now + 2)
        self.assertEqual(duplicate.exception.code, "DUPLICATE_ANSWER")
        self.assertLessEqual(self.session.score, 10)

    def test_timeout_finalizes_once_and_blanks_score_zero(self) -> None:
        self.session.start(self.now)
        self.assertFalse(self.session.is_expired(self.now + 119))
        self.assertTrue(self.session.is_expired(self.now + 120))
        with self.assertRaises(server.QuizError) as expired:
            self.session.submit(self.paper[0]["id"], "A", self.now + 120)
        self.assertEqual(expired.exception.code, "TIME_EXPIRED")
        result = self.session.finalize(self.now + 130, "timeout")
        assert result is not None
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["unanswered"], 10)
        self.assertEqual(result["duration_seconds"], 120.0)
        self.assertIsNone(self.session.finalize(self.now + 131, "timeout"))

    def test_partial_score_then_timeout(self) -> None:
        question = self.session.start(self.now)
        self.session.submit(question["question_id"], self.answers[question["question_id"]], self.now + 5)
        result = self.session.finalize(self.now + 50, "timeout")
        assert result is not None
        self.assertEqual(result["score"], 10)
        self.assertEqual(result["correct"], 1)
        self.assertEqual(result["unanswered"], 9)

    def test_username_rules(self) -> None:
        self.assertEqual(server.validate_username("  Asha  "), "Asha")
        with self.assertRaises(server.QuizError):
            server.validate_username("   ")
        with self.assertRaises(server.QuizError):
            server.validate_username("bad$name")
        with self.assertRaises(server.QuizError):
            server.validate_username("x" * 21)


class DatabaseTests(unittest.TestCase):
    def test_persist_and_rank(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "quiz.db"
            database.init_db(path)
            slow = {
                "session_id": "slow",
                "username": "Slow",
                "score": 80,
                "total": 10,
                "correct": 8,
                "wrong": 2,
                "unanswered": 0,
                "status": "completed",
                "duration_seconds": 90,
            }
            fast = dict(slow, session_id="fast", username="Fast", duration_seconds=40)
            low = dict(slow, session_id="low", username="Low", score=20, correct=2, wrong=8, duration_seconds=10)
            dropped = dict(slow, session_id="drop", username="Drop", status="disconnected", score=80, duration_seconds=5)
            self.assertTrue(database.save_result(path, slow))
            self.assertTrue(database.save_result(path, fast))
            self.assertTrue(database.save_result(path, low))
            self.assertTrue(database.save_result(path, dropped))
            self.assertFalse(database.save_result(path, fast))
            self.assertEqual(database.count_results(path), 4)
            board = database.fetch_leaderboard(path)
            self.assertEqual([row["username"] for row in board], ["Fast", "Slow", "Low"])
            self.assertEqual(board[0]["rank"], 1)
            self.assertNotIn("Drop", [row["username"] for row in board])


class LiveServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "live.db"
        self.server = server.QuizServer(
            "127.0.0.1",
            0,
            QUESTIONS,
            self.db,
            quiz_seconds=30,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertTrue(self.server.ready.wait(3), "server did not bind")
        self.port = self.server.bound_port

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.tmp.cleanup()

    def probe(self) -> "Probe":
        return Probe(self.port)

    def test_two_students_are_independent_and_share_a_board(self) -> None:
        asha = self.probe()
        rohan = self.probe()
        try:
            asha.send({"type": protocol.JOIN, "username": "Asha"})
            rohan.send({"type": protocol.JOIN, "username": "Rohan"})
            asha_ack = asha.expect(protocol.JOIN_ACK)
            rohan_ack = rohan.expect(protocol.JOIN_ACK)
            self.assertNotEqual(asha_ack["session_id"], rohan_ack["session_id"])

            again = self.probe()
            again.send({"type": protocol.JOIN, "username": "asha"})
            dup = again.expect(protocol.ERROR)
            self.assertEqual(dup["code"], "DUPLICATE_USERNAME")
            again.close()

            asha.send({"type": protocol.START_QUIZ, "session_id": asha_ack["session_id"]})
            rohan.send({"type": protocol.START_QUIZ, "session_id": rohan_ack["session_id"]})
            aq = asha.expect(protocol.QUESTION)
            rq = rohan.expect(protocol.QUESTION)
            self.assertEqual(aq["question_id"], rq["question_id"])
            self.assertNotIn("answer", aq)
            self.assertNotIn("correct_option", aq)

            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": asha.session_id,
                    "question_id": aq["question_id"],
                    "answer": "Z",
                }
            )
            bad = asha.expect(protocol.ERROR)
            self.assertEqual(bad["code"], "INVALID_OPTION")

            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": asha.session_id,
                    "question_id": 9999,
                    "answer": "A",
                }
            )
            out = asha.expect(protocol.ERROR)
            self.assertEqual(out["code"], "OUT_OF_ORDER")

            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": "someone-else",
                    "question_id": aq["question_id"],
                    "answer": "A",
                }
            )
            stolen = asha.expect(protocol.ERROR)
            self.assertEqual(stolen["code"], "INVALID_SESSION")

            right = self.server.answer_key[aq["question_id"]]
            wrong = next(opt for opt in ("A", "B", "C", "D") if opt != right)
            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": asha.session_id,
                    "question_id": aq["question_id"],
                    "answer": right,
                }
            )
            rohan.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": rohan.session_id,
                    "question_id": rq["question_id"],
                    "answer": wrong,
                }
            )
            asha_fb = asha.expect(protocol.ANSWER_FEEDBACK)
            rohan_fb = rohan.expect(protocol.ANSWER_FEEDBACK)
            self.assertTrue(asha_fb["correct"])
            self.assertEqual(asha_fb["score"], 10)
            self.assertFalse(rohan_fb["correct"])
            self.assertEqual(rohan_fb["score"], 0)
            asha_next = asha.expect(protocol.QUESTION)
            rohan_next = rohan.expect(protocol.QUESTION)
            self.assertEqual(asha_next["number"], 2)
            self.assertEqual(rohan_next["number"], 2)

            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": asha.session_id,
                    "question_id": aq["question_id"],
                    "answer": right,
                }
            )
            replay = asha.expect(protocol.ERROR)
            self.assertEqual(replay["code"], "DUPLICATE_ANSWER")

            rohan.close()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and database.count_results(self.db) < 1:
                time.sleep(0.05)
            self.assertGreaterEqual(database.count_results(self.db), 1)
            asha.send({"type": protocol.GET_LEADERBOARD, "session_id": asha.session_id})
            board = asha.expect(protocol.LEADERBOARD)
            names = [row["username"] for row in board["entries"]]
            self.assertNotIn("Asha", names)
            self.assertNotIn("Rohan", names)
            asha.send({"type": protocol.START_QUIZ, "session_id": asha.session_id})
            busy = asha.expect(protocol.ERROR)
            self.assertEqual(busy["code"], "ALREADY_STARTED")
            current = asha_next["question_id"]
            asha.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": asha.session_id,
                    "question_id": current,
                    "answer": self.server.answer_key[current],
                }
            )
            moved = asha.expect(protocol.ANSWER_FEEDBACK)
            self.assertEqual(moved["score"], 20)
            third = asha.expect(protocol.QUESTION)
            self.assertEqual(third["number"], 3)
            asha.close()
            # Closing Asha must not prevent that name from joining again.
            reused = None
            late = None
            for _ in range(30):
                late = self.probe()
                late.send({"type": protocol.JOIN, "username": "Asha"})
                incoming = late.expect_any(timeout=1)
                if incoming.get("type") == protocol.JOIN_ACK:
                    reused = incoming
                    break
                late.close()
                late = None
                time.sleep(0.05)
            self.assertIsNotNone(reused)
            assert reused is not None and late is not None
            self.assertEqual(reused["username"], "Asha")
            late.close()
        finally:
            asha.close()
            rohan.close()

    def test_server_pushes_timeout_without_another_answer(self) -> None:
        timed = server.QuizServer(
            "127.0.0.1", 0, QUESTIONS, Path(self.tmp.name) / "time.db", quiz_seconds=0.8
        )
        thread = threading.Thread(target=timed.serve_forever, daemon=True)
        thread.start()
        self.assertTrue(timed.ready.wait(3))
        probe = Probe(timed.bound_port)
        try:
            probe.send({"type": protocol.JOIN, "username": "Timer"})
            ack = probe.expect(protocol.JOIN_ACK)
            probe.send({"type": protocol.START_QUIZ, "session_id": ack["session_id"]})
            probe.expect(protocol.QUESTION)
            result = probe.expect(protocol.QUIZ_RESULT, timeout=4)
            self.assertEqual(result["status"], "timeout")
            self.assertEqual(result["score"], 0)
            self.assertEqual(result["unanswered"], 10)
            probe.send(
                {
                    "type": protocol.SUBMIT_ANSWER,
                    "session_id": probe.session_id,
                    "question_id": 1,
                    "answer": "A",
                }
            )
            # The attempt is already final. A late answer must not raise the score.
            late = probe.collect(timeout=1.0)
            self.assertTrue(any(msg.get("type") == protocol.ERROR for msg in late) or late == [])
            rows = database.fetch_leaderboard(timed.db_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["score"], 0)
        finally:
            probe.close()
            timed.shutdown()
            thread.join(timeout=3)


class Probe:
    def __init__(self, port: int) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=3)
        self.sock.settimeout(0.3)
        self.stream = protocol.SocketStream(self.sock)
        self.session_id: str | None = None

    def send(self, message: dict) -> None:
        self.stream.send(message)

    def expect(self, kind: str, timeout: float = 3.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.stream.recv_message()
            except socket.timeout:
                continue
            if message is None:
                break
            if isinstance(message.get("session_id"), str):
                self.session_id = message["session_id"]
            if message.get("type") == protocol.ERROR and kind != protocol.ERROR:
                raise AssertionError(f"unexpected {message} while waiting for {kind}")
            if message.get("type") == kind:
                return message
        self.fail(f"timed out waiting for {kind}")
        raise AssertionError(f"timed out waiting for {kind}")

    def expect_any(self, timeout: float = 3.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.stream.recv_message()
            except socket.timeout:
                continue
            if message is None:
                break
            if isinstance(message.get("session_id"), str):
                self.session_id = message["session_id"]
            return message
        raise AssertionError("timed out waiting for a message")

    def collect(self, timeout: float) -> list[dict]:
        deadline = time.monotonic() + timeout
        found: list[dict] = []
        while time.monotonic() < deadline:
            try:
                message = self.stream.recv_message()
            except socket.timeout:
                continue
            if message is None:
                break
            found.append(message)
        return found

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def fail(self, message: str) -> None:
        raise AssertionError(message)


if __name__ == "__main__":
    unittest.main()
