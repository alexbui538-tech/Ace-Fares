// Browser test: the real page + the real booking server code, with a fake Stripe.
// Run: npm i --no-save playwright && npx playwright install chromium && node tests/site.e2e.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { availabilityHandler, checkoutHandler, cancelHandler, bookingStatusHandler, webhookHandler, adminHandler, adminCancelHandler } from "../lib/handlers.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { makeAuth } from "../lib/auth.mjs";
import { verifyHandler } from "../lib/identity.mjs";
import { makeReferrals } from "../lib/referrals.mjs";
import { inspectionHandler } from "../lib/inspections.mjs";
import { quote } from "../lib/pricing.mjs";
import { tripHandler, adminTripHandler } from "../lib/trips.mjs";
import { makeReviews } from "../lib/reviews.mjs";
import { hostHandler, contactHandler } from "../lib/host.mjs";
import { adminToolsHandler } from "../lib/admin-tools.mjs";
import { payHandler } from "../lib/pay.mjs";
import { saveSettings } from "../lib/trips.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) process.exitCode = 1; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nm = new Date(); nm.setDate(1); nm.setMonth(nm.getMonth() + 1);           // first of next month
const D = day => iso(new Date(nm.getFullYear(), nm.getMonth(), day));

const store = memoryStore(), stripe = fakeStripe(), users = memoryStore(), mails = [];
let base = "", apiDown = false;
const referrals = makeReferrals({ users, bookingsStore: store, siteUrl: "" });
const photos = memoryStore();
const auth = makeAuth({ store: users, bookingsStore: store, secret: "e2e-secret", mailer: { send: async m => { mails.push(m); } }, referrals, log: { error() {}, warn() {}, log() {} } });
const inspection = inspectionHandler({ photos, store, userOf: auth.userOf, adminKey: "owner-key-123" });
const ownerMailer = { ownerEmail: "owner@example.com", send: async m => { mails.push(m); } };
const quietLog = { error() {}, warn() {}, log() {} };
const reviews = makeReviews({ store, mailer: ownerMailer, log: quietLog });
const checkoutFor = siteUrl => checkoutHandler({ store, stripe, siteUrl, userOf: auth.userOf, requireAccount: true, linkBooking: auth.linkBooking });
const H = {
  "/api/availability": availabilityHandler({ store }),
  "/api/checkout": checkoutFor(""),
  "/api/verify": verifyHandler({ store, stripe, userOf: auth.userOf, siteUrl: "" }),
  "/api/cancel": cancelHandler({ store, stripe }),
  "/api/booking": bookingStatusHandler({ store, stripe }),
  "/api/stripe-webhook": webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET }),
  "/api/admin/bookings": adminHandler({ store, adminKey: "owner-key-123" }),
  "/api/admin/cancel": adminCancelHandler({ store, adminKey: "owner-key-123" }),
  "/api/trip": tripHandler({ store, stripe, userOf: auth.userOf, mailer: ownerMailer, log: quietLog }),
  "/api/admin/trip": adminTripHandler({ store, stripe, adminKey: "owner-key-123", mailer: ownerMailer, reviews, log: quietLog }),
  "/api/reviews": reviews.handler({ userOf: auth.userOf }),
  "/api/host-application": hostHandler({ store, mailer: ownerMailer, log: quietLog }),
  "/api/contact": contactHandler({ store, mailer: ownerMailer, log: quietLog }),
  "/api/admin/tools": adminToolsHandler({ store, adminKey: "owner-key-123", log: quietLog }),
  "/api/pay": payHandler({ store, stripe, siteUrl: "", log: quietLog }),
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const h = url.pathname.startsWith("/api/auth/") ? auth.handler : url.pathname.startsWith("/api/inspection") ? inspection : H[url.pathname];
  if (h) {
    if (apiDown && url.pathname === "/api/checkout") { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
    const chunks = []; for await (const c of req) chunks.push(c);
    // siteUrl is read when checkout runs
    const r = await (url.pathname === "/api/checkout" ? checkoutFor(base) : h)(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
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

// pick free dates, Dallas pickup; the page shows the same total the server will charge
await pickRange(10, 14);
await page.selectOption("#b-loc", "dallas-pickup");
const expect = quote({ car: "escalade", location: "dallas-pickup", days: 4, from: D(10) }).total / 100;
const shown = (await page.textContent("#b-quote .sum")).replace(/[^\d.]/g, "");
ok(Number(shown) === expect, `trip total on the page ($${shown}) matches what the server charges ($${expect})`);
// 7+ days on the Escalade: weekends at the weekday price, same total as the server
await pickRange(10, 17);
const expect7 = quote({ car: "escalade", location: "dallas-pickup", days: 7, from: D(10) }).total / 100;
const shown7 = (await page.textContent("#b-quote .sum")).replace(/[^\d.]/g, "");
ok(Number(shown7) === expect7, `7-day trip total on the page ($${shown7}) matches the server ($${expect7}), weekends at the weekday price`);
ok((await page.textContent("#b-quote")).includes("$259 × 7 days"), "7-day trip: one line at the weekday price");
ok(await page.locator("#b-deals .deal.on[data-we]").count() === 1, "7-day trip: the 'Weekends at $259' deal is lit");
await page.locator("#b-quote").screenshot({ path: "e2e-week.png" });
// 30+ days on the Escalade: $200 every day, then 30% off
await pickRange(10, 40);
const expect30 = quote({ car: "escalade", location: "dallas-pickup", days: 30, from: D(10) }).total / 100;
const shown30 = (await page.textContent("#b-quote .sum")).replace(/[^\d.]/g, "");
ok(Number(shown30) === expect30 && expect30 === 4620, `30-day Escalade total on the page ($${shown30}) matches the server ($${expect30}): $200 x 30, 30% off, + 10% tax`);
ok((await page.textContent("#b-quote")).includes("$200 × 30 days (monthly price)") && (await page.textContent("#b-quote")).includes("Monthly discount (30%)"), "30-day trip: one line at $200, then the 30% monthly discount");
ok(await page.locator("#b-deals .deal.on").count() === 2 && await page.locator("#b-deals .deal.on[data-mo]").count() === 1 && await page.locator('#b-deals .deal.on[data-min="30"]').count() === 1, "30-day trip: the $200/day and 30% monthly deals are lit");
await page.locator("#b-quote").screenshot({ path: "e2e-month.png" });
await pickRange(10, 14);

// book while logged out -> "Log in to book" -> sign up -> straight on to Stripe
ok(await page.isVisible("#acct-out") && !(await page.isVisible("#acct-in")), "header shows Log in / Sign up when logged out");
await page.click("#b-go");
await page.waitForSelector("#auth[open]");
ok((await page.textContent("#auth-title")).includes("Log in or sign up"), "when login is required (REQUIRE_ACCOUNT=true): Book and pay while logged out asks to log in");
await page.screenshot({ path: "e2e-auth.png" });
await page.fill("#a-email", "nope"); await page.click("#auth [data-step=start] button[type=submit]");
ok((await page.textContent("#auth-err")).includes("valid email"), "sign-in: a bad email gets a clear message");
await page.fill("#a-email", "Riley.Brooks@example.com"); await page.click("#auth [data-step=start] button[type=submit]");
await page.waitForSelector("#auth [data-step=signup]:not([hidden])");
ok((await page.textContent("#auth [data-step=signup] .a-email-show")) === "Riley.Brooks@example.com", "new email: goes to the sign-up form with the email filled in");
await page.fill("#a-first", "Riley"); await page.fill("#a-last", "Brooks"); await page.fill("#a-phone", "214-555-0188"); await page.fill("#a-newpass", "short");
await page.click("#auth [data-step=signup] button[type=submit]");
await page.waitForFunction(() => document.querySelector("#auth-err").textContent.includes("8 characters"), null, { timeout: 5000 }).catch(() => {});
ok((await page.textContent("#auth-err")).includes("8 characters"), "sign-up: short password is refused");
await page.fill("#a-newpass", "riley-pass-2027");
await page.screenshot({ path: "e2e-signup.png" });
await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click("#auth [data-step=signup] button[type=submit]")]);
ok(true, "after signing up, booking continues straight to payment");
const riley = (await users.getWithMetadata(`email-${(await import("../lib/auth.mjs")).sha("riley.brooks@example.com")}`)).data.id;
ok((await makeRepo(store).all("escalade")).some(b => b.userId === riley), "the booking is saved to Riley's account");

// pay -> back to the site
const p = stripe.calls.create.at(-1).params;
ok(p.metadata.from === D(10) && p.metadata.to === D(14) && p.metadata.location === "dallas-pickup", "Stripe checkout started with the chosen dates and Dallas pickup");
const sid = [...stripe.sessions.keys()].at(-1);
await H["/api/stripe-webhook"](signedEvent("checkout.session.completed", stripe.pay(sid)));
await page.goto(p.success_url.replace("{CHECKOUT_SESSION_ID}", sid));
await page.waitForSelector("#done[open]"); await page.waitForTimeout(400);
ok((await page.textContent("#done-title")).includes("You're booked"), "after paying, the site shows 'You're booked!'");
ok((await page.textContent("#done-sum")).includes("Dallas pickup"), "confirmation shows the trip details");
ok(!page.url().includes("session_id"), "the address bar is cleaned up");
ok(await page.isVisible("#done-verify") && (await page.getAttribute("#done-verify", "href")).startsWith("/verify.html?car=escalade&ref="), "after paying: 'Verify your license now' button");
ok(await page.isVisible("#acct-in") && (await page.textContent("#acct-first")) === "Riley", "header shows Riley's account");
await page.screenshot({ path: "e2e-confirmed.png" });
ok(!(await page.isVisible("#done-close")), "You're booked: no 'do it later' option, only Verify your license");
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
ok(await page.isVisible("#done[open]"), "You're booked: Escape doesn't skip the license check");
await page.evaluate(() => document.querySelector("#done").close());

// My trips: the paid trip, with the license check to do
await page.click("#acct-btn"); await page.click("#m-trips"); await page.waitForSelector("#trips .trip");
const tripTxt = await page.textContent("#trips-list");
ok(tripTxt.includes("Escalade") && tripTxt.includes("Booked") && tripTxt.includes("Verify ID by"), "My trips lists the booking and its ID deadline");
const verifyHref = await page.getAttribute("#trips-list a.btn", "href");
await page.screenshot({ path: "e2e-trips.png" });
await page.click("#trips-close");

// license + selfie page (Stripe Identity)
await page.route(/verify\.stripe\.com/, r => r.fulfill({ contentType: "text/html", body: "<h1>Stripe ID check</h1>" }));
await page.goto(base + verifyHref); await page.waitForSelector("#page:not([hidden])");
ok((await page.textContent("#box-license")).includes("front and the back") && (await page.textContent("#box-selfie")).includes("selfie"), "ID page: license box and selfie box");
ok(await page.isDisabled("#go"), "ID page: Start is disabled until the consent box is checked");
ok((await page.textContent("#start .agree")).trim().startsWith("I agree that Ace Fares Rental may use its identity verification provider."), "ID page: short consent line");
await page.click("#terms-open"); await page.waitForSelector("#terms-dlg[open]");
ok((await page.textContent("#consent-text")).includes("biometric") && !(await page.isChecked("#consent")), "ID page: Terms and conditions opens the full Texas biometric notice (box stays unchecked)");
await page.click("#terms-close");
ok((await page.textContent("#due")).includes("within 1 hour of booking"), "ID page: shows the 1-hour deadline");
await page.click("#box-license");
ok((await page.textContent("#err")).includes("agree first"), "ID page: tapping a box before agreeing asks for consent");
await page.screenshot({ path: "e2e-verify.png", fullPage: true });
await page.goto(base + "/"); await page.waitForTimeout(500); await page.locator("#refer-band").screenshot({ path: "e2e-refer-band.png" });
await page.goto(base + verifyHref); await page.waitForSelector("#page:not([hidden])");
await page.check("#consent");
await Promise.all([page.waitForURL(/verify\.stripe\.com/), page.click("#box-license")]);
const vs = [...stripe.identity.verificationSessions.all.keys()].at(-1);
ok(stripe.calls.vsCreate.at(-1).params.options.document.require_matching_selfie === true, "ID page: opens Stripe's license + matching-selfie check");
await H["/api/stripe-webhook"](signedEvent("identity.verification_session.verified", stripe.finishIdentity(vs, { first: "Riley", last: "Brooks" })));
await page.goto(base + verifyHref + "&returned=1"); await page.waitForSelector("#state:not([hidden])");
ok((await page.textContent("#state-title")).includes("You're verified"), "ID page: shows 'You're verified' after the check");
await page.goto(base + "/"); await page.waitForTimeout(500);

// log out, then log back in with the password
await page.click("#acct-btn"); await page.click("#m-logout"); await page.waitForTimeout(300);
ok(await page.isVisible("#acct-out"), "log out: back to Log in / Sign up");
await page.click(".login-link"); await page.fill("#a-email", "riley.brooks@example.com"); await page.click("#auth [data-step=start] button[type=submit]");
await page.waitForSelector("#auth [data-step=login]:not([hidden])");
await page.fill("#a-pass", "wrong-password"); await page.click("#auth [data-step=login] button[type=submit]");
await page.waitForSelector("#auth-err:not([hidden])");
ok((await page.textContent("#auth-err")).includes("don't match"), "log in: wrong password is refused");
await page.fill("#a-pass", "riley-pass-2027"); await page.click("#auth [data-step=login] button[type=submit]");
await page.waitForSelector("#acct-in:not([hidden])");
ok(!(await page.isVisible("#auth")), "log in with email + password works");

// refer a friend: link in the account menu, invite bar for the friend
await page.click("#refer-cta"); await page.waitForSelector("#refer[open]");
await page.waitForFunction(() => /invite=[A-Z2-9]{7}$/.test(document.querySelector("#ref-url").value));
const invite = await page.inputValue("#ref-url");
ok(/^http:\/\/localhost:\d+\/\?invite=[A-Z2-9]{7}$/.test(invite), "Refer a friend shows the renter's invite link");
await page.screenshot({ path: "e2e-refer.png" });
await page.click("#refer-close");
const friend = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await friend.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
await friend.goto(invite); await friend.waitForSelector("#invite-bar:not([hidden])");
ok((await friend.textContent("#invite-bar")).includes("Riley invited you: $50 off"), "invite link: friend sees 'Riley invited you: $50 off your first trip'");
await friend.click("#invite-go"); await friend.waitForSelector("#auth[open]");
ok(await friend.isVisible("#auth-invite"), "invite link: the sign-up window shows the $50 invite");
await friend.fill("#a-email", "casey@example.com"); await friend.click("#auth [data-step=start] button[type=submit]");
await friend.waitForSelector("#auth [data-step=signup]:not([hidden])");
await friend.fill("#a-first", "Casey"); await friend.fill("#a-last", "Nguyen"); await friend.fill("#a-newpass", "casey-pass-1");
await friend.click("#auth [data-step=signup] button[type=submit]"); await friend.waitForSelector("#acct-in:not([hidden])");
await friend.click("#acct-btn");
ok((await friend.textContent("#acct-credit")).includes("$50 off your first trip"), "the friend's account has $50 off their first trip");
await friend.close();

// pickup photos: renter takes every shot on the photo page
const tripRef = new URL(base + verifyHref).searchParams.get("ref");
page.on("dialog", d => d.accept());
await page.goto(`${base}/inspect.html?car=escalade&ref=${tripRef}&stage=pickup`); await page.waitForSelector("#page:not([hidden])");
ok(await page.locator("#shots .shot").count() === 9 && await page.isDisabled("#submit"), "photo page: 9 photo boxes, Submit disabled until done");
const pic = join(ROOT, "images", "escalade-1-sm.webp");
for (const shot of ["front", "back", "driver", "passenger", "odometer", "fuel", "interior_front", "interior_back", "damage"]) {
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click(`.shot[data-shot="${shot}"]`)]);
  await fc.setFiles(pic);
  await page.waitForSelector(`.shot.has[data-shot="${shot}"]`);
}
await page.fill("#odo", "41,200"); await page.selectOption("#fuel", "3/4"); await page.fill("#notes", "Small chip on the windshield");
ok(!(await page.isDisabled("#submit")), "photo page: Submit turns on with every photo plus mileage and fuel");
await page.screenshot({ path: "e2e-inspect.png", fullPage: true });
await page.click("#submit"); await page.waitForSelector("#done-note:not([hidden])");
ok((await page.textContent("#done-note")).includes("41,200 miles"), "photo page: submitted with mileage and fuel, then locked");
ok(photos.keys().filter(k => k.startsWith(`img/${tripRef}/pickup/renter/`)).length === 9, "every photo is saved in the photo database");
ok(await page.evaluate(() => [...document.querySelectorAll("#shots img[data-key]")].every(i => i.complete && i.naturalWidth > 0)), "photo page: the saved photos show as thumbnails");
// host side, with the admin key
const hp = await browser.newPage(); hp.on("dialog", d => d.accept());
await hp.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
await hp.goto(`${base}/inspect.html?car=escalade&ref=${tripRef}&stage=pickup&as=host`); await hp.waitForSelector("#keyform:not([hidden])");
await hp.fill("#key", "owner-key-123"); await hp.click("#keyform button"); await hp.waitForSelector("#page:not([hidden])");
ok((await hp.textContent("#who")).includes("Host") && (await hp.textContent("#other-title")).includes("Renter's pickup photos"), "host photo page: separate host checklist, renter's photos shown read-only");
await hp.close();
await page.goto(base + "/"); await page.waitForTimeout(400);

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

