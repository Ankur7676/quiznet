import { useCallback, useEffect, useState } from "react";
import { Check, CircleCheck, CircleX, KeyRound, LogOut, User, GraduationCap } from "lucide-react";
import { getBoard, joinQuiz, quizStatus, submitAnswer } from "@/lib/quiz-room.functions";
import { Trophy } from "lucide-react";
import {
  AppHeader,
  BOARD_POLL_MS,
  ErrorLine,
  LETTERS,
  Leaderboard,
  card,
  cleanCode,
  clock,
  field,
  filled,
  kicker,
  messageOf,
  outline,
  readStorage,
  writeStorage,
  type Letter,
  type Row,
} from "./shared";

type Question = {
  id: number;
  number: number;
  total: number;
  text: string;
  options: Record<Letter, string>;
};

type Play = {
  title: string;
  name: string;
  score: number;
  correct: number;
  total: number;
  points: number;
  seconds: number;
  done: boolean;
  remaining: number;
  question: Question | null;
  rank: number | null;
};

type Review = {
  number: number;
  total: number;
  text: string;
  options: Record<Letter, string>;
  choice: Letter;
  marked: boolean;
  answer: Letter | null;
  done: boolean;
};

const WARN_SECONDS = 60;
const URGENT_SECONDS = 20;
const PLAYER_CODE = "quiznet.player.code";
const PLAYER_KEY = "quiznet.player.key";
const PLAYER_NAME = "quiznet.player.name";

function fromSnap(snap: Play): Play {
  return {
    title: snap.title,
    name: snap.name,
    score: snap.score,
    correct: snap.correct,
    total: snap.total,
    points: snap.points,
    seconds: snap.seconds,
    done: snap.done,
    remaining: snap.remaining,
    question: snap.question,
    rank: snap.rank,
  };
}

