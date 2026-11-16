import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleCheck,
  BookOpen,
  FilePlus2,
  Save,
  Copy,
  Download,
  Link2,
  Lock,
  Maximize2,
  Plus,
  Radio,
  Trash2,
  Users,
  X,
  CopyPlus,
} from "lucide-react";
import { closeQuiz, createQuiz, getBoard } from "@/lib/quiz-room.functions";
import {
  AppHeader,
  BOARD_POLL_MS,
  ErrorLine,
  LETTERS,
  Leaderboard,
  card,
  field,
  filled,
  ghost,
  joinLink,
  kicker,
  messageOf,
  outline,
  readStorage,
  writeStorage,
  type Letter,
  type Row,
} from "./shared";

type Draft = {
  text: string;
  options: Record<Letter, string>;
  answer: Letter;
};

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const POINTS_PER_QUESTION = 10;
const TIME_CHOICES = [2, 5, 10, 15] as const;
const MIN_TEXT = 4;
const ADMIN_CODE = "quiznet.admin.code";
const ADMIN_KEY = "quiznet.admin.key";

const SAMPLE: Draft[] = [
  {
    text: "Which protocol resends lost data?",
    options: { A: "TCP", B: "UDP", C: "IP", D: "DNS" },
    answer: "A",
  },
  {
    text: "A port number selects what?",
    options: { A: "A country", B: "A program", C: "A cable", D: "A password" },
    answer: "B",
  },
  {
    text: "What is 127.0.0.1?",
    options: { A: "The internet", B: "This computer", C: "The router", D: "Nobody" },
    answer: "B",
  },
];

const DRAFT_STORAGE = "quiznet.draft.v1";
const TEMPLATES: { name: string; title: string; questions: Draft[] }[] = [
  { name: "Computer Networks", title: "Computer Networks · Quick Check", questions: SAMPLE },
  {
    name: "Database Systems",
    title: "Database Systems · Fundamentals",
    questions: [
      {
        text: "Which SQL clause filters groups after aggregation?",
        options: { A: "WHERE", B: "HAVING", C: "ORDER BY", D: "SELECT" },
        answer: "B",
      },
      {
        text: "What does a primary key uniquely identify?",
        options: {
          A: "A database",
          B: "A table column type",
          C: "A row in a table",
          D: "A SQL query",
        },
        answer: "C",
      },
      {
        text: "Which ACID property ensures all-or-nothing transactions?",
        options: { A: "Atomicity", B: "Consistency", C: "Isolation", D: "Durability" },
        answer: "A",
      },
    ],
  },
  {
    name: "Operating Systems",
    title: "Operating Systems · Essentials",
    questions: [
      {
        text: "Which scheduling algorithm gives each process a fixed time slice?",
        options: { A: "FCFS", B: "Round Robin", C: "Shortest Job First", D: "Priority scheduling" },
        answer: "B",
      },
      {
        text: "What is a process waiting indefinitely for a resource called?",
        options: { A: "Paging", B: "Swapping", C: "Starvation", D: "Compiling" },
        answer: "C",
      },
      {
        text: "Which memory management technique uses fixed-size pages?",
        options: { A: "Segmentation", B: "Contiguous allocation", C: "Compaction", D: "Paging" },
        answer: "D",
      },
    ],
  },
];

function blank(): Draft {
  return { text: "", options: { A: "", B: "", C: "", D: "" }, answer: "A" };
}

function problemWith(question: Draft): string {
  if (question.text.trim().length < MIN_TEXT) return "Add the question text";
  const options = LETTERS.map((letter) => question.options[letter].trim());
  if (options.some((option) => !option)) return "Fill in all four options";
  if (new Set(options.map((option) => option.toLowerCase())).size !== LETTERS.length)
    return "Two options are identical";
  return "";
}

