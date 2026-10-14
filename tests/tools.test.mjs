// Owner tools: blocked dates, refunds on cancel, date changes, payment links, prices, reports, export,
// vehicle records, reminder emails and the contact form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth } from "../lib/auth.mjs";
import { makeReferrals } from "../lib/referrals.mjs";
import { checkoutHandler, checkoutDetailsHandler, webhookHandler, availabilityHandler } from "../lib/handlers.mjs";
import { tripHandler, adminTripHandler } from "../lib/trips.mjs";
import { adminToolsHandler, makeAdminTools, monthEntries, monthSummary, csv } from "../lib/admin-tools.mjs";
import { payHandler } from "../lib/pay.mjs";
import { makeReminders } from "../lib/reminders.mjs";
import { contactHandler } from "../lib/host.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { localMs } from "../lib/deposits.mjs";
import { quote } from "../lib/pricing.mjs";
import { CARS, DEPOSITS, applyPrices } from "../lib/catalog.mjs";
import { AGREEMENT_VERSION } from "../lib/agreement.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

const quiet = { error() {}, warn() {}, log() {} };
const H = 3600e3, KEY = { "x-admin-key": "owner-key" };
const j = async res => ({ status: res.status, data: await res.json().catch(() => null), cookie: (res.headers.get("set-cookie") || "").split(";")[0], headers: res.headers });
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
  const deps = { store, stripe, now, mailer, siteUrl: "https://acefares.test", notify, referrals, log: quiet };
  const trip = tripHandler({ ...deps, userOf: auth.userOf }), admin = adminTripHandler({ ...deps, adminKey: "owner-key" });
  const tools = adminToolsHandler({ store, adminKey: "owner-key", now, notify, log: quiet });
  const pay = payHandler({ store, stripe, siteUrl: "https://acefares.test", now, notify, log: quiet });
  return { now, setTime: x => { t = x; }, store, users, stripe, sent, notices, auth,
    a: (path, o) => auth.handler(req("/api/auth/" + path, o), { ip: "198.51.100.1" }).then(j),
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now, publishableKey: "pk_test_1", userOf: auth.userOf, linkBooking: auth.linkBooking, creditsFor: referrals.creditsFor }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: "pk_test_1", now, userOf: auth.userOf }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, mailer, siteUrl: "https://acefares.test", referrals, notify }),
    trip: (body, cookie) => trip(req("/api/trip", { method: "POST", body, cookie })).then(j),
    admin: body => admin(req("/api/admin/trip", { method: "POST", body, headers: KEY })).then(j),
    tools: body => tools(req("/api/admin/tools", { method: "POST", body, headers: KEY })).then(j),
    toolsGet: q => tools(req("/api/admin/tools?" + q, { headers: KEY })),
    pay: (o, q = "") => pay(req("/api/pay" + q, o)).then(j),
    avail: () => availabilityHandler({ store, now })(req("/api/availability")).then(j),
    repo: makeRepo(store, { now }) };
}
const sign = { name: "Jordan Lee", email: "jordan@example.com", phone: "(214) 555-0100", agree: true, termsVersion: AGREEMENT_VERSION, insurance: { choice: "own", company: "State Farm", policy: "SF-1" } };
const TRIP = { car: "srx", from: "2027-03-01", to: "2027-03-06", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };   // Mon to Sat
async function signup(s, email = "jordan@example.com", first = "Jordan") { return s.a("signup", { method: "POST", body: { email, password: "pass-word-1", firstName: first, lastName: "Lee", phone: "2145550100" } }); }
async function book(s, cookie, trip = TRIP) {
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await j(await s.details(req("/api/checkout-details", { method: "POST", cookie, body: { car: trip.car, ref: r.data.ref, ...sign } })));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const b = await s.repo.get(trip.car, r.data.ref);
  await s.hook(signedEvent("payment_intent.succeeded", s.stripe.payIntent(b.paymentIntentId)));
  return s.repo.get(trip.car, b.id);
}
const tryBook = async (s, cookie, trip) => j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie })));

