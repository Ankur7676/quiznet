import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 5000;
const MAX_BYTES = 65_536;
const LOG_PATH = "/workspace/quiznet/server.log";

type Trace = { dir: "C→S" | "S→C"; text: string; at: string };

type Desk = {
  id: string;
  username: string;
  sessionId: string | null;
  socket: net.Socket;
  buf: Buffer;
  queue: JsonObject[];
  trace: Trace[];
  waiters: Array<() => void>;
  closed: boolean;
  error: string | null;
  created: number;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

export type BridgeSnap = {
  ok: boolean;
  error?: string;
  deskId?: string;
  connected?: boolean;
  sessionId?: string | null;
  messages?: JsonObject[];
  trace?: Trace[];
};

const STORE_KEY = Symbol.for("quiznet.desk-store");

type DeskStore = { desks: Map<string, Desk> };

function deskStore(): Map<string, Desk> {
  const root = globalThis as typeof globalThis & { [key: symbol]: DeskStore };
  if (!root[STORE_KEY]) root[STORE_KEY] = { desks: new Map() };
  return root[STORE_KEY].desks;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function notify(desk: Desk): void {
  const waiters = desk.waiters.splice(0);
  for (const wake of waiters) wake();
}

function remember(desk: Desk, message: JsonObject): void {
  if (typeof message.session_id === "string" && message.session_id) {
    desk.sessionId = message.session_id;
  }
}

function pushLine(desk: Desk, line: string): void {
  desk.trace.push({ dir: "S→C", text: line, at: stamp() });
  if (desk.trace.length > 40) desk.trace.splice(0, desk.trace.length - 40);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    desk.error = "The server sent a line that was not JSON.";
    notify(desk);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    desk.error = "The server sent a JSON value that was not an object.";
    notify(desk);
    return;
  }
  const message = parsed as JsonObject;
  remember(desk, message);
  desk.queue.push(message);
  notify(desk);
}

function bindSocket(desk: Desk, socket: net.Socket): void {
  socket.on("data", (chunk: Buffer) => {
    desk.buf = desk.buf.length === 0 ? chunk : Buffer.concat([desk.buf, chunk]);
    if (desk.buf.length > MAX_BYTES && !desk.buf.includes(0x0a)) {
      desk.error = "A server message exceeded the size limit.";
      socket.destroy();
      return;
    }
    while (true) {
      const idx = desk.buf.indexOf(0x0a);
      if (idx < 0) break;
      const line = desk.buf.subarray(0, idx).toString("utf8").replace(/\r$/, "");
      desk.buf = desk.buf.subarray(idx + 1);
      if (line.trim()) pushLine(desk, line);
    }
  });
  socket.on("error", (err: Error) => {
    desk.error = err.message;
    desk.closed = true;
    notify(desk);
  });
  socket.on("close", () => {
    desk.closed = true;
    notify(desk);
  });
}

function writeJson(desk: Desk, payload: JsonObject): void {
  if (desk.closed) throw new Error("The TCP connection is closed.");
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line) + 1 > MAX_BYTES) {
    throw new Error("Message is too large.");
  }
  desk.socket.write(`${line}\n`);
  desk.trace.push({ dir: "C→S", text: line, at: stamp() });
  if (desk.trace.length > 40) desk.trace.splice(0, desk.trace.length - 40);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(desk: Desk, ms: number): Promise<void> {
  if (desk.queue.length > 0 || desk.closed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      desk.waiters = desk.waiters.filter((item) => item !== done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    desk.waiters.push(done);
  });
}

function snapshot(desk: Desk, ok = true, error?: string): BridgeSnap {
  const messages = desk.queue.splice(0);
  return {
    ok,
    error: error ?? desk.error ?? undefined,
    deskId: desk.id,
    connected: !desk.closed,
    sessionId: desk.sessionId,
    messages,
    trace: desk.trace.slice(-12),
  };
}

function prune(): void {
  const desks = deskStore();
  if (desks.size <= 12) return;
  const oldest = [...desks.values()].sort((a, b) => a.created - b.created)[0];
  if (oldest) {
    oldest.socket.destroy();
    desks.delete(oldest.id);
  }
}

export async function labStatus(): Promise<{ listening: boolean; log: string }> {
  const listening = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let settled = false;
    const finish = (up: boolean) => {
      if (settled) return;
      settled = true;
      if (!up) socket.destroy();
      resolve(up);
    };
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.end();
      finish(true);
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
  return { listening, log: readLog() };
}

