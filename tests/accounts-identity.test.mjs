// Renter accounts (email + Google), sign-in required to book, and the Stripe Identity license/selfie check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth } from "../lib/auth.mjs";
import { verifyHandler, makeIdentity, checkResult, consentText } from "../lib/identity.mjs";
import { checkoutHandler, checkoutDetailsHandler, webhookHandler } from "../lib/handlers.mjs";
import { makeRepo } from "../lib/bookings.mjs";
import { localMs } from "../lib/deposits.mjs";
import { memoryStore, fakeStripe, signedEvent, WEBHOOK_SECRET, NOW } from "./helpers.mjs";

const quiet = { error() {}, warn() {}, log() {} };
const j = async res => ({ status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] });
const req = (path, { method = "GET", body, cookie, headers = {} } = {}) => new Request("https://site.test" + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers } });

function setup(o = {}) {
  let t = o.t || NOW; const now = () => t;
  const users = memoryStore(), store = memoryStore(), stripe = fakeStripe({ clock: now });
  const sent = [], mailer = o.noMail ? null : { send: async m => { sent.push(m); } };
  const google = { claims: null };
  const auth = makeAuth({ store: users, bookingsStore: store, now, secret: "test-secret", googleClientId: "client-123.apps.googleusercontent.com",
    verifyGoogle: async cred => { if (cred !== "good-token" || !google.claims) throw new Error("bad token"); return google.claims; }, mailer, siteUrl: "https://acefares.test", log: quiet });
  const notices = [], notify = async (subject, text) => notices.push({ subject, text });
  const a = (path, opts) => auth.handler(req("/api/auth/" + path, opts), { ip: "198.51.100.9" }).then(j);
  return { now, setTime: x => { t = x; }, users, store, stripe, auth, a, sent, google, notices,
    checkout: checkoutHandler({ store, stripe, siteUrl: "https://acefares.test", now, publishableKey: "pk_test_1", userOf: auth.userOf, requireAccount: true, linkBooking: auth.linkBooking }),
    details: checkoutDetailsHandler({ store, stripe, publishableKey: "pk_test_1", now, userOf: auth.userOf }),
    verify: verifyHandler({ store, stripe, userOf: auth.userOf, publishableKey: "pk_test_1", siteUrl: "https://acefares.test", now, notify }),
    hook: webhookHandler({ store, stripe, webhookSecret: WEBHOOK_SECRET, now, notify }),
    idv: makeIdentity({ store, stripe, now, notify, log: quiet }), repo: makeRepo(store, { now }) };
}
const jordan = { email: "Jordan@Example.com", password: "correct horse 9", firstName: "Jordan", lastName: "Lee", phone: "(214) 555-0100" };
const trip = { car: "srx", from: "2027-03-02", to: "2027-03-05", fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" };

async function paidTrip(s, cookie) {
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = await s.repo.get("srx", r.data.ref);
  s.stripe.payIntent(b.paymentIntentId);
  await s.repo.confirm("srx", b.id, { paymentIntent: b.paymentIntentId, customer: { name: "Jordan Lee", email: "jordan@example.com", phone: "2145550100" } });
  return b.id;
}

/* ---------- accounts ---------- */

test("sign up, stay signed in, and log in again with the same details", async () => {
  const s = setup();
  const look = await s.a("lookup", { method: "POST", body: { email: jordan.email } });
  assert.deepEqual(look.data, { exists: false, hasPassword: false, google: false });
  const up = await s.a("signup", { method: "POST", body: jordan });
  assert.equal(up.status, 201); assert.match(up.cookie, /^af_session=.+\..+/);
  assert.equal(up.data.user.email, "jordan@example.com"); assert.equal(up.data.user.name, "Jordan Lee"); assert.equal(up.data.user.passwordHash, undefined);
  const me = await s.a("me", { cookie: up.cookie });
  assert.equal(me.data.user.email, "jordan@example.com");
  assert.deepEqual((await s.a("lookup", { method: "POST", body: { email: "jordan@example.com" } })).data, { exists: true, hasPassword: true, google: false });
  const dup = await s.a("signup", { method: "POST", body: { ...jordan, email: "JORDAN@example.com" } });
  assert.equal(dup.status, 409); assert.equal(dup.data.error, "email_taken");
  const bad = await s.a("login", { method: "POST", body: { email: jordan.email, password: "nope nope" } });
  assert.equal(bad.status, 401); assert.equal(bad.data.error, "bad_login"); assert.equal(bad.cookie, "");
  const good = await s.a("login", { method: "POST", body: { email: " jordan@EXAMPLE.com ", password: jordan.password } });
  assert.equal(good.status, 200); assert.equal(good.data.user.id, up.data.user.id); assert.ok(good.cookie);
  // the stored password is a scrypt hash, never the password itself
  const raw = JSON.stringify([...(await s.users.getWithMetadata(`user-${up.data.user.id}`)).data.passwordHash]);
  assert.ok(!raw.includes("correct horse"));
});

test("sign-up form checks: password length, names, phone, email", async () => {
  const s = setup();
  assert.equal((await s.a("signup", { method: "POST", body: { ...jordan, password: "short" } })).data.error, "weak_password");
  assert.equal((await s.a("signup", { method: "POST", body: { ...jordan, lastName: " " } })).data.error, "bad_name");
  assert.equal((await s.a("signup", { method: "POST", body: { ...jordan, phone: "123" } })).data.error, "bad_phone");
  assert.equal((await s.a("signup", { method: "POST", body: { ...jordan, email: "not-an-email" } })).data.error, "bad_email");
  assert.equal((await s.a("signup", { method: "POST", body: { ...jordan, phone: "" } })).status, 201);   // phone is optional
});

test("too many wrong passwords locks that email for a while", async () => {
  const s = setup();
  await s.a("signup", { method: "POST", body: jordan });
  for (let i = 0; i < 8; i++) assert.equal((await s.a("login", { method: "POST", body: { email: jordan.email, password: "wrong pass " + i } })).status, 401);
  const locked = await s.a("login", { method: "POST", body: { email: jordan.email, password: jordan.password } });
  assert.equal(locked.status, 429);
  s.setTime(NOW + 16 * 60e3);
  assert.equal((await s.a("login", { method: "POST", body: { email: jordan.email, password: jordan.password } })).status, 200);
});

test("a tampered or expired session cookie is not accepted; logout clears it", async () => {
  const s = setup();
  const up = await s.a("signup", { method: "POST", body: jordan });
  const [body, sig] = up.cookie.slice("af_session=".length).split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "someone-else", sv: 0, exp: NOW + 1e9 })).toString("base64url");
  assert.equal((await s.a("me", { cookie: `af_session=${forged}.${sig}` })).data.user, null);
  assert.equal((await s.a("me", { cookie: `af_session=${body}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}` })).data.user, null);
  s.setTime(NOW + 31 * 864e5);
  assert.equal((await s.a("me", { cookie: up.cookie })).data.user, null);
  const out = await j(await s.auth.handler(req("/api/auth/logout", { method: "POST", body: {}, cookie: up.cookie })));
  assert.match(out.cookie, /^af_session=$/);
});

