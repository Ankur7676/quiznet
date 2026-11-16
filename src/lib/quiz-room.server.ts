import { randomBytes, timingSafeEqual } from "node:crypto";
import { kv } from "./quiz-kv.server.ts";

export const DEFAULT_SECONDS = 300;
export const MIN_SECONDS = 60;
export const MAX_SECONDS = 900;
export const POINTS = 10;
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 10;
export const MAX_PLAYERS = 40;

/** How long a computed leaderboard is reused before being rebuilt from the player records. */
let boardTtlMs = 1500;
export function setBoardTtl(ms: number): void {
  boardTtlMs = ms;
}

const LETTERS = ["A", "B", "C", "D"] as const;
export type Letter = (typeof LETTERS)[number];

export type PublicQuestion = {
  id: number;
  number: number;
  total: number;
  text: string;
  options: Record<Letter, string>;
};

export type BoardRow = {
  name: string;
  score: number;
  answered: number;
  total: number;
  done: boolean;
};

export type Fail = { ok: false; error: string };

type StoredQuestion = {
  id: number;
  text: string;
  options: Record<Letter, string>;
  answer: Letter;
};

type Player = {
  key: string;
  name: string;
  score: number;
  correct: number;
  index: number;
  finished: boolean;
  deadline: number;
  joinedAt: number;
};

type Room = {
  code: string;
  adminKey: string;
  title: string;
  questions: StoredQuestion[];
  closed: boolean;
  seconds: number;
  createdAt: number;
};

type BoardEntry = BoardRow & { joinedAt: number };
type BoardCache = { at: number; rows: BoardEntry[] };

const roomKey = (code: string) => `room/${code}`;
const playerPrefix = (code: string) => `player/${code}/`;
const playerKeyOf = (code: string, key: string) => `${playerPrefix(code)}${key}`;
const nameKey = (code: string, name: string) => `name/${code}/${name.toLowerCase()}`;
const boardKey = (code: string) => `board/${code}`;

function fail(error: string): Fail {
  return { ok: false, error };
}

function isLetter(value: unknown): value is Letter {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function codeAlphabet(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(4);
  let code = "";
  for (let i = 0; i < 4; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

function publicQuestion(room: Room, index: number): PublicQuestion | null {
  const question = room.questions[index];
  if (!question) return null;
  return {
    id: question.id,
    number: index + 1,
    total: room.questions.length,
    text: question.text,
    options: question.options,
  };
}

/** A player is finished once they answered everything or their clock ran out. */
function isFinished(player: Player): boolean {
  return player.finished || Date.now() >= player.deadline;
}

function entryOf(room: Room, player: Player): BoardEntry {
  return {
    name: player.name,
    score: player.score,
    answered: player.index,
    total: room.questions.length,
    done: isFinished(player),
    joinedAt: player.joinedAt,
  };
}

function sortBoard(rows: BoardEntry[]): BoardEntry[] {
  return rows.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.joinedAt - b.joinedAt;
  });
}

function publicRows(rows: BoardEntry[]): BoardRow[] {
  return rows.map(({ name, score, answered, total, done }) => ({ name, score, answered, total, done }));
}

async function loadRoom(code: string): Promise<Room | null> {
  return (await kv()).get<Room>(roomKey(code));
}

async function loadPlayer(code: string, key: string): Promise<Player | null> {
  return (await kv()).get<Player>(playerKeyOf(code, key));
}

/** Board = every player record, cached briefly so many pollers cost one rebuild, not one each. */
async function boardRows(room: Room): Promise<BoardEntry[]> {
  const store = await kv();
  const hit = await store.get<BoardCache>(boardKey(room.code));
  if (hit && Date.now() - hit.at < boardTtlMs) return hit.rows;
  const keys = await store.list(playerPrefix(room.code));
  const players = await Promise.all(keys.map((key) => store.get<Player>(key)));
  const rows = sortBoard(players.filter((p): p is Player => p !== null).map((p) => entryOf(room, p)));
  await store.set(boardKey(room.code), { at: Date.now(), rows } satisfies BoardCache);
  return rows;
}

export type CreateInput = {
  title: string;
  seconds?: number;
  questions: { text: string; options: Record<Letter, string>; answer: Letter }[];
};

export async function createRoom(input: CreateInput): Promise<
  | {
      ok: true;
      code: string;
      adminKey: string;
      title: string;
      seconds: number;
      points: number;
      count: number;
    }
  | Fail
> {
  const title = cleanText(input.title, 40);
  if (title.length < 2) return fail("Give the quiz a short title.");
  if (
    !Array.isArray(input.questions) ||
    input.questions.length < MIN_QUESTIONS ||
    input.questions.length > MAX_QUESTIONS
  ) {
    return fail(`A quiz needs ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions.`);
  }
  const seconds = Number.isFinite(input.seconds)
    ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(input.seconds as number)))
    : DEFAULT_SECONDS;
  const questions: StoredQuestion[] = [];
  for (let i = 0; i < input.questions.length; i += 1) {
    const raw = input.questions[i];
    const text = cleanText(raw?.text, 140);
    if (text.length < 4) return fail(`Question ${i + 1} is too short.`);
    if (!raw?.options || !isLetter(raw.answer)) return fail(`Question ${i + 1} needs a right answer.`);
    const options = {} as Record<Letter, string>;
    for (const letter of LETTERS) {
      const option = cleanText(raw.options[letter], 48);
      if (!option) return fail(`Question ${i + 1} is missing option ${letter}.`);
      options[letter] = option;
    }
    const distinct = new Set(LETTERS.map((letter) => options[letter].toLowerCase()));
    if (distinct.size !== LETTERS.length) return fail(`Question ${i + 1} has two identical options.`);
    questions.push({ id: i + 1, text, options, answer: raw.answer });
  }
  const store = await kv();
  const adminKey = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    // Widen the code after a few collisions so a crowded keyspace still terminates.
    const code = attempt < 8 ? codeAlphabet() : codeAlphabet() + codeAlphabet().slice(0, 2);
    const room: Room = { code, adminKey, title, questions, closed: false, seconds, createdAt: Date.now() };
    if (await store.set(roomKey(code), room, { onlyIfNew: true })) {
      return { ok: true, code, adminKey, title, seconds, points: POINTS, count: questions.length };
    }
  }
  return fail("Could not allocate a join code. Try again.");
}

