import { useEffect, useState } from "react";
import { Cable, Radio, Server, Timer, Trophy } from "lucide-react";
import { getLabStatus, joinDesk, pollDesk, talkDesk } from "@/lib/quiznet.functions";

type Trace = { dir: string; text: string; at: string };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Msg = { [key: string]: JsonValue };

type Question = {
  question_id: number;
  number: number;
  total: number;
  topic: string;
  text: string;
  options: Record<string, string>;
};

type QuizResult = {
  score: number;
  correct: number;
  wrong: number;
  unanswered: number;
  total: number;
  percentage: number;
  duration_seconds: number;
  status: string;
};

type BoardRow = {
  rank: number;
  username: string;
  score: number;
  duration_seconds: number;
  status: string;
};

type Phase = "home" | "lobby" | "quiz" | "result";

type DeskState = {
  phase: Phase;
  deskId: string | null;
  sessionId: string | null;
  connected: boolean;
  busy: boolean;
  error: string;
  banner: string;
  tone: "ok" | "bad" | "muted";
  question: Question | null;
  selected: string;
  locked: boolean;
  result: QuizResult | null;
  remaining: number;
  syncedAt: number;
};

type Snap = {
  ok: boolean;
  error?: string;
  deskId?: string;
  connected?: boolean;
  sessionId?: string | null;
  messages?: Msg[];
  trace?: Trace[];
};

const primaryBtn =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-ink disabled:opacity-50";
const ghostBtn =
  "inline-flex h-11 items-center justify-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-fg disabled:opacity-50";