// become a host: the form goes straight to the business inbox
await page.goto(base + "/?e2e=host#host"); await page.waitForSelector("#host-form");
await page.fill("#h-name", "Dana Fox"); await page.fill("#h-phone", "214-555-0142"); await page.fill("#h-email", "dana@example.com"); await page.fill("#h-car", "2019 Lexus RX 350");
await page.click("#h-send"); await page.waitForSelector("#host-ok.show");
ok(mails.some(m => m.to === "owner@example.com" && m.replyTo === "dana@example.com" && m.subject === "New host application: 2019 Lexus RX 350 (Dana Fox)"), "host form: emailed to the business inbox, reply goes to the applicant");
ok((await page.textContent("#host-ok")).includes("We got your details"), "host form: thank-you message on the page");
await page.goto(base + "/"); await page.waitForTimeout(400);

// My trips: ask to extend, see the cancel terms
await page.click("#acct-btn"); await page.click("#m-trips"); await page.waitForSelector("#trips .trip [data-act=extend]");
await page.click("#trips [data-act=extend]"); await page.waitForSelector("#trips .trip-panel .rows .tot");
ok((await page.textContent("#trips .trip-panel")).includes("Extension fee (1 x $25)"), "My trips: extension price shows the daily rate + $25");
await page.screenshot({ path: "e2e-trips-extend.png" });
await page.click("#trips [data-act=extend-send]"); await page.waitForSelector("#trips .pill.warn >> text=Extension to");
const rb = (await makeRepo(store).all("escalade")).find(b => b.userId === riley);
ok(rb.extension && rb.extension.status === "requested" && rb.extension.to === D(15), "My trips: extension request saved and the extra day held");
ok(mails.some(m => m.to === "owner@example.com" && /Extension request/.test(m.subject)), "owner emailed about the extension request");
await page.click("#trips [data-act=cancel]"); await page.waitForSelector("#trips [data-act=cancel-yes]");
ok((await page.textContent("#trips .trip-panel:not([hidden])")).includes("full refund"), "My trips: Cancel trip explains the refund first");
await page.click("#trips .trip-panel:not([hidden]) [data-act=close]"); await page.click("#trips-close");

