// Renter cancellations, trip extensions, post-trip charges, reviews and the host form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth } from "../lib/auth.mjs";
import { makeReferrals } from "../lib/referrals.mjs";
import { checkoutHandler, checkoutDetailsHandler, webhookHandler, availabilityHandler, adminHandler } from "../lib/handlers.mjs";
import { tripHandler, adminTripHandler, extensionQuote, priceCharge, cancelTerms } from "../lib/trips.mjs";
import { makeReviews, displayName } from "../lib/reviews.mjs";
import { hostHandler } from "../lib/host.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { localMs } from "../lib/deposits.mjs";
import { AGREEMENT_VERSION, agreementText, POLICY } from "../lib/agreement.mjs";
import { updateJSON } from "../lib/kv.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

const quiet = { error() {}, warn() {}, log() {} };
const H = 3600e3;
const j = async res => ({ status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] });
const req = (path, { method = "GET", body, cookie, headers = {} } = {}) => new Request("https://site.test" + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers } });

function setup() {
  let t = NOW; const now = () => t;
  const users = memoryStore(), store = memoryStore(), stripe = fakeStripe({ clock: now });
  const sent = [], mailer = { ownerEmail: "acefaresrental@gmail.com", send: async m => { sent.push(m); } };
  const notices = [], notify = async (subject, text) => { notices.push({ subject, text }); };
  const referrals = makeReferrals({ users, bookingsStore: store, now, mailer, siteUrl: "https://acefares.test", log: quiet });
  const auth = makeAuth({ store: users, bookingsStore: store, now, secret: "s", mailer, siteUrl: "https://acefares.test", referrals, log: quiet });
  const reviews = makeReviews({ store, now, mailer, siteUrl: "https://acefares.test", notify, log: quiet });
  const deps = { store, stripe, now, mailer, siteUrl: "https://acefares.test", notify, referrals, log: quiet };
  const trip = tripHandler({ ...deps, userOf: auth.userOf });
  const admin = adminTripHandler({ ...deps, adminKey: "owner-key", reviews });
  const rev = reviews.handler({ userOf: auth.userOf });
  return { now, setTime: x => { t = x; }, users, store, stripe, sent, notices, auth, reviews, referrals,
    a: (path, o) => auth.handler(req("/api/auth/" + path, o), { ip: "198.51.100.1" }).then(j),
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now, publishableKey: "pk_test_1", userOf: auth.userOf, linkBooking: auth.linkBooking, creditsFor: referrals.creditsFor }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: "pk_test_1", now, userOf: auth.userOf }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, mailer, siteUrl: "https://acefares.test", referrals }),
    trip: (body, cookie) => trip(req("/api/trip", { method: "POST", body, cookie })).then(j),
    admin: body => admin(req("/api/admin/trip", { method: "POST", body, headers: { "x-admin-key": "owner-key" } })).then(j),
    rev: (o, path = "/api/reviews") => rev(req(path, o)).then(j),
    host: (body, ip = "203.0.113.9") => hostHandler({ store, mailer, now, log: quiet })(req("/api/host-application", { method: "POST", body }), { ip }).then(j),
    avail: () => availabilityHandler({ store, now })(req("/api/availability")).then(j),
    repo: makeRepo(store, { now }) };
}
const person = (email, first) => ({ email, password: "pass-word-1", firstName: first, lastName: "Lee", phone: "2145550100" });
const sign = { name: "Jordan Lee", email: "jordan@example.com", phone: "(214) 555-0100", agree: true, termsVersion: AGREEMENT_VERSION, insurance: { choice: "own", company: "State Farm", policy: "SF-1" } };
const TRIP = { car: "srx", from: "2027-03-01", to: "2027-03-06", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };   // Mon to Sat

async function signup(s, email = "jordan@example.com", first = "Jordan") { return s.a("signup", { method: "POST", body: person(email, first) }); }
async function bookAndPay(s, cookie, trip = TRIP) {
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await j(await s.details(req("/api/checkout-details", { method: "POST", cookie, body: { car: trip.car, ref: r.data.ref, ...sign } })));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const b = await s.repo.get(trip.car, r.data.ref);
  await s.hook(signedEvent("payment_intent.succeeded", s.stripe.payIntent(b.paymentIntentId)));
  return s.repo.get(trip.car, b.id);
}

/* ---------- the agreement ---------- */

