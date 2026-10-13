// Refer a friend credits, pickup/return photo inspections, the insurance choice and the owner's booking alert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth } from "../lib/auth.mjs";
import { makeReferrals } from "../lib/referrals.mjs";
import { inspectionHandler, SHOTS, sniffImage } from "../lib/inspections.mjs";
import { checkoutHandler, checkoutDetailsHandler, webhookHandler } from "../lib/handlers.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { localMs } from "../lib/deposits.mjs";
import { AGREEMENT_VERSION } from "../lib/agreement.mjs";
import { quote } from "../lib/pricing.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

const quiet = { error() {}, warn() {}, log() {} };
const j = async res => ({ status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] });
const req = (path, { method = "GET", body, cookie, headers = {}, raw } = {}) => new Request("https://site.test" + path, {
  method, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(raw !== undefined ? { "content-type": "image/jpeg" } : {}), ...(cookie ? { cookie } : {}), ...headers } });
const JPEG = n => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b.buffer; };

function setup() {
  let t = NOW; const now = () => t;
  const users = memoryStore(), store = memoryStore(), photos = memoryStore(), stripe = fakeStripe({ clock: now });
  const sent = [], mailer = { ownerEmail: "acefaresrental@gmail.com", send: async m => { sent.push(m); } };
  const referrals = makeReferrals({ users, bookingsStore: store, now, mailer, siteUrl: "https://acefares.test", log: quiet });
  const auth = makeAuth({ store: users, bookingsStore: store, now, secret: "s", mailer, siteUrl: "https://acefares.test", referrals, log: quiet });
  const notices = [], notify = async (subject, text) => notices.push({ subject, text });
  return { now, setTime: x => { t = x; }, users, store, photos, stripe, sent, notices, referrals, auth,
    a: (path, o) => auth.handler(req("/api/auth/" + path, o), { ip: "198.51.100.1" }).then(j),
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now, publishableKey: "pk_test_1", userOf: auth.userOf, requireAccount: true, linkBooking: auth.linkBooking, creditsFor: referrals.creditsFor }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: "pk_test_1", now, userOf: auth.userOf, roamlyUrl: "https://www.roamly.com/" }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, mailer, siteUrl: "https://acefares.test", referrals }),
    insp: inspectionHandler({ photos, store, userOf: auth.userOf, adminKey: "owner-key", now, notify }),
    repo: makeRepo(store, { now }) };
}
const person = (email, first) => ({ email, password: "pass-word-1", firstName: first, lastName: "Lee", phone: "2145550100" });
const sign = { name: "Jordan Lee", email: "jordan@example.com", phone: "(214) 555-0100", agree: true, termsVersion: AGREEMENT_VERSION };

async function bookAndPay(s, cookie, trip) {
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = await s.repo.get(trip.car, r.data.ref);
  const d = await j(await s.details(req("/api/checkout-details", { method: "POST", cookie, body: { car: trip.car, ref: b.id, ...sign, insurance: { choice: "own", company: "State Farm", policy: "SF-1" } } })));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  await s.hook(signedEvent("payment_intent.succeeded", s.stripe.payIntent(b.paymentIntentId)));
  return s.repo.get(trip.car, b.id);
}

/* ---------- refer a friend ---------- */

