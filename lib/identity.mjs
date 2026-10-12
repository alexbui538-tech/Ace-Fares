// Driver identity check after payment, with Stripe Identity.
// The renter photographs the front and back of their driver's license and takes a selfie in
// Stripe's secure screens (camera, photo library or file). Stripe checks the license is genuine
// and compares the selfie with the license photo. We keep only the result, never the images,
// and ask Stripe to delete (redact) the images and biometric data after the rental.
//
// Texas: comparing faces uses "biometric identifiers" (Tex. Bus. & Com. Code §503.001), so the
// renter gets a notice and must consent first, the data is not sold or shared except to do the
// check, and it is destroyed within a year (we redact IDENTITY_KEEP_DAYS after the return).
//
// Booking field: verification = { status, sessionId, consent, checks, reasons, error, verifiedAt, redactedAt, ... }
//   status: started | processing | verified | review (passed Stripe, but a detail needs the owner's eye)
//           | retry (Stripe couldn't verify; renter can try again) | canceled
import { createHash } from "node:crypto";
import { CARS, LOCATIONS, MIN_AGE as POLICY_MIN_AGE, IDENTITY_KEEP_DAYS, IDENTITY_KEEP_DAYS_CANCELLED } from "./catalog.mjs";
import { makeRepo } from "./bookings.mjs";
import { localMs } from "./deposits.mjs";

export const CONSENT_VERSION = "2026-10-12-idv1";
export const consentText = () =>
  `I agree that Ace Fares Rental may use its identity verification provider, Stripe, to collect photos of the front and back of my driver's license and a selfie, ` +
  `and to compare my face with the photo on my license (a biometric comparison) to confirm my identity and eligibility for this rental. ` +
  `Ace Fares will not sell, lease or disclose my license images or biometric data, except to Stripe to perform this check or where the law requires. ` +
  `Ace Fares keeps only the result of the check, and will have Stripe permanently delete the images and biometric data ${IDENTITY_KEEP_DAYS} days after my rental ends (sooner if it is cancelled), and in all cases within one year.`;
export const consentSha = () => createHash("sha256").update(consentText()).digest("hex");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const isStripe = e => e && e.type && String(e.type).startsWith("Stripe");
const letters = s => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
const ymd = d => d && d.year ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;

const REASONS = {
  age: `The license shows the renter is under ${POLICY_MIN_AGE} at pickup.`,
  name: "The name on the license doesn't match the name on the booking.",
  expiry: "The license expires before the trip ends.",
  data: "Stripe didn't return the license details needed to check age, name and expiry.",
};

/** Compare what Stripe read from the license with the booking. Never stores the date of birth. */
export function checkResult(b, outputs, report) {
  const checks = {}, reasons = [];
  const dob = outputs && outputs.dob;
  if (dob && dob.year) {
    const pickup = new Date(b.from + "T12:00:00Z"), born = Date.UTC(dob.year + POLICY_MIN_AGE, dob.month - 1, dob.day);
    checks.age = born <= pickup.getTime();
  }
  const exp = report && report.document && ymd(report.document.expiration_date);
  if (exp) checks.expiry = exp >= b.to;
  // the name on the booking (from checkout) or on the renter's account must match the license
  const first = letters(outputs && outputs.first_name), last = letters(outputs && outputs.last_name);
  const names = [b.customer && b.customer.name, b.accountName].map(letters).filter(w => w.length);
  if (names.length && last.length) checks.name = names.some(want => last.every(w => want.includes(w)) && (!first.length || want[0][0] === first[0][0]));
  for (const k of ["age", "name", "expiry"]) if (checks[k] === false) reasons.push(REASONS[k]);
  if (checks.age === undefined || checks.name === undefined) reasons.push(REASONS.data);
  return { checks, reasons, verifiedName: [outputs && outputs.first_name, outputs && outputs.last_name].filter(Boolean).join(" ") };
}

