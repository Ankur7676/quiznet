// End-to-end check: admin creates quiz, two students play, board updates.
// Usage: node scripts/e2e-quiz.mjs [baseUrl]
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Uses an installed browser channel (msedge/chrome) so no Playwright download is needed.
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "msedge" });
const errors = [];
try {
  const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const admin = await adminCtx.newPage();
  admin.on("pageerror", (e) => errors.push(`admin: ${e.message}`));
  admin.on("console", (m) => m.type() === "error" && errors.push(`admin console: ${m.text()}`));

  await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: /create quiz/i }).click();
  await admin.getByText(/join code/i).waitFor({ timeout: 15000 });
  const code = (await admin.locator("[data-testid=join-code]").innerText()).trim();
  check("admin creates quiz, gets code", /^[A-Z0-9]{4,6}$/.test(code), code);

  async function student(name, picks) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(`${BASE}/student`, { waitUntil: "networkidle" });
    await page.getByLabel(/your name/i).fill(name);
    await page.getByLabel(/^code/i).fill(code);
    await page.getByRole("button", { name: /^join/i }).click();
    await page.getByText(/question 1 of 3/i).waitFor({ timeout: 15000 });
    for (let i = 0; i < picks.length; i += 1) {
      await page.getByRole("button", { name: new RegExp(`^${picks[i]}\\b`) }).first().click();
      await page.getByRole("button", { name: /next|see score/i }).click();
    }
    return page;
  }

  // sample answers: A, B, B => alice all right, bob all wrong
  const alice = await student("Alice", ["A", "B", "B"]);
  check("alice sees final score", await alice.getByText(/30/).first().isVisible());
  const bob = await student("Bob", ["D", "D", "D"]);
  check("bob sees zero score", await bob.getByText(/0 of 3 correct/i).isVisible());

  await admin.waitForTimeout(2500);
  const text = await admin.locator("body").innerText();
  check("admin board lists both students", /Alice/.test(text) && /Bob/.test(text));

  // landing links reach both pages
  const home = await adminCtx.newPage();
  await home.goto(BASE, { waitUntil: "networkidle" });
  await home.getByRole("link", { name: /^student/i }).first().click();
  await home.waitForURL(/\/student/);
  check("landing links to student page", true);

  // duplicate name rejected
  const dupCtx = await browser.newContext();
  const dup = await dupCtx.newPage();
  await dup.goto(`${BASE}/student?code=${code}`, { waitUntil: "networkidle" });
  await dup.getByLabel(/your name/i).fill("alice");
  await dup.getByLabel(/^code/i).fill(code);
  await dup.getByRole("button", { name: /^join/i }).click();
  await dup.getByRole("alert").waitFor({ timeout: 8000 });
  check("duplicate name rejected", /already/i.test(await dup.getByRole("alert").innerText()));

  // bad code rejected
  await dup.getByLabel(/your name/i).fill("Carol");
  await dup.getByLabel(/^code/i).fill("ZZZZ");
  await dup.getByRole("button", { name: /^join/i }).click();
  await dup.waitForFunction(() => /no quiz/i.test(document.querySelector("[role=alert]")?.textContent ?? ""), null, {
    timeout: 8000,
  });
  check("bad code rejected", true);

  // close joining then join fails
  await admin.getByRole("button", { name: /close joining/i }).click();
  await admin.getByText(/joining is closed/i).first().waitFor({ timeout: 8000 });
  await dup.getByLabel(/^code/i).fill(code);
  await dup.getByRole("button", { name: /^join/i }).click();
  await dup.waitForFunction(() => /closed/i.test(document.querySelector("[role=alert]")?.textContent ?? ""), null, {
    timeout: 8000,
  });
  check("closed quiz rejects new joins", true);

  await admin.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/admin.png` : "screenshots/e2e-admin.png" });
  await alice.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/student.png` : "screenshots/e2e-student.png" });
} catch (error) {
  check("script completed", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