test("refer a friend: friend gets $50 off their first trip, referrer gets $100 after the friend's 4+ day trip ends", async () => {
  const s = setup();
  const alex = await s.a("signup", { method: "POST", body: person("alex@example.com", "Alex") });
  const ref = await s.a("referral", { cookie: alex.cookie });
  assert.match(ref.data.code, /^[A-Z2-9]{7}$/); assert.equal(ref.data.link, `https://acefares.test/?invite=${ref.data.code}`);
  assert.equal(ref.data.reward, 10000); assert.equal(ref.data.friendDiscount, 5000); assert.match(ref.data.terms, /no cash value/);
  assert.equal((await s.a("referral", { cookie: alex.cookie })).data.code, ref.data.code);          // same code every time
  assert.deepEqual((await s.a(`invite?code=${ref.data.code.toLowerCase()}`)).data, { valid: true, firstName: "Alex", friendDiscount: 5000 });
  assert.equal((await s.a("invite?code=NOPE123")).data.valid, false);

  // friend signs up through the link and books 5 days
  const sam = await s.a("signup", { method: "POST", body: { ...person("sam@example.com", "Sam"), invite: ref.data.code } });
  assert.equal(sam.data.user.welcome, true);
  const trip = { car: "srx", from: "2027-03-01", to: "2027-03-06", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };
  const b = await bookAndPay(s, sam.cookie, trip);
  assert.deepEqual(b.credits, [{ code: "welcome", label: "Friend referral: first trip", amount: 5000 }]);
  const plain = quote({ ...trip, days: 5 });
  assert.equal(s.stripe.intents.get(b.paymentIntentId).amount, plain.total - 5000 - Math.round(5000 * plain.taxPct / 100));
  assert.equal((await s.a("me", { cookie: sam.cookie })).data.user.welcome, false);              // used up
  // the $50 is only for the first trip
  const second = await j(await s.checkout(req("/api/checkout", { method: "POST", cookie: sam.cookie, body: { ...trip, from: "2027-04-01", to: "2027-04-03" } })));
  assert.equal((await s.repo.get("srx", second.data.ref)).credits, undefined);

  // nothing for Alex until the trip is over
  assert.deepEqual(await s.referrals.sweep(), []);
  s.setTime(localMs(trip.to, trip.toTime) + 60e3);
  assert.deepEqual(await s.referrals.sweep(), [["rewarded", alex.data.user.id, b.id]]);
  assert.deepEqual(await s.referrals.sweep(), []);                                          // once
  alex.cookie = (await s.a("login", { method: "POST", body: { email: "alex@example.com", password: "pass-word-1" } })).cookie;   // months later: log in again
  const r2 = await s.a("referral", { cookie: alex.cookie });
  assert.equal(r2.data.credit, 10000); assert.equal(r2.data.friendsRewarded, 1);
  assert.ok(s.sent.some(m => m.to === "alex@example.com" && /\$100 in Ace Fares credit/.test(m.subject)));

  // Alex's next booking uses the credit automatically, and it comes off the balance once paid
  const alexTrip = { car: "escalade", from: "2027-05-03", to: "2027-05-05", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };
  const ab = await bookAndPay(s, alex.cookie, alexTrip);
  assert.deepEqual(ab.credits, [{ code: "credit", label: "Ace Fares credit", amount: 10000 }]);
  assert.equal((await s.a("me", { cookie: alex.cookie })).data.user.credit, 0);
});

test("referral: trips under 3 days, cancelled trips and late invites don't earn credit", async () => {
  const s = setup();
  const alex = await s.a("signup", { method: "POST", body: person("alex@example.com", "Alex") });
  const code = (await s.a("referral", { cookie: alex.cookie })).data.code;
  const sam = await s.a("signup", { method: "POST", body: { ...person("sam@example.com", "Sam"), invite: code } });
  const short = await bookAndPay(s, sam.cookie, { car: "van", from: "2027-03-01", to: "2027-03-03", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });
  const long = await bookAndPay(s, sam.cookie, { car: "bmw", from: "2027-03-10", to: "2027-03-15", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });
  await s.repo.cancel("bmw", long.id);
  s.setTime(Date.parse("2027-04-01T12:00:00Z"));
  assert.deepEqual(await s.referrals.sweep(), []);
  alex.cookie = (await s.a("login", { method: "POST", body: { email: "alex@example.com", password: "pass-word-1" } })).cookie;
  assert.equal((await s.a("referral", { cookie: alex.cookie })).data.credit, 0);
  assert.ok((await s.repo.get("van", short.id)).referralChecked === undefined);             // too short: not even counted
  // an existing account can't be "referred" later, and a bad code is ignored
  const pat = await s.a("signup", { method: "POST", body: { ...person("pat@example.com", "Pat"), invite: "XXXXXXX" } });
  assert.equal(pat.data.user.welcome, false);
});

