"""SQLite persistence for QuizNet results.

Each call opens and closes its own connection. That avoids sharing a
sqlite3 connection across threads (the default check_same_thread guard)
while still allowing many client handlers to save results safely.
Queries are parameterized. session_id is UNIQUE so a session cannot
be inserted twice.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    score INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    wrong_count INTEGER NOT NULL,
    unanswered_count INTEGER NOT NULL,
    completion_status TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    created_at TEXT NOT NULL
);
"""

# Ranked on the public leaderboard. Disconnects are stored but not ranked,
# so a student who leaves early cannot win a duration tie with a tiny score.
RANKED_STATUSES = ("completed", "timeout")


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def init_db(db_path: str | Path) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def save_result(db_path: str | Path, result: dict[str, Any], created_at: str | None = None) -> bool:
    """Insert one final result.

    Returns True if a new row was written, False if this session_id was
    already stored (duplicate finalization).
    """
    required = (
        "session_id",
        "username",
        "score",
        "total",
        "correct",
        "wrong",
        "unanswered",
        "status",
        "duration_seconds",
    )
    missing = [key for key in required if key not in result]
    if missing:
        raise ValueError(f"result is missing fields: {', '.join(missing)}")
    status = str(result["status"])
    if status not in {"completed", "timeout", "disconnected"}:
        raise ValueError(f"invalid completion status: {status}")
    conn = connect(db_path)
    try:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO results (
                session_id, username, score, total_questions,
                correct_count, wrong_count, unanswered_count,
                completion_status, duration_seconds, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(result["session_id"]),
                str(result["username"]),
                int(result["score"]),
                int(result["total"]),
                int(result["correct"]),
                int(result["wrong"]),
                int(result["unanswered"]),
                status,
                float(result["duration_seconds"]),
                created_at or utc_now_iso(),
            ),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()


def fetch_leaderboard(db_path: str | Path, limit: int = 20) -> list[dict[str, Any]]:
    """Highest score first. Equal scores: shorter duration ranks higher."""
    if limit < 1:
        raise ValueError("limit must be positive")
    placeholders = ",".join("?" for _ in RANKED_STATUSES)
    conn = connect(db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT username, score, duration_seconds, completion_status
            FROM results
            WHERE completion_status IN ({placeholders})
            ORDER BY score DESC, duration_seconds ASC, id ASC
            LIMIT ?
            """,
            (*RANKED_STATUSES, int(limit)),
        ).fetchall()
    finally:
        conn.close()
    board: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        board.append(
            {
                "rank": index,
                "username": row["username"],
                "score": int(row["score"]),
                "duration_seconds": float(row["duration_seconds"]),
                "status": row["completion_status"],
            }
        )
    return board


def count_results(db_path: str | Path) -> int:
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM results").fetchone()
        return int(row["n"]) if row is not None else 0
    finally:
        conn.close()
