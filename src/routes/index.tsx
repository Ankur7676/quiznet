import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  Clock3,
  GraduationCap,
  Presentation,
  ShieldCheck,
  Radio,
  Network,
  BookOpen,
  Users,
  Trophy,
} from "lucide-react";
import { AppHeader, cleanCode, filled } from "@/components/quiz/shared";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();
  return (
    <div className="app-shell">
      <AppHeader />
      <main>
        <div className="mb-6 mt-9 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-muted">Your classroom, connected.</p>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-primary">
            <Radio className="size-3.5" /> Live classroom quizzes
          </span>
        </div>
        <section className="hero-panel grid items-center gap-10 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <p className="mb-5 text-xs font-semibold uppercase tracking-widest text-ink-muted">
              Less setup. More participation.
            </p>
            <h1 className="hero-title">
              A little competition.
              <br />
              <span className="text-lime">A lot of learning.</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-ink-muted">
              Turn your next lesson into a live quiz. Create questions, bring everyone in with a
              code, and watch learning happen.
            </p>
            <Link to="/admin" className={`${filled} mt-8 hero-cta`}>
              Create a quiz <ArrowRight className="size-4" />
            </Link>
            <p className="mt-5 flex items-center gap-2 text-xs text-ink-muted">
              <Check className="size-3.5" /> No accounts. No downloads. Just a join code.
            </p>
          </div>
          <div className="rounded-2xl bg-surface p-6 text-fg sm:p-8">
            <span className="mb-5 grid size-11 place-items-center rounded-xl bg-primary-soft text-primary">
              <GraduationCap className="size-6" />
            </span>
            <h2 className="text-2xl font-semibold tracking-tight">Got a quiz code?</h2>
            <p className="mt-2 text-sm text-muted">Your seat in the classroom is one code away.</p>
            <form
              className="mt-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length >= 4) void navigate({ to: "/student", search: { code } });
              }}
            >
              <label
                htmlFor="home-code"
                className="text-xs font-semibold uppercase tracking-wider text-muted"
              >
                Enter join code
              </label>
              <input
                id="home-code"
                value={code}
                onChange={(e) => setCode(cleanCode(e.target.value))}
                maxLength={6}
                minLength={4}
                required
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCD"
                className="mt-3 h-16 w-full rounded-xl border border-line bg-bg text-center font-mono text-3xl uppercase tracking-widest outline-primary"
              />
              <button className={`${filled} mt-4 w-full`} disabled={code.length < 4}>
                Join a quiz <ArrowRight className="size-4" />
              </button>
            </form>
            <p className="mt-4 text-center text-xs text-muted">
              Ask your teacher for the room code.
            </p>
          </div>
        </section>
        <section className="mt-12" aria-labelledby="start-title">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">
                One room. Everyone involved.
              </p>
              <h2 id="start-title" className="section-title">
                Choose your side of the classroom.
              </h2>
            </div>
            <span className="text-sm text-muted">Built for teaching. Ready for a challenge.</span>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <Link to="/admin" className="feature-card group transition hover:border-primary">
              <div className="flex items-center justify-between">
                <Presentation className="size-6 text-primary" />
                <span className="text-xs text-muted">FOR EDUCATORS</span>
              </div>
              <h3 className="mt-6 text-xl font-semibold">You bring the questions.</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Build your own quiz, set a time limit, and follow every student's progress on a live
                leaderboard.
              </p>
              <span className="mt-6 flex items-center gap-2 text-sm font-semibold text-primary">
                Open host workspace{" "}
                <ArrowRight className="size-4 transition group-hover:translate-x-1" />
              </span>
            </Link>
            <Link to="/student" className="feature-card group transition hover:border-primary">
              <div className="flex items-center justify-between">
                <GraduationCap className="size-6 text-primary" />
                <span className="text-xs text-muted">FOR STUDENTS</span>
              </div>
              <h3 className="mt-6 text-xl font-semibold">You bring your A game.</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Join with a code, answer against the clock, and get instant feedback. Every correct
                answer earns ten points.
              </p>
              <span className="mt-6 flex items-center gap-2 text-sm font-semibold text-primary">
                Join the classroom{" "}
                <ArrowRight className="size-4 transition group-hover:translate-x-1" />
              </span>
            </Link>
          </div>
        </section>
        <section className="mt-10 grid gap-5 sm:grid-cols-3" aria-label="Quiz features">
          {[
            [
              Clock3,
              "Your pace, on the clock",
              "Choose a 2–15 minute time limit for each attempt.",
            ],
            [ShieldCheck, "Fair by design", "Answers and scoring stay on the server."],
            [Trophy, "See progress as it happens", "Live rankings and downloadable results."],
          ].map(([Icon, title, description]) => {
            const FeatureIcon = Icon as typeof Clock3;
            return (
              <div key={String(title)} className="flex gap-3 py-3">
                <FeatureIcon className="mt-1 size-5 shrink-0 text-primary" />
                <div>
                  <h3 className="text-sm font-semibold">{String(title)}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{String(description)}</p>
                </div>
              </div>
            );
          })}
        </section>
        <section className="mt-10 rounded-2xl border border-line bg-primary-soft p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <Network className="mt-1 size-5 shrink-0 text-primary" />
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                Behind the classroom
              </p>
              <h2 className="mt-2 text-xl font-semibold">A client–server system, in action.</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
                Students send answers to a shared server. The server checks each answer, enforces
                the deadline, and updates the leaderboard. The browser edition uses HTTPS requests
                and polling; the included Python and C editions demonstrate direct TCP sockets.
              </p>
            </div>
          </div>
          <div className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
            {[
              [Users, "01", "Student client", "Join · answer · receive feedback"],
              [Network, "02", "Quiz server", "Validate · time · calculate scores"],
              [BookOpen, "03", "Shared results", "Rank · track progress · export"],
            ].map(([Icon, n, title, desc]) => {
              const StepIcon = Icon as typeof Users;
              return (
                <div key={String(n)} className="rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-center justify-between text-primary">
                    <StepIcon className="size-4" />
                    <span className="font-mono text-xs text-muted">{String(n)}</span>
                  </div>
                  <h3 className="mt-3 font-semibold">{String(title)}</h3>
                  <p className="mt-1 text-xs text-muted">{String(desc)}</p>
                </div>
              );
            })}
          </div>
        </section>
      </main>
      <footer className="page-footer">
        <span className="font-semibold">
          QuizNet <span className="font-normal">/ Learn together. Compete a little.</span>
        </span>
        <span>Computer Networks · AAT Project</span>
      </footer>
    </div>
  );
}