test("rental agreement has the $15 toll/ticket handling fee, the $25/day extension fee and online cancellation", () => {
  assert.equal(POLICY.ticketAdminFee, 15); assert.equal(POLICY.extensionDailyFee, 25);
  const text = agreementText({});
  assert.match(text, /A \$15 handling fee applies to each toll or ticket we process/);
  assert.match(text, /Each extra day costs that day's daily rate plus a \$25 extension fee, plus tax/);
  assert.match(text, /You can cancel in My trips on our website any time before your pickup time/);
  assert.doesNotMatch(text, /\[to be set\]/);
});

/* ---------- cancellations ---------- */

test("renter cancels within 24 hours of booking: full refund, dates open again, both sides emailed", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  assert.equal(b.status, "confirmed");
  // My trips shows the cancel terms
  const trips = (await s.a("trips", { cookie: me.cookie })).data.trips;
  assert.equal(trips[0].cancel.allowed, true); assert.equal(trips[0].cancel.free, true); assert.equal(trips[0].cancel.refund, b.amountPaid);
  // preview, then confirm
  const p = await s.trip({ action: "cancel", car: "srx", ref: b.id }, me.cookie);
  assert.equal(p.data.preview.fee, 0);
  s.setTime(NOW + 23 * H);
  s.sent.length = 0;
  const c = await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.totalRefund, b.amountPaid); assert.equal(c.data.fee, 0);
  assert.equal(s.stripe.calls.refunds.length, 1);
  assert.equal(s.stripe.calls.refunds[0].params.amount, b.amountPaid);
  const after = await s.repo.get("srx", b.id);
  assert.equal(after.status, "cancelled"); assert.equal(after.cancellation.status, "refunded"); assert.equal(after.cancellation.by, "renter");
  assert.deepEqual((await s.avail()).data.cars.srx, []);
  assert.deepEqual(s.sent.map(m => m.to).sort(), ["acefaresrental@gmail.com", "jordan@example.com"]);
  assert.match(s.sent.find(m => m.to === "jordan@example.com" && /cancelled/.test(m.subject)).text, /refund of \$/);
  // twice does nothing more
  assert.equal((await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie)).status, 409);
  assert.equal(s.stripe.calls.refunds.length, 1);
});

test("cancelling more than 24 hours after booking keeps the $20 fee; after pickup it can't be cancelled online", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  s.setTime(NOW + 25 * H);
  const c = await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal(c.status, 200);
  assert.equal(c.data.fee, 2000); assert.equal(c.data.totalRefund, b.amountPaid - 2000);
  assert.equal(s.stripe.calls.refunds[0].params.amount, b.amountPaid - 2000);
  assert.match(s.sent.find(m => m.to === "jordan@example.com" && /cancelled/.test(m.subject)).text, /\$20\.00 cancellation fee/);

  const b2 = await bookAndPay(s, me.cookie, { ...TRIP, from: "2027-04-01", to: "2027-04-03" });
  s.setTime(localMs("2027-04-01", "10:00") + 60e3);
  const again = (await s.a("login", { method: "POST", body: { email: "jordan@example.com", password: "pass-word-1" } })).cookie;   // months later
  const late = await s.trip({ action: "cancel", car: "srx", ref: b2.id, confirm: true }, again);
  assert.equal(late.status, 409); assert.match(late.data.message, /already started/);
  assert.equal(cancelTerms(await s.repo.get("srx", b2.id), s.now()).allowed, false);
});

test("only the renter who booked can cancel; logged-out gets 401", async () => {
  const s = setup();
  const me = await signup(s), other = await signup(s, "sam@example.com", "Sam");
  const b = await bookAndPay(s, me.cookie);
  assert.equal((await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, other.cookie)).status, 404);
  assert.equal((await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true })).status, 401);
  assert.equal((await s.repo.get("srx", b.id)).status, "confirmed");
});

test("a refund that fails still cancels the trip and tells the owner to refund in Stripe", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  s.stripe.fake.failRefunds = true;
  const c = await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal(c.status, 200); assert.equal(c.data.refundFailed, true);
  assert.equal((await s.repo.get("srx", b.id)).cancellation.status, "refund_failed");
  assert.match(s.sent.find(m => m.to === "acefaresrental@gmail.com" && /cancelled/.test(m.subject)).text, /Refund .* in your Stripe dashboard/);
});

