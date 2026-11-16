"""QuizNet TCP server.

One listening socket accepts many clients. Each client is served by its
own thread with its own quiz session. The server owns the answer key,
the 120-second deadline, and the SQLite write. Clients never score
themselves.

Run:
    python server.py
    python server.py --host 0.0.0.0 --port 5000
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import secrets
import signal
import socket
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Any

import database
import protocol

QUIZ_LENGTH = 10
QUIZ_SECONDS = 120.0
POINTS_PER_CORRECT = 10
VALID_OPTIONS = frozenset({"A", "B", "C", "D"})
MIN_BANK = 20
USERNAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}")

LOG = logging.getLogger("quiznet")

HERE = Path(__file__).resolve().parent


class QuizError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def validate_username(raw: object) -> str:
    if not isinstance(raw, str):
        raise QuizError("BAD_USERNAME", "Username must be text.")
    name = raw.strip()
    if not name:
        raise QuizError("BAD_USERNAME", "Username is required.")
    if len(name) > 20:
        raise QuizError("BAD_USERNAME", "Username must be at most 20 characters.")
    if USERNAME_RE.fullmatch(name) is None:
        raise QuizError(
            "BAD_USERNAME",
            "Use letters, digits, spaces, dots, underscores, or hyphens.",
        )
    return name


def _public_question(raw: dict[str, Any]) -> dict[str, Any]:
    options = raw["options"]
    return {
        "id": int(raw["id"]),
        "topic": str(raw["topic"]),
        "text": str(raw["text"]),
        "options": {key: str(options[key]) for key in ("A", "B", "C", "D")},
    }


def load_paper(path: str | Path) -> tuple[list[dict[str, Any]], dict[int, str], int]:
    """Load the bank and return (public paper of 10, answer key, bank size).

    The paper is the lowest 10 ids, sorted, so every student gets the same
    questions in the same order. The answer key is not part of the public
    question dicts.
    """
    file_path = Path(path)
    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise QuizError("BAD_QUESTIONS", f"Cannot load questions: {exc}") from exc
    raw_list = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(raw_list, list) or len(raw_list) < MIN_BANK:
        raise QuizError("BAD_QUESTIONS", f"Need at least {MIN_BANK} questions.")

    seen_ids: set[int] = set()
    seen_text: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for item in raw_list:
        if not isinstance(item, dict):
            raise QuizError("BAD_QUESTIONS", "Each question must be an object.")
        try:
            qid = int(item["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise QuizError("BAD_QUESTIONS", "Question id must be an integer.") from exc
        text = item.get("text")
        topic = item.get("topic")
        options = item.get("options")
        answer = item.get("answer")
        if not isinstance(text, str) or not text.strip():
            raise QuizError("BAD_QUESTIONS", f"Question {qid} has no text.")
        if not isinstance(topic, str) or not topic.strip():
            raise QuizError("BAD_QUESTIONS", f"Question {qid} has no topic.")
        if not isinstance(options, dict) or set(options) != VALID_OPTIONS:
            raise QuizError("BAD_QUESTIONS", f"Question {qid} must have options A-D.")
        if any(not isinstance(options[k], str) or not options[k].strip() for k in VALID_OPTIONS):
            raise QuizError("BAD_QUESTIONS", f"Question {qid} has an empty option.")
        if not isinstance(answer, str) or answer.strip().upper() not in VALID_OPTIONS:
            raise QuizError("BAD_QUESTIONS", f"Question {qid} has a bad answer key.")
        answer = answer.strip().upper()
        if qid in seen_ids:
            raise QuizError("BAD_QUESTIONS", f"Duplicate question id {qid}.")
        norm = " ".join(text.split()).casefold()
        if norm in seen_text:
            raise QuizError("BAD_QUESTIONS", f"Duplicate question text for id {qid}.")
        seen_ids.add(qid)
        seen_text.add(norm)
        cleaned.append(
            {
                "id": qid,
                "topic": topic.strip(),
                "text": text.strip(),
                "options": {k: options[k].strip() for k in ("A", "B", "C", "D")},
                "answer": answer,
            }
        )
    cleaned.sort(key=lambda row: row["id"])
    paper_raw = cleaned[:QUIZ_LENGTH]
    public = [_public_question(row) for row in paper_raw]
    answers = {row["id"]: row["answer"] for row in paper_raw}
    return public, answers, len(cleaned)


class QuizSession:
    """One student's attempt. Mutate it only while holding the handler lock."""

    def __init__(
        self,
        session_id: str,
        username: str,
        questions: list[dict[str, Any]],
        answers: dict[int, str],
        quiz_seconds: float,
    ) -> None:
        self.session_id = session_id
        self.username = username
        self.questions = questions
        self._answers = answers
        self.quiz_seconds = float(quiz_seconds)
        self.index = 0
        self.score = 0
        self.answered: dict[int, dict[str, Any]] = {}
        self.status = "lobby"
        self.finished = False
        self.started_at: float | None = None
        self.deadline: float | None = None

    def remaining(self, now: float) -> float:
        if self.deadline is None:
            return self.quiz_seconds
        return max(0.0, self.deadline - now)

    def is_expired(self, now: float) -> bool:
        return self.status == "active" and self.deadline is not None and now >= self.deadline

    def start(self, now: float) -> dict[str, Any]:
        if self.finished:
            raise QuizError("SESSION_CLOSED", "This session is already finished.")
        if self.status == "active":
            raise QuizError("ALREADY_STARTED", "The quiz is already running.")
        self.status = "active"
        self.started_at = now
        self.deadline = now + self.quiz_seconds
        payload = self.question_payload(now)
        if payload is None:
            raise QuizError("NO_QUESTIONS", "The paper is empty.")
        return payload

    def question_payload(self, now: float) -> dict[str, Any] | None:
        if self.index >= len(self.questions):
            return None
        question = self.questions[self.index]
        # Deliberately omit the correct option. It is revealed only after submit.
        return {
            "type": protocol.QUESTION,
            "session_id": self.session_id,
            "question_id": question["id"],
            "number": self.index + 1,
            "total": len(self.questions),
            "topic": question["topic"],
            "text": question["text"],
            "options": dict(question["options"]),
            "remaining_seconds": round(self.remaining(now), 1),
        }

    def submit(self, question_id: object, answer: object, now: float) -> dict[str, Any]:
        if self.finished or self.status != "active":
            raise QuizError("NOT_ACTIVE", "There is no quiz in progress.")
        if self.is_expired(now):
            raise QuizError("TIME_EXPIRED", "Time is up. The server is closing this attempt.")
        if isinstance(question_id, bool) or not isinstance(question_id, int):
            raise QuizError("INVALID_QUESTION", "question_id must be an integer.")
        if self.index >= len(self.questions):
            raise QuizError("QUIZ_COMPLETE", "There is no open question.")
        expected = int(self.questions[self.index]["id"])
        if question_id in self.answered or any(qid == question_id for qid in self.answered):
            raise QuizError("DUPLICATE_ANSWER", "That question was already answered.")
        if question_id != expected:
            raise QuizError(
                "OUT_OF_ORDER",
                f"The server is waiting for question {expected}, not {question_id}.",
            )
        if not isinstance(answer, str) or answer.strip().upper() not in VALID_OPTIONS:
            raise QuizError("INVALID_OPTION", "Answer must be A, B, C, or D.")
        selected = answer.strip().upper()
        correct_option = self._answers[expected]
        is_correct = selected == correct_option
        if is_correct:
            self.score += POINTS_PER_CORRECT
        self.answered[expected] = {"selected": selected, "correct": is_correct}
        self.index += 1
        return {
            "type": protocol.ANSWER_FEEDBACK,
            "session_id": self.session_id,
            "question_id": expected,
            "selected": selected,
            "correct": is_correct,
            "correct_option": correct_option,
            "score": self.score,
            "remaining_seconds": round(self.remaining(now), 1),
        }

    def finalize(self, now: float, status: str) -> dict[str, Any] | None:
        """Build the result exactly once. Later calls return None."""
        if self.finished:
            return None
        if self.status == "lobby":
            self.finished = True
            self.status = "disconnected"
            return None
        if status not in {"completed", "timeout", "disconnected"}:
            status = "completed"
        self.finished = True
        self.status = status
        duration = 0.0
        if self.started_at is not None:
            elapsed = now - self.started_at
            if self.deadline is not None:
                elapsed = min(elapsed, self.quiz_seconds)
            duration = max(0.0, elapsed)
        correct = sum(1 for row in self.answered.values() if row["correct"])
        wrong = sum(1 for row in self.answered.values() if not row["correct"])
        total = len(self.questions)
        unanswered = total - correct - wrong
        max_score = total * POINTS_PER_CORRECT
        percentage = (self.score / max_score * 100.0) if max_score else 0.0
        return {
            "type": protocol.QUIZ_RESULT,
            "session_id": self.session_id,
            "username": self.username,
            "score": self.score,
            "correct": correct,
            "wrong": wrong,
            "unanswered": unanswered,
            "total": total,
            "percentage": round(percentage, 1),
            "duration_seconds": round(duration, 2),
            "status": self.status,
        }