/* ---------- insurance choice ---------- */

test("insurance choice: own insurance needs the company; Roamly only when it's set up; saved to the booking and Stripe", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", cookie: me.cookie, body: { car: "srx", from: "2027-03-01", to: "2027-03-03", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" } })));
  const g = await j(await s.details(req(`/api/checkout-details?car=srx&ref=${r.data.ref}`, { cookie: me.cookie })));
  assert.equal(g.data.insurance.roamlyUrl, "https://www.roamly.com/");
  const post = ins => s.details(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref: r.data.ref, ...sign, insurance: ins } })).then(j);
  assert.equal((await post({ choice: "own", company: "" })).data.error, "insurance_required");
  assert.equal((await post({ choice: "roamly" })).status, 200);
  let b = await s.repo.get("srx", r.data.ref);
  assert.equal(b.insurance.choice, "roamly"); assert.equal(s.stripe.intents.get(b.paymentIntentId).metadata.insurance_choice, "roamly");
  assert.equal((await post({ choice: "own", company: "Progressive", policy: "P-9" })).status, 200);
  b = await s.repo.get("srx", r.data.ref);
  assert.deepEqual([b.insurance.choice, b.insurance.company, b.insurance.policy], ["own", "Progressive", "P-9"]);
  assert.equal(s.stripe.intents.get(b.paymentIntentId).metadata.insurance_company, "Progressive");
  // without a Roamly link, choosing Roamly falls back to own insurance (and needs a company)
  const off = checkoutDetailsHandler({ store: s.store, stripe: s.stripe, publishableKey: "pk_test_1", now: s.now, userOf: s.auth.userOf });
  const x = await j(await off(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref: r.data.ref, ...sign, insurance: { choice: "roamly" } } })));
  assert.equal(x.data.error, "insurance_required");
});

/* ---------- owner alert ---------- */

test("the business inbox gets a 'New booking' email once per booking", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const b = await bookAndPay(s, me.cookie, { car: "van", from: "2027-03-05", to: "2027-03-07", fromTime: "10:00", toTime: "10:00", location: "dfw" });
  const owner = s.sent.filter(m => m.to === "acefaresrental@gmail.com");
  assert.equal(owner.length, 1);
  assert.match(owner[0].subject, /^New booking: 2019 Honda Odyssey EX-L/);
  for (const w of ["Jordan Lee", "(214) 555-0100", "DFW International Airport", "State Farm", "inspect.html?car=van&ref=" + b.id]) assert.ok(owner[0].text.includes(w), w);
  await s.hook(signedEvent("payment_intent.succeeded", s.stripe.intents.get(b.paymentIntentId)));   // webhook retry
  assert.equal(s.sent.filter(m => m.to === "acefaresrental@gmail.com").length, 1);
  assert.ok((await s.repo.get("van", b.id)).ownerEmailedAt);
});

/* ---------- pickup / return photos ---------- */