/* ---------- blocked dates ---------- */
test("owner blocks dates: renters can't book them, a block can't cover a trip, removing it frees the dates", async () => {
  const s = setup();
  const me = await signup(s);
  const r = await s.tools({ action: "block", car: "srx", from: "2027-03-10", to: "2027-03-12", note: "Oil change" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-10", to: "2027-03-12" }]);
  assert.equal((await tryBook(s, me.cookie, { ...TRIP, from: "2027-03-12", to: "2027-03-14" })).status, 409);
  assert.equal((await tryBook(s, me.cookie, { ...TRIP, from: "2027-03-08", to: "2027-03-10" })).status, 409);
  const ok = await tryBook(s, me.cookie, { ...TRIP, from: "2027-03-13", to: "2027-03-15" });
  assert.equal(ok.status, 200);
  // can't block over a booking in progress
  assert.equal((await s.tools({ action: "block", car: "srx", from: "2027-03-14", to: "2027-03-14" })).status, 409);
  assert.equal((await s.tools({ action: "block", car: "srx", from: "2027-03-12", to: "2027-03-10" })).status, 400);
  assert.equal((await s.tools({ action: "unblock", car: "srx", id: r.data.block.id })).status, 200);
  assert.equal((await tryBook(s, me.cookie, { ...TRIP, from: "2027-03-09", to: "2027-03-11" })).status, 200);
  assert.equal((await s.tools({ action: "unblock", car: "srx", id: r.data.block.id })).status, 404);
  assert.equal((await adminToolsHandler({ store: s.store, adminKey: "owner-key" })(req("/api/admin/tools", { method: "POST", body: { action: "block" }, headers: { "x-admin-key": "x" } }))).status, 401);
});

/* ---------- owner cancel with refund ---------- */
test("owner cancels with a full refund, the policy refund, or no refund", async () => {
  const s = setup();
  const me = await signup(s);
  const a = await book(s, me.cookie), b2 = await book(s, me.cookie, { ...TRIP, from: "2027-04-05", to: "2027-04-07" }), c3 = await book(s, me.cookie, { ...TRIP, from: "2027-05-03", to: "2027-05-05" });
  s.setTime(NOW + 30 * H);
  s.sent.length = 0;
  const full = await s.admin({ action: "cancel", car: "srx", id: a.id, refund: "full" });
  assert.equal(full.status, 200, JSON.stringify(full.data)); assert.equal(full.data.totalRefund, a.amountPaid);
  assert.match(s.sent.find(m => m.to === "jordan@example.com").text, /we've cancelled your Cadillac SRX trip/);
  assert.ok(!s.sent.some(m => m.to === "acefaresrental@gmail.com"));            // no email to yourself for your own cancel
  const pol = await s.admin({ action: "cancel", car: "srx", id: b2.id, refund: "policy" });
  assert.equal(pol.data.totalRefund, b2.amountPaid - 2000);
  const none = await s.admin({ action: "cancel", car: "srx", id: c3.id, refund: "none" });
  assert.equal(none.data.totalRefund, 0);
  assert.deepEqual(s.stripe.calls.refunds.map(r => r.params.amount), [a.amountPaid, b2.amountPaid - 2000]);
  assert.equal((await s.repo.get("srx", c3.id)).status, "cancelled");
  // after pickup the owner can still cancel and refund
  const d4 = await book(s, (await s.a("login", { method: "POST", body: { email: "jordan@example.com", password: "pass-word-1" } })).cookie, { ...TRIP, from: "2027-06-07", to: "2027-06-09" });
  s.setTime(localMs("2027-06-07", "12:00"));
  assert.equal((await s.admin({ action: "cancel", car: "srx", id: d4.id, refund: "full" })).data.totalRefund, d4.amountPaid);
});

/* ---------- date changes ---------- */
test("renter asks to move a trip; both date ranges are held; owner approves and the difference is charged", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);                                       // Mar 1-6, 5 days
  const trips = (await s.a("trips", { cookie: me.cookie })).data.trips;
  assert.equal(trips[0].canChange, true);
  const q = await s.trip({ action: "change-quote", car: "srx", ref: b.id, from: "2027-03-08", to: "2027-03-15", fromTime: "09:00", toTime: "18:00" }, me.cookie);
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const want = quote({ car: "srx", location: "dallas-pickup", days: 7, from: "2027-03-08" }).total;
  assert.equal(q.data.quote.newTotal, want); assert.equal(q.data.quote.diff, want - b.amountPaid);
  assert.equal((await s.trip({ action: "change-quote", car: "srx", ref: b.id, from: b.from, to: b.to }, me.cookie)).status, 400);
  s.sent.length = 0;
  const r = await s.trip({ action: "change", car: "srx", ref: b.id, from: "2027-03-08", to: "2027-03-15", fromTime: "09:00", toTime: "18:00" }, me.cookie);
  assert.equal(r.status, 200); assert.match(s.sent[0].subject, /Date change request/);
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-01", to: "2027-03-06" }, { from: "2027-03-08", to: "2027-03-15" }]);
  assert.equal((await tryBook(s, (await signup(s, "sam@example.com", "Sam")).cookie, { ...TRIP, from: "2027-03-10", to: "2027-03-12" })).status, 409);
  assert.equal((await s.trip({ action: "extend", car: "srx", ref: b.id, to: "2027-03-07" }, me.cookie)).status, 409);   // one request at a time
  const ok = await s.admin({ action: "change-approve", car: "srx", id: b.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await s.repo.get("srx", b.id);
  assert.deepEqual([after.from, after.to, after.fromTime, after.toTime], ["2027-03-08", "2027-03-15", "09:00", "18:00"]);
  assert.equal(s.stripe.calls.piCreate.at(-1).params.amount, want - b.amountPaid);
  assert.equal(after.adjustments[0].amount, want - b.amountPaid);
  assert.deepEqual((await s.avail()).data.cars.srx, [{ from: "2027-03-08", to: "2027-03-15" }]);
  // cancelling now refunds the rental and the extra payment
  const c = await s.trip({ action: "cancel", car: "srx", ref: b.id, confirm: true }, me.cookie);
  assert.equal(c.data.totalRefund, want);
});

test("moving to a cheaper trip refunds the difference; declined requests change nothing", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);                                       // 5 days
  await s.trip({ action: "change", car: "srx", ref: b.id, from: "2027-03-02", to: "2027-03-04" }, me.cookie);
  assert.equal((await s.trip({ action: "change-withdraw", car: "srx", ref: b.id }, me.cookie)).status, 200);
  await s.trip({ action: "change", car: "srx", ref: b.id, from: "2027-03-02", to: "2027-03-04" }, me.cookie);
  assert.equal((await s.admin({ action: "change-decline", car: "srx", id: b.id })).status, 200);
  assert.equal((await s.repo.get("srx", b.id)).from, "2027-03-01");
  await s.trip({ action: "change", car: "srx", ref: b.id, from: "2027-03-02", to: "2027-03-04" }, me.cookie);   // Tue-Thu: 2 weekdays
  const want = quote({ car: "srx", location: "dallas-pickup", days: 2, from: "2027-03-02" }).total;
  assert.equal((await s.admin({ action: "change-approve", car: "srx", id: b.id })).status, 200);
  assert.equal(s.stripe.calls.refunds.at(-1).params.amount, b.amountPaid - want);
  const after = await s.repo.get("srx", b.id);
  assert.equal(after.amountPaid, want);
  assert.match(s.sent.find(m => /Date change approved/.test(m.subject)).text, /We refunded/);
});

/* ---------- payment links ---------- */
test("a declined post-trip charge emails the renter a payment link that works (and the webhook marks it paid)", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);
  s.stripe.fake.declineCharges = true;
  s.sent.length = 0;
  const r = await s.admin({ action: "charge", car: "srx", id: b.id, type: "toll", qty: 1, cost: 12 });
  assert.equal(r.status, 402); assert.match(r.data.message, /emailed the renter a secure link/);
  const mail = s.sent.find(m => /Payment needed/.test(m.subject));
  assert.equal(mail.to, "jordan@example.com");
  const link = new URL(mail.text.match(/https:\/\/acefares\.test\/pay\.html\?\S+/)[0]);
  const qs = "?" + link.searchParams.toString();
  const info = await s.pay({}, qs);
  assert.equal(info.status, 200); assert.equal(info.data.total, 2700); assert.equal(info.data.status, "due");
  assert.equal((await s.pay({}, qs.replace(/t=[^&]+/, "t=wrong"))).status, 404);
  const p = Object.fromEntries(link.searchParams);
  const go = await s.pay({ method: "POST", body: p });
  assert.equal(go.status, 200); assert.match(go.data.url, /checkout\.stripe\.com/);
  const sess = s.stripe.calls.create.at(-1).params;
  assert.equal(sess.metadata.kind, "charge_link"); assert.deepEqual(sess.line_items.map(l => l.price_data.unit_amount), [1200, 1500]);
  // renter pays; coming back to the page confirms it even before the webhook
  const sid = [...s.stripe.sessions.keys()].at(-1);
  s.stripe.pay(sid);
  assert.equal((await s.pay({}, qs + "&paid=1")).data.status, "paid");
  const c = (await s.repo.get("srx", b.id)).charges.at(-1);
  assert.equal(c.status, "paid"); assert.equal(c.paidVia, "link");
  assert.match(s.notices.at(-1).subject, /Paid: Tolls/);
  assert.equal((await s.pay({ method: "POST", body: p })).status, 409);
});