function downloadCsv(code: string, rows: Row[]): void {
  const esc = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = ["Rank,Name,Score,Answered,Total,Status"];
  rows.forEach((row, index) => {
    lines.push(
      [
        index + 1,
        esc(row.name),
        row.score,
        row.answered,
        row.total,
        row.done ? "Finished" : "In progress",
      ].join(","),
    );
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `quiznet-${code}-results.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function AdminPage() {
  const [draftTitle, setDraftTitle] = useState("Computer Networks · Quick Check");
  const [minutes, setMinutes] = useState<number>(5);
  const [draft, setDraft] = useState<Draft[]>(() =>
    SAMPLE.map((item) => ({ ...item, options: { ...item.options } })),
  );
  const [code, setCode] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [title, setTitle] = useState("");
  const [closed, setClosed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          typeof saved.title === "string" &&
          TIME_CHOICES.includes(saved.minutes) &&
          Array.isArray(saved.questions) &&
          saved.questions.length >= 1 &&
          saved.questions.length <= MAX_QUESTIONS &&
          saved.questions.every(
            (q: Draft) =>
              q &&
              typeof q.text === "string" &&
              LETTERS.includes(q.answer) &&
              q.options &&
              LETTERS.every((l) => typeof q.options[l] === "string"),
          )
        ) {
          setDraftTitle(saved.title);
          setMinutes(saved.minutes);
          setDraft(saved.questions);
        }
      }
    } catch {
      /* A malformed or unavailable local draft must not block the builder. */
    }
    setDraftLoaded(true);
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    setDraftSaved(false);
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_STORAGE,
          JSON.stringify({ title: draftTitle, minutes, questions: draft }),
        );
        setDraftSaved(true);
      } catch {
        /* The quiz can still be created without browser storage. */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftTitle, minutes, draft, draftLoaded]);

  useEffect(() => {
    const savedCode = readStorage(ADMIN_CODE);
    const savedKey = readStorage(ADMIN_KEY);
    if (!savedCode || !savedKey) {
      setReady(true);
      return;
    }
    setCode(savedCode);
    setAdminKey(savedKey);
    getBoard({ data: { code: savedCode } })
      .then((board) => {
        if (board.ok) {
          setTitle(board.title);
          setClosed(board.closed);
          setRows(board.rows);
        } else {
          writeStorage(ADMIN_CODE, "");
          writeStorage(ADMIN_KEY, "");
          setCode("");
          setAdminKey("");
        }
      })
      .catch(() => {
        setCode("");
        setAdminKey("");
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!code) return;
    let stop = false;
    const pull = () => {
      getBoard({ data: { code } })
        .then((board) => {
          if (stop || !board.ok) return;
          setTitle(board.title);
          setClosed(board.closed);
          setRows(board.rows);
        })
        .catch(() => {
          /* transient network error: the next tick retries */
        });
    };
    const id = window.setInterval(pull, BOARD_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [code]);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await createQuiz({
        data: { title: draftTitle, seconds: minutes * 60, questions: draft },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      writeStorage(ADMIN_CODE, result.code);
      writeStorage(ADMIN_KEY, result.adminKey);
      setCode(result.code);
      setAdminKey(result.adminKey);
      setTitle(result.title);
      setClosed(false);
      setRows([]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    setError("");
    try {
      const result = await closeQuiz({ data: { code, adminKey } });
      if (!result.ok) setError(result.error);
      else setClosed(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function another() {
    writeStorage(ADMIN_CODE, "");
    writeStorage(ADMIN_KEY, "");
    setCode("");
    setAdminKey("");
    setRows([]);
    setClosed(false);
    setError("");
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <div className="mt-8">
        {!ready ? (
          <p className="text-sm text-muted">Loading the quiz…</p>
        ) : code ? (
          <Dashboard
            code={code}
            title={title}
            closed={closed}
            rows={rows}
            busy={busy}
            error={error}
            setError={setError}
            onClose={() => void close()}
            onAnother={another}
          />
        ) : (
          <Builder
            draftSaved={draftSaved}
            title={draftTitle}
            setTitle={setDraftTitle}
            minutes={minutes}
            setMinutes={setMinutes}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            error={error}
            onCreate={() => void create()}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- builder ---------- */
function Builder({
  draftSaved,
  title,
  setTitle,
  minutes,
  setMinutes,
  draft,
  setDraft,
  busy,
  error,
  onCreate,
}: {
  draftSaved: boolean;
  title: string;
  setTitle: (value: string) => void;
  minutes: number;
  setMinutes: (value: number) => void;
  draft: Draft[];
  setDraft: (updater: (prev: Draft[]) => Draft[]) => void;
  busy: boolean;
  error: string;
  onCreate: () => void;
}) {
  const problems = useMemo(() => draft.map(problemWith), [draft]);
  const readyCount = problems.filter((problem) => !problem).length;
  const titleOk = title.trim().length >= 2;
  const allReady = readyCount === draft.length && titleOk;
  const maxPoints = draft.length * POINTS_PER_QUESTION;

  const patch = (index: number, next: Draft) =>
    setDraft((prev) => prev.map((item, i) => (i === index ? next : item)));
  const add = () => setDraft((prev) => (prev.length >= MAX_QUESTIONS ? prev : [...prev, blank()]));
  const remove = (index: number) =>
    setDraft((prev) => (prev.length <= MIN_QUESTIONS ? prev : prev.filter((_, i) => i !== index)));
  const duplicate = (index: number) =>
    setDraft((prev) => {
      if (prev.length >= MAX_QUESTIONS) return prev;
      const copy = { ...prev[index], options: { ...prev[index].options } };
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });

  const createButton = (
    <button
      type="button"
      className={`${filled} w-full`}
      disabled={busy || !allReady}
      onClick={onCreate}
    >
      {busy ? "Creating…" : "Create quiz"}
    </button>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <section aria-label="Quiz builder" className="min-w-0">
        <p className={kicker}>Host workspace</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Build a quiz</h1>
        <p className="mt-1 text-sm text-muted">
          Write the questions, pick the clock, get a code to share.
        </p>

        <div className="mt-6 rounded-2xl border border-line bg-primary-soft p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <BookOpen className="size-4 text-primary" /> Start with a question set
            </h2>
            <span role="status" className="flex items-center gap-1.5 text-xs text-muted">
              <Save className="size-3.5" />{" "}
              {draftSaved ? "Draft saved on this device" : "Editing draft"}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted">
            Choose a subject or build from scratch. Loading a set replaces the current draft.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {TEMPLATES.map((template) => (
              <button
                key={template.name}
                type="button"
                className={outline}
                onClick={() => {
                  if (!window.confirm("Replace this draft with the selected question set?")) return;
                  setTitle(template.title);
                  setDraft(() =>
                    template.questions.map((q) => ({ ...q, options: { ...q.options } })),
                  );
                }}
              >
                {template.name}
              </button>
            ))}
            <button
              type="button"
              className={outline}
              onClick={() => {
                if (!window.confirm("Clear this draft and start a blank quiz?")) return;
                setTitle("");
                setDraft(() => [blank()]);
              }}
            >
              <FilePlus2 className="size-4" /> Blank quiz
            </button>
          </div>
        </div>
        <div className={`${card} mt-6`}>
          <label className="block text-sm font-semibold" htmlFor="quiz-title">
            Title
          </label>
          <input
            id="quiz-title"
            className={`${field} mt-2`}
            value={title}
            maxLength={40}
            onChange={(event) => setTitle(event.target.value)}
          />
          <fieldset className="mt-5">
            <legend className="text-sm font-semibold">Time per student</legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {TIME_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={minutes === choice}
                  onClick={() => setMinutes(choice)}
                  className={`h-11 rounded-xl border text-sm font-semibold transition ${
                    minutes === choice
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-line bg-surface text-muted hover:text-fg"
                  }`}
                >
                  {choice} min
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-4 space-y-4">
          {draft.map((question, index) => (
            <fieldset key={index} className={`${card} question-panel`}>
              <div className="flex items-center justify-between gap-2">
                <legend className="flex items-center gap-2 text-sm font-semibold">
                  <span className="grid size-6 place-items-center rounded-full bg-primary text-xs font-bold text-primary-ink">
                    {index + 1}
                  </span>
                  Question {index + 1}
                  {!problems[index] && (
                    <CircleCheck className="size-4 text-success" aria-label="Ready" />
                  )}
                </legend>
                <div className="flex items-center">
                  <button
                    type="button"
                    className={ghost}
                    disabled={draft.length >= MAX_QUESTIONS}
                    aria-label={`Duplicate question ${index + 1}`}
                    onClick={() => duplicate(index)}
                  >
                    <CopyPlus className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={ghost}
                    disabled={draft.length <= MIN_QUESTIONS}
                    aria-label={`Remove question ${index + 1}`}
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <input
                className={`${field} mt-3`}
                aria-label={`Question ${index + 1} text`}
                placeholder="Type the question"
                value={question.text}
                maxLength={140}
                onChange={(event) => patch(index, { ...question, text: event.target.value })}
              />
              <div
                className="mt-4 grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label={`Right answer for question ${index + 1}`}
              >
                {LETTERS.map((letter) => {
                  const right = question.answer === letter;
                  return (
                    <div key={letter} className="flex items-center gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={right}
                        aria-label={`Option ${letter} is the right answer for question ${index + 1}`}
                        onClick={() => patch(index, { ...question, answer: letter })}
                        className={`grid size-12 shrink-0 place-items-center rounded-xl border font-mono text-sm font-medium transition ${
                          right
                            ? "border-success bg-success-soft text-success"
                            : "border-line bg-surface text-muted hover:text-fg"
                        }`}
                      >
                        {right ? <Check className="size-5" aria-hidden="true" /> : letter}
                      </button>
                      <input
                        className={`${field} min-w-0 flex-1`}
                        aria-label={`Question ${index + 1} option ${letter}`}
                        placeholder={`Option ${letter}`}
                        value={question.options[letter]}
                        maxLength={48}
                        onChange={(event) =>
                          patch(index, {
                            ...question,
                            options: { ...question.options, [letter]: event.target.value },
                          })
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted">
                {problems[index] ? problems[index] : "Tap a letter to change the right answer."}
              </p>
            </fieldset>
          ))}
        </div>

        <button
          type="button"
          className={`${outline} mt-4 w-full border-dashed`}
          disabled={draft.length >= MAX_QUESTIONS}
          onClick={add}
        >
          <Plus className="size-4" aria-hidden="true" />
          Add question ({draft.length}/{MAX_QUESTIONS})
        </button>
        <div className="lg:hidden">
          <ErrorLine message={error} />
        </div>
        {/* Spacer so the mobile bar never covers the last control. */}
        <div className="h-24 lg:hidden" aria-hidden="true" />
      </section>

      <aside aria-label="Quiz summary" className="hidden lg:sticky lg:top-6 lg:block">
        <div className={card}>
          <h2 className="text-sm font-semibold">Summary</h2>
          <dl className="mt-4 space-y-3 text-sm">
            {[
              ["Questions", String(draft.length)],
              ["Time each", `${minutes} min`],
              ["Max score", `${maxPoints} pts`],
              ["Ready", `${readyCount} of ${draft.length}`],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <dt className="text-muted">{label}</dt>
                <dd className="font-mono font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5">{createButton}</div>
          {!allReady && (
            <p className="mt-3 text-xs text-muted">
              {titleOk ? "Finish every question to continue." : "Give the quiz a title."}
            </p>
          )}
          <ErrorLine message={error} />
        </div>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto max-w-6xl">
          <button
            type="button"
            className={`${filled} w-full`}
            disabled={busy || !allReady}
            onClick={onCreate}
          >
            {busy
              ? "Creating…"
              : allReady
                ? `Create quiz · ${draft.length} ${draft.length === 1 ? "question" : "questions"} · ${minutes} min`
                : `${readyCount} of ${draft.length} questions ready`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- live dashboard ---------- */
function Dashboard({
  code,
  title,
  closed,
  rows,
  busy,
  error,
  setError,
  onClose,
  onAnother,
}: {
  code: string;
  title: string;
  closed: boolean;
  rows: Row[];
  busy: boolean;
  error: string;
  setError: (value: string) => void;
  onClose: () => void;
  onAnother: () => void;
}) {
  const [copied, setCopied] = useState<"" | "code" | "link">("");
  const [present, setPresent] = useState(false);

  useEffect(() => {
    if (!present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresent(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present]);

  async function copy(kind: "code" | "link") {
    try {
      await navigator.clipboard.writeText(kind === "code" ? code : joinLink(code));
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setError("Copy is blocked in this browser. Select the code and copy it by hand.");
    }
  }

  const finished = rows.filter((row) => row.done).length;
  const average = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length)
    : 0;
  const top = rows.reduce((best, row) => Math.max(best, row.score), 0);

  return (
    <section aria-label="Live quiz">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={kicker}>Host workspace</p>
          <h1 className="mt-1 truncate text-3xl font-bold tracking-tight">{title || "Quiz"}</h1>
        </div>
        <span
          className={`mt-1 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${
            closed ? "bg-warn-soft text-warn" : "bg-success-soft text-success"
          }`}
        >
          {closed ? (
            <Lock className="size-3.5" aria-hidden="true" />
          ) : (
            <Radio className="size-3.5" aria-hidden="true" />
          )}
          {closed ? "Joining closed" : "Open for joining"}
        </span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          <div className={`${card} text-center`}>
            <p className={kicker}>Join code</p>
            <p
              data-testid="join-code"
              className="mt-2 font-mono text-6xl font-medium tracking-[0.2em]"
            >
              {code}
            </p>
            <p className="mt-3 text-sm text-muted">
              {closed
                ? "Joining is closed. People already in can finish."
                : "Students open the Student page and type this code. Their clock starts when they join."}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" className={outline} onClick={() => void copy("code")}>
                {copied === "code" ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied === "code" ? "Copied" : "Copy code"}
              </button>
              <button type="button" className={outline} onClick={() => void copy("link")}>
                {copied === "link" ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Link2 className="size-4" aria-hidden="true" />
                )}
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
            </div>
            <button type="button" className={`${ghost} mt-2`} onClick={() => setPresent(true)}>
              <Maximize2 className="size-4" aria-hidden="true" />
              Show full screen
            </button>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-center">
            {[
              ["Joined", rows.length],
              ["Finished", finished],
              ["Average", average],
              ["Top score", top],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-line bg-surface px-2 py-3">
                <dd className="font-mono text-2xl font-medium">{value}</dd>
                <dt className="text-xs text-muted">{label}</dt>
              </div>
            ))}
          </dl>

          <div className="grid gap-2">
            <button type="button" className={outline} disabled={busy || closed} onClick={onClose}>
              <Lock className="size-4" aria-hidden="true" />
              {closed ? "Joining is closed" : "Close joining"}
            </button>
            <button
              type="button"
              className={filled}
              onClick={() => {
                if (
                  window.confirm(
                    "Leave this dashboard and create another quiz? Save your results first. Students can still finish this quiz.",
                  )
                )
                  onAnother();
              }}
            >
              Make another quiz
            </button>
          </div>
          <ErrorLine message={error} />
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Users className="size-4 text-muted" aria-hidden="true" />
              Live leaderboard
            </h2>
            <button
              type="button"
              className={ghost}
              disabled={rows.length === 0}
              onClick={() => downloadCsv(code, rows)}
            >
              <Download className="size-4" aria-hidden="true" />
              Export CSV
            </button>
          </div>
          <Leaderboard rows={rows} empty="No one has joined yet. Share the code to get started." />
        </div>
      </div>

      {present && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Join code, full screen"
          className="fixed inset-0 z-50 grid place-items-center bg-bg p-6 text-center"
        >
          <button
            type="button"
            autoFocus
            className={`${ghost} absolute right-4 top-4`}
            onClick={() => setPresent(false)}
          >
            <X className="size-4" aria-hidden="true" />
            Close
          </button>
          <div>
            <p className={kicker}>{title}</p>
            <p className="mt-3 text-lg text-muted">Open the Student page and enter</p>
            <p className="mt-4 font-mono text-[clamp(4rem,22vw,14rem)] font-medium leading-none tracking-[0.15em]">
              {code}
            </p>
            <p className="mt-6 text-sm text-muted">Press Escape to close</p>
          </div>
        </div>
      )}
    </section>
  );
}
