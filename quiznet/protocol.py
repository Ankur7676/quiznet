"""Newline-delimited JSON framing for QuizNet TCP messages.

Each message is one UTF-8 JSON object followed by a single ``\\n``.
The reader reassembles bytes across TCP recv() calls so a partial
object, or several objects in one segment, cannot corrupt parsing.

This module never uses pickle or eval. Untrusted bytes are decoded
only with json.loads after a hard size check.
"""

from __future__ import annotations

import json
import socket
from typing import Any

MAX_MESSAGE_BYTES = 65_536
ENCODING = "utf-8"

# Client -> server
JOIN = "JOIN"
START_QUIZ = "START_QUIZ"
SUBMIT_ANSWER = "SUBMIT_ANSWER"
GET_LEADERBOARD = "GET_LEADERBOARD"
DISCONNECT = "DISCONNECT"

# Server -> client
JOIN_ACK = "JOIN_ACK"
QUESTION = "QUESTION"
ANSWER_FEEDBACK = "ANSWER_FEEDBACK"
QUIZ_RESULT = "QUIZ_RESULT"
LEADERBOARD = "LEADERBOARD"
ERROR = "ERROR"

CLIENT_TYPES = frozenset(
    {JOIN, START_QUIZ, SUBMIT_ANSWER, GET_LEADERBOARD, DISCONNECT}
)
SERVER_TYPES = frozenset(
    {JOIN_ACK, QUESTION, ANSWER_FEEDBACK, QUIZ_RESULT, LEADERBOARD, ERROR, DISCONNECT}
)

# Documented samples. Tests round-trip these through the framer.
SAMPLE_REQUESTS: dict[str, dict[str, Any]] = {
    JOIN: {"type": JOIN, "username": "Asha"},
    START_QUIZ: {"type": START_QUIZ, "session_id": "s1"},
    SUBMIT_ANSWER: {
        "type": SUBMIT_ANSWER,
        "session_id": "s1",
        "question_id": 1,
        "answer": "A",
    },
    GET_LEADERBOARD: {"type": GET_LEADERBOARD, "session_id": "s1"},
    DISCONNECT: {"type": DISCONNECT, "session_id": "s1"},
}

SAMPLE_RESPONSES: dict[str, dict[str, Any]] = {
    JOIN_ACK: {
        "type": JOIN_ACK,
        "session_id": "s1",
        "username": "Asha",
        "message": "Welcome to QuizNet, Asha.",
        "quiz_seconds": 120,
        "question_count": 10,
    },
    QUESTION: {
        "type": QUESTION,
        "session_id": "s1",
        "question_id": 1,
        "number": 1,
        "total": 10,
        "topic": "Computer Networks",
        "text": "TCP establishes a connection with which sequence?",
        "options": {
            "A": "SYN, SYN-ACK, ACK",
            "B": "ACK, SYN, FIN",
            "C": "FIN, FIN-ACK, ACK",
            "D": "ARP, DNS, DHCP",
        },
        "remaining_seconds": 118.4,
    },
    ANSWER_FEEDBACK: {
        "type": ANSWER_FEEDBACK,
        "session_id": "s1",
        "question_id": 1,
        "selected": "A",
        "correct": True,
        "correct_option": "A",
        "score": 10,
        "remaining_seconds": 110.2,
    },
    QUIZ_RESULT: {
        "type": QUIZ_RESULT,
        "session_id": "s1",
        "username": "Asha",
        "score": 80,
        "correct": 8,
        "wrong": 1,
        "unanswered": 1,
        "total": 10,
        "percentage": 80.0,
        "duration_seconds": 95.2,
        "status": "completed",
    },
    LEADERBOARD: {
        "type": LEADERBOARD,
        "entries": [
            {
                "rank": 1,
                "username": "Asha",
                "score": 80,
                "duration_seconds": 95.2,
                "status": "completed",
            }
        ],
    },
    ERROR: {
        "type": ERROR,
        "code": "DUPLICATE_USERNAME",
        "message": "That username is already connected.",
    },
}


class ProtocolError(Exception):
    """A frame was too large, not UTF-8, or not a JSON object with type."""


def encode_message(payload: dict[str, Any]) -> bytes:
    """Serialize one message, including the trailing newline."""
    if not isinstance(payload, dict):
        raise ProtocolError("payload must be a JSON object")
    if not isinstance(payload.get("type"), str) or not payload["type"]:
        raise ProtocolError("message requires a non-empty string type")
    line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    data = line.encode(ENCODING) + b"\n"
    if len(data) > MAX_MESSAGE_BYTES:
        raise ProtocolError("message exceeds maximum length")
    return data


def send_message(sock: socket.socket, payload: dict[str, Any]) -> None:
    """Send one complete frame. sendall retries until every byte is queued."""
    sock.sendall(encode_message(payload))


class MessageReader:
    """Incremental decoder for a TCP byte stream.

    Feed every chunk from recv(). Completed objects are returned in order.
    Bytes after the last newline stay buffered until the rest arrives.
    """

    def __init__(self, max_bytes: int = MAX_MESSAGE_BYTES) -> None:
        self._buf = bytearray()
        self._max = max_bytes

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        if not chunk:
            return []
        if not isinstance(chunk, (bytes, bytearray)):
            raise ProtocolError("chunk must be bytes")
        self._buf.extend(chunk)
        messages: list[dict[str, Any]] = []
        while True:
            idx = self._buf.find(b"\n")
            if idx < 0:
                if len(self._buf) > self._max:
                    self._buf.clear()
                    raise ProtocolError("message exceeds maximum length")
                break
            raw = bytes(self._buf[:idx])
            del self._buf[: idx + 1]
            if raw.endswith(b"\r"):
                raw = raw[:-1]
            if not raw:
                continue
            if len(raw) > self._max:
                raise ProtocolError("message exceeds maximum length")
            try:
                text = raw.decode(ENCODING)
            except UnicodeDecodeError as exc:
                raise ProtocolError("message is not valid UTF-8") from exc
            try:
                obj = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ProtocolError("invalid JSON") from exc
            if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
                raise ProtocolError("JSON message must be an object with a string type")
            messages.append(obj)
        return messages

    def pending_bytes(self) -> int:
        return len(self._buf)


class SocketStream:
    """A TCP socket plus a frame buffer and a queue of already-split messages.

    ``recv_message`` returns one JSON object at a time. If a single ``recv``
    contains two frames, the second waits in the queue and is not parsed again.
    ``socket.timeout`` is not swallowed — callers use it as a tick.
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.reader = MessageReader()
        self._queue: list[dict[str, Any]] = []

    def recv_message(self) -> dict[str, Any] | None:
        if self._queue:
            return self._queue.pop(0)
        while not self._queue:
            chunk = self.sock.recv(4096)
            if chunk == b"":
                if self.reader.pending_bytes():
                    raise ProtocolError("connection closed in the middle of a message")
                return None
            self._queue.extend(self.reader.feed(chunk))
        return self._queue.pop(0)

    def send(self, payload: dict[str, Any]) -> None:
        send_message(self.sock, payload)



def error_message(code: str, message: str) -> dict[str, Any]:
    return {"type": ERROR, "code": code, "message": message}