test("requests from other websites are refused", async () => {
  const s = setup();
  const r = await s.a("signup", { method: "POST", body: jordan, headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  assert.equal((await s.a("signup", { method: "POST", body: jordan, headers: { origin: "https://site.test" } })).status, 201);
});

test("Continue with Google: creates the account, then signs into the same one", async () => {
  const s = setup();
  s.google.claims = { sub: "g-111", email: "Pat.Rivera@gmail.com", email_verified: true, given_name: "Pat", family_name: "Rivera", picture: "https://lh3.googleusercontent.com/p" };
  const first = await s.a("google", { method: "POST", body: { credential: "good-token" } });
  assert.equal(first.status, 201); assert.equal(first.data.created, true); assert.ok(first.cookie);
  assert.deepEqual([first.data.user.email, first.data.user.name, first.data.user.google, first.data.user.hasPassword], ["pat.rivera@gmail.com", "Pat Rivera", true, false]);
  const again = await s.a("google", { method: "POST", body: { credential: "good-token" } });
  assert.equal(again.status, 200); assert.equal(again.data.user.id, first.data.user.id);
  // a Google account can't log in with a password it never set
  const pw = await s.a("login", { method: "POST", body: { email: "pat.rivera@gmail.com", password: "anything 123" } });
  assert.equal(pw.data.error, "use_google");
  assert.equal((await s.a("google", { method: "POST", body: { credential: "forged" } })).status, 401);
});

test("Google with an email someone already signed up with: links to it and removes the unproven password", async () => {
  const s = setup();
  const squatter = await s.a("signup", { method: "POST", body: { ...jordan, email: "pat.rivera@gmail.com" } });
  s.google.claims = { sub: "g-222", email: "pat.rivera@gmail.com", email_verified: true, given_name: "Pat", family_name: "Rivera" };
  const g = await s.a("google", { method: "POST", body: { credential: "good-token" } });
  assert.equal(g.data.user.id, squatter.data.user.id); assert.equal(g.data.user.hasPassword, false);
  assert.equal((await s.a("me", { cookie: squatter.cookie })).data.user, null);          // old session signed out
  s.google.claims = { sub: "g-333", email: "unverified@example.com", email_verified: false };
  assert.equal((await s.a("google", { method: "POST", body: { credential: "good-token" } })).data.error, "google_unverified");
});

test("forgot password: emails a one-time link that sets a new password and signs out other sessions", async () => {
  const s = setup();
  const up = await s.a("signup", { method: "POST", body: jordan });
  const f = await s.a("forgot", { method: "POST", body: { email: jordan.email } });
  assert.equal(f.status, 200); assert.equal(s.sent.length, 1);
  assert.equal((await s.a("forgot", { method: "POST", body: { email: "nobody@example.com" } })).status, 200);   // same answer, no email
  assert.equal(s.sent.length, 1);
  const token = s.sent[0].text.match(/reset=([A-Za-z0-9_-]+)/)[1];
  const r = await s.a("reset", { method: "POST", body: { token, password: "brand new pass" } });
  assert.equal(r.status, 200); assert.ok(r.cookie);
  assert.equal((await s.a("me", { cookie: up.cookie })).data.user, null);
  assert.equal((await s.a("login", { method: "POST", body: { email: jordan.email, password: "brand new pass" } })).status, 200);
  assert.equal((await s.a("reset", { method: "POST", body: { token, password: "another pass 1" } })).status, 410);   // link used
  const s2 = setup({ noMail: true });
  assert.equal((await s2.a("forgot", { method: "POST", body: { email: jordan.email } })).data.emailEnabled, false);
});

/* ---------- booking requires an account ---------- */

test("when login is required: booking needs a signed-in account, the trip is saved to it, and the checkout link works without logging in", async () => {
  const s = setup();
  const none = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip })));
  assert.equal(none.status, 401); assert.equal(none.data.error, "login_required");
  const me = await s.a("signup", { method: "POST", body: jordan });
  const r = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie: me.cookie })));
  assert.equal(r.status, 200);
  const b = await s.repo.get("srx", r.data.ref);
  assert.equal(b.userId, me.data.user.id);
  assert.equal(s.stripe.intents.get(b.paymentIntentId).metadata.user_id, me.data.user.id);
  // checkout page: prefilled for the owner, closed to others
  const mine = await j(await s.details(req(`/api/checkout-details?car=srx&ref=${b.id}`, { cookie: me.cookie })));
  assert.equal(mine.status, 200); assert.deepEqual(mine.data.prefill, { name: "Jordan Lee", email: "jordan@example.com", phone: "(214) 555-0100" });
  const anon = await j(await s.details(req(`/api/checkout-details?car=srx&ref=${b.id}`)));
  assert.equal(anon.status, 200); assert.equal(anon.data.prefill, undefined);       // never forced to log in; no account details shown
  const other = await s.a("signup", { method: "POST", body: { ...jordan, email: "other@example.com" } });
  const theirs = await j(await s.details(req(`/api/checkout-details?car=srx&ref=${b.id}`, { cookie: other.cookie })));
  assert.equal(theirs.data.prefill.email, "other@example.com");                        // their own details, not Jordan's
  // My trips
  s.stripe.payIntent(b.paymentIntentId);
  await s.repo.confirm("srx", b.id, { paymentIntent: b.paymentIntentId });
  const trips = await s.a("trips", { cookie: me.cookie });
  assert.equal(trips.data.trips.length, 1);
  assert.deepEqual([trips.data.trips[0].ref, trips.data.trips[0].status, trips.data.trips[0].verification], [b.id, "confirmed", "not_started"]);
  assert.equal((await s.a("trips", { cookie: other.cookie })).data.trips.length, 0);
});