function readLog(): string {
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf8");
    return raw.trim().split(/\r?\n/).slice(-30).join("\n");
  } catch {
    return "";
  }
}

export async function connectDesk(username: string): Promise<BridgeSnap> {
  const name = username.trim();
  if (!name) return { ok: false, error: "Username is required." };
  prune();
  const desk: Desk = {
    id: randomUUID(),
    username: name,
    sessionId: null,
    socket: new net.Socket(),
    buf: Buffer.alloc(0),
    queue: [],
    trace: [],
    waiters: [],
    closed: false,
    error: null,
    created: Date.now(),
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = net.connect({ host: HOST, port: PORT });
      desk.socket = socket;
      bindSocket(desk, socket);
      socket.setTimeout(2500);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        resolve();
      });
      socket.once("timeout", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Timed out reaching the QuizNet server."));
      });
      socket.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : "Connection failed.";
    const refused = text.includes("ECONNREFUSED") || text.toLowerCase().includes("refused");
    return {
      ok: false,
      error: refused
        ? "The Python quiz server is not listening. It should be on port 5000 on this lab machine."
        : `Could not open a TCP connection: ${text}`,
    };
  }

  const desks = deskStore();
  desks.set(desk.id, desk);
  try {
    writeJson(desk, { type: "JOIN", username: name });
  } catch (err) {
    desks.delete(desk.id);
    desk.socket.destroy();
    return { ok: false, error: err instanceof Error ? err.message : "JOIN failed." };
  }

  const started = Date.now();
  while (Date.now() - started < 2500 && desk.queue.length === 0 && !desk.closed) {
    await waitFor(desk, 2500 - (Date.now() - started));
  }
  const first = desk.queue[0];
  if (!first) {
    desk.socket.destroy();
    desks.delete(desk.id);
    return { ok: false, error: desk.error ?? "The server did not answer JOIN." };
  }
  if (first.type === "ERROR") {
    const snap = snapshot(desk, false, String(first.message ?? "JOIN was rejected."));
    desk.socket.destroy();
    desks.delete(desk.id);
    return { ...snap, connected: false, messages: [first] };
  }
  return snapshot(desk);
}

function requireDesk(deskId: string): Desk | BridgeSnap {
  const desk = deskStore().get(deskId);
  if (!desk || desk.closed) {
    return { ok: false, error: "That desk is not connected.", connected: false };
  }
  return desk;
}

export async function sendDesk(deskId: string, message: JsonObject): Promise<BridgeSnap> {
  const found = requireDesk(deskId);
  if (!("socket" in found)) return found;
  const desk = found;
  const type = message.type;
  if (type !== "START_QUIZ" && type !== "SUBMIT_ANSWER" && type !== "GET_LEADERBOARD" && type !== "DISCONNECT") {
    return snapshot(desk, false, "That message type is not allowed from the console.");
  }
  const sessionId = typeof message.session_id === "string" ? message.session_id : "";
  if (!desk.sessionId || sessionId !== desk.sessionId) {
    return snapshot(desk, false, "Session id does not match this TCP connection.");
  }
  const payload: JsonObject = { type, session_id: desk.sessionId ?? "" };
  if (type === "SUBMIT_ANSWER") {
    const questionId = message.question_id;
    const answer = message.answer;
    if (typeof questionId !== "number" || !Number.isInteger(questionId)) {
      return snapshot(desk, false, "question_id must be an integer.");
    }
    if (answer !== "A" && answer !== "B" && answer !== "C" && answer !== "D") {
      return snapshot(desk, false, "Answer must be A, B, C, or D.");
    }
    payload.question_id = questionId;
    payload.answer = answer;
  }
  try {
    writeJson(desk, payload);
  } catch (err) {
    return snapshot(desk, false, err instanceof Error ? err.message : "Send failed.");
  }
  const started = Date.now();
  while (Date.now() - started < 1200 && desk.queue.length === 0 && !desk.closed) {
    await waitFor(desk, 80);
  }
  if (desk.queue.length > 0) await sleep(80);
  const snap = snapshot(desk);
  if (type === "DISCONNECT") {
    desk.socket.end();
  }
  return snap;
}

export function pullDesk(deskId: string): BridgeSnap {
  const desk = deskStore().get(deskId);
  if (!desk) return { ok: false, error: "Unknown desk.", connected: false };
  return snapshot(desk, !desk.closed || desk.queue.length > 0);
}