// a finished trip gets a review from the emailed link, and it shows on the home page
const pastRef = "00000000-0000-4000-8000-000000000001";
await repo.hold("srx", { from: "2026-01-02", to: "2026-01-04", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" }, pastRef);
await repo.confirm("srx", pastRef, { customer: { name: "Morgan Diaz", email: "morgan@example.com" }, reviewToken: "tok-e2e-123" });
await page.goto(`${base}/review.html?car=srx&ref=${pastRef}&t=tok-e2e-123`); await page.waitForSelector("#form:not([hidden])");
await page.click('label[for="s5"]'); await page.fill("#text", "Clean car, easy pickup, would rent again.");
await page.screenshot({ path: "e2e-review.png", fullPage: true });
await page.click("#send"); await page.waitForSelector("#thanks:not([hidden])");
await page.goto(base + "/"); await page.waitForSelector("#reviews:not([hidden])");
ok((await page.textContent("#reviews")).includes("Clean car, easy pickup") && (await page.textContent("#reviews")).includes("Morgan D."), "reviews: posted review shows on the home page");
await page.locator("#reviews").screenshot({ path: "e2e-reviews.png" });

// owner bookings page
const a = await browser.newPage(); const aErrs = []; a.on("pageerror", e => aErrs.push(e.message));
a.on("dialog", d => d.accept());
await a.goto(base + "/admin.html");
await a.fill("#key", "wrong"); await a.click("#login button"); await a.waitForTimeout(800);
ok((await a.textContent("#login-err")).includes("isn't right"), "bookings page: wrong admin key is refused");
await a.fill("#key", "owner-key-123"); await a.click("#login button"); await a.waitForTimeout(800);
const txt = await a.textContent("main");
ok(txt.includes("Test Renter") && txt.includes("Paid") && txt.includes("Dallas pickup"), "bookings page: shows the paid booking with renter and pickup");
await a.screenshot({ path: "e2e-admin.png", fullPage: true });
ok(await a.isChecked("#ext-on"), "bookings page: extension requests switch is on");
await a.click('button[data-ext="extend-approve"]'); await a.waitForTimeout(900);
ok((await makeRepo(store).get("escalade", rb.id)).to === D(15), "bookings page: approving the extension charges the card and moves the return date");
await a.click(`button[data-charge][data-id="${rb.id}"]`); await a.waitForSelector("#charge-dlg[open]");
await a.selectOption("#cf-type", "toll"); await a.fill("#cf-cost", "7.25"); await a.waitForFunction(() => /\$22\.25/.test(document.querySelector("#cf-go").textContent));
await a.screenshot({ path: "e2e-charge.png" });
await a.click("#cf-go"); await a.waitForTimeout(900);
const ch = (await makeRepo(store).get("escalade", rb.id)).charges || [];
ok(ch.length === 1 && ch[0].total === 2225 && ch[0].status === "paid", "bookings page: toll charged at cost + $15 handling");
ok(mails.some(m => m.to === rb.customer.email && /Charges for your trip/.test(m.subject) && /Handling fee \(1 x \$15\.00\)/.test(m.text)), "renter emailed an itemized statement");
// a declined charge emails a payment link, and the pay page opens Stripe
stripe.fake.declineCharges = true;
await a.click(`button[data-charge][data-id="${rb.id}"]`); await a.waitForSelector("#charge-dlg[open]");
await a.selectOption("#cf-type", "cleaning"); await a.waitForFunction(() => /\$30\.00/.test(document.querySelector("#cf-go").textContent));
await a.click("#cf-go"); await a.waitForSelector("#cf-err:text('secure link')");
stripe.fake.declineCharges = false;
const payMail = mails.find(m => /Payment needed/.test(m.subject));
ok(!!payMail, "declined charge: renter emailed a payment link");
await a.keyboard.press("Escape"); await a.waitForTimeout(500);
ok(await a.locator(`button[data-paylink]`).count() === 1, "bookings page: unpaid charge shows Resend payment link");
const payUrl = payMail.text.match(/\/pay\.html\?\S+/)[0];
const pp = await browser.newPage(); pp.on("pageerror", e => aErrs.push(e.message));
await pp.route(/checkout\.stripe\.com/, r => r.fulfill({ contentType: "text/html", body: "<p>Stripe checkout</p>" }));
await pp.goto(base + payUrl); await pp.waitForSelector("#card:not([hidden])");
ok((await pp.textContent("#rows")).includes("$30.00") && (await pp.textContent("#pay")).includes("Pay $30.00"), "pay page: shows the itemized charge");
await pp.screenshot({ path: "e2e-pay.png" });
await Promise.all([pp.waitForURL(/checkout\.stripe\.com/), pp.click("#pay")]);
ok(true, "pay page: Pay opens Stripe's secure checkout");
await pp.close();

// block dates
await a.click("#block-open"); await a.waitForSelector("#block-dlg[open]");
await a.selectOption("#bk-car", "van"); await a.fill("#bk-from", D(20)); await a.fill("#bk-to", D(22)); await a.fill("#bk-note", "Tires");
await a.click("#bk-go"); await a.waitForTimeout(700);
ok((await makeRepo(store).all("van")).some(b => b.status === "blocked" && b.from === D(20) && b.to === D(22)), "bookings page: owner blocks dates");
ok((await a.textContent("main")).includes("Tires"), "bookings page: the blocked dates show in the list");

// prices tab
await a.click("[data-tab=prices]"); await a.waitForSelector('tr[data-car="srx"] input[name="weekday"]');
await a.fill('tr[data-car="srx"] input[name="weekday"]', "55"); await a.click("#p-save"); await a.waitForTimeout(700);
ok((await (await fetch(base + "/api/availability")).json()).prices.srx.weekday === 55, "prices tab: new price is what the website shows");
await a.screenshot({ path: "e2e-prices.png", fullPage: true });
await a.click("#p-reset"); await a.waitForTimeout(700);
ok((await (await fetch(base + "/api/availability")).json()).prices.srx.weekday === 39, "prices tab: back to defaults");

// vehicles tab
await a.click("[data-tab=vehicles]"); await a.waitForSelector('.vcard[data-car="escalade"]');
await a.click('.vcard[data-car="escalade"] details:nth-of-type(2) summary');
await a.fill('.vcard[data-car="escalade"] [name="plate"]', "ACE 777"); await a.fill('.vcard[data-car="escalade"] [name="lastOilMiles"]', "38000");
await a.click('.vcard[data-car="escalade"] [data-vsave]'); await a.waitForSelector('.vcard[data-car="escalade"] h3 small');
ok((await a.textContent('.vcard[data-car="escalade"]')).includes("41,200 miles") && (await a.textContent('.vcard[data-car="escalade"]')).includes("ACE 777"), "vehicles tab: mileage from the pickup photos, details saved");
await a.screenshot({ path: "e2e-vehicles.png", fullPage: true });

// reports tab
await a.click("[data-tab=reports]"); await a.waitForSelector(".tiles");
ok((await a.textContent(".tiles")).includes("Texas rental tax collected"), "reports tab: monthly totals with the rental tax");
await a.screenshot({ path: "e2e-reports.png", fullPage: true });
const [dl] = await Promise.all([a.waitForEvent("download"), a.click("#rp-dl")]);
ok(/^ace-fares-sales-\d{4}-\d{2}\.csv$/.test(dl.suggestedFilename()), "reports tab: downloads the sales report spreadsheet");
const [dl2] = await Promise.all([a.waitForEvent("download"), a.click("#ex-csv")]);
ok(/^ace-fares-bookings-.*\.csv$/.test(dl2.suggestedFilename()), "reports tab: downloads every booking as a spreadsheet");

// reviews tab
await a.click("[data-tab=reviews]"); await a.waitForSelector('button[data-rev="review-hide"]');
await a.click('button[data-rev="review-hide"]'); await a.waitForTimeout(600);
ok((await reviews.summary()).count === 0, "reviews tab: owner can hide a review");

// compare pickup and return photos
await a.goto(`${base}/compare.html?car=escalade&ref=${rb.id}`); await a.waitForSelector("#page:not([hidden])");
await a.waitForFunction(() => [...document.querySelectorAll("img[data-key]")].some(i => i.complete && i.naturalWidth > 0));
ok(await a.locator("#rows .row").count() === 9 && (await a.textContent("#trip")).includes("41,200 miles"), "compare page: pickup and return side by side for each photo");
await a.screenshot({ path: "e2e-compare.png", fullPage: true });
await a.goto(base + "/admin.html"); await a.waitForSelector("[data-tab=bookings]");
await a.click("[data-tab=bookings]"); await a.waitForSelector("#ext-on");

await a.click("#ext-on"); await a.waitForTimeout(500);
ok((await (await import("../lib/trips.mjs")).getSettings(store)).extensionsAllowed === false, "bookings page: owner can turn extension requests off");
await saveSettings(store, { extensionsAllowed: true });
const btn = a.locator('button.danger[data-car="escalade"]').first();
await btn.click(); await a.waitForSelector("#cancel-dlg[open]");
await a.click("#cx-go"); await a.waitForTimeout(900);
const esc = await makeRepo(store).all("escalade");
ok(esc.some(b => b.status === "cancelled"), "bookings page: owner can cancel a booking, freeing the dates");
ok(aErrs.length === 0, "bookings page: no errors " + aErrs.join(" | "));

// contact form
await page.goto(base + "/?e2e=contact#message"); await page.waitForSelector("#contact-form");
await page.fill("#c-name", "Pat Kim"); await page.fill("#c-email", "pat@example.com"); await page.fill("#c-msg", "Do you rent by the month?");
await page.click("#c-send"); await page.waitForSelector("#c-ok.show");
ok(mails.some(m => m.to === "owner@example.com" && m.replyTo === "pat@example.com" && /Website message/.test(m.subject)), "contact form: message emailed to the business inbox");

// phone: header, sign-in window and My trips fit the screen
const m = await browser.newPage({ viewport: { width: 390, height: 844 } }); m.on("pageerror", e => errs.push(e.message));
await m.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
await m.goto(base + "/"); await m.waitForTimeout(400);
ok(await m.isVisible(".login-link"), "phone: Log in is in the header");
await m.click(".login-link"); await m.waitForSelector("#auth[open]");
ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: sign-in window has no sideways scrolling");
await m.screenshot({ path: "e2e-phone-auth.png" });
await m.fill("#a-email", "riley.brooks@example.com"); await m.click("#auth [data-step=start] button[type=submit]");
await m.waitForSelector("#auth [data-step=login]:not([hidden])");
await m.fill("#a-pass", "riley-pass-2027"); await m.click("#auth [data-step=login] button[type=submit]");
await m.waitForSelector("#acct-in:not([hidden])");
await m.click("#acct-btn"); await m.screenshot({ path: "e2e-phone-menu.png" });
await m.click("#m-trips"); await m.waitForSelector("#trips .trip");
ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: My trips has no sideways scrolling");
await m.screenshot({ path: "e2e-phone-trips.png" });
// change dates from My trips
await m.click("#trips [data-act=change]"); await m.waitForSelector("#trips .trip-panel:not([hidden]) input[type=date]");
const panel = "#trips .trip-panel:not([hidden])";
await m.fill(`${panel} input[id^=chg-from]`, D(24)); await m.fill(`${panel} input[id^=chg-to]`, D(26));
await m.locator(`${panel} input[id^=chg-to]`).dispatchEvent("change");
await m.waitForSelector(`${panel} .rows .tot`);
ok((await m.textContent(panel)).includes("Paid so far"), "My trips: Change dates shows the new price and the difference");
await m.screenshot({ path: "e2e-phone-change.png" });
await m.click(`${panel} [data-act=change-send]`); await m.waitForSelector("#trips .pill.warn >> text=New dates requested");
const rc = (await makeRepo(store).all("escalade")).find(b => b.userId === riley && b.status === "confirmed");
ok(rc && rc.change && rc.change.status === "requested" && rc.change.from === D(24), "My trips: date change request saved and the new dates held");
ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: change dates fits the screen");

ok(errs.length === 0, "no page errors " + errs.join(" | "));
await browser.close(); server.close();