/* ---------- Stripe Identity ---------- */

test("ID check: needs sign-in, a paid trip and Texas biometric consent; then opens Stripe's license + selfie check", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: jordan });
  assert.equal((await s.verify(req("/api/verify?car=srx&ref=x"))).status, 401);
  const unpaid = await j(await s.checkout(req("/api/checkout", { method: "POST", body: trip, cookie: me.cookie })));
  assert.equal((await j(await s.verify(req(`/api/verify?car=srx&ref=${unpaid.data.ref}`, { cookie: me.cookie })))).status, 409);
  await s.repo.cancel("srx", unpaid.data.ref);
  const ref = await paidTrip(s, me.cookie);
  const g = await j(await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: me.cookie })));
  assert.equal(g.status, 200); assert.equal(g.data.verification.status, "not_started");
  assert.match(g.data.consent.text, /biometric/); assert.match(g.data.consent.text, /within one year/);
  const noConsent = await j(await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref }, cookie: me.cookie })));
  assert.equal(noConsent.status, 400); assert.equal(noConsent.data.error, "consent_required");
  const st = await j(await s.verify(new Request("https://site.test/api/verify", { method: "POST", body: JSON.stringify({ car: "srx", ref, consent: true }),
    headers: { "content-type": "application/json", cookie: me.cookie, "x-nf-client-connection-ip": "203.0.113.5" } })));
  assert.equal(st.status, 200); assert.match(st.data.clientSecret, /^vs_test_1_secret/); assert.equal(st.data.publishableKey, "pk_test_1");
  const p = s.stripe.calls.vsCreate[0].params;
  assert.deepEqual(p.options, { document: { allowed_types: ["driving_license"], require_matching_selfie: true, require_live_capture: false } });
  assert.equal(p.metadata.kind, "identity"); assert.equal(p.metadata.booking_id, ref); assert.equal(p.provided_details.email, "jordan@example.com");
  const v = (await s.repo.get("srx", ref)).verification;
  assert.equal(v.status, "started"); assert.equal(v.consent.ip, "203.0.113.5"); assert.equal(v.consent.version, "2026-10-12-idv1");
  // starting again continues the same check instead of paying for a new one
  await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref, consent: true }, cookie: me.cookie }));
  assert.equal(s.stripe.calls.vsCreate.length, 1);
  // someone else's account can't see or start it
  const other = await s.a("signup", { method: "POST", body: { ...jordan, email: "other@example.com" } });
  assert.equal((await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: other.cookie }))).status, 404);
});