test("photos: renter and host each upload every required shot, readings, then submit; every picture is stored", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const b = await bookAndPay(s, me.cookie, { car: "escalade", from: "2027-03-01", to: "2027-03-04", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });
  const q = `car=escalade&ref=${b.id}`;
  const host = { "x-admin-key": "owner-key" };
  // who can see it
  assert.equal((await s.insp(req(`/api/inspection?${q}`))).status, 401);
  const other = await s.a("signup", { method: "POST", body: person("x@example.com", "X") });
  assert.equal((await s.insp(req(`/api/inspection?${q}`, { cookie: other.cookie }))).status, 404);
  const v0 = await j(await s.insp(req(`/api/inspection?${q}`, { cookie: me.cookie })));
  assert.equal(v0.data.role, "renter"); assert.equal(v0.data.shots.length, SHOTS.length);
  assert.equal((await j(await s.insp(req(`/api/inspection?${q}`, { headers: host })))).data.role, "host");

  const up = (shot, o = {}) => s.insp(req(`/api/inspection/photo?${q}&stage=pickup&shot=${shot}&clientTime=2027-03-01T15:59:00Z`, { method: "POST", raw: o.raw || JPEG(5000), ...(o.host ? { headers: host } : { cookie: me.cookie }) })).then(j);
  // not a photo / unknown shot
  assert.equal((await up("front", { raw: new TextEncoder().encode("hello, not an image").buffer })).status, 415);
  assert.equal((await up("roof")).data.error, "bad_shot");
  const first = await up("front");
  assert.equal(first.status, 200); assert.match(first.data.photo.sha256, /^[0-9a-f]{64}$/);
  // submitting too early lists what's missing
  const early = await j(await s.insp(req("/api/inspection/complete", { method: "POST", cookie: me.cookie, body: { car: "escalade", ref: b.id, stage: "pickup", odometer: "41,200", fuel: "3/4" } })));
  assert.equal(early.data.error, "missing_photos"); assert.match(early.data.message, /Back, Driver side, Passenger side, Odometer/);
  await up("front");                                                                          // a retake
  for (const sh of ["back", "driver", "passenger", "odometer", "fuel", "interior_front", "interior_back", "damage", "damage"]) assert.equal((await up(sh)).status, 200);
  assert.equal((await j(await s.insp(req("/api/inspection/complete", { method: "POST", cookie: me.cookie, body: { car: "escalade", ref: b.id, stage: "pickup", odometer: "41,200", fuel: "full" } })))).data.error, "bad_fuel");
  const done = await j(await s.insp(req("/api/inspection/complete", { method: "POST", cookie: me.cookie, body: { car: "escalade", ref: b.id, stage: "pickup", odometer: "41,200", fuel: "3/4", notes: "Small chip on windshield" } })));
  assert.equal(done.status, 200);
  const mine = done.data.stages.pickup.renter;
  assert.equal(mine.done.odometer, 41200); assert.equal(mine.done.fuel, "3/4"); assert.equal(mine.shots.damage.length, 2);
  assert.equal(mine.all, 11);                                                                 // every upload is kept, retakes included
  assert.equal(s.photos.keys().filter(k => k.startsWith(`img/${b.id}/pickup/renter/`)).length, 11);
  const meta = (await s.photos.getWithMetadata(mine.shots.front.key, { type: "arrayBuffer" })).metadata;
  assert.deepEqual([meta.role, meta.shot, meta.by, meta.clientTime], ["renter", "front", "Jo Lee", "2027-03-01T15:59:00.000Z"]);
  // locked once submitted
  assert.equal((await up("back")).status, 409);
  assert.equal(s.notices.length, 1); assert.match(s.notices[0].text, /41,200 miles/);
  // the renter can view their photo; someone else can't
  const img = await s.insp(req(`/api/inspection/img?${q}&key=${encodeURIComponent(mine.shots.front.key)}`, { cookie: me.cookie }));
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg"); assert.equal((await img.arrayBuffer()).byteLength, 5000);
  assert.equal((await s.insp(req(`/api/inspection/img?${q}&key=img/other-booking/x`, { cookie: me.cookie }))).status, 404);
  // the host's side is separate
  for (const sh of ["front", "back", "driver", "passenger", "odometer", "fuel", "interior_front", "interior_back"]) await up(sh, { host: true });
  await s.insp(req("/api/inspection/complete", { method: "POST", headers: host, body: { car: "escalade", ref: b.id, stage: "pickup", odometer: 41201, fuel: "3/4" } }));
  // return
  const upR = sh => s.insp(req(`/api/inspection/photo?${q}&stage=return&shot=${sh}`, { method: "POST", raw: JPEG(3000), headers: host })).then(j);
  for (const sh of ["front", "back", "driver", "passenger", "odometer", "fuel", "interior_front", "interior_back"]) await upR(sh);
  const ret = await j(await s.insp(req("/api/inspection/complete", { method: "POST", headers: host, body: { car: "escalade", ref: b.id, stage: "return", odometer: 41466, fuel: "1/2" } })));
  assert.equal(ret.data.milesDriven, 265);
  const bk = await s.repo.get("escalade", b.id);
  assert.deepEqual(Object.keys(bk.inspection).sort(), ["pickup", "return"]); assert.equal(bk.inspection.pickup.renter.odometer, 41200);
  assert.deepEqual((await s.a("trips", { cookie: me.cookie })).data.trips[0].photos, { pickup: true, return: false });
});