export function StudentPage({ initialCode }: { initialCode?: string }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => cleanCode(initialCode ?? ""));
  const [playerKey, setPlayerKey] = useState("");
  const [play, setPlay] = useState<Play | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [history, setHistory] = useState<boolean[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [syncedAt, setSyncedAt] = useState(() => Date.now());

  // Resume a session after reload — unless the visitor arrived with a fresh join link for a different quiz.
  useEffect(() => {
    const savedCode = readStorage(PLAYER_CODE);
    const savedKey = readStorage(PLAYER_KEY);
    const savedName = readStorage(PLAYER_NAME);
    if (savedName) setName(savedName);
    const linked = cleanCode(initialCode ?? "");
    if ((linked && linked !== savedCode) || !savedCode || !savedKey) {
      setBooting(false);
      return;
    }
    setCode(savedCode);
    setPlayerKey(savedKey);
    quizStatus({ data: { code: savedCode, playerKey: savedKey } })
      .then((snap) => {
        if (!snap.ok) {
          writeStorage(PLAYER_CODE, "");
          writeStorage(PLAYER_KEY, "");
          setPlayerKey("");
          return;
        }
        setPlay(fromSnap(snap));
        setSyncedAt(Date.now());
      })
      .catch(() => setPlayerKey(""))
      .finally(() => setBooting(false));
  }, [initialCode]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const remaining = play
    ? play.done
      ? 0
      : Math.max(0, play.remaining - Math.floor((now - syncedAt) / 1000))
    : 0;

  const awaitingExpiry = Boolean(play && !play.done && playerKey && remaining <= 0);

  // Ask the server at expiry; retry until the authoritative result arrives.
  useEffect(() => {
    if (!awaitingExpiry) return;
    let stopped = false;
    const sync = () => {
      void quizStatus({ data: { code, playerKey } })
        .then((snap) => {
          if (stopped || !snap.ok) return;
          setPlay(fromSnap(snap));
          setSyncedAt(Date.now());
          if (snap.done) setReview(null);
        })
        .catch(() => {
          /* The next poll retries without stopping the local timer. */
        });
    };
    const id = window.setInterval(sync, 1000);
    sync();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [awaitingExpiry, playerKey, code]);

  async function join() {
    setBusy(true);
    setError("");
    try {
      const snap = await joinQuiz({ data: { code, name } });
      if (!snap.ok) {
        setError(snap.error);
        return;
      }
      const nextCode = cleanCode(code);
      writeStorage(PLAYER_CODE, nextCode);
      writeStorage(PLAYER_KEY, snap.playerKey);
      writeStorage(PLAYER_NAME, snap.name);
      setCode(nextCode);
      setPlayerKey(snap.playerKey);
      setReview(null);
      setHistory([]);
      setPlay(fromSnap(snap));
      setSyncedAt(Date.now());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const choose = useCallback(
    async (letter: Letter) => {
      if (!play?.question || review || busy) return;
      const asked = play.question;
      setBusy(true);
      setError("");
      try {
        const snap = await submitAnswer({
          data: { code, playerKey, questionId: asked.id, choice: letter },
        });
        if (!snap.ok) {
          setError(snap.error);
          return;
        }
        setPlay(fromSnap(snap));
        if (snap.answer === null) {
          setReview(null);
          setSyncedAt(Date.now());
          return;
        }
        setHistory((prev) => [...prev, snap.marked]);
        setReview({
          number: asked.number,
          total: asked.total,
          text: asked.text,
          options: asked.options,
          choice: letter,
          marked: snap.marked,
          answer: snap.answer,
          done: snap.done,
        });
        setSyncedAt(Date.now());
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [play, review, busy, code, playerKey],
  );

  function leave() {
    writeStorage(PLAYER_CODE, "");
    writeStorage(PLAYER_KEY, "");
    setPlayerKey("");
    setPlay(null);
    setReview(null);
    setHistory([]);
    setError("");
  }

  // Keyboard: A-D / 1-4 answer, Enter or N moves on.
  useEffect(() => {
    if (!play?.question && !review) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = event.key.toUpperCase();
      if (review) {
        if (key === "ENTER" || key === "N") setReview(null);
        return;
      }
      const index = "1234".indexOf(key);
      const letter =
        index >= 0 ? LETTERS[index] : (LETTERS as string[]).includes(key) ? (key as Letter) : null;
      if (letter) void choose(letter);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, review, choose]);

  let body;
  if (booting) {
    body = <p className="text-sm text-muted">Loading…</p>;
  } else if (!play) {
    body = (
      <JoinForm
        name={name}
        setName={setName}
        code={code}
        setCode={setCode}
        busy={busy}
        error={error}
        onJoin={() => void join()}
      />
    );
  } else if (play.done && !review) {
    body = <Results play={play} code={code} history={history} onLeave={leave} />;
  } else {
    body = (
      <Playing
        play={play}
        review={review}
        history={history}
        remaining={remaining}
        busy={busy}
        error={error}
        onChoose={(letter) => void choose(letter)}
        onNext={() => setReview(null)}
      />
    );
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="student-body">{body}</main>
    </div>
  );
}

function JoinForm({
  name,
  setName,
  code,
  setCode,
  busy,
  error,
  onJoin,
}: {
  name: string;
  setName: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  busy: boolean;
  error: string;
  onJoin: () => void;
}) {
  return (
    <section aria-label="Join a quiz">
      <div className="student-intro">
        <GraduationCap className="mb-4 size-8" />
        <p className="text-xs font-semibold uppercase tracking-widest">Student workspace</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Join a quiz</h1>
        <p className="mt-1 text-sm text-muted">Enter your name and the code from your teacher.</p>
      </div>
      <form
        className={`${card} mt-6`}
        onSubmit={(event) => {
          event.preventDefault();
          onJoin();
        }}
      >
        <label className="flex items-center gap-2 text-sm font-semibold" htmlFor="student-name">
          <User className="size-4 text-muted" aria-hidden="true" />
          Your name
        </label>
        <input
          id="student-name"
          className={`${field} mt-2`}
          value={name}
          maxLength={16}
          minLength={2}
          required
          autoComplete="nickname"
          placeholder="e.g. Asha"
          onChange={(event) => setName(event.target.value)}
        />
        <label
          className="mt-5 flex items-center gap-2 text-sm font-semibold"
          htmlFor="student-code"
        >
          <KeyRound className="size-4 text-muted" aria-hidden="true" />
          Code
        </label>
        <input
          id="student-code"
          className={`${field} mt-2 h-16 text-center font-mono text-3xl uppercase tracking-[0.3em]`}
          value={code}
          maxLength={6}
          minLength={4}
          required
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ABCD"
          onChange={(event) => setCode(cleanCode(event.target.value))}
        />
        <ErrorLine message={error} />
        <button
          type="submit"
          className={`${filled} mt-6 w-full`}
          disabled={busy || name.trim().length < 2 || code.length < 4}
        >
          {busy ? "Joining…" : "Join quiz"}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-muted">Your clock starts the moment you join.</p>
    </section>
  );
}

function Playing({
  play,
  review,
  history,
  remaining,
  busy,
  error,
  onChoose,
  onNext,
}: {
  play: Play;
  review: Review | null;
  history: boolean[];
  remaining: number;
  busy: boolean;
  error: string;
  onChoose: (letter: Letter) => void;
  onNext: () => void;
}) {
  const question = review
    ? { number: review.number, total: review.total, text: review.text, options: review.options }
    : play.question;
  const urgent = remaining <= URGENT_SECONDS;
  const warn = remaining <= WARN_SECONDS;
  const total = question?.total ?? play.total;
  const current = question?.number ?? total;
  const timePct = play.seconds > 0 ? Math.min(100, (remaining / play.seconds) * 100) : 0;

  return (
    <section aria-label="Quiz in progress">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={`${kicker} truncate`}>{play.title}</p>
          <h1 className="mt-1 text-xl font-bold tracking-tight">
            Question {current} <span className="text-muted">of {total}</span>
          </h1>
        </div>
        <p
          role="timer"
          aria-label={`${clock(remaining)} left`}
          className={`rounded-full px-3.5 py-1.5 font-mono text-lg font-medium tabular-nums ${
            urgent
              ? "bg-danger-soft text-danger"
              : warn
                ? "bg-warn-soft text-warn"
                : "bg-primary-soft text-primary"
          }`}
        >
          {clock(remaining)}
        </p>
      </div>

      <ol className="mt-4 flex gap-1.5" aria-label="Progress">
        {Array.from({ length: total }, (_, i) => {
          const result = history[i];
          const tone =
            result === true
              ? "bg-success"
              : result === false
                ? "bg-danger"
                : i + 1 === current
                  ? "bg-primary"
                  : "bg-line";
          return (
            <li
              key={i}
              className={`h-2 flex-1 rounded-full transition-colors duration-200 ${tone}`}
              aria-label={`Question ${i + 1}: ${result === true ? "correct" : result === false ? "wrong" : i + 1 === current ? "current" : "not yet"}`}
            />
          );
        })}
      </ol>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label="Time left"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(timePct)}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${urgent ? "bg-danger" : warn ? "bg-warn" : "bg-primary"}`}
          style={{ width: `${timePct}%` }}
        />
      </div>

      {question && (
        <div className={`${card} mt-5`}>
          <p className="text-xl font-semibold leading-snug">{question.text}</p>
          <div className="mt-5 grid gap-2.5">
            {LETTERS.map((letter) => {
              const picked = review?.choice === letter;
              const right = review?.answer === letter;
              let tone = "border-line bg-surface hover:border-primary";
              if (review) {
                if (right) tone = "border-success bg-success-soft";
                else if (picked) tone = "border-danger bg-danger-soft";
                else tone = "border-line bg-surface opacity-60";
              }
              return (
                <button
                  key={letter}
                  type="button"
                  aria-label={`${letter}. ${question.options[letter]}`}
                  disabled={busy || review !== null}
                  className={`flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3.5 py-3 text-left text-base transition active:scale-[0.99] disabled:pointer-events-none ${tone}`}
                  onClick={() => onChoose(letter)}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-lg font-mono text-sm font-medium ${
                      review && right
                        ? "bg-success text-primary-ink"
                        : review && picked
                          ? "bg-danger text-primary-ink"
                          : "bg-primary-soft text-primary"
                    }`}
                  >
                    {review && right ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : review && picked ? (
                      <CircleX className="size-4" aria-hidden="true" />
                    ) : (
                      letter
                    )}
                  </span>
                  <span className="flex-1">{question.options[letter]}</span>
                </button>
              );
            })}
          </div>
          {review ? (
            <p
              role="status"
              className={`mt-4 flex items-center gap-2 rounded-xl px-3.5 py-3 text-sm font-semibold ${
                review.marked ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
              }`}
            >
              {review.marked ? (
                <CircleCheck className="size-4" aria-hidden="true" />
              ) : (
                <CircleX className="size-4" aria-hidden="true" />
              )}
              {review.marked
                ? `Correct. +${play.points} points.`
                : `Not quite.${review.answer ? ` The answer was ${review.answer}.` : ""} +0 points.`}
            </p>
          ) : (
            <p className="mt-4 hidden text-center text-xs text-muted sm:block">
              Tip: press A, B, C or D to answer.
            </p>
          )}
        </div>
      )}
      <ErrorLine message={error} />
      {review && (
        <button type="button" className={`${filled} mt-5 w-full`} onClick={onNext}>
          {review.done ? "See score" : "Next question"}
        </button>
      )}
    </section>
  );
}

