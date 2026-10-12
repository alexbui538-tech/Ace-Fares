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

// pick free dates, DFW handoff; the page shows the same total the server will charge
await pickRange(10, 14);
await page.selectOption("#b-loc", "dfw");
const expect = quote({ car: "escalade", location: "dfw", days: 4, from: D(10) }).total / 100;
const shown = (await page.textContent("#b-quote .sum")).replace(/[^\d.]/g, "");
ok(Number(shown) === expect, `trip total on the page ($${shown}) matches what the server charges ($${expect})`);

// book while logged out -> "Log in to book" -> sign up -> straight on to Stripe
ok(await page.isVisible("#acct-out") && !(await page.isVisible("#acct-in")), "header shows Log in / Sign up when logged out");
await page.click("#b-go");
await page.waitForSelector("#auth[open]");
ok((await page.textContent("#auth-title")).includes("Log in to book"), "Book and pay while logged out opens 'Log in to book'");
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
ok(p.metadata.from === D(10) && p.metadata.to === D(14) && p.metadata.location === "dfw", "Stripe checkout started with the chosen dates and DFW");
const sid = [...stripe.sessions.keys()].at(-1);
await H["/api/stripe-webhook"](signedEvent("checkout.session.completed", stripe.pay(sid)));
await page.goto(p.success_url.replace("{CHECKOUT_SESSION_ID}", sid));
await page.waitForSelector("#done[open]"); await page.waitForTimeout(400);
ok((await page.textContent("#done-title")).includes("You're booked"), "after paying, the site shows 'You're booked!'");
ok((await page.textContent("#done-sum")).includes("DFW"), "confirmation shows the trip details");
ok(!page.url().includes("session_id"), "the address bar is cleaned up");
ok(await page.isVisible("#done-verify") && (await page.getAttribute("#done-verify", "href")).startsWith("/verify.html?car=escalade&ref="), "after paying: 'Verify your license now' button");
ok(await page.isVisible("#acct-in") && (await page.textContent("#acct-first")) === "Riley", "header shows Riley's account");
await page.screenshot({ path: "e2e-confirmed.png" });
await page.click("#done-close");

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

// owner bookings page
const a = await browser.newPage(); const aErrs = []; a.on("pageerror", e => aErrs.push(e.message));
a.on("dialog", d => d.accept());
await a.goto(base + "/admin.html");
await a.fill("#key", "wrong"); await a.click("#login button"); await a.waitForTimeout(800);
ok((await a.textContent("#login-err")).includes("isn't right"), "bookings page: wrong admin key is refused");
await a.fill("#key", "owner-key-123"); await a.click("#login button"); await a.waitForTimeout(800);
const txt = await a.textContent("main");
ok(txt.includes("Test Renter") && txt.includes("Paid") && txt.includes("DFW Airport"), "bookings page: shows the paid booking with renter and pickup");
await a.screenshot({ path: "e2e-admin.png", fullPage: true });
const btn = a.locator('button.danger[data-car="escalade"]').first();
await btn.click(); await a.waitForTimeout(900);
const esc = await makeRepo(store).all("escalade");
ok(esc.some(b => b.status === "cancelled"), "bookings page: owner can cancel a booking, freeing the dates");
ok(aErrs.length === 0, "bookings page: no errors " + aErrs.join(" | "));

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

ok(errs.length === 0, "no page errors " + errs.join(" | "));
await browser.close(); server.close();
