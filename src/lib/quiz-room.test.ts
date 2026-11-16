import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  answerRoom,
  closeRoom,
  createRoom,
  joinRoom,
  playerStatus,
  roomBoard,
  setBoardTtl,
  MAX_PLAYERS,
  MAX_QUESTIONS,
  MAX_SECONDS,
  MIN_SECONDS,
  type CreateInput,
} from "./quiz-room.server.ts";

// No leaderboard caching in tests: every read must reflect the latest write.
before(() => setBoardTtl(0));

function quiz(count: number, seconds?: number): CreateInput {
  return {
    title: "Test quiz",
    seconds,
    questions: Array.from({ length: count }, (_, i) => ({
      text: `Question number ${i + 1}?`,
      options: { A: "alpha", B: "bravo", C: "charlie", D: "delta" },
      answer: "B" as const,
    })),
  };
}

async function made(count = 3, seconds?: number) {
  const room = await createRoom(quiz(count, seconds));
  assert.equal(room.ok, true);
  if (!room.ok) throw new Error("unreachable");
  return room;
}

async function joined(code: string, name: string) {
  const snap = await joinRoom(code, name);
  assert.equal(snap.ok, true);
  if (!snap.ok) throw new Error("unreachable");
  return snap;
}

describe("createRoom", () => {
  it("accepts 1 to 10 questions and rejects the rest", async () => {
    assert.equal((await createRoom(quiz(1))).ok, true);
    assert.equal((await createRoom(quiz(MAX_QUESTIONS))).ok, true);
    assert.equal((await createRoom(quiz(0))).ok, false);
    assert.equal((await createRoom(quiz(MAX_QUESTIONS + 1))).ok, false);
  });

  it("clamps the time limit", async () => {
    assert.equal((await made(3, 5)).seconds, MIN_SECONDS);
    assert.equal((await made(3, 99999)).seconds, MAX_SECONDS);
    assert.equal((await made(3, 600)).seconds, 600);
    assert.equal((await made(3)).seconds, 300);
  });

  it("rejects identical options and short text", async () => {
    const dup = quiz(1);
    dup.questions[0].options.C = "ALPHA";
    assert.match(String(((await createRoom(dup)) as { error: string }).error), /identical/);
    const short = quiz(1);
    short.questions[0].text = "?";
    assert.equal((await createRoom(short)).ok, false);
  });
});

describe("play", () => {
  it("scores answers, reveals the key only after answering, finishes the quiz", async () => {
    const room = await made(2);
    const me = await joined(room.code, "Alice");
    assert.equal(me.question?.number, 1);
    assert.equal(JSON.stringify(me).includes('"answer"'), false, "key must not leak before answering");

    const first = await answerRoom(room.code, me.playerKey, me.question!.id, "B");
    assert.equal(first.ok && first.marked, true);
    assert.equal(first.ok && first.answer, "B");

    const second = await answerRoom(room.code, me.playerKey, 2, "A");
    assert.equal(second.ok && second.marked, false);
    assert.equal(second.ok && second.answer, "B");
    assert.equal(second.ok && second.done, true);
    assert.equal(second.ok && second.score, 10);
    assert.equal(second.ok && second.rank, 1);
  });

  it("rejects stale questions and bad choices", async () => {
    const room = await made();
    const me = await joined(room.code, "Bob");
    assert.equal((await answerRoom(room.code, me.playerKey, 3, "A")).ok, false);
    assert.equal((await answerRoom(room.code, me.playerKey, 1, "Z")).ok, false);
    assert.equal((await answerRoom(room.code, "nope-nope-nope-nope", 1, "A")).ok, false);
  });

  it("blocks duplicate names, bad names, and joins after close", async () => {
    const room = await made();
    await joined(room.code, "Cara");
    assert.equal((await joinRoom(room.code, "cara")).ok, false);
    assert.equal((await joinRoom(room.code, "1")).ok, false);
    assert.equal((await joinRoom("ZZZZ", "Dan")).ok, false);
    assert.equal((await closeRoom(room.code, "wrong-key")).ok, false);
    assert.equal((await closeRoom(room.code, room.adminKey)).ok, true);
    assert.equal((await joinRoom(room.code, "Eve")).ok, false);
  });

  it("lets only one of two simultaneous joins claim a name", async () => {
    const room = await made();
    const [a, b] = await Promise.all([joinRoom(room.code, "Sam"), joinRoom(room.code, "sam")]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
  });

  it("caps the number of players", async () => {
    const room = await made();
    for (let i = 0; i < MAX_PLAYERS; i += 1) await joined(room.code, `Pl${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`);
    const extra = await joinRoom(room.code, "Overflow");
    assert.equal(extra.ok, false);
    assert.match(String((extra as { error: string }).error), /full/);
  });

  it("orders the board: finished first, then score", async () => {
    const room = await made(1);
    const low = await joined(room.code, "Low");
    const high = await joined(room.code, "High");
    await answerRoom(room.code, low.playerKey, 1, "A");
    await answerRoom(room.code, high.playerKey, 1, "B");
    const board = await roomBoard(room.code);
    assert.equal(board.ok && board.rows[0].name, "High");
    assert.equal(board.ok && board.questionCount, 1);
    const status = await playerStatus(room.code, low.playerKey);
    assert.equal(status.ok && status.rank, 2);
  });
});


describe("deadline and session recovery", () => {
  it("rejects a late answer and finalizes an idle attempt on the server", async () => {
    const room = await made(2, MIN_SECONDS);
    const me = await joined(room.code, "TimeoutStudent");
    const realNow = Date.now;
    try {
      const afterDeadline = realNow() + (MIN_SECONDS + 1) * 1000;
      Date.now = () => afterDeadline;
      const late = await answerRoom(room.code, me.playerKey, 1, "B");
      assert.equal(late.ok && late.done, true);
      assert.equal(late.ok && late.score, 0);
      assert.equal(late.ok && late.answer, null);
      const status = await playerStatus(room.code, me.playerKey);
      assert.equal(status.ok && status.remaining, 0);
      assert.equal(status.ok && status.question, null);
    } finally {
      Date.now = realNow;
    }
  });

  it("keeps existing attempts playable when the host closes joining", async () => {
    const room = await made(1);
    const me = await joined(room.code, "AlreadyJoined");
    await closeRoom(room.code, room.adminKey);
    const result = await answerRoom(room.code, me.playerKey, 1, "B");
    assert.equal(result.ok && result.score, 10);
    assert.equal(result.ok && result.done, true);
    assert.equal((await joinRoom(room.code, "NewStudent")).ok, false);
  });

  it("resumes the next question and score using the same player key", async () => {
    const room = await made(3);
    const me = await joined(room.code, "ResumeStudent");
    await answerRoom(room.code, me.playerKey, 1, "B");
    const resumed = await playerStatus(room.code, me.playerKey);
    assert.equal(resumed.ok && resumed.score, 10);
    assert.equal(resumed.ok && resumed.question?.number, 2);
    assert.equal(JSON.stringify(resumed).includes('"answer"'), false);
  });
});
