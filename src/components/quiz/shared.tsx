import { Link } from "@tanstack/react-router";
import { CircleX, Crown, Network } from "lucide-react";

export type Letter = "A" | "B" | "C" | "D";

export type Row = {
  name: string;
  score: number;
  answered: number;
  total: number;
  done: boolean;
};

export const LETTERS: Letter[] = ["A", "B", "C", "D"];
export const BOARD_POLL_MS = 2000;

/* ---------- style tokens (classes consume theme tokens only) ---------- */
const btnBase =
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
export const filled = `${btnBase} bg-primary text-primary-ink shadow-sm hover:brightness-110`;
export const outline = `${btnBase} border border-line bg-surface text-fg hover:bg-primary-soft`;
export const ghost =
  "inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted transition hover:bg-primary-soft hover:text-fg disabled:pointer-events-none disabled:opacity-40";
export const field =
  "h-12 w-full rounded-xl border border-line bg-surface px-3.5 text-base text-fg outline-none transition placeholder:text-muted focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20";
export const card =
  "rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[var(--shadow-card)] animate-rise";
export const kicker = "text-xs font-semibold uppercase tracking-widest text-primary";

/* ---------- helpers ---------- */
export function clock(seconds: number): string {
  const whole = Math.max(0, seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function readStorage(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode) — session simply will not resume */
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

export function cleanCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

export function joinLink(code: string): string {
  return `${window.location.origin}/student?code=${encodeURIComponent(code)}`;
}

/* ---------- shared components ---------- */
export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="grid size-9 place-items-center rounded-xl bg-primary text-primary-ink shadow-sm"
        aria-hidden="true"
      >
        <Network className="size-5" />
      </span>
      <span className="text-lg font-bold tracking-tight">QuizNet</span>
    </span>
  );
}

export function AppHeader() {
  return (
    <header className="app-header flex items-center justify-between gap-3">
      <Link to="/" aria-label="QuizNet home" className="rounded-lg">
        <Logo />
      </Link>
      <nav aria-label="Main navigation" className="app-nav">
        <Link to="/" activeOptions={{ exact: true }}>
          Overview
        </Link>
        <Link to="/admin">Host a quiz</Link>
        <Link to="/student">Student · Join quiz</Link>
      </nav>
    </header>
  );
}

export function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-4 flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
    >
      <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

export function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span className="grid size-7 place-items-center rounded-full bg-warn-soft text-warn">
        <Crown className="size-4" aria-label="First place" />
      </span>
    );
  }
  return (
    <span className="grid size-7 place-items-center rounded-full bg-primary-soft font-mono text-xs font-medium text-muted">
      {rank}
    </span>
  );
}

export function Leaderboard({ rows, empty, me }: { rows: Row[]; empty: string; me?: string }) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        {empty}
      </p>
    );
  }
  return (
    <ol className="mt-3 space-y-2">
      {rows.map((row, index) => {
        const pct = row.total ? Math.round((row.answered / row.total) * 100) : 0;
        const mine = me !== undefined && row.name.toLowerCase() === me.toLowerCase();
        return (
          <li
            key={row.name}
            className={`rounded-xl border px-3.5 py-3 ${mine ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}
          >
            <div className="flex items-center gap-3">
              <RankBadge rank={index + 1} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {row.name}
                {mine ? <span className="ml-2 text-xs font-semibold text-primary">You</span> : null}
              </span>
              <span className="font-mono text-sm tabular-nums">{row.score} pts</span>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-label={`${row.name} progress`}
              aria-valuemin={0}
              aria-valuemax={row.total}
              aria-valuenow={row.answered}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-200 ${row.done ? "bg-success" : "bg-primary"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted">
              {row.done ? "Finished" : `${row.answered} of ${row.total} answered`}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