test("ID check result: verified, needs review (under 21 / name mismatch), or try again", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: jordan });
  const ref = await paidTrip(s, me.cookie);
  await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref, consent: true }, cookie: me.cookie }));
  const vsId = (await s.repo.get("srx", ref)).verification.sessionId;
  // failed attempt -> renter can retry with the same session
  const failed = s.stripe.finishIdentity(vsId, { result: "requires_input" });
  assert.equal((await s.hook(signedEvent("identity.verification_session.requires_input", failed))).status, 200);
  let g = await j(await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: me.cookie })));
  assert.equal(g.data.verification.status, "retry"); assert.match(g.data.verification.error, /expired/);
  // verified by Stripe and everything matches the booking
  const ok = s.stripe.finishIdentity(vsId);
  await s.hook(signedEvent("identity.verification_session.verified", { ...ok, verified_outputs: null, last_verification_report: "vr_1" }));
  const v = (await s.repo.get("srx", ref)).verification;
  assert.equal(v.status, "verified"); assert.deepEqual(v.checks, { age: true, name: true, expiry: true }); assert.equal(v.verifiedName, "Jordan Lee");
  assert.ok(!JSON.stringify(v).includes("1990"));                          // date of birth is not stored
  assert.equal(s.notices.length, 0);
  g = await j(await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: me.cookie })));
  assert.equal(g.data.verification.status, "verified");
  assert.equal((await s.a("trips", { cookie: me.cookie })).data.trips[0].verification, "verified");
});