test("photos: only real image files are accepted", () => {
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer), "image/jpeg");
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer), "image/png");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ").buffer), "image/webp");
  assert.equal(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic\0\0").buffer), "image/heic");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns=").buffer), null);
});

test("owner can clear every calendar: bookings archived (not deleted), dates open, deposit holds released", async () => {
  const { adminResetHandler, availabilityHandler } = await import("../lib/handlers.mjs");
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const b = await bookAndPay(s, me.cookie, { car: "bmw", from: "2027-03-01", to: "2027-03-04", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });
  await s.repo.note("bmw", b.id, { deposit: { status: "held", paymentIntentId: b.paymentIntentId, amount: 50000 } });
  const reset = adminResetHandler({ store: s.store, stripe: s.stripe, adminKey: "owner-key", now: s.now });
  const call = (body, key = "owner-key") => reset(req("/api/admin/reset", { method: "POST", body, headers: { "x-admin-key": key } })).then(j);
  assert.equal((await call({ confirm: "RESET" }, "wrong")).status, 401);
  assert.equal((await call({})).data.error, "confirm_required");
  const r = await call({ confirm: "RESET" });
  assert.equal(r.status, 200); assert.equal(r.data.archived, 1); assert.equal(r.data.released, 1);
  assert.deepEqual(await s.repo.all("bmw"), []);
  const avail = await j(await availabilityHandler({ store: s.store })(req("/api/availability")));
  assert.deepEqual(avail.data.cars.bmw, []);
  assert.equal((await s.store.getWithMetadata(`${r.data.archive}-car-bmw`)).data.bookings[0].id, b.id);
});

test("guests can book: checkout creates their account and signs them in; an existing email gets the trip but no sign-in", async () => {
  const s = setup();
  const open = checkoutHandler({ store: s.store, stripe: s.stripe, siteUrl: "https://acefares.test", now: s.now, publishableKey: "pk_test_1", userOf: s.auth.userOf, requireAccount: false, linkBooking: s.auth.linkBooking });
  const details = checkoutDetailsHandler({ store: s.store, stripe: s.stripe, publishableKey: "pk_test_1", now: s.now, userOf: s.auth.userOf, accounts: s.auth });
  const trip = { car: "srx", from: "2027-03-01", to: "2027-03-03", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };
  const r = await j(await open(req("/api/checkout", { method: "POST", body: trip })));
  assert.equal(r.status, 200);
  const g = await j(await details(req(`/api/checkout-details?car=srx&ref=${r.data.ref}`)));
  assert.equal(g.data.signedIn, false);
  const p = await j(await details(req("/api/checkout-details", { method: "POST", body: { car: "srx", ref: r.data.ref, ...sign, name: "Morgan Diaz", email: "Morgan@Example.com", insurance: { choice: "own", company: "GEICO" } } })));
  assert.equal(p.status, 200); assert.equal(p.data.account, "created"); assert.match(p.cookie, /^af_session=/);
  const me = (await s.a("me", { cookie: p.cookie })).data.user;
  assert.deepEqual([me.email, me.firstName, me.lastName, me.hasPassword], ["morgan@example.com", "Morgan", "Diaz", false]);
  const b = await s.repo.get("srx", r.data.ref);
  assert.equal(b.userId, me.id); assert.equal(b.accountCreatedAtCheckout, true);
  assert.deepEqual((await s.a("trips", { cookie: p.cookie })).data.trips.map(t => t.ref), [r.data.ref]);
  assert.deepEqual((await s.a("lookup", { method: "POST", body: { email: "morgan@example.com" } })).data, { exists: true, hasPassword: false, google: false });
  // someone else books with an email that already has an account: the trip goes on that account, nobody is signed in
  const r2 = await j(await open(req("/api/checkout", { method: "POST", body: { ...trip, from: "2027-04-01", to: "2027-04-03" } })));
  const p2 = await j(await details(req("/api/checkout-details", { method: "POST", body: { car: "srx", ref: r2.data.ref, ...sign, name: "Morgan Diaz", email: "morgan@example.com", insurance: { choice: "own", company: "GEICO" } } })));
  assert.equal(p2.data.account, "existing"); assert.equal(p2.cookie, "");
  assert.equal((await s.repo.get("srx", r2.data.ref)).userId, me.id);
  // signed-in renter: trip saved to their account
  const jo = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const r3 = await j(await open(req("/api/checkout", { method: "POST", body: { ...trip, from: "2027-05-03", to: "2027-05-05" }, cookie: jo.cookie })));
  assert.equal((await s.repo.get("srx", r3.data.ref)).userId, jo.data.user.id);
});

