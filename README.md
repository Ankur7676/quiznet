# QuizNet — Live Classroom Quiz System

A Computer Networks AAT project with a working browser application and separate Python and C TCP implementations.

## What to demonstrate

1. Open the host workspace, choose Computer Networks (the default), and create a quiz.
2. Show the generated room code. Open the student page in another browser profile or a private window; join with a different name for each student.
3. Answer a question correctly in one session and incorrectly in another. The server returns feedback and the live host leaderboard updates.
4. Reload the student page to demonstrate session recovery. The deadline continues; reloading does not reset it.
5. Finish an attempt, inspect the score, and export the host results as CSV.
6. Close joining. New students are rejected; students already in the room can finish.
7. For the TCP part of the assessment, demonstrate the separate Python or C client/server, rather than describing browser requests as direct TCP socket programming.

## Implemented features

- Responsive home, host builder, live dashboard, student quiz and results screens.
- Four-character room codes with collision handling and six-character fallback.
- 1–10 multiple-choice questions, four distinct options, and a selected answer key.
- Networking, database and operating system question templates.
- Host draft autosave in localStorage; attempt and host session credentials in sessionStorage.
- Server-enforced deadlines, ten points per correct answer, and answer-key disclosure only after submission.
- Shared leaderboard polling every two seconds, presentation mode, clipboard sharing and CSV export.
- Validation for duplicate names, invalid choices, stale questions, missing sessions and closed rooms.

## Architecture and scope

| Edition | Client | Transport | Server | Storage |
| --- | --- | --- | --- | --- |
| Browser | React 19 / TanStack Router | HTTPS server-function requests; leaderboard polling | TanStack Start | Netlify Blobs in Netlify runtime; in-memory Map locally |
| Python | Tkinter | TCP socket, newline-delimited JSON | Thread per client | SQLite |
| C | Terminal client | TCP socket, newline-delimited JSON | pthread-based server | CSV |

The browser is a practical classroom interface. It uses the browser networking stack; it does not open a raw TCP connection to the Python or C server. The unused browser TCP lab components are retained as reference and are not part of the three public routes.

The web answer key and scoring logic live in `src/lib/quiz-room.server.ts`. Students receive a question without its correct option. The server validates each submission against the current question and the deadline. Room creation returns a private host capability; joining returns a private player capability. These are session tokens, not user accounts.

## Local development

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
sh startup.sh
```

`startup.sh` is idempotent and starts `npm run dev`. The server listens on port 8080. Drafts survive reloads on the same browser; local room data survives requests but is lost when the development server process restarts.

## Verification

```sh
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s quiznet/tests -v
```

Browser smoke checks use Playwright Chromium (install with `npx playwright install chromium`) or an installed Chrome via `PW_CHANNEL=chrome`:

```sh
PW_CHANNEL=chrome node scripts/browser-smoke.mjs http://127.0.0.1:8080/ "$PWD/screenshots/home.png"
PW_CHANNEL=chrome node scripts/e2e-quiz.mjs
npm run preview:restart
PW_CHANNEL=chrome node scripts/browser-smoke.mjs http://127.0.0.1:8081/ "$PWD/screenshots/built.png" --baseline "$PWD/screenshots/home.json"
npm run preview:stop
```

See `quiznet/README.md` and `quiznet-c/README.md` for the socket editions.

## Netlify deployment

The included `netlify.toml` runs `npm run build`, publishes `dist/client`, and uses the TanStack Start Netlify adapter. Auth is intentionally off. Netlify provides the Blobs runtime context; no external database is required for this edition. A deployment must run the build and server functions; uploading only the static client files is insufficient.

Existing site: https://quiznet-live-quiz.netlify.app/

Local edits do not change the deployed site until a new Netlify deployment is published.

## Limits to explain during viva

- This is an assessment/demo system without verified student identity or proctoring.
- The web edition supports up to 40 participants per room, capped by application validation; this is not a measured throughput guarantee.
- Web rankings show finished attempts first, then descending score, with join time as the tie-breaker. The TCP editions use their documented ranking rules.
- Polling is near-live, not WebSockets. Expect roughly two seconds of leaderboard delay plus a short server cache.
- Local web rooms use process memory; Netlify uses durable Blobs.
- The web storage layer does not implement conditional writes for competing submissions from the same player token. Normal UI submission is locked while a request is pending; multi-tab concurrency and malicious replay need stronger transactional storage for production use.
- Rooms currently have no expiry/cleanup policy or host account recovery across browsers.

## Dependency review

The installation audit flags high/critical advisories in the existing zod and better-auth dependency versions. Authentication is disabled in this project; the auth scaffolding remains in the template. A separately tested dependency upgrade is still needed before treating this as a production service. No forced dependency upgrades were applied during the submission UI pass.

## Useful next steps after submission

Add transactional submission control and room expiry, a question bank with import/export, per-question analytics, and automated Netlify deployment checks. Keep those separate from the stable assessed demo.