test("ID check: an under-21 renter, a different name or an expiring license is flagged for the owner", () => {
  const b = { from: "2027-03-02", to: "2027-03-05", customer: { name: "Jordan Lee" } };
  const lic = { document: { expiration_date: { day: 1, month: 1, year: 2030 } } };
  assert.deepEqual(checkResult(b, { first_name: "JORDAN", last_name: "LEE", dob: { day: 2, month: 3, year: 2006 } }, lic).checks, { age: true, expiry: true, name: true });   // 21 on pickup day
  assert.equal(checkResult(b, { first_name: "Jordan", last_name: "Lee", dob: { day: 3, month: 3, year: 2006 } }, lic).checks.age, false);
  assert.equal(checkResult(b, { first_name: "Sam", last_name: "Smith", dob: { day: 1, month: 1, year: 1990 } }, lic).checks.name, false);
  assert.equal(checkResult(b, { first_name: "Jordan", last_name: "Lee", dob: { day: 1, month: 1, year: 1990 } }, { document: { expiration_date: { day: 4, month: 3, year: 2027 } } }).checks.expiry, false);
  assert.equal(checkResult({ ...b, customer: { name: "Maria de la Cruz" } }, { first_name: "Maria", last_name: "De La Cruz", dob: { day: 1, month: 1, year: 1990 } }, lic).checks.name, true);
});

test("an under-21 result is marked for review and the owner is emailed", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: jordan });
  const ref = await paidTrip(s, me.cookie);
  await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref, consent: true }, cookie: me.cookie }));
  const vsId = (await s.repo.get("srx", ref)).verification.sessionId;
  await s.hook(signedEvent("identity.verification_session.verified", s.stripe.finishIdentity(vsId, { dob: { day: 1, month: 1, year: 2010 } })));
  const v = (await s.repo.get("srx", ref)).verification;
  assert.equal(v.status, "review"); assert.equal(v.checks.age, false);
  assert.equal(s.notices.length, 1); assert.match(s.notices[0].text, /under 21/);
});

test("license images and face data are deleted at Stripe 90 days after the return", async () => {
  const s = setup();
  const me = await s.a("signup", { method: "POST", body: jordan });
  const ref = await paidTrip(s, me.cookie);
  await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref, consent: true }, cookie: me.cookie }));
  const vsId = (await s.repo.get("srx", ref)).verification.sessionId;
  await s.hook(signedEvent("identity.verification_session.verified", s.stripe.finishIdentity(vsId)));
  const back = localMs(trip.to, trip.toTime);
  s.setTime(back + 89 * 864e5); assert.deepEqual(await s.idv.sweep(), []);
  s.setTime(back + 90 * 864e5 + 1);
  assert.deepEqual(await s.idv.sweep(), [["redacted", "srx", ref]]);
  assert.deepEqual(s.stripe.calls.vsRedact, [vsId]);
  const v = (await s.repo.get("srx", ref)).verification;
  assert.ok(v.redactedAt); assert.equal(v.verifiedName, null); assert.equal(v.status, "verified");
  assert.deepEqual(await s.idv.sweep(), []);     // only once
});