test("cancelling gives back Ace Fares credit the trip used", async () => {
  const s = setup();
  const me = await signup(s);
  await updateJSON(s.users, `user-${me.data.user.id}`, u => ({ ...u, credit: 3000 }));
  const b = await bookAndPay(s, me.cookie);
  assert.equal(b.credits[0].amount, 3000);
  assert.equal((await s.a("me", { cookie: me.cookie })).data.user.credit ?? 0, 0);
  await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  const u = JSON.parse(JSON.stringify(await (await s.users.getWithMetadata(`user-${me.data.user.id}`, { type: "json" })).data));
  assert.equal(u.credit, 3000);
  await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal((await s.users.getWithMetadata(`user-${me.data.user.id}`, { type: "json" })).data.credit, 3000);   // once
});

/* ---------- extensions ---------- */

test("extension price: each extra day's rate + $25, plus tax", () => {
  const q = extensionQuote("srx", { from: "2027-03-01", to: "2027-03-06", toTime: "10:00" }, "2027-03-08");   // Sat + Sun
  // the trip becomes 7 days, so the SRX's Sat + Sun cost the $49 weekday price
  assert.equal(q.days, 2); assert.equal(q.weekends, 2); assert.equal(q.weekendRate, 49); assert.equal(q.rental, 9800); assert.equal(q.fee, 5000);
  assert.equal(q.tax, 1480);
  const short = extensionQuote("srx", { from: "2027-03-03", to: "2027-03-06", toTime: "10:00" }, "2027-03-08");   // a 5-day trip: weekend price
  assert.equal(short.weekendRate, 69); assert.equal(short.rental, 13800); assert.equal(q.total, 16280);
  assert.throws(() => extensionQuote("srx", { from: "2027-03-01", to: "2027-03-06" }, "2027-03-06"), /after your current one/);
});