test("the Stripe webhook marks a linked charge paid; owner can resend the link", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);
  s.stripe.fake.declineCharges = true;
  await s.admin({ action: "charge", car: "srx", id: b.id, type: "cleaning" });
  const c = (await s.repo.get("srx", b.id)).charges[0];
  s.sent.length = 0;
  assert.equal((await s.admin({ action: "pay-link", car: "srx", id: b.id, chargeId: c.id })).status, 200);
  assert.equal(s.sent.length, 1);
  const res = await j(await s.hook(signedEvent("checkout.session.completed", { id: "cs_x", payment_status: "paid", payment_intent: "pi_x", amount_total: 3000,
    metadata: { kind: "charge_link", car: "srx", booking_id: b.id, charge_id: c.id } })));
  assert.deepEqual(res.data, { received: true, charge: true });
  assert.equal((await s.repo.get("srx", b.id)).charges[0].status, "paid");
  assert.equal((await s.admin({ action: "pay-link", car: "srx", id: b.id, chargeId: c.id })).status, 409);
});

/* ---------- prices ---------- */
test("prices and deposits set on the bookings page are used for new bookings and shown on the site", async () => {
  const s = setup();
  try {
    const me = await signup(s);
    const r = await s.tools({ action: "prices", cars: { srx: { weekday: 59, weekend: "$79" } }, deposits: { srx: 300 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.prices.cars.srx, { weekday: 59, weekend: 79 }); assert.equal(DEPOSITS.srx, 300);
    assert.deepEqual((await s.avail()).data.prices.srx, { weekday: 59, weekend: 79, deposit: 300 });
    const b = await tryBook(s, me.cookie, { ...TRIP, from: "2027-03-01", to: "2027-03-02" });          // one Monday
    assert.equal(b.data.total, 5900 + 590);
    assert.equal((await s.tools({ action: "prices", cars: { srx: { weekday: 0, weekend: 79 } } })).status, 400);
    const back = await s.tools({ action: "prices-reset" });
    assert.deepEqual(back.data.prices.cars.srx, { weekday: 49, weekend: 69 }); assert.equal(DEPOSITS.srx, 250);
  } finally { applyPrices({}); }
  assert.equal(CARS.srx.weekday, 49);
});

/* ---------- reports and export ---------- */
test("monthly report lists payments, charges and refunds with the Texas rental tax inside; CSV opens in a spreadsheet", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie), b2 = await book(s, me.cookie, { ...TRIP, from: "2027-04-05", to: "2027-04-07" });
  await s.admin({ action: "charge", car: "srx", id: b.id, type: "toll", qty: 2, cost: 10 });
  s.setTime(NOW + 2 * H);
  await s.trip({ action: "cancel", car: "srx", ref: b2.id, confirm: true }, me.cookie);
  const r = await j(await s.toolsGet("action=report&month=2026-10"));
  assert.equal(r.status, 200);
  const types = r.data.entries.map(e => e.type);
  assert.deepEqual(types.sort(), ["Cancellation refund", "Charge: Tolls", "Rental payment", "Rental payment"].sort());
  const pay = r.data.entries.find(e => e.ref === b.id && e.type === "Rental payment");
  const q = quote({ car: "srx", location: "dallas-pickup", days: 5, from: "2027-03-01" });
  assert.equal(pay.total, q.total); assert.ok(Math.abs(pay.tax - q.tax) <= 1, `${pay.tax} vs ${q.tax}`);
  const sum = r.data.summary;
  assert.equal(sum.trips, 2); assert.equal(sum.charges, 1000 + 3000); assert.equal(sum.refunds, b2.amountPaid);
  assert.equal(sum.gross, b.amountPaid + 4000);
  assert.ok(Math.abs(sum.tax - q.tax) <= 2);
  const file = await s.toolsGet("action=report&month=2026-10&format=csv");
  assert.match(file.headers.get("content-disposition"), /ace-fares-sales-2026-10\.csv/);
  const bytes = Buffer.from(await file.arrayBuffer()), text = bytes.toString("utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);          // byte-order mark so Excel reads it as UTF-8
  assert.match(text, /Texas motor vehicle rental tax collected/);
  assert.equal((await j(await s.toolsGet("action=report&month=2026-13"))).status, 400);
  assert.equal((await j(await s.toolsGet("action=report&month=2026-09"))).data.entries.length, 0);
});

test("export: all bookings as a spreadsheet and a full JSON backup; renter text can't run as a formula", async () => {
  const s = setup();
  const me = await signup(s);
  await book(s, me.cookie);
  await s.tools({ action: "block", car: "van", from: "2027-01-01", to: "2027-01-02", note: "=HYPERLINK(\"x\")" });
  const c = await (await s.toolsGet("action=export&format=csv")).text();
  assert.match(c, /jordan@example\.com/); assert.match(c, /Cadillac SRX/); assert.match(c, /blocked/);
  const backup = JSON.parse(await (await s.toolsGet("action=export&format=json")).text());
  assert.equal(backup.bookings.srx.length, 1); assert.equal(backup.bookings.van[0].status, "blocked");
  assert.equal(csv([["=1+1", "-5", "a,b", 'say "hi"']]), "\uFEFF'=1+1,-5,\"a,b\",\"say \"\"hi\"\"\"\r\n");
});

/* ---------- vehicles ---------- */
test("vehicle records: mileage from trip photos, oil change and date reminders emailed once", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);
  await s.repo.note("srx", b.id, { inspection: { pickup: { host: { at: "2027-03-01T16:00:00Z", odometer: 44100, fuel: "F" } }, return: { renter: { at: "2027-03-06T16:00:00Z", odometer: 44720, fuel: "3/4" } } } });
  await s.tools({ action: "vehicle", car: "srx", fields: { plate: "ACE 123", lastOilMiles: "40,000", oilIntervalMiles: 5000, registrationDue: "2026-10-30", inspectionDue: "2027-06-01" } });
  const v = (await j(await s.toolsGet("action=vehicles"))).data.vehicles.find(x => x.car === "srx");
  assert.equal(v.miles.miles, 44720); assert.match(v.miles.source, /Return photos/); assert.equal(v.milesDriven, 620);
  const lvl = Object.fromEntries(v.items.map(i => [i.key, i.level]));
  assert.deepEqual(lvl, { oil: "soon", inspectionDue: "ok", registrationDue: "soon", insuranceDue: "unknown" });
  const tools = makeAdminTools({ store: s.store, now: s.now, notify: async (subject, text) => s.notices.push({ subject, text }), log: quiet });
  assert.deepEqual(await tools.sweep(), [["vehicle-reminder", "srx", "oil,registrationDue"]]);
  assert.match(s.notices.at(-1).subject, /Cadillac SRX: oil change due soon, registration due soon/);
  assert.deepEqual(await tools.sweep(), []);                                // once
  s.setTime(Date.parse("2026-11-02T17:00:00Z"));
  assert.deepEqual(await tools.sweep(), [["vehicle-reminder", "srx", "registrationDue"]]);   // now overdue: one more email
  // logging the oil change resets it
  const done = await s.tools({ action: "service", car: "srx", type: "oil", miles: 44800, date: "2026-11-02", note: "Synthetic" });
  const v2 = done.data.vehicles.find(x => x.car === "srx");
  assert.equal(v2.items.find(i => i.key === "oil").level, "ok"); assert.equal(v2.log[0].text, "Oil change: Synthetic");
  assert.equal((await s.tools({ action: "service", car: "srx", miles: "lots" })).status, 400);
});