test("if Stripe Identity isn't switched on yet, the renter gets a clear message", async () => {
  const s = setup();
  s.stripe.fake.identityOff = true;
  const me = await s.a("signup", { method: "POST", body: jordan });
  const ref = await paidTrip(s, me.cookie);
  const r = await j(await s.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref, consent: true }, cookie: me.cookie })));
  assert.equal(r.status, 502); assert.match(r.data.message, /isn't switched on yet/);
});

test("consent text names Stripe, the biometric comparison, no selling, and deletion", () => {
  const t = consentText();
  for (const w of ["Stripe", "biometric", "will not sell", "delete", "90 days"]) assert.ok(t.includes(w), w);
});

test("ID name check also accepts the name on the renter's account", () => {
  const lic = { document: { expiration_date: { day: 1, month: 1, year: 2030 } } };
  const out = { first_name: "Riley", last_name: "Brooks", dob: { day: 1, month: 1, year: 1990 } };
  const b = { from: "2027-03-02", to: "2027-03-05", customer: { name: "R B" }, accountName: "Riley Brooks" };
  assert.equal(checkResult(b, out, lic).checks.name, true);
  assert.equal(checkResult({ ...b, accountName: "Sam Smith" }, out, lic).checks.name, false);
});

test("1-hour rule: an ID check not done within an hour of booking emails the owner and the renter once", async () => {
  const s = setup();
  const sent = [];
  const idv = makeIdentity({ store: s.store, stripe: s.stripe, now: s.now, notify: async (subject, text) => s.notices.push({ subject, text }),
    mailer: { send: async m => { sent.push(m); } }, siteUrl: "https://acefares.test", log: quiet });
  const me = await s.a("signup", { method: "POST", body: jordan });
  const ref = await paidTrip(s, me.cookie);
  const g = await j(await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: me.cookie })));
  assert.equal(g.data.dueAt, new Date(NOW + 3600e3).toISOString()); assert.equal(g.data.overdue, false);
  s.setTime(NOW + 59 * 60e3); assert.deepEqual(await idv.sweep(), []);
  s.setTime(NOW + 61 * 60e3);
  assert.deepEqual(await idv.sweep(), [["overdue", "srx", ref]]);
  assert.equal(s.notices.length, 1); assert.match(s.notices[0].subject, /ID check overdue/);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, "jordan@example.com"); assert.match(sent[0].text, /verify\.html\?car=srx&ref=/);
  assert.deepEqual(await idv.sweep(), []);                                   // only once
  assert.equal((await j(await s.verify(req(`/api/verify?car=srx&ref=${ref}`, { cookie: me.cookie })))).data.overdue, true);
  // a finished check is never overdue
  const s2 = setup(); const me2 = await s2.a("signup", { method: "POST", body: jordan }); const ref2 = await paidTrip(s2, me2.cookie);
  await s2.verify(req("/api/verify", { method: "POST", body: { car: "srx", ref: ref2, consent: true }, cookie: me2.cookie }));
  await s2.hook(signedEvent("identity.verification_session.verified", s2.stripe.finishIdentity((await s2.repo.get("srx", ref2)).verification.sessionId)));
  s2.setTime(NOW + 2 * 3600e3);
  assert.deepEqual(await makeIdentity({ store: s2.store, stripe: s2.stripe, now: s2.now, log: quiet }).sweep(), []);
});