class ClientHandler(threading.Thread):
    def __init__(self, server: "QuizServer", conn: socket.socket, addr: tuple[Any, ...]) -> None:
        super().__init__(name=f"QuizClient-{addr[0]}:{addr[1]}", daemon=True)
        self.server = server
        self.conn = conn
        self.addr = addr
        self.stream = protocol.SocketStream(conn)
        self._state = threading.Lock()
        self._send_lock = threading.Lock()
        self.username: str | None = None
        self.session: QuizSession | None = None
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.conn.close()
        except OSError:
            pass

    def send(self, payload: dict[str, Any]) -> bool:
        try:
            with self._send_lock:
                self.stream.send(payload)
            return True
        except (OSError, protocol.ProtocolError) as exc:
            LOG.warning("send failed to %s: %s", self.addr, exc)
            return False

    def run(self) -> None:
        self.conn.settimeout(0.5)
        try:
            while not self._stop.is_set() and not self.server.stopping:
                self.check_timeout(time.monotonic())
                try:
                    message = self.stream.recv_message()
                except socket.timeout:
                    continue
                except protocol.ProtocolError as exc:
                    if self.username:
                        LOG.info("bad frame from %s: %s", self.addr, exc)
                        self.send(protocol.error_message("BAD_MESSAGE", str(exc)))
                    else:
                        # Port scanners and HTTP probes are not quiz clients.
                        LOG.debug("ignored non-quiz bytes from %s", self.addr)
                    break
                except OSError as exc:
                    if self.username:
                        LOG.info("socket error from %s: %s", self.addr, exc)
                    else:
                        LOG.debug("socket closed before JOIN from %s: %s", self.addr, exc)
                    break
                if message is None:
                    break
                try:
                    self.handle(message)
                except Exception:
                    LOG.exception("handler failure for %s", self.addr)
                    self.send(
                        protocol.error_message(
                            "SERVER_ERROR",
                            "The server hit an unexpected error on that message.",
                        )
                    )
        finally:
            self._on_disconnect()

    def check_timeout(self, now: float) -> None:
        with self._state:
            session = self.session
            expired = session is not None and session.is_expired(now)
        if expired:
            self.finish("timeout", now)

    def handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == protocol.JOIN:
            self._join(message)
            return
        if self.username is None or self.session is None:
            self.send(protocol.error_message("NOT_JOINED", "Send JOIN before anything else."))
            return
        if kind == protocol.DISCONNECT:
            # Store a partial attempt before the socket is closed.
            self.finish("disconnected", time.monotonic())
            self.send({"type": protocol.DISCONNECT, "message": "Goodbye."})
            self.stop()
            return
        if not self._session_matches(message):
            return
        if kind == protocol.START_QUIZ:
            self._start()
        elif kind == protocol.SUBMIT_ANSWER:
            self._submit(message)
        elif kind == protocol.GET_LEADERBOARD:
            self._leaderboard()
        else:
            self.send(
                protocol.error_message("UNKNOWN_TYPE", f"Unknown message type: {kind}")
            )

    def _session_matches(self, message: dict[str, Any]) -> bool:
        sent = message.get("session_id")
        with self._state:
            current = None if self.session is None else self.session.session_id
        if sent != current:
            self.send(
                protocol.error_message(
                    "INVALID_SESSION",
                    "That session id does not belong to this connection.",
                )
            )
            return False
        return True

    def _join(self, message: dict[str, Any]) -> None:
        with self._state:
            already = self.username
        if already:
            self.send(protocol.error_message("ALREADY_JOINED", "You are already connected."))
            return
        try:
            username = validate_username(message.get("username"))
        except QuizError as exc:
            self.send(protocol.error_message(exc.code, exc.message))
            return
        if not self.server.claim_username(username, self):
            self.send(
                protocol.error_message(
                    "DUPLICATE_USERNAME",
                    f"{username} is already connected. Choose another name.",
                )
            )
            return
        session = self.server.new_session(username)
        with self._state:
            self.username = username
            self.session = session
        self.name = f"QuizClient-{username}"
        LOG.info("JOIN %s from %s session=%s", username, self.addr, session.session_id)
        self.server.log_active()
        self.send(
            {
                "type": protocol.JOIN_ACK,
                "session_id": session.session_id,
                "username": username,
                "message": f"Welcome to QuizNet, {username}.",
                "quiz_seconds": int(self.server.quiz_seconds),
                "question_count": QUIZ_LENGTH,
            }
        )

    def _start(self) -> None:
        now = time.monotonic()
        with self._state:
            session = self.session
            if session is None:
                self.send(protocol.error_message("NOT_JOINED", "Join first."))
                return
            if session.finished or session.status != "lobby":
                if session.status == "active":
                    self.send(
                        protocol.error_message("ALREADY_STARTED", "The quiz is already running.")
                    )
                    return
                # A finished attempt can be replaced by a fresh session.
                session = self.server.new_session(session.username)
                self.session = session
            try:
                question = session.start(now)
            except QuizError as exc:
                self.send(protocol.error_message(exc.code, exc.message))
                return
            username = session.username
            sid = session.session_id
        LOG.info("START %s session=%s limit=%.0fs", username, sid, self.server.quiz_seconds)
        self.send(question)

    def _submit(self, message: dict[str, Any]) -> None:
        now = time.monotonic()
        timeout = False
        error: QuizError | None = None
        feedback: dict[str, Any] | None = None
        last = False
        with self._state:
            session = self.session
            if session is None:
                error = QuizError("NOT_JOINED", "Join first.")
            elif session.is_expired(now):
                timeout = True
            else:
                try:
                    feedback = session.submit(
                        message.get("question_id"), message.get("answer"), now
                    )
                    last = session.index >= len(session.questions)
                except QuizError as exc:
                    if exc.code == "TIME_EXPIRED":
                        timeout = True
                    else:
                        error = exc
        if timeout:
            self.finish("timeout", now)
            return
        if error is not None or feedback is None:
            assert error is not None
            self.send(protocol.error_message(error.code, error.message))
            return
        LOG.info(
            "SUBMIT %s q=%s answer=%s correct=%s score=%s",
            feedback.get("session_id"),
            feedback.get("question_id"),
            feedback.get("selected"),
            feedback.get("correct"),
            feedback.get("score"),
        )
        self.send(feedback)
        if last:
            self.finish("completed", time.monotonic())
            return
        now = time.monotonic()
        with self._state:
            session = self.session
            if session is None or session.finished or session.status != "active":
                return
            if session.is_expired(now):
                timeout = True
                nxt = None
            else:
                nxt = session.question_payload(now)
        if timeout:
            self.finish("timeout", now)
            return
        if nxt is not None:
            self.send(nxt)

    def _leaderboard(self) -> None:
        try:
            entries = database.fetch_leaderboard(self.server.db_path)
        except sqlite3.Error:
            LOG.exception("leaderboard query failed")
            self.send(
                protocol.error_message("DB_ERROR", "The leaderboard could not be read.")
            )
            return
        with self._state:
            sid = None if self.session is None else self.session.session_id
        self.send({"type": protocol.LEADERBOARD, "session_id": sid, "entries": entries})

    def finish(self, status: str, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._state:
            session = self.session
            if session is None:
                return
            payload = session.finalize(now, status)
        if payload is None:
            return
        try:
            inserted = database.save_result(self.server.db_path, payload)
            if not inserted:
                LOG.warning("duplicate result ignored for session %s", payload["session_id"])
        except (sqlite3.Error, ValueError):
            LOG.exception("could not store result for %s", payload.get("username"))
        LOG.info(
            "RESULT %s score=%s status=%s duration=%ss correct=%s wrong=%s unanswered=%s",
            payload["username"],
            payload["score"],
            payload["status"],
            payload["duration_seconds"],
            payload["correct"],
            payload["wrong"],
            payload["unanswered"],
        )
        self.send(payload)

    def _on_disconnect(self) -> None:
        now = time.monotonic()
        with self._state:
            session = self.session
            active = session is not None and session.status == "active" and not session.finished
            username = self.username
        if active:
            self.finish("disconnected", now)
        elif session is not None:
            with self._state:
                if session.status == "lobby" and not session.finished:
                    session.finalize(now, "disconnected")
        if username:
            self.server.release_username(username, self)
            LOG.info("DISCONNECT %s from %s", username, self.addr)
            self.server.log_active()
        else:
            LOG.debug("connection closed before JOIN from %s", self.addr)
        try:
            self.conn.close()
        except OSError:
            pass
        self.server.forget_handler(self)


class QuizServer:
    def __init__(
        self,
        host: str,
        port: int,
        questions_path: str | Path,
        db_path: str | Path,
        quiz_seconds: float = QUIZ_SECONDS,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.questions_path = Path(questions_path)
        self.db_path = Path(db_path)
        self.quiz_seconds = float(quiz_seconds)
        if self.quiz_seconds <= 0:
            raise QuizError("BAD_CONFIG", "Quiz duration must be positive.")
        self.paper, self.answer_key, self.bank_size = load_paper(self.questions_path)
        database.init_db(self.db_path)
        self._lock = threading.Lock()
        self._users: dict[str, ClientHandler] = {}
        self._handlers: list[ClientHandler] = []
        self._stop = threading.Event()
        self.ready = threading.Event()
        self.bound_port = self.port
        self._sock: socket.socket | None = None
        self._shutdown_lock = threading.Lock()
        self._did_shutdown = False

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def new_session(self, username: str) -> QuizSession:
        # Copy the public paper so a session cannot mutate the shared bank.
        questions = [
            {
                "id": q["id"],
                "topic": q["topic"],
                "text": q["text"],
                "options": dict(q["options"]),
            }
            for q in self.paper
        ]
        return QuizSession(
            session_id=secrets.token_hex(8),
            username=username,
            questions=questions,
            answers=dict(self.answer_key),
            quiz_seconds=self.quiz_seconds,
        )

    def claim_username(self, username: str, handler: ClientHandler) -> bool:
        key = username.casefold()
        with self._lock:
            if key in self._users:
                return False
            self._users[key] = handler
            return True

    def release_username(self, username: str, handler: ClientHandler) -> None:
        key = username.casefold()
        with self._lock:
            if self._users.get(key) is handler:
                self._users.pop(key, None)

    def log_active(self) -> None:
        with self._lock:
            names = [handler.username for handler in self._users.values() if handler.username]
        label = ", ".join(names) if names else "none"
        LOG.info("Active clients (%d): %s", len(names), label)

    def forget_handler(self, handler: ClientHandler) -> None:
        with self._lock:
            self._handlers = [item for item in self._handlers if item is not handler]

    def serve_forever(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.host, self.port))
        except OSError as exc:
            sock.close()
            raise QuizError("BIND_FAILED", f"Cannot bind {self.host}:{self.port}: {exc}") from exc
        sock.listen(16)
        sock.settimeout(0.5)
        self._sock = sock
        self.bound_port = sock.getsockname()[1]
        self.ready.set()
        LOG.info(
            "QuizNet listening on %s:%s  paper=%d  bank=%d  limit=%.0fs  db=%s",
            self.host,
            self.bound_port,
            len(self.paper),
            self.bank_size,
            self.quiz_seconds,
            self.db_path,
        )
        if self.host in {"0.0.0.0", "::"}:
            LOG.warning(
                "Bound to all interfaces. Use this only on a trusted LAN. "
                "QuizNet does not encrypt traffic."
            )
        sweeper = threading.Thread(target=self._sweep, name="QuizSweep", daemon=True)
        sweeper.start()
        try:
            while not self._stop.is_set():
                try:
                    conn, addr = sock.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                handler = ClientHandler(self, conn, addr)
                with self._lock:
                    self._handlers.append(handler)
                handler.start()
        finally:
            self.shutdown()

    def _sweep(self) -> None:
        while not self._stop.wait(0.25):
            now = time.monotonic()
            with self._lock:
                handlers = list(self._handlers)
            for handler in handlers:
                try:
                    handler.check_timeout(now)
                except Exception:
                    LOG.exception("timeout sweep failed")

    def shutdown(self) -> None:
        with self._shutdown_lock:
            if self._did_shutdown:
                return
            self._did_shutdown = True
            self._stop.set()
            sock = self._sock
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
            with self._lock:
                handlers = list(self._handlers)
        for handler in handlers:
            handler.stop()
        LOG.info("Server stopped.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="QuizNet multiplayer quiz server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5000, help="TCP port (default 5000)")
    parser.add_argument(
        "--questions",
        default=str(HERE / "questions.json"),
        help="Path to questions.json",
    )
    parser.add_argument(
        "--db",
        default=str(HERE / "quiznet.db"),
        help="SQLite database path",
    )
    parser.add_argument(
        "--quiz-seconds",
        type=float,
        default=QUIZ_SECONDS,
        help="Per-student time limit in seconds (default 120)",
    )
    parser.add_argument(
        "--log-file",
        default=str(HERE / "server.log"),
        help="Append server logs to this file as well as the console",
    )
    return parser


def configure_logging(log_file: str) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S")
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    root.addHandler(stream)
    try:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:
        LOG.warning("Could not open log file %s: %s", log_file, exc)


def _stdin_quit(server: QuizServer) -> None:
    if not sys.stdin or not sys.stdin.isatty():
        return
    while not server.stopping:
        try:
            line = sys.stdin.readline()
        except Exception:
            return
        if line == "":
            return
        if line.strip().lower() in {"quit", "exit", "shutdown"}:
            LOG.info("Shutdown requested from console.")
            server.shutdown()
            return


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not (1 <= args.port <= 65535):
        print("Port must be between 1 and 65535.", file=sys.stderr)
        return 2
    if args.quiz_seconds <= 0:
        print("Quiz duration must be positive.", file=sys.stderr)
        return 2
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    configure_logging(args.log_file)
    try:
        server = QuizServer(
            args.host,
            args.port,
            args.questions,
            args.db,
            quiz_seconds=args.quiz_seconds,
        )
    except QuizError as exc:
        LOG.error("%s", exc.message)
        return 1
    threading.Thread(target=_stdin_quit, args=(server,), name="QuizStdin", daemon=True).start()

    def _stop_signal(signum: int, _frame: object) -> None:
        LOG.info("Signal %s received, shutting down.", signum)
        server.shutdown()

    signal.signal(signal.SIGINT, _stop_signal)
    signal.signal(signal.SIGTERM, _stop_signal)
    try:
        server.serve_forever()
    except QuizError as exc:
        LOG.error("%s", exc.message)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