export function makeIdentity({ store, stripe, now = () => Date.now(), notify = null, log = console }) {
  const repo = makeRepo(store, { now });
  const setV = async (car, id, fields) => (await repo.note(car, id, { verification: fields })).verification;
  const tell = async (s, t) => { if (notify) try { await notify(s, t); } catch (e) { log.error("[idv] notice failed", e && e.message); } };

  /** Bring the booking's verification up to date with Stripe's session. */
  async function sync(car, b, session) {
    const v = b.verification || {};
    if (!session || session.id !== v.sessionId) return v;
    const t = new Date(now()).toISOString();
    if (session.status === "verified") {
      if (v.status === "verified" || v.status === "review") return v;
      let full = session;
      if (!session.verified_outputs || !session.last_verification_report || typeof session.last_verification_report === "string")
        full = await stripe.identity.verificationSessions.retrieve(session.id, { expand: ["verified_outputs", "last_verification_report"] });
      const r = checkResult(b, full.verified_outputs, full.last_verification_report);
      const status = r.reasons.length ? "review" : "verified";
      const out = await setV(car, b.id, { ...v, status, verifiedAt: t, updatedAt: t, checks: r.checks, reasons: r.reasons, verifiedName: r.verifiedName, error: null });
      if (status === "review") await tell(`ID check needs your review: ${CARS[car].name}, ${b.from}`,
        `${(b.customer && b.customer.name) || "A renter"} finished the license and selfie check for ${b.from} to ${b.to}, and Stripe verified the license, but:\n- ${r.reasons.join("\n- ")}\n\nLook at the verification in your Stripe Dashboard (Identity) and on your bookings page before handing over the keys.`);
      return out;
    }
    if (session.status === "processing") return setV(car, b.id, { ...v, status: "processing", updatedAt: t });
    if (session.status === "canceled") return setV(car, b.id, { ...v, status: "canceled", updatedAt: t });
    if (session.status === "requires_input") {
      const err = session.last_error;
      if (err && err.code) return setV(car, b.id, { ...v, status: "retry", updatedAt: t, error: { code: err.code, message: String(err.reason || "We couldn't verify your ID.").slice(0, 300) } });
      return v;
    }
    return v;
  }

  /** Start (or continue) the check. Returns { clientSecret, url } for Stripe's screens. */
  async function start(car, b, { user, ip, returnUrl }) {
    const v = b.verification || {};
    if (v.status === "verified" || v.status === "review" || v.status === "processing") return { status: v.status };
    if (v.sessionId && (v.status === "started" || v.status === "retry")) {
      const s = await stripe.identity.verificationSessions.retrieve(v.sessionId);
      if (s.status === "requires_input" && s.client_secret) return { clientSecret: s.client_secret, url: s.url, status: "started" };
      if (s.status !== "requires_input") return { status: (await sync(car, b, s)).status };
    }
    const attempt = (v.attempts || 0) + 1;
    if (attempt > 5) throw Object.assign(new Error("Too many attempts. Please text us so we can verify your ID in person."), { code: "too_many" });
    const s = await stripe.identity.verificationSessions.create({
      type: "document",
      options: { document: { allowed_types: ["driving_license"], require_matching_selfie: true } },
      provided_details: { email: user.email },
      client_reference_id: user.id,
      return_url: returnUrl,
      metadata: { kind: "identity", car, booking_id: b.id, user_id: user.id, consent_version: CONSENT_VERSION },
    }, { idempotencyKey: `idv-${b.id}-${attempt}` });
    const t = new Date(now()).toISOString();
    await setV(car, b.id, { ...v, status: "started", sessionId: s.id, attempts: attempt, startedAt: t, updatedAt: t, error: null,
      consent: { at: t, ip, version: CONSENT_VERSION, sha256: consentSha(), userId: user.id } });
    return { clientSecret: s.client_secret, url: s.url, status: "started" };
  }

  async function onEvent(event) {
    const s = event.data.object, m = s.metadata || {};
    if (!CARS[m.car] || !m.booking_id) return;
    const b = await repo.get(m.car, m.booking_id);
    if (b) await sync(m.car, b, s);
  }

  /** Hourly: have Stripe delete license images and biometric data once they're no longer needed. */
  async function sweep() {
    const t = now(), done = [];
    for (const car of Object.keys(CARS)) for (const b of await repo.all(car)) {
      const v = b.verification;
      if (!v || !v.sessionId || v.redactedAt || v.status === "processing") continue;
      const cancelled = b.status !== "confirmed";
      const due = cancelled ? Date.parse(b.cancelledAt || b.flaggedAt || b.releasedAt || b.createdAt || 0) + IDENTITY_KEEP_DAYS_CANCELLED * 864e5
        : localMs(b.to, b.toTime) + IDENTITY_KEEP_DAYS * 864e5;
      if (!(t >= due)) continue;
      try {
        if (v.status === "started" || v.status === "retry") { try { await stripe.identity.verificationSessions.cancel(v.sessionId); } catch (e) { if (!isStripe(e)) throw e; } }
        await stripe.identity.verificationSessions.redact(v.sessionId);
        await setV(car, b.id, { ...v, redactedAt: new Date(t).toISOString(), verifiedName: null });
        done.push(["redacted", car, b.id]);
      } catch (e) { log.error(`[idv] redact ${v.sessionId}`, e && e.message); }
    }
    return done;
  }

  return { start, sync, onEvent, sweep, repo };
}