/* ---------- reminder emails ---------- */
test("pickup reminder the day before and a return-day reminder, each once", async () => {
  const s = setup();
  const me = await signup(s);
  const b = await book(s, me.cookie);
  const rem = makeReminders({ store: s.store, mailer: { send: async m => s.sent.push(m) }, siteUrl: "https://acefares.test", now: s.now, log: quiet });
  s.sent.length = 0;
  assert.deepEqual(await rem.sweep(), []);
  s.setTime(localMs(b.from, b.fromTime) - 23 * H);
  assert.deepEqual(await rem.sweep(), [["pickup-reminder", "srx", b.id]]);
  assert.deepEqual(await rem.sweep(), []);
  assert.match(s.sent[0].subject, /Tomorrow: your Cadillac SRX pickup at 10:00 AM/);
  assert.match(s.sent[0].text, /license check isn't finished/); assert.match(s.sent[0].text, /inspect\.html\?car=srx&ref=.*stage=pickup/);
  s.setTime(localMs(b.to, "07:00") - 60e3);   // 10 AM return: reminder at 7 AM (3 hours before)
  assert.deepEqual(await rem.sweep(), []);
  s.setTime(localMs(b.to, "07:00") + 60e3);
  assert.deepEqual(await rem.sweep(), [["return-reminder", "srx", b.id]]);
  assert.match(s.sent.at(-1).subject, /Today: return your Cadillac SRX by 10:00 AM/); assert.match(s.sent.at(-1).text, /\$50 late fee/);
  assert.deepEqual(await rem.sweep(), []);
  // a trip booked less than a day ahead gets no "tomorrow" email (the confirmation covers it)
  const soon = await book(s, (await s.a("login", { method: "POST", body: { email: "jordan@example.com", password: "pass-word-1" } })).cookie, { ...TRIP, from: "2027-03-20", to: "2027-03-22" });
  s.setTime(localMs("2027-03-20", "10:00") - 30 * H);
  await s.repo.note("srx", soon.id, { confirmedAt: new Date(localMs("2027-03-20", "10:00") - 5 * H).toISOString() });
  s.setTime(localMs("2027-03-20", "10:00") - 2 * H);
  assert.deepEqual((await rem.sweep()).filter(x => x[0] === "pickup-reminder"), []);
});

/* ---------- contact form ---------- */
test("contact form emails the business inbox with reply-to the visitor", async () => {
  const store = memoryStore(), sent = [], mailer = { ownerEmail: "acefaresrental@gmail.com", send: async m => { sent.push(m); } };
  const h = contactHandler({ store, mailer, log: quiet });
  const send = (body, ip = "203.0.113.5") => h(req("/api/contact", { method: "POST", body }), { ip }).then(j);
  const r = await send({ name: "Pat Kim", email: "Pat@Example.com", phone: "214", topic: "Long-term rental", message: "Do you rent by the month?" });
  assert.deepEqual(r.data, { ok: true, emailed: true });
  assert.equal(sent[0].to, "acefaresrental@gmail.com"); assert.equal(sent[0].replyTo, "pat@example.com");
  assert.equal(sent[0].subject, "Website message (Long-term rental): Pat Kim"); assert.match(sent[0].text, /Do you rent by the month\?/);
  assert.equal(store.keys().filter(k => k.startsWith("contact-msg-")).length, 1);
  assert.equal((await send({ name: "Pat", email: "nope", message: "Hello there" })).data.field, "email");
  assert.equal((await send({ name: "Pat", email: "p@x.com", message: "" })).data.field, "message");
  assert.equal((await send({ name: "Bot", email: "b@x.com", message: "spam spam", website: "x" })).status, 200);
  assert.equal(sent.length, 1);
  for (let i = 0; i < 5; i++) await send({ name: "Pat", email: "p@x.com", message: "Hello there" }, "203.0.113.77");
  assert.equal((await send({ name: "Pat", email: "p@x.com", message: "Hello there" }, "203.0.113.77")).status, 429);
});

/* ---------- optional Wheelbase damage protection ---------- */
test("renter can ask for Wheelbase damage protection at checkout; owner and renter emails say so; agreement explains it", async () => {
  const s = setup();
  const me = await signup(s);
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: TRIP, cookie: me.cookie })));
  const d = await j(await s.details(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref: r.data.ref, ...sign, insurance: { choice: "own", company: "GEICO", protection: true } } })));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const b = await s.repo.get("srx", r.data.ref);
  assert.equal(b.insurance.protection, "requested");
  assert.equal(s.stripe.intents.get(b.paymentIntentId).metadata.damage_protection, "wheelbase_requested");
  await s.hook(signedEvent("payment_intent.succeeded", s.stripe.payIntent(b.paymentIntentId)));
  assert.match(s.sent.find(m => m.to === "acefaresrental@gmail.com").text, /Damage protection: REQUESTED \(Wheelbase\)/);
  assert.match(s.sent.find(m => m.to === "jordan@example.com" && /Booking confirmed/.test(m.subject)).text, /damage protection through Wheelbase/);
  const { agreementText } = await import("../lib/agreement.mjs");
  assert.match(agreementText({}), /Optional damage protection\. You may ask to add optional physical damage protection for the vehicle offered through Wheelbase/);
  // without the box ticked nothing is recorded
  const r2 = await j(await s.checkout(req("/api/checkout", { method: "POST", body: { ...TRIP, from: "2027-04-05", to: "2027-04-07" }, cookie: me.cookie })));
  await s.details(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref: r2.data.ref, ...sign } }));
  assert.equal((await s.repo.get("srx", r2.data.ref)).insurance.protection, undefined);
});