test("renter asks to extend; the extra days are held; owner approves and the saved card is charged", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  assert.equal((await s.a("trips", { cookie: me.cookie })).data.trips[0].canExtend, true);
  const q = await s.trip({ action: "extend-quote", car: "srx", ref: b.id, to: "2027-03-08" }, me.cookie);
  assert.equal(q.status, 200, JSON.stringify(q.data)); assert.equal(q.data.quote.total, 16280);
  s.sent.length = 0;
  const r = await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-08" }, me.cookie);
  assert.equal(r.status, 200); assert.equal(r.data.extension.status, "requested");
  assert.equal(s.sent[0].to, "acefaresrental@gmail.com"); assert.match(s.sent[0].subject, /Extension request/);
  // held for this renter while the owner decides
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-01", to: "2027-03-08" }]);
  const other = await signup(s, "sam@example.com", "Sam");
  const clash = await j(await s.checkout(req("/api/checkout", { method: "POST", cookie: other.cookie, body: { ...TRIP, from: "2027-03-08", to: "2027-03-10" } })));
  assert.equal(clash.status, 409);
  // a second request waits for the first
  assert.equal((await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-09" }, me.cookie)).status, 409);
  assert.equal((await s.a("trips", { cookie: me.cookie })).data.trips[0].extension.status, "requested");

  s.sent.length = 0;
  const ok = await s.admin({ action: "extend-approve", car: "srx", id: b.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const charge = s.stripe.calls.piCreate.at(-1).params;
  assert.equal(charge.amount, 16280); assert.equal(charge.off_session, true); assert.equal(charge.metadata.kind, "extension");
  assert.equal(charge.customer, s.stripe.intents.get(b.paymentIntentId).customer);
  const after = await s.repo.get("srx", b.id);
  assert.equal(after.to, "2027-03-08"); assert.equal(after.extension.status, "approved");
  assert.deepEqual(after.extensions.map(e => [e.from, e.to, e.amount]), [["2027-03-06", "2027-03-08", 16280]]);
  assert.equal(s.sent[0].to, "jordan@example.com"); assert.match(s.sent[0].subject, /Extension approved/);
  assert.equal((await s.admin({ action: "extend-approve", car: "srx", id: b.id })).status, 409);   // only once

  // the extension charge's webhook doesn't touch the trip
  const pi = s.stripe.intents.get(after.extension.paymentIntentId);
  assert.deepEqual((await j(await s.hook(signedEvent("payment_intent.succeeded", pi)))).data, { received: true, ignored: true });

  // cancelling before pickup refunds the extension too
  const c = await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal(c.data.extensionRefund, 16280); assert.equal(s.stripe.calls.refunds.length, 2);
});

test("owner can switch extension requests off; declined and failed requests", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  assert.equal((await s.admin({ action: "settings", extensionsAllowed: false })).data.settings.extensionsAllowed, false);
  const off = await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-08" }, me.cookie);
  assert.equal(off.status, 409); assert.match(off.data.message, /Text us/);
  const t = (await s.a("trips", { cookie: me.cookie })).data.trips[0];
  assert.equal(t.canExtend, false); assert.equal(t.extensionsOff, true);
  await s.admin({ action: "settings", extensionsAllowed: true });

  // declined: dates free again, renter told
  await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-08" }, me.cookie);
  s.sent.length = 0;
  assert.equal((await s.admin({ action: "extend-decline", car: "srx", id: b.id })).status, 200);
  assert.equal((await s.repo.get("srx", b.id)).to, "2027-03-06");
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-01", to: "2027-03-06" }]);
  assert.match(s.sent[0].subject, /extension request/);

  // card declined: recorded, renter emailed, dates still held, owner can retry
  await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-07" }, me.cookie);
  s.stripe.fake.declineCharges = true;
  const f = await s.admin({ action: "extend-approve", car: "srx", id: b.id });
  assert.equal(f.status, 402); assert.match(f.data.message, /declined/);
  assert.equal((await s.repo.get("srx", b.id)).extension.status, "payment_failed");
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-01", to: "2027-03-07" }]);
  s.stripe.fake.declineCharges = false;
  assert.equal((await s.admin({ action: "extend-approve", car: "srx", id: b.id })).status, 200);
  assert.equal((await s.repo.get("srx", b.id)).to, "2027-03-07");
});

test("an extension into someone else's booking is refused; withdrawing a request frees the days", async () => {
  const s = setup();
  const me = await signup(s), sam = await signup(s, "sam@example.com", "Sam");
  const b = await bookAndPay(s, me.cookie);
  await bookAndPay(s, sam.cookie, { ...TRIP, from: "2027-03-08", to: "2027-03-10" });
  const r = await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-08" }, me.cookie);
  assert.equal(r.status, 409); assert.match(r.data.message, /booked by someone else/);
  assert.equal((await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-07" }, me.cookie)).status, 200);   // returning the 7th leaves a day's gap
  assert.equal((await s.trip({ action: "extend-withdraw", car: "srx", ref: b.id }, me.cookie)).data.extension.status, "withdrawn");
  assert.equal((await s.trip({ action: "extend-withdraw", car: "srx", ref: b.id }, me.cookie)).status, 409);
});

/* ---------- post-trip charges ---------- */

test("charge prices follow the rental agreement", () => {
  const b = { from: "2027-03-01", to: "2027-03-06" };
  assert.equal(priceCharge("srx", b, { type: "toll", qty: 2, cost: "12.50" }).total, 1250 + 3000);
  assert.equal(priceCharge("srx", b, { type: "ticket", cost: 75 }).total, 7500 + 1500);
  assert.equal(priceCharge("srx", b, { type: "miles", qty: 40 }).total, 3960);          // 99 cents a mile
  assert.equal(priceCharge("escalade", b, { type: "miles", qty: 40 }).total, 12000);     // $3 a mile for the Escalade
  assert.equal(priceCharge("srx", b, { type: "fuel", cost: 20 }).total, 5000);
  assert.equal(priceCharge("srx", b, { type: "fuel", cost: 0 }).total, 3000);
  assert.equal(priceCharge("srx", b, { type: "late" }).total, 5000);
  assert.equal(priceCharge("srx", b, { type: "lateDays", qty: 2 }).total, 6900 * 2);   // Sat + Sun
  assert.equal(priceCharge("srx", b, { type: "cleaning" }).total, 3000);
  assert.equal(priceCharge("srx", b, { type: "smoking" }).total, 15000);
  assert.throws(() => priceCharge("srx", b, { type: "other", cost: 100 }), /what this charge is for/);
  assert.throws(() => priceCharge("srx", b, { type: "toll", cost: 0 }), /amount/);
  assert.throws(() => priceCharge("srx", b, { type: "nope" }), /Choose/);
});

test("owner charges tolls to the saved card; the renter gets an itemized statement; a decline is recorded", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  const q = await s.admin({ action: "charge-quote", car: "srx", id: b.id, type: "toll", qty: 3, cost: 9.6 });
  assert.equal(q.data.quote.total, 960 + 4500);
  s.sent.length = 0;
  const r = await s.admin({ action: "charge", car: "srx", id: b.id, type: "toll", qty: 3, cost: 9.6, note: "NTTA TollTag, Mar 2-4" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pi = s.stripe.calls.piCreate.at(-1).params;
  assert.equal(pi.amount, 5460); assert.equal(pi.metadata.kind, "charge"); assert.equal(pi.metadata.charge_type, "toll"); assert.equal(pi.receipt_email, "jordan@example.com");
  assert.equal(s.sent[0].to, "jordan@example.com");
  assert.match(s.sent[0].text, /Tolls \(3\) at cost: \$9\.60/); assert.match(s.sent[0].text, /Handling fee \(3 x \$15\.00\): \$45\.00/); assert.match(s.sent[0].text, /Total: \$54\.60/);
  s.stripe.fake.declineCharges = true;
  const bad = await s.admin({ action: "charge", car: "srx", id: b.id, type: "cleaning" });
  assert.equal(bad.status, 402);
  const after = await s.repo.get("srx", b.id);
  assert.deepEqual(after.charges.map(c => [c.type, c.total, c.status]), [["toll", 5460, "paid"], ["cleaning", 3000, "failed"]]);
  // the admin page gets the charge menu and settings
  const all = await j(await adminHandler({ store: s.store, adminKey: "owner-key", now: s.now })(req("/api/admin/bookings", { headers: { "x-admin-key": "owner-key" } })));
  assert.equal(all.data._settings.extensionsAllowed, true); assert.match(all.data._chargeTypes.toll.hint, /\$15\.00 handling per toll/);
  assert.equal((await adminTripHandler({ store: s.store, stripe: s.stripe, adminKey: "owner-key" })(req("/api/admin/trip", { method: "POST", body: { action: "charge" }, headers: { "x-admin-key": "nope" } }))).status, 401);
});

test("a charge can be collected from the deposit hold instead", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie, { ...TRIP, from: "2026-10-13", to: "2026-10-15" });   // pickup tomorrow: hold placed now
  assert.equal(b.deposit.status, "held");
  const r = await s.admin({ action: "charge", car: "srx", id: b.id, type: "smoking", source: "deposit", note: "Ash in cup holder, photos sent" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(s.stripe.calls.piCapture.at(-1).params.amount_to_capture, 15000);
  assert.equal((await s.repo.get("srx", b.id)).deposit.status, "captured");
  assert.equal((await s.admin({ action: "charge", car: "srx", id: b.id, type: "cleaning", source: "deposit" })).status, 409);   // the hold is used up
});

/* ---------- reviews ---------- */

test("review request goes out after the trip, once; the renter reviews; it shows on the site; the owner can hide it", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await bookAndPay(s, me.cookie);
  assert.deepEqual(await s.reviews.sweep(), []);
  assert.equal((await s.a("trips", { cookie: me.cookie })).data.trips[0].review.canReview, false);
  const end = localMs(b.to, b.toTime);
  s.setTime(end + H);
  assert.deepEqual(await s.reviews.sweep(), []);                     // waits a couple of hours
  assert.equal((await s.a("trips", { cookie: (await s.a("login", { method: "POST", body: { email: "jordan@example.com", password: "pass-word-1" } })).cookie })).data.trips[0].review.canReview, true);
  s.setTime(end + 2 * H + 60e3);
  s.sent.length = 0;
  assert.deepEqual(await s.reviews.sweep(), [["review-requested", "srx", b.id]]);
  assert.deepEqual(await s.reviews.sweep(), []);
  assert.equal(s.sent.length, 1); assert.equal(s.sent[0].to, "jordan@example.com");
  const link = s.sent[0].text.match(/https:\/\/acefares\.test(\/review\.html\?\S+)/)[1];
  const p = new URL("https://x" + link).searchParams;

  assert.equal((await s.rev({}, `/api/reviews?car=srx&ref=${b.id}&t=wrong`)).status, 404);
  const info = await s.rev({}, `/api/reviews?car=srx&ref=${b.id}&t=${p.get("t")}`);
  assert.equal(info.status, 200); assert.equal(info.data.carName, "Cadillac SRX"); assert.equal(info.data.name, "Jordan L."); assert.equal(info.data.review, null);
  assert.equal((await s.rev({ method: "POST", body: { car: "srx", ref: b.id, t: p.get("t"), stars: 6 } })).status, 400);
  const ok = await s.rev({ method: "POST", body: { car: "srx", ref: b.id, t: p.get("t"), stars: 5, text: "Spotless car and an easy handoff." } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await s.rev({ method: "POST", body: { car: "srx", ref: b.id, t: p.get("t"), stars: 4 } })).status, 409);
  assert.match(s.notices.at(-1).subject, /New 5-star review/);

  const pub = await s.rev({});
  assert.equal(pub.data.count, 1); assert.equal(pub.data.average, 5); assert.deepEqual(pub.data.byCar.srx, { count: 1, average: 5 });
  assert.equal(pub.data.reviews[0].name, "Jordan L."); assert.equal(pub.data.reviews[0].id, undefined);
  assert.equal(pub.data.reviews[0].text, "Spotless car and an easy handoff.");

  assert.equal((await s.admin({ action: "review-hide", id: b.id })).status, 200);
  assert.equal((await s.rev({})).data.count, 0);
  await s.admin({ action: "review-show", id: b.id });
  assert.equal((await s.rev({})).data.count, 1);
});

test("a logged-in renter can review from My trips, but not before the trip is over or someone else's trip", async () => {
  const s = setup();
  const me = await signup(s), sam = await signup(s, "sam@example.com", "Sam");
  const b = await bookAndPay(s, me.cookie);
  const early = await s.rev({ method: "POST", cookie: me.cookie, body: { car: "srx", ref: b.id, stars: 5 } });
  assert.equal(early.status, 409);
  s.setTime(localMs(b.to, b.toTime) + 60e3);
  const login = async email => (await s.a("login", { method: "POST", body: { email, password: "pass-word-1" } })).cookie;
  assert.equal((await s.rev({ method: "POST", cookie: await login("sam@example.com"), body: { car: "srx", ref: b.id, stars: 1 } })).status, 404);
  const ok = await s.rev({ method: "POST", cookie: await login("jordan@example.com"), body: { car: "srx", ref: b.id, stars: 4 } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await s.a("trips", { cookie: await login("jordan@example.com") })).data.trips[0].review, { done: true, stars: 4 });
  assert.equal(displayName("madonna"), "madonna"); assert.equal(displayName("Ana de la Cruz"), "Ana C.");
});

/* ---------- become a host ---------- */

test("host form emails the business inbox with reply-to the applicant, and keeps a copy", async () => {
  const s = setup();
  const r = await s.host({ name: "Maria Gomez", phone: "214-555-0199", email: "Maria@Example.com", car: "2020 Toyota Camry", miles: "45,000", note: "Free on weekdays" });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { ok: true, emailed: true });
  const m = s.sent.at(-1);
  assert.equal(m.to, "acefaresrental@gmail.com"); assert.equal(m.replyTo, "maria@example.com");
  assert.equal(m.subject, "New host application: 2020 Toyota Camry (Maria Gomez)");
  assert.match(m.text, /Phone: 214-555-0199/); assert.match(m.text, /Notes: Free on weekdays/);
  assert.equal(s.store.keys().filter(k => k.startsWith("host-app-")).length, 1);
  // checks
  assert.equal((await s.host({ name: "M", phone: "214-555-0199", car: "Camry" })).data.field, "name");
  assert.equal((await s.host({ name: "Maria", phone: "12", car: "Camry" })).data.field, "phone");
  assert.equal((await s.host({ name: "Maria", phone: "214-555-0199", car: "" })).data.field, "car");
  // bots filling the hidden field are dropped silently
  const n = s.sent.length;
  assert.equal((await s.host({ name: "Bot", phone: "2145550199", car: "Car", website: "http://spam" })).status, 200);
  assert.equal(s.sent.length, n);
  // at most 5 an hour from one network
  for (let i = 0; i < 4; i++) assert.equal((await s.host({ name: "Maria", phone: "2145550199", car: "Camry" }, "203.0.113.50")).status, 200);
  assert.equal((await s.host({ name: "Maria", phone: "2145550199", car: "Camry" }, "203.0.113.50")).status, 200);
  assert.equal((await s.host({ name: "Maria", phone: "2145550199", car: "Camry" }, "203.0.113.50")).status, 429);
});

test("host form still saves the application when email isn't set up", async () => {
  const store = memoryStore();
  const r = await j(await hostHandler({ store, mailer: null, log: quiet })(req("/api/host-application", { method: "POST", body: { name: "Maria", phone: "2145550199", car: "Camry" } }), {}));
  assert.deepEqual(r.data, { ok: true, emailed: false });
  assert.equal(store.keys().filter(k => k.startsWith("host-app-")).length, 1);
});