function verdict(correct: number, total: number): string {
  if (total === 0) return "Done.";
  const ratio = correct / total;
  if (ratio === 1) return "Perfect score!";
  if (ratio >= 0.67) return "Great work.";
  if (ratio >= 0.34) return "Good effort.";
  return "Keep practicing.";
}

function ScoreRing({ score, max }: { score: number; max: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const fraction = max > 0 ? Math.min(1, score / max) : 0;
  return (
    <div
      className="relative mx-auto size-40"
      role="img"
      aria-label={`Score ${score} out of ${max}`}
    >
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={radius} fill="none" strokeWidth="10" className="stroke-line" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          className="stroke-primary transition-[stroke-dashoffset] duration-200"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="font-mono text-4xl font-medium leading-none">{score}</p>
          <p className="mt-1 text-xs text-muted">of {max}</p>
        </div>
      </div>
    </div>
  );
}

function Results({
  play,
  code,
  history,
  onLeave,
}: {
  play: Play;
  code: string;
  history: boolean[];
  onLeave: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let stop = false;
    const pull = () => {
      getBoard({ data: { code } })
        .then((board) => {
          if (!stop && board.ok) setRows(board.rows);
        })
        .catch(() => {
          /* transient: next tick retries */
        });
    };
    pull();
    const id = window.setInterval(pull, BOARD_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [code]);

  return (
    <section aria-label="Your results">
      <p className={kicker}>{play.name}</p>
      <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{play.title}</h1>
      <div className={`${card} mt-5 text-center`}>
        <ScoreRing score={play.score} max={play.total * play.points} />
        <p className="mt-4 text-xl font-bold">{verdict(play.correct, play.total)}</p>
        <p className="mt-1 text-sm text-muted">
          {play.correct} of {play.total} correct
          {play.rank ? ` · Rank ${play.rank}` : ""}
        </p>
        {history.length > 0 && (
          <ul
            className="mt-4 flex flex-wrap justify-center gap-1.5"
            aria-label="Per-question results"
          >
            {history.map((ok, index) => (
              <li
                key={index}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                }`}
              >
                Q{index + 1}
                {ok ? (
                  <Check className="size-3" aria-label="correct" />
                ) : (
                  <CircleX className="size-3" aria-label="wrong" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <h2 className="mt-6 flex items-center gap-2 text-sm font-semibold">
        <Trophy className="size-4 text-muted" aria-hidden="true" />
        Leaderboard
      </h2>
      <Leaderboard rows={rows} me={play.name} empty="Waiting for the board…" />
      <button type="button" className={`${outline} mt-6 w-full`} onClick={onLeave}>
        <LogOut className="size-4" aria-hidden="true" />
        Leave quiz
      </button>
    </section>
  );
}