const owns = (b, user) => !!(b && user && (b.userId ? b.userId === user.id : (b.customer && String(b.customer.email || "").toLowerCase() === user.email)));

/** GET /api/verify?car=&ref=   POST /api/verify { car, ref, consent: true } */
export function verifyHandler({ store, stripe, userOf, publishableKey = "", siteUrl = "", now = () => Date.now(), notify = null }) {
  const idv = makeIdentity({ store, stripe, now, notify });
  return async (req, ctx) => {
    try {
      const user = await userOf(req);
      if (!user) return json({ error: "login_required", message: "Please log in to verify your ID." }, 401);
      let car, ref, body = {};
      if (req.method === "GET") { const u = new URL(req.url); car = u.searchParams.get("car"); ref = u.searchParams.get("ref"); }
      else if (req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: "bad_origin" }, 403);
        try { body = JSON.parse((await req.text()) || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); }
        car = body.car; ref = body.ref;
      } else return json({ error: "method" }, 405);
      if (!CARS[car] || typeof ref !== "string") return json({ error: "not_found", message: "We couldn't find that trip." }, 404);
      let b = await idv.repo.get(car, ref);
      if (!owns(b, user)) return json({ error: "not_found", message: "We couldn't find that trip on your account. Log in with the account you booked with." }, 404);
      if (b.status !== "confirmed") return json({ error: "not_paid", message: "ID verification opens once your trip is paid." }, 409);

      if (req.method === "POST") {
        if (body.consent !== true) return json({ error: "consent_required", message: "Please check the box to agree to the ID check." }, 400);
        const ip = (ctx && ctx.ip) || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
        const r = await idv.start(car, b, { user, ip, returnUrl: `${siteUrl}/verify.html?car=${car}&ref=${ref}&returned=1` });
        return json({ ...r, publishableKey });
      }
      // GET: refresh from Stripe if the check is underway
      const v = b.verification || {};
      if (v.sessionId && ["started", "processing", "retry"].includes(v.status)) {
        try { await idv.sync(car, b, await stripe.identity.verificationSessions.retrieve(v.sessionId)); b = await idv.repo.get(car, ref); }
        catch (e) { if (!isStripe(e)) throw e; }
      }
      const vv = b.verification || {};
      return json({
        trip: { car, carName: CARS[car].name, photo: CARS[car].photo, from: b.from, to: b.to, fromTime: b.fromTime, toTime: b.toTime, location: (LOCATIONS[b.location] || {}).name },
        verification: { status: vv.status || "not_started", error: vv.error ? vv.error.message : null, verifiedAt: vv.verifiedAt || null },
        consent: { text: consentText(), version: CONSENT_VERSION },
        renter: { name: (b.customer && b.customer.name) || user.firstName + " " + user.lastName },
      });
    } catch (e) {
      if (e && e.code === "too_many") return json({ error: "too_many", message: e.message }, 429);
      if (isStripe(e)) { console.error("[idv] Stripe error", e.type, e.message);
        return json({ error: "stripe", message: /identity/i.test(e.message || "") && /activ|not enabled|access/i.test(e.message || "") ? "ID verification isn't switched on yet. Please text us and we'll verify your ID at pickup." : "Our ID check is having trouble right now. Please try again in a minute." }, 502); }
      console.error("[idv] error", e);
      return json({ error: "server", message: "Something went wrong. Please try again." }, 500);
    }
  };
}
