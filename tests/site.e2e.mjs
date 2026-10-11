// Browser test: the real page + the real booking server code, with a fake Stripe.
// Run: npm i --no-save playwright && npx playwright install chromium && node tests/site.e2e.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { availabilityHandler, checkoutHandler, cancelHandler, bookingStatusHandler, webhookHandler } from "../lib/handlers.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { quote } from "../lib/pricing.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) process.exitCode = 1; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nm = new Date(); nm.setDate(1); nm.setMonth(nm.getMonth() + 1);           // first of next month
const D = day => iso(new Date(nm.getFullYear(), nm.getMonth(), day));

const store = memoryStore(), stripe = fakeStripe();
let base = "", apiDown = false;
const H = {
  "/api/availability": availabilityHandler({ store }),
  "/api/checkout": checkoutHandler({ store, stripe, siteUrl: () => base }),
  "/api/cancel": cancelHandler({ store, stripe }),
  "/api/booking": bookingStatusHandler({ store, stripe }),
  "/api/stripe-webhook": webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET }),
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const h = H[url.pathname];
  if (h) {
    if (apiDown && url.pathname === "/api/checkout") { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
    const chunks = []; for await (const c of req) chunks.push(c);
    // siteUrl is read when checkout runs
    const r = await (url.pathname === "/api/checkout" ? checkoutHandler({ store, stripe, siteUrl: base }) : h)(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  try {
    const f = await readFile(join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    res.writeHead(200, { "content-type": { ".html": "text/html", ".webp": "image/webp", ".png": "image/png" }[extname(url.pathname) || ".html"] || "application/octet-stream" }); res.end(f);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`;

// an existing paid booking for the Escalade on days 4-8 of next month
const repo = makeRepo(store);
await repo.hold("escalade", { from: D(4), to: D(8), fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" }, "existing");
await repo.confirm("escalade", "existing");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; page.on("pageerror", e => errs.push(e.message));
await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
// stand-in for Stripe's hosted checkout page
await page.route(/checkout\.stripe\.com/, r => r.fulfill({ contentType: "text/html", body: "<h1>Stripe test checkout</h1>" }));

async function pickRange(a, b) {
  await page.click("#b-from-btn"); await page.waitForSelector("#cal[open]");
  const hasDay = () => page.locator(`#cal-months button[data-d="${D(a)}"]`).count();
  for (let i = 0; i < 3 && !(await hasDay()); i++) await page.click("#cal-next");
  await page.click(`#cal-months button[data-d="${D(a)}"]`);
  await page.click(`#cal-months button[data-d="${D(b)}"]`);
  await page.click("#cal-done");
}

await page.goto(base + "/"); await page.waitForTimeout(500);
await page.click("[data-book=escalade]");
ok((await page.textContent("#b-go")).includes("Book and pay"), "server reachable: button says 'Book and pay securely'");

// booked days are blocked in the calendar
await page.click("#b-from-btn"); await page.waitForSelector("#cal[open]");
for (let i = 0; i < 3 && !(await page.locator(`#cal-months button[data-d="${D(6)}"]`).count()); i++) await page.click("#cal-next");
ok(await page.locator(`#cal-months button[data-d="${D(6)}"]`).isDisabled(), "a booked day can't be picked");
await page.click(`#cal-months button[data-d="${D(2)}"]`);
ok(await page.locator(`#cal-months button[data-d="${D(10)}"]`).isDisabled(), "after picking a start before a booking, days past it are blocked");
await page.click("#cal-close");

// pick free dates, DFW handoff; the page shows the same total the server will charge
await pickRange(10, 14);
await page.selectOption("#b-loc", "dfw");
const expect = quote({ car: "escalade", location: "dfw", days: 4 }).total / 100;
const shown = (await page.textContent("#b-quote .sum")).replace(/[^\d.]/g, "");
ok(Number(shown) === expect, `trip total on the page ($${shown}) matches what the server charges ($${expect})`);

// book -> Stripe -> pay -> back to the site
await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click("#b-go")]);
const p = stripe.calls.create.at(-1).params;
ok(p.metadata.from === D(10) && p.metadata.to === D(14) && p.metadata.location === "dfw", "Stripe checkout started with the chosen dates and DFW");
const sid = [...stripe.sessions.keys()].at(-1);
await H["/api/stripe-webhook"](signedEvent("checkout.session.completed", stripe.pay(sid)));
await page.goto(p.success_url.replace("{CHECKOUT_SESSION_ID}", sid));
await page.waitForSelector("#done[open]"); await page.waitForTimeout(400);
ok((await page.textContent("#done-title")).includes("You're booked"), "after paying, the site shows 'You're booked!'");
ok((await page.textContent("#done-sum")).includes("DFW"), "confirmation shows the trip details");
ok(!page.url().includes("session_id"), "the address bar is cleaned up");
await page.screenshot({ path: "e2e-confirmed.png" });
await page.click("#done-close");

// the new booking now blocks those dates for the next renter
await page.click("[data-book=escalade]");
await page.click("#b-from-btn");
for (let i = 0; i < 3 && !(await page.locator(`#cal-months button[data-d="${D(12)}"]`).count()); i++) await page.click("#cal-next");
ok(await page.locator(`#cal-months button[data-d="${D(12)}"]`).isDisabled(), "the dates just booked are now blocked");
await page.click("#cal-close"); await page.keyboard.press("Escape");

// renter backs out of Stripe checkout
await page.click("[data-book=srx]"); await pickRange(20, 22);
await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click("#b-go")]);
await page.goto(stripe.calls.create.at(-1).params.cancel_url); await page.waitForTimeout(700);
ok((await page.textContent(".toast")).includes("weren't charged"), "cancelled checkout: renter told they weren't charged");
ok((await makeRepo(store).active("srx")).length === 0, "cancelled checkout: the dates are free again");

// booking server error
apiDown = true;
await page.click("[data-book=van]"); await pickRange(3, 5);
await page.click("#b-go"); await page.waitForTimeout(600);
ok(await page.isVisible("#b-notice") && (await page.textContent("#b-notice")).includes("Text"), "server error: clear message with a text-us link, still on the site");
await page.screenshot({ path: "e2e-error.png" });
apiDown = false;

// opened as a file (no server): falls back to text booking
const p2 = await browser.newPage();
await p2.goto("file://" + join(ROOT, "index.html")); await p2.waitForTimeout(500);
await p2.click("[data-book=bmw]");
ok((await p2.textContent("#b-go")).includes("Text us"), "no server: falls back to 'Text us to book'");

ok(errs.length === 0, "no page errors " + errs.join(" | "));
await browser.close(); server.close();