function asBoard(value: JsonValue | undefined): BoardRow[] {
  if (!Array.isArray(value)) return [];
  const rows: BoardRow[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    rows.push({
      rank: typeof item.rank === "number" ? item.rank : 0,
      username: typeof item.username === "string" ? item.username : "",
      score: typeof item.score === "number" ? item.score : 0,
      duration_seconds: typeof item.duration_seconds === "number" ? item.duration_seconds : 0,
      status: typeof item.status === "string" ? item.status : "",
    });
  }
  return rows;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(mins).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function durationLabel(seconds: number): string {
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    return `${mins}m ${(seconds - mins * 60).toFixed(1)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function fresh(name: string): DeskState {
  return {
    phase: "home",
    deskId: null,
    sessionId: null,
    connected: false,
    busy: false,
    error: "",
    banner: "",
    tone: "muted",
    question: null,
    selected: "",
    locked: false,
    result: null,
    remaining: 120,
    syncedAt: Date.now(),
  };
}

function asQuestion(message: Msg): Question {
  const options = message.options;
  const clean: Record<string, string> = {};
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    for (const key of ["A", "B", "C", "D"]) {
      const value = options[key];
      clean[key] = typeof value === "string" ? value : "";
    }
  }
  return {
    question_id: num(message.question_id),
    number: num(message.number, 1),
    total: num(message.total, 10),
    topic: text(message.topic),
    text: text(message.text),
    options: clean,
  };
}

function asResult(message: Msg): QuizResult {
  return {
    score: num(message.score),
    correct: num(message.correct),
    wrong: num(message.wrong),
    unanswered: num(message.unanswered),
    total: num(message.total, 10),
    percentage: num(message.percentage),
    duration_seconds: num(message.duration_seconds),
    status: text(message.status),
  };
}

function applyMessage(state: DeskState, message: Msg): DeskState {
  const next: DeskState = { ...state, busy: false };
  if (typeof message.session_id === "string" && message.session_id) {
    next.sessionId = message.session_id;
  }
  if (typeof message.remaining_seconds === "number") {
    next.remaining = message.remaining_seconds;
    next.syncedAt = Date.now();
  }
  switch (message.type) {
    case "JOIN_ACK":
      next.phase = "lobby";
      next.connected = true;
      next.error = "";
      next.banner = text(message.message, "Connected.");
      next.tone = "ok";
      break;
    case "QUESTION":
      next.phase = "quiz";
      next.question = asQuestion(message);
      next.selected = "";
      next.locked = false;
      next.error = "";
      break;
    case "ANSWER_FEEDBACK": {
      const correct = message.correct === true;
      next.locked = true;
      next.tone = correct ? "ok" : "bad";
      next.banner = correct
        ? `Correct. Server score is now ${num(message.score)}.`
        : `Incorrect. The server says ${text(message.correct_option)} was right. Score ${num(message.score)}.`;
      break;
    }
    case "QUIZ_RESULT":
      next.phase = "result";
      next.result = asResult(message);
      next.locked = true;
      next.banner =
        message.status === "timeout"
          ? "The server closed the attempt because the 120-second deadline passed."
          : "The server stored this result.";
      next.tone = message.status === "completed" ? "ok" : "bad";
      break;
    case "ERROR": {
      const code = text(message.code);
      const detail = text(message.message, "The server rejected that message.");
      next.error = detail;
      next.banner = detail;
      next.tone = "bad";
      if (code === "DUPLICATE_USERNAME" || code === "BAD_USERNAME") {
        next.phase = "home";
        next.connected = false;
        next.deskId = null;
        next.sessionId = null;
      }
      if (code === "INVALID_OPTION") next.locked = false;
      break;
    }
    case "DISCONNECT":
      next.phase = "home";
      next.connected = false;
      next.deskId = null;
      next.sessionId = null;
      next.banner = "Disconnected.";
      next.tone = "muted";
      break;
    default:
      break;
  }
  return next;
}

function Desk({
  title,
  initialName,
  active,
  onTrace,
  onBoard,
}: {
  title: string;
  initialName: string;
  active: boolean;
  onTrace: (id: string, trace: Trace[]) => void;
  onBoard: (rows: BoardRow[]) => void;
}) {
  const [name, setName] = useState(initialName);
  const [state, setState] = useState<DeskState>(() => fresh(initialName));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state.phase !== "quiz") return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [state.phase]);

  useEffect(() => {
    if (!state.deskId || !state.connected) return;
    let stop = false;
    const id = window.setInterval(() => {
      const deskId = state.deskId;
      if (!deskId || stop) return;
      void pollDesk({ data: { deskId } })
        .then((snap) => {
          if (!stop) ingest(snap);
        })
        .catch(() => {
          if (!stop) {
            setState((prev) => ({
              ...prev,
              error: "Lost contact with the lab relay.",
            }));
          }
        });
    }, 700);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [state.deskId, state.connected]);

  function ingest(snap: Snap) {
    if (snap.deskId && snap.trace) onTrace(snap.deskId, snap.trace);
    const messages = snap.messages ?? [];
    for (const message of messages) {
      if (message.type === "LEADERBOARD") onBoard(asBoard(message.entries));
    }
    setState((prev) => {
      let next = messages.reduce(applyMessage, prev);
      if (snap.sessionId) next = { ...next, sessionId: snap.sessionId };
      if (snap.connected === false && next.phase !== "home") {
        next = {
          ...next,
          connected: false,
          error: snap.error || next.error || "The TCP connection closed.",
        };
      }
      if (snap.ok === false && snap.error && messages.length === 0) {
        next = { ...next, busy: false, error: snap.error, banner: snap.error, tone: "bad" };
      }
      return next;
    });
  }

  async function connect() {
    setState((prev) => ({ ...prev, busy: true, error: "", banner: "" }));
    try {
      const snap = await joinDesk({ data: { username: name } });
      if (!snap.ok && !snap.messages?.length) {
        setState((prev) => ({
          ...prev,
          busy: false,
          error: snap.error || "Could not connect.",
          phase: "home",
          connected: false,
        }));
        return;
      }
      setState((prev) => {
        const base = { ...prev, deskId: snap.deskId ?? prev.deskId, busy: false };
        return (snap.messages ?? []).reduce(applyMessage, base);
      });
      if (snap.deskId && snap.trace) onTrace(snap.deskId, snap.trace);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        busy: false,
        error: err instanceof Error ? err.message : "Could not connect.",
      }));
    }
  }

  async function send(message: Msg) {
    if (!state.deskId || !state.sessionId) return;
    setState((prev) => ({ ...prev, busy: true, error: "" }));
    try {
      const snap = await talkDesk({
        data: { deskId: state.deskId, message: { ...message, session_id: state.sessionId } },
      });
      ingest(snap);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        busy: false,
        error: err instanceof Error ? err.message : "Send failed.",
      }));
    }
  }

  const remain =
    state.phase === "quiz" ? Math.max(0, state.remaining - (now - state.syncedAt) / 1000) : state.remaining;
  const question = state.question;
  const progress = question
    ? ((state.locked ? question.number : question.number - 1) / question.total) * 100
    : 0;
  const hidden = active ? "" : "hidden md:block";

  return (
    <section className={`rounded-lg border border-line bg-card p-4 ${hidden}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className={state.connected ? "text-sm font-medium text-accent" : "text-sm text-muted"}>
          {state.connected ? "TCP connected" : "Not connected"}
        </span>
      </div>

      {state.phase === "home" && (
        <div className="space-y-3">
          <label className="block text-sm text-muted" htmlFor={`${title}-name`}>
            Username
          </label>
          <input
            id={`${title}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-fg outline-none focus:border-primary"
            autoComplete="off"
          />
          <button type="button" className={primaryBtn} disabled={state.busy} onClick={() => void connect()}>
            {state.busy ? "Connecting" : "Connect"}
          </button>
        </div>
      )}

      {state.phase === "lobby" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Ten questions, ten points each, 120 seconds on the server clock. This desk does not have the answer key.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryBtn} disabled={state.busy} onClick={() => void send({ type: "START_QUIZ" })}>
              Start quiz
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={state.busy}
              onClick={() => void send({ type: "GET_LEADERBOARD" })}
            >
              Leaderboard
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={state.busy}
              onClick={() => void send({ type: "DISCONNECT" })}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {state.phase === "quiz" && question && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-primary">
              Question {question.number} of {question.total}
              <span className="mt-1 block text-muted">{question.topic}</span>
            </p>
            <p className={`font-mono text-lg font-medium ${remain <= 15 ? "text-danger" : "text-fg"}`}>
              <Timer className="mr-1 inline size-4" aria-hidden="true" />
              {clock(remain)}
            </p>
          </div>
          <p className="text-base font-medium leading-snug">{question.text}</p>
          <div className="space-y-2" role="radiogroup" aria-label="Answer choices">
            {(["A", "B", "C", "D"] as const).map((key) => {
              const chosen = state.selected === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  disabled={state.locked || state.busy}
                  onClick={() => setState((prev) => ({ ...prev, selected: key }))}
                  className={`flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm ${
                    chosen ? "border-primary bg-surface" : "border-line bg-card"
                  } disabled:opacity-70`}
                >
                  <span className="font-mono text-primary">{key}</span>
                  <span>{question.options[key]}</span>
                </button>
              );
            })}
          </div>
          <div className="h-2 overflow-hidden rounded-lg bg-surface" aria-hidden="true">
            <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryBtn}
              disabled={state.busy || state.locked}
              onClick={() => {
                if (!state.selected) {
                  setState((prev) => ({
                    ...prev,
                    banner: "Select an option before submitting.",
                    tone: "bad",
                  }));
                  return;
                }
                void send({
                  type: "SUBMIT_ANSWER",
                  question_id: question.question_id,
                  answer: state.selected,
                });
              }}
            >
              Submit answer
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={state.busy}
              onClick={() => void send({ type: "GET_LEADERBOARD" })}
            >
              Leaderboard
            </button>
          </div>
        </div>
      )}

      {state.phase === "result" && state.result && (
        <div className="space-y-3">
          <p className="font-mono text-3xl font-medium text-primary">
            {state.result.score}
            <span className="text-lg text-muted"> / 100</span>
          </p>
          <ul className="space-y-1 text-sm">
            <li>Correct: {state.result.correct}</li>
            <li>Wrong: {state.result.wrong}</li>
            <li>Unanswered: {state.result.unanswered}</li>
            <li>Percentage: {state.result.percentage}%</li>
            <li>Time: {durationLabel(state.result.duration_seconds)}</li>
            <li>Status: {state.result.status}</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryBtn} disabled={state.busy} onClick={() => void send({ type: "START_QUIZ" })}>
              New quiz
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={state.busy}
              onClick={() => void send({ type: "GET_LEADERBOARD" })}
            >
              Leaderboard
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={state.busy}
              onClick={() => void send({ type: "DISCONNECT" })}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {state.banner && (
        <p className={`mt-3 text-sm ${state.tone === "ok" ? "text-accent" : state.tone === "bad" ? "text-danger" : "text-muted"}`}>
          {state.banner}
        </p>
      )}
      {state.error && state.error !== state.banner && <p className="mt-2 text-sm text-danger">{state.error}</p>}
    </section>
  );
}

export function QuizLab() {
  const [desk, setDesk] = useState<0 | 1>(0);
  const [listening, setListening] = useState<boolean | null>(null);
  const [log, setLog] = useState("Waiting for the server log.");
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [traces, setTraces] = useState<Record<string, Trace[]>>({});

  useEffect(() => {
    let stop = false;
    const load = () => {
      void getLabStatus()
        .then((status) => {
          if (stop) return;
          setListening(status.listening);
          setLog(status.log || "No server log yet.");
        })
        .catch(() => {
          if (!stop) setListening(false);
        });
    };
    load();
    const id = window.setInterval(load, 3000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const wire = Object.entries(traces)
    .flatMap(([id, rows]) => rows.map((row) => ({ ...row, id: id.slice(0, 4) })))
    .slice(-10)
    .reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <Server className="size-4 text-primary" aria-hidden="true" />
          {listening === null ? "Checking TCP port" : listening ? "Python server listening" : "Python server not reachable"}
        </span>
        <a className={ghostBtn} href="/QuizNet-source.zip">
          Download source
        </a>
      </div>

      <div className="grid grid-cols-2 gap-2 md:hidden">
        <button type="button" className={desk === 0 ? primaryBtn : ghostBtn} onClick={() => setDesk(0)}>
          Desk A
        </button>
        <button type="button" className={desk === 1 ? primaryBtn : ghostBtn} onClick={() => setDesk(1)}>
          Desk B
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Desk
          title="Desk A"
          initialName="Asha"
          active={desk === 0}
          onTrace={(id, trace) => setTraces((prev) => ({ ...prev, [id]: trace }))}
          onBoard={setBoard}
        />
        <Desk
          title="Desk B"
          initialName="Rohan"
          active={desk === 1}
          onTrace={(id, trace) => setTraces((prev) => ({ ...prev, [id]: trace }))}
          onBoard={setBoard}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-line bg-card p-4 lg:col-span-1">
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
            <Trophy className="size-4 text-primary" aria-hidden="true" />
            Leaderboard
          </h2>
          {board.length === 0 ? (
            <p className="text-sm text-muted">Finished attempts show up here after a desk requests the board.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-2 font-medium">#</th>
                    <th className="py-1 pr-2 font-medium">Name</th>
                    <th className="py-1 pr-2 font-medium">Score</th>
                    <th className="py-1 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((row) => (
                    <tr key={`${row.rank}-${row.username}`} className="border-t border-line">
                      <td className="py-2 pr-2">{row.rank}</td>
                      <td className="py-2 pr-2">{row.username}</td>
                      <td className="py-2 pr-2">{row.score}</td>
                      <td className="py-2">{durationLabel(row.duration_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-line bg-card p-4 lg:col-span-1">
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
            <Cable className="size-4 text-primary" aria-hidden="true" />
            TCP frames
          </h2>
          {wire.length === 0 ? (
            <p className="text-sm text-muted">JSON lines appear here as soon as a desk connects.</p>
          ) : (
            <ol className="max-h-64 space-y-2 overflow-auto font-mono text-xs leading-relaxed">
              {wire.map((row, index) => (
                <li key={`${row.at}-${index}`} className="break-all text-muted">
                  <span className={row.dir === "C→S" ? "text-primary" : "text-accent"}>{row.dir}</span> {row.text}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="rounded-lg border border-line bg-card p-4 lg:col-span-1">
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
            <Radio className="size-4 text-primary" aria-hidden="true" />
            Server log
          </h2>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted">
            {log}
          </pre>
        </section>
      </div>
    </div>
  );
}