test("paid on Stripe's hosted page without an account: the account is created from Stripe's details", async () => {
  const s = setup();
  const open = checkoutHandler({ store: s.store, stripe: s.stripe, siteUrl: "https://acefares.test", now: s.now });
  const hook = webhookHandler({ store: s.store, stripe: s.stripe, webhookSecret: WEBHOOK_SECRET, now: s.now, accounts: s.auth });
  await open(req("/api/checkout", { method: "POST", body: { car: "van", from: "2027-03-01", to: "2027-03-03", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" } }));
  const sid = [...s.stripe.sessions.keys()].at(-1);
  await hook(signedEvent("checkout.session.completed", s.stripe.pay(sid)));
  const b = await s.repo.get("van", s.stripe.sessions.get(sid).metadata.booking_id);
  assert.ok(b.userId); assert.equal(b.accountEmail, "renter@example.com"); assert.equal(b.accountCreatedAtCheckout, true);
});

test("delivery bookings need the address; airport bookings can add a flight", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: person("jo@example.com", "Jo") });
  const book = async loc => (await j(await s.checkout(req("/api/checkout", { method: "POST", cookie: me.cookie, body: { car: "srx", from: loc === "dfw" ? "2027-06-01" : "2027-05-01", to: loc === "dfw" ? "2027-06-03" : "2027-05-03", fromTime: "10:00", toTime: "10:00", location: loc } })))).data.ref;
  const ref = await book("dallas-delivery");
  const g = await j(await s.details(req(`/api/checkout-details?car=srx&ref=${ref}`, { cookie: me.cookie })));
  assert.equal(g.data.summary.locationId, "dallas-delivery");
  const post = extra => s.details(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref, ...sign, insurance: { choice: "own", company: "GEICO" }, ...extra } })).then(j);
  assert.equal((await post({})).data.error, "address_required");
  assert.equal((await post({ deliveryAddress: "500 Elm St, Dallas, TX 75202" })).status, 200);
  assert.equal((await s.repo.get("srx", ref)).handoff.address, "500 Elm St, Dallas, TX 75202");
  const ref2 = await book("dfw");
  await s.details(req("/api/checkout-details", { method: "POST", cookie: me.cookie, body: { car: "srx", ref: ref2, ...sign, insurance: { choice: "own", company: "GEICO" }, flight: "AA 1234" } }));
  const b2 = await s.repo.get("srx", ref2);
  assert.equal(b2.handoff.flight, "AA 1234"); assert.equal(s.stripe.intents.get(b2.paymentIntentId).metadata.flight, "AA 1234");
});
