"""Framing tests: partial reads, coalesced messages, and rejected frames."""

from __future__ import annotations

import socket
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import protocol


class MessageReaderTests(unittest.TestCase):
    def test_one_message(self) -> None:
        reader = protocol.MessageReader()
        payload = protocol.SAMPLE_REQUESTS[protocol.JOIN]
        messages = reader.feed(protocol.encode_message(payload))
        self.assertEqual(messages, [payload])
        self.assertEqual(reader.pending_bytes(), 0)

    def test_two_messages_in_one_chunk(self) -> None:
        reader = protocol.MessageReader()
        raw = protocol.encode_message(protocol.SAMPLE_REQUESTS[protocol.JOIN])
        raw += protocol.encode_message(protocol.SAMPLE_REQUESTS[protocol.START_QUIZ])
        messages = reader.feed(raw)
        self.assertEqual([m["type"] for m in messages], [protocol.JOIN, protocol.START_QUIZ])

    def test_split_across_reads(self) -> None:
        reader = protocol.MessageReader()
        raw = protocol.encode_message(protocol.SAMPLE_RESPONSES[protocol.QUESTION])
        first, second = raw[:7], raw[7:]
        self.assertEqual(reader.feed(first), [])
        self.assertGreater(reader.pending_bytes(), 0)
        messages = reader.feed(second)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["type"], protocol.QUESTION)
        self.assertNotIn("answer", messages[0])
        self.assertNotIn("correct_option", messages[0])

    def test_crlf_and_blank_lines(self) -> None:
        reader = protocol.MessageReader()
        line = protocol.encode_message({"type": protocol.DISCONNECT, "session_id": "s"})
        raw = b"\n" + line[:-1] + b"\r\n"
        messages = reader.feed(raw)
        self.assertEqual(messages[0]["type"], protocol.DISCONNECT)

    def test_invalid_json(self) -> None:
        reader = protocol.MessageReader()
        with self.assertRaises(protocol.ProtocolError):
            reader.feed(b"{not json}\n")

    def test_non_object_rejected(self) -> None:
        reader = protocol.MessageReader()
        with self.assertRaises(protocol.ProtocolError):
            reader.feed(b"[1, 2, 3]\n")

    def test_oversized_frame(self) -> None:
        reader = protocol.MessageReader(max_bytes=64)
        with self.assertRaises(protocol.ProtocolError):
            reader.feed(b"x" * 80)

    def test_samples_round_trip(self) -> None:
        reader = protocol.MessageReader()
        blob = b"".join(protocol.encode_message(msg) for msg in protocol.SAMPLE_REQUESTS.values())
        blob += b"".join(protocol.encode_message(msg) for msg in protocol.SAMPLE_RESPONSES.values())
        messages = reader.feed(blob)
        self.assertEqual(len(messages), len(protocol.SAMPLE_REQUESTS) + len(protocol.SAMPLE_RESPONSES))
        self.assertTrue(all(isinstance(m["type"], str) for m in messages))

    def test_encode_rejects_missing_type(self) -> None:
        with self.assertRaises(protocol.ProtocolError):
            protocol.encode_message({"username": "Asha"})

    def test_socketpair_preserves_both_frames(self) -> None:
        left, right = socket.socketpair()
        try:
            left.sendall(protocol.encode_message({"type": protocol.JOIN, "username": "Asha"}))
            left.sendall(
                protocol.encode_message(
                    {"type": protocol.SUBMIT_ANSWER, "session_id": "s", "question_id": 1, "answer": "B"}
                )
            )
            stream = protocol.SocketStream(right)
            right.settimeout(2)
            first = stream.recv_message()
            second = stream.recv_message()
            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            assert first is not None and second is not None
            self.assertEqual(first["username"], "Asha")
            self.assertEqual(second["answer"], "B")
            self.assertIsInstance(second["question_id"], int)
        finally:
            left.close()
            right.close()


if __name__ == "__main__":
    unittest.main()