export async function roomBoard(code: string): Promise<
  | {
      ok: true;
      title: string;
      code: string;
      closed: boolean;
      seconds: number;
      points: number;
      questionCount: number;
      rows: BoardRow[];
    }
  | Fail
> {
  const room = await loadRoom(code);
  if (!room) return fail("No quiz with that code.");
  const rows = await boardRows(room);
  return {
    ok: true,
    title: room.title,
    code: room.code,
    closed: room.closed,
    seconds: room.seconds,
    points: POINTS,
    questionCount: room.questions.length,
    rows: publicRows(rows),
  };
}

export async function closeRoom(code: string, adminKey: string): Promise<{ ok: true } | Fail> {
  const room = await loadRoom(code);
  if (!room || !safeEqual(room.adminKey, adminKey)) return fail("This admin session cannot change that quiz.");
  room.closed = true;
  await (await kv()).set(roomKey(code), room);
  return { ok: true };
}

export type PlaySnap = {
  ok: true;
  title: string;
  name: string;
  score: number;
  correct: number;
  total: number;
  points: number;
  seconds: number;
  done: boolean;
  remaining: number;
  question: PublicQuestion | null;
  rank: number | null;
};

/** Rank among finished players. Uses the cached board but always with this player's live entry. */
async function rankOf(room: Room, player: Player): Promise<number | null> {
  if (!isFinished(player)) return null;
  const rows = await boardRows(room);
  const me = entryOf(room, player);
  const others = rows.filter((row) => row.joinedAt !== me.joinedAt || row.name !== me.name);
  return sortBoard([...others, me]).findIndex((row) => row.joinedAt === me.joinedAt && row.name === me.name) + 1;
}

async function snap(room: Room, player: Player): Promise<PlaySnap> {
  const done = isFinished(player);
  const remaining = done ? 0 : Math.max(0, Math.ceil((player.deadline - Date.now()) / 1000));
  return {
    ok: true,
    title: room.title,
    name: player.name,
    score: player.score,
    correct: player.correct,
    total: room.questions.length,
    points: POINTS,
    seconds: room.seconds,
    done,
    remaining,
    question: done ? null : publicQuestion(room, player.index),
    rank: await rankOf(room, player),
  };
}

export async function joinRoom(
  code: string,
  nameRaw: string,
): Promise<({ ok: true; playerKey: string } & PlaySnap) | Fail> {
  const room = await loadRoom(code);
  if (!room) return fail("No quiz with that code.");
  if (room.closed) return fail("The admin has closed this quiz.");
  const name = cleanText(nameRaw, 16);
  if (!/^[A-Za-z][A-Za-z0-9 ]{1,15}$/.test(name)) {
    return fail("Use a name of 2–16 letters.");
  }
  const store = await kv();
  // The name claim is atomic (create-if-absent), so two students cannot both get the same name.
  const claimed = await store.set(nameKey(code, name), { at: Date.now() }, { onlyIfNew: true });
  if (!claimed) return fail("That name is already in this quiz.");
  const existing = await store.list(playerPrefix(code));
  if (existing.length >= MAX_PLAYERS) {
    await store.delete(nameKey(code, name));
    return fail("This quiz is full.");
  }
  const player: Player = {
    key: randomBytes(16).toString("hex"),
    name,
    score: 0,
    correct: 0,
    index: 0,
    finished: false,
    deadline: Date.now() + room.seconds * 1000,
    joinedAt: Date.now(),
  };
  await store.set(playerKeyOf(code, player.key), player);
  return { ...(await snap(room, player)), playerKey: player.key };
}

export async function playerStatus(code: string, playerKey: string): Promise<PlaySnap | Fail> {
  const room = await loadRoom(code);
  if (!room) return fail("This quiz is no longer open.");
  const player = await loadPlayer(code, playerKey);
  if (!player) return fail("Join again with your name.");
  return snap(room, player);
}

export async function answerRoom(
  code: string,
  playerKey: string,
  questionId: number,
  choice: unknown,
): Promise<({ ok: true; marked: boolean; answer: Letter | null } & PlaySnap) | Fail> {
  const room = await loadRoom(code);
  if (!room) return fail("This quiz is no longer open.");
  const player = await loadPlayer(code, playerKey);
  if (!player) return fail("Join again with your name.");
  if (isFinished(player)) return { ...(await snap(room, player)), marked: false, answer: null };
  const current = room.questions[player.index];
  if (!current || current.id !== questionId) return fail("That question is already closed.");
  if (!isLetter(choice)) return fail("Choose A, B, C, or D.");
  const marked = choice === current.answer;
  if (marked) {
    player.score += POINTS;
    player.correct += 1;
  }
  player.index += 1;
  if (player.index >= room.questions.length) player.finished = true;
  await (await kv()).set(playerKeyOf(code, player.key), player);
  return { ...(await snap(room, player)), marked, answer: current.answer };
}
