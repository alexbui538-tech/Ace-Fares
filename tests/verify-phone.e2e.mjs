// Browser test: on a phone (or an app's built-in browser) the ID check opens Stripe's own full-screen page
// instead of the pop-up, which can show a blank white screen on phones. On a computer it uses the pop-up.
// Run: npm i --no-save playwright && node tests/verify-phone.e2e.mjs
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) process.exitCode = 1; };
const REF = "11111111-2222-4333-8444-555555555555";
const HOSTED = "https://verify.stripe.com/start/test_vs_123";
const trip = { trip: { carName: "Cadillac SRX", photo: "srx-1", from: "2026-11-02", to: "2026-11-04", fromTime: "10:00", toTime: "10:00", location: "Dallas pickup" },
  verification: { status: "not_started" }, consent: { text: "Consent text" }, dueAt: new Date(Date.now() + 3600e3).toISOString() };
const page = await readFile(join(ROOT, "verify.html"), "utf8");

async function run(browser, ctxOpts, label) {
  const ctx = await browser.newContext(ctxOpts);
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  let hosted = false;
  await ctx.route("https://acefares.test/verify.html*", r => r.fulfill({ contentType: "text/html", body: page }));
  await ctx.route("https://acefares.test/api/verify*", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify(r.request().method() === "POST" ? { clientSecret: "vs_secret", url: HOSTED, publishableKey: "pk_test_x", status: "started" } : trip) }));
  await ctx.route("https://js.stripe.com/**", r => r.fulfill({ contentType: "application/javascript",
    body: "window.Stripe = () => ({ verifyIdentity: async () => { window.__modal = true; return { error: { code: 'session_cancelled' } }; } });" }));
  await ctx.route("https://verify.stripe.com/**", r => { hosted = true; return r.fulfill({ contentType: "text/html", body: "<p>Stripe hosted ID page</p>" }); });
  await ctx.route(/fonts\.(googleapis|gstatic)|\/images\//, r => r.abort());
  await p.goto(`https://acefares.test/verify.html?car=srx&ref=${REF}`); await p.waitForSelector("#page:not([hidden])");
  await p.check("#consent"); await p.click("#box-license");
  await p.waitForTimeout(800);
  const modal = hosted ? false : await p.evaluate(() => !!window.__modal);
  await ctx.close();
  return { hosted, modal, errs };
}

const browser = await chromium.launch();
const iphone = await run(browser, { ...devices["iPhone 13"] }, "iPhone");
ok(iphone.hosted && !iphone.modal, "iPhone: the ID check opens Stripe's full-screen page (no pop-up)");
const android = await run(browser, { ...devices["Pixel 7"] }, "Android");
ok(android.hosted && !android.modal, "Android: the ID check opens Stripe's full-screen page");
const insta = await run(browser, { viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Instagram 300.0" }, "Instagram");
ok(insta.hosted, "Instagram's built-in browser: opens Stripe's full-screen page");
const desk = await run(browser, { viewport: { width: 1280, height: 900 } }, "desktop");
ok(desk.modal && !desk.hosted, "computer: the ID check opens in Stripe's pop-up");
ok([iphone, android, insta, desk].every(r => !r.errs.length), "no page errors");
await browser.close();
