// Browser test for the on-site checkout page: the real pages + the real booking server code,
// with fake Stripe on both sides (server API and Stripe.js in the browser).
// Run: npm i --no-save playwright && npx playwright install chromium && node tests/checkout.e2e.mjs [screenshot-dir]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { availabilityHandler, checkoutHandler, checkoutDetailsHandler, cancelHandler, bookingStatusHandler, webhookHandler } from "../lib/handlers.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { makeAuth } from "../lib/auth.mjs";
import { quote, daysBetween } from "../lib/pricing.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const SHOTS = process.argv[2] || "";
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) process.exitCode = 1; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nm = new Date(); nm.setDate(1); nm.setMonth(nm.getMonth() + 1);
const D = day => iso(new Date(nm.getFullYear(), nm.getMonth(), day));

const store = memoryStore(), stripe = fakeStripe(), PK = "pk_test_fake";
const mailer = { sent: [], async send(m) { this.sent.push(m); } };
let base = "";
const auth = makeAuth({ store: memoryStore(), bookingsStore: store, secret: "e2e", log: { error() {}, warn() {}, log() {} } });
const hook = webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, mailer, siteUrl: "" });
const H = {
  "/api/availability": availabilityHandler({ store }),
  "/api/checkout-details": checkoutDetailsHandler({ store, stripe, publishableKey: PK, userOf: auth.userOf, accounts: auth }),
  "/api/cancel": cancelHandler({ store, stripe }),
  "/api/booking": bookingStatusHandler({ store, stripe, mailer, siteUrl: "" }),
  "/api/stripe-webhook": hook,
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === "/__test/pay") {          // the fake Stripe.js "pays": Stripe marks it paid and sends the webhook
    const pi = stripe.payIntent(url.searchParams.get("pi"));
    await hook(signedEvent("payment_intent.succeeded", pi));
    res.writeHead(200); return res.end("ok");
  }
  const h = url.pathname === "/api/checkout" ? checkoutHandler({ store, stripe, siteUrl: base, publishableKey: PK, userOf: auth.userOf, requireAccount: false, linkBooking: auth.linkBooking })
    : url.pathname.startsWith("/api/auth/") ? auth.handler : H[url.pathname];
  if (h) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await h(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  try {
    let f = await readFile(join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    // these tests cover the site's own checkout; ?wb=1 keeps the live setting (Wheelbase takes bookings)
    if ((url.pathname === "/" || url.pathname === "/index.html") && !url.searchParams.has("wb")) f = Buffer.from(String(f).replace('booking: "wheelbase"', 'booking: "site"'));
    res.writeHead(200, { "content-type": { ".html": "text/html", ".webp": "image/webp", ".png": "image/png" }[extname(url.pathname) || ".html"] || "application/octet-stream" }); res.end(f);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`;

const FAKE_STRIPE_JS = `
window.Stripe = function (pk) { window.__pk = pk; return {
  elements(opts) { window.__elOpts = opts; return {
    create() { return { mount(sel) { document.querySelector(sel).innerHTML =
      '<div class="fake-pe" style="display:grid;gap:10px">' +
      '<div style="display:flex;gap:8px"><div style="flex:1;border:1.5px solid #15130F;border-radius:10px;padding:10px 12px;font-weight:600">Card</div><div style="flex:1;border:1.5px solid #E4DCCB;border-radius:10px;padding:10px 12px;color:#514A3D">Google Pay</div></div>' +
      '<div style="border:1.5px solid #E4DCCB;border-radius:10px;padding:13px;color:#6F6757">1234 1234 1234 1234</div>' +
      '<div style="display:flex;gap:10px"><div style="flex:1;border:1.5px solid #E4DCCB;border-radius:10px;padding:13px;color:#6F6757">MM / YY</div><div style="flex:1;border:1.5px solid #E4DCCB;border-radius:10px;padding:13px;color:#6F6757">CVC</div></div>' +
      '<div style="display:flex;gap:10px"><div style="flex:1;border:1.5px solid #E4DCCB;border-radius:10px;padding:13px">United States</div><div style="flex:1;border:1.5px solid #E4DCCB;border-radius:10px;padding:13px;color:#6F6757">ZIP</div></div></div>'; }, on() {} }; },
    async submit() { return {}; } }; },
  async confirmPayment({ confirmParams }) {
    window.__confirm = confirmParams;
    if (confirmParams.payment_method_data.billing_details.name === "Decline Test") return { error: { message: "Your card was declined." } };
    const pi = window.__elOpts.clientSecret.split("_secret")[0];
    await fetch("/__test/pay?pi=" + pi, { method: "POST" });
    return { paymentIntent: { id: pi, status: "succeeded" } };
  } }; };`;

const browser = await chromium.launch();
let renters = 0;
async function newPage(w = 1280, h = 900, stripeJs = FAKE_STRIPE_JS, guest = false) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  p.errs = []; p.on("pageerror", e => p.errs.push(e.message));
  // every renter books from a signed-in account (each page gets its own)
  if (!guest) {
  const su = await p.request.post(base + "/api/auth/signup", { data: { email: `renter${++renters}@example.com`, password: "renter-pass-1", firstName: "Jordan", lastName: "Lee", phone: "(214) 555-0100" } });
  if (su.status() !== 201) throw new Error("test sign-up failed " + su.status());
  }
  await p.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await p.route(/js\.stripe\.com/, r => stripeJs ? r.fulfill({ contentType: "application/javascript", body: stripeJs }) : r.abort());
  return p;
}
async function pickRange(p, a, b) {
  await p.click("#b-from-btn"); await p.waitForSelector("#cal[open]");
  for (let i = 0; i < 3 && !(await p.locator(`#cal-months button[data-d="${D(a)}"]`).count()); i++) await p.click("#cal-next");
  await p.click(`#cal-months button[data-d="${D(a)}"]`); await p.click(`#cal-months button[data-d="${D(b)}"]`);
  await p.click("#cal-done");
}
async function startCheckout(p, car, a, b, loc) {
  await p.goto(base + "/"); await p.waitForTimeout(400);
  await p.click(`[data-book=${car}]`); await pickRange(p, a, b);
  if (loc) await p.selectOption("#b-loc", loc);
  await Promise.all([p.waitForURL(/\/checkout\.html\?car=/), p.click("#b-go")]);
  await p.waitForSelector("#page:not([hidden])");
}
const fill = async (p, name = "Jordan Lee") => {
  const [f, ...l] = name.split(" ");
  await p.fill("#first", f); await p.fill("#last", l.join(" ")); await p.fill("#email", "jordan@example.com"); await p.fill("#phone", "(214) 555-0100");
  await p.selectOption("#age", "25+"); await p.fill("#ins-co", "State Farm");
  if (await p.isVisible("#addr")) await p.fill("#addr", "123 Main St, Dallas, TX 75201");
};

/* 1. happy path, desktop */
const p = await newPage();
await startCheckout(p, "escalade", 10, 13, "dallas-delivery");
ok(/\/checkout\.html\?car=escalade&ref=/.test(p.url()), "Book and pay securely opens the site's own checkout page");
ok(await p.inputValue("#first") === "Jordan" && await p.inputValue("#last") === "Lee" && /^renter\d+@example\.com$/.test(await p.inputValue("#email")) && await p.inputValue("#phone") === "(214) 555-0100", "checkout is prefilled from the renter's account");
ok((await p.textContent("#h-details")) === "Primary driver" && await p.locator("#cc option").count() >= 2 && (await p.textContent("#age option")) === "Select your age", "Primary driver form: first/last name, country code, mobile, email, age");
ok(await p.locator(".fake-pe").count() === 1, "Stripe payment form is shown on the page");
const shownTotal = (await p.textContent("#sum-total")).trim();
const q = quote({ car: "escalade", location: "dallas-delivery", from: D(10), days: daysBetween(D(10), D(13)) });
ok(shownTotal === "$" + (q.total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }), `summary total ${shownTotal} matches what is charged`);
ok((await p.textContent("#sum-car")).includes("Escalade") && (await p.textContent("#sum-loc")) === "Delivery", "summary shows the car and delivery");
ok(/holding these dates/.test(await p.textContent("#hold")), "hold countdown is shown");
ok(await p.evaluate(() => window.__pk) === PK, "Stripe started with the publishable key from the server");
if (SHOTS) await p.screenshot({ path: `${SHOTS}/checkout-desktop.png`, fullPage: true });

ok(await p.isDisabled("#pay-btn"), "Book trip is disabled until the agreement box is checked");
ok(/^I agree to pay the total shown \(\$[\d,.]+\) and to the Ace Fares Rental Agreement/.test(await p.textContent("#agree-text")), "short agreement line next to the box");
const agreeLinks = await p.$$eval("#agree-text a", as => as.map(a => [a.textContent, a.getAttribute("href")]));
ok(agreeLinks.length === 6 && agreeLinks.some(([t, h]) => t === "privacy policy" && h === "/privacy.html") && agreeLinks.some(([t, h]) => t === "cancellation policy" && h === "/rental-agreement#section-15"), "each document it names is a link");
ok((await p.textContent("#t-deposit")) === "$750" && (await p.textContent("#t-smoke")) === "$150" && !(await p.isHidden("#sum-dep")), "key terms and deposit shown");
await p.check("#agree");
ok(!(await p.isDisabled("#pay-btn")), "checking the box enables Book trip");
await p.uncheck("#agree"); ok(await p.isDisabled("#pay-btn"), "unchecking disables it again");
await p.check("#agree");
await p.fill("#first", ""); await p.selectOption("#age", "under18");
await p.click("#pay-btn");
ok(await p.locator("#c-first.bad").count() === 1 && p.url().includes("checkout.html"), "empty details: asks for the name, nothing charged");
ok((await p.textContent("#age-err")).includes("at least 18") && await p.locator("#c-age.bad").count() === 1 && (await p.$$eval("#age option", o => o.map(x => x.value))).includes("18"), "18+: ages start at 18, under 18 can't book");
await fill(p);
await Promise.all([p.waitForURL(/booking=success|\/$|\/#/), p.click("#pay-btn")]);
await p.waitForSelector("#done[open]"); await p.waitForTimeout(500);
ok((await p.textContent("#done-title")).includes("You're booked"), "after paying: You're booked!");
ok((await p.textContent("#done-text")).includes("jordan@example.com"), "confirmation mentions the renter's email");
ok(mailer.sent.length === 1 && mailer.sent[0].to === "jordan@example.com", "confirmation + agreement emailed once");
const bk = (await makeRepo(store).all("escalade")).find(b => b.from === D(10));
ok(bk && bk.handoff && bk.handoff.address === "123 Main St, Dallas, TX 75201", "delivery: the address is asked for and saved with the booking");
ok(bk && bk.status === "confirmed" && bk.customer.phone === "+1 (214) 555-0100" && bk.customer.age === "25+" && bk.termsAccepted, "booking saved with renter details (phone with country code, age) and agreement");
ok(bk && bk.signature && /^[0-9a-f]{64}$/.test(bk.signature.sha256) && bk.signature.clientTime && bk.signature.depositAck && bk.signature.smokingAck, "signature recorded with time, fingerprint and policy acknowledgments");
ok(bk && bk.deposit && bk.deposit.status === "scheduled", "deposit hold scheduled for 24h before pickup");
ok(/Signature record/.test(mailer.sent[0].html), "email includes the signature record");
if (SHOTS) await p.screenshot({ path: `${SHOTS}/checkout-done.png` });

/* 2. declined card, phone size */
const m = await newPage(390, 844);
await startCheckout(m, "srx", 16, 18);
const top = await m.evaluate(() => [document.querySelector(".sum").getBoundingClientRect().top, document.querySelector(".form").getBoundingClientRect().top]);
ok(top[0] < top[1], "phone: trip summary shows above the form");
ok(await m.evaluate(() => document.documentElement.scrollWidth) === 390, "phone: no sideways scrolling");
if (SHOTS) await m.screenshot({ path: `${SHOTS}/checkout-phone.png`, fullPage: true });
await fill(m, "Decline Test"); await m.check("#agree"); await m.click("#pay-btn"); await m.waitForTimeout(400);
ok(!(await m.isHidden("#pay-err")) && (await m.textContent("#pay-err")).includes("declined"), "declined card: clear message, still on checkout");
ok(m.url().includes("checkout.html") && !(await m.isDisabled("#pay-btn")), "declined card: can try again");
ok((await makeRepo(store).active("srx")).some(b => b.from === D(16)), "declined card: dates still held");

/* 3. Change trip releases the dates */
await Promise.all([m.waitForURL(/\/#fleet$/), m.click("#back")]);
ok(!(await makeRepo(store).active("srx")).some(b => b.from === D(16)), "Change trip: dates released");

/* 4. Stripe.js blocked */
const x = await newPage(1280, 900, null);
await startCheckout(x, "bmw", 20, 22);
ok((await x.textContent("#pay-err")).includes("couldn't load") && await x.isDisabled("#pay-btn"), "payment form blocked: clear message, can't submit");

/* 5. dead link */
await x.goto(base + "/checkout.html?car=bmw&ref=00000000-0000-0000-0000-000000000000"); await x.waitForTimeout(300);
ok(await x.isVisible("#ended"), "invalid checkout link: friendly 'ended' screen");

for (const pg of [p, m, x]) ok(pg.errs.length === 0, "no page errors " + pg.errs.join(" | "));
/* guest: books without logging in; checkout creates the account and signs them in */
const gp = await newPage(1280, 900, FAKE_STRIPE_JS, true);
await startCheckout(gp, "srx", 24, 26);
ok(await gp.isVisible("#login-btn") && (await gp.getAttribute("#login-btn", "href")).startsWith("/?login=1&next=%2Fcheckout.html"), "guest: books without logging in; checkout shows a Log in button next to Your details");
await gp.fill("#first", "Morgan"); await gp.fill("#last", "Diaz"); await gp.fill("#email", "morgan@example.com"); await gp.fill("#phone", "(214) 555-0177");
await gp.selectOption("#age", "23"); await gp.fill("#ins-co", "GEICO");
await gp.check("#agree");
await Promise.all([gp.waitForURL(/booking=success/), gp.click("#pay-btn")]);
await gp.waitForSelector("#done[open]"); await gp.waitForTimeout(600);
ok((await gp.textContent("#done-title")).includes("You're booked"), "guest: paid and booked");
ok(await gp.isVisible("#acct-in") && (await gp.textContent("#acct-first")) === "Morgan", "guest: their account was created and they're logged in");
ok(await gp.isVisible("#done-verify"), "guest: can go straight on to verify their license");
ok((await gp.textContent("#done-text b")) === "within the next hour", "You're booked: 'within the next hour' is bold");
await gp.close();

await browser.close(); server.close();
