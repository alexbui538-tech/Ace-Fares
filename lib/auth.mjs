// Renter accounts: sign up / log in with email and password, or with Google.
//
// Storage (Netlify Blobs store "users"):
//   user-<id>           { id, email, firstName, lastName, phone, passwordHash?, googleSub?, emailVerified, sv, createdAt, bookings: [{car,id}] }
//   email-<sha256>      { id }        one account per email address
//   google-<sub>        { id }        Google account -> our account
//   reset-<sha256>      { id, exp }   password reset links (1 hour)
//   throttle-<sha256>   { hits: [] }  rate limits
//   config-session-secret             random key that signs session cookies (unless SESSION_SECRET is set)
//
// Sessions are a signed, HttpOnly cookie. Passwords are hashed with scrypt; we never store them.
// Google sign-in: the browser gets an ID token from Google; the server checks its signature,
// audience (our Google client ID) and that Google verified the email.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getJSON, createJSON, updateJSON, removeKey } from "./kv.mjs";
import { makeRepo } from "./bookings.mjs";
import { CARS, LOCATIONS } from "./catalog.mjs";

const scrypt = promisify(scryptCb);
export const COOKIE = "af_session";
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const b64u = buf => Buffer.from(buf).toString("base64url");
export const sha = s => createHash("sha256").update(String(s)).digest("hex");
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
export const normEmail = e => clean(e, 254).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export class AuthError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }

export async function hashPassword(pw) {
  const salt = randomBytes(16), key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(String(pw), Buffer.from(salt, "base64url"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, want);
}

/** Checks a Google ID token with Google's public keys. Returns the token's claims. */
export function googleVerifier(clientId) {
  let jwks = null;
  return async credential => {
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    jwks ||= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
    const { payload } = await jwtVerify(credential, jwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: clientId });
    return payload;
  };
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, name: `${u.firstName} ${u.lastName}`.trim(),
    phone: u.phone || "", google: !!u.googleSub, hasPassword: !!u.passwordHash, picture: u.picture || "", credit: u.credit || 0,
    welcome: !!(u.referredBy && !u.welcomeUsed && !u.hasBooked) };
}

function checkPassword(pw, email) {
  pw = String(pw ?? "");
  if (pw.length < 8) throw new AuthError("weak_password", "Use at least 8 characters for your password.");
  if (pw.length > 200) throw new AuthError("weak_password", "That password is too long.");
  if (pw.toLowerCase() === email) throw new AuthError("weak_password", "Your password can't be your email address.");
  return pw;
}
function checkNames(b) {
  const firstName = clean(b.firstName, 50), lastName = clean(b.lastName, 50);
  if (!firstName || !lastName) throw new AuthError("bad_name", "Enter your first and last name as they appear on your driver's license.");
  const phone = clean(b.phone, 30);
  if (phone && phone.replace(/\D/g, "").length < 10) throw new AuthError("bad_phone", "Enter a 10-digit mobile number, or leave it blank.");
  return { firstName, lastName, phone };
}

export function makeAuth({ store, bookingsStore = null, now = () => Date.now(), secret = "", googleClientId = "", verifyGoogle = null,
  mailer = null, siteUrl = "", referrals = null, log = console } = {}) {
  const verify = verifyGoogle || (googleClientId ? googleVerifier(googleClientId) : null);
  let keyPromise = null;

  async function signingKey() {
    if (secret) return secret;
    return keyPromise ||= (async () => {
      const k = "config-session-secret";
      let v = await getJSON(store, k);
      if (!v) { await createJSON(store, k, { key: b64u(randomBytes(32)) }); v = await getJSON(store, k); }
      return v.key;
    })();
  }
  const mac = async data => createHmac("sha256", await signingKey()).update(data).digest("base64url");

  async function cookieFor(req, u) {
    const exp = now() + SESSION_DAYS * 864e5;
    const body = b64u(JSON.stringify({ uid: u.id, sv: u.sv || 0, exp }));
    const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
    return `${COOKIE}=${body}.${await mac(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
  }
  const clearCookie = req => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;

  /** The signed-in user for this request, or null. */
  async function userOf(req) {
    const raw = (req.headers.get("cookie") || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
    if (!raw) return null;
    const [body, sig] = raw.slice(COOKIE.length + 1).split(".");
    if (!body || !sig) return null;
    const want = Buffer.from(await mac(body)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
    if (!p || typeof p.uid !== "string" || !(p.exp > now())) return null;
    const u = await getJSON(store, `user-${p.uid}`);
    return u && (u.sv || 0) === p.sv ? u : null;
  }

  async function throttle(kind, id, limit, minutes = 15) {
    const k = `throttle-${sha(kind + ":" + id)}`, t = now(), win = minutes * 60e3;
    const rec = await getJSON(store, k);
    const hits = ((rec && rec.hits) || []).filter(h => t - h < win);
    if (hits.length >= limit) throw new AuthError("too_many", "Too many attempts. Please wait a few minutes and try again.", 429);
    return { hit: () => updateJSON(store, k, cur => ({ hits: [...((cur && cur.hits) || []).filter(h => t - h < win), t].slice(-limit * 2) })), clear: () => removeKey(store, k) };
  }

  const userByEmail = async email => { const ix = await getJSON(store, `email-${sha(email)}`); return ix ? getJSON(store, `user-${ix.id}`) : null; };
  const saveUser = (id, fn) => updateJSON(store, `user-${id}`, cur => cur ? fn(cur) : undefined);

  async function createUser(fields) {
    const id = randomUUID();
    if (!(await createJSON(store, `email-${sha(fields.email)}`, { id }))) return null;    // email already taken
    const u = { id, sv: 0, bookings: [], createdAt: new Date(now()).toISOString(), emailVerified: false, ...fields };
    await store.setJSON(`user-${id}`, u);
    return u;
  }

  /** Remember a booking on the renter's account (for My trips). */
  async function linkBooking(userId, car, bookingId) {
    await saveUser(userId, u => (u.bookings || []).some(b => b.id === bookingId) ? undefined
      : { ...u, bookings: [...(u.bookings || []), { car, id: bookingId, at: new Date(now()).toISOString() }].slice(-200) });
  }

  const ipOf = (req, ctx) => (ctx && ctx.ip) || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  async function signedIn(req, u, status = 200, extra = {}) {
    return json({ ok: true, user: publicUser(u), ...extra }, status, { "set-cookie": await cookieFor(req, u) });
  }

  const routes = {
    "GET config": async () => json({ googleClientId: googleClientId || "", resetByEmail: !!mailer }),

    "GET me": async req => json({ user: publicUser(await userOf(req)) }),

    // email-first: tell the page whether to ask for a password or show the sign-up form
    "POST lookup": async (req, b, ctx) => {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) throw new AuthError("bad_email", "Enter a valid email address.");
      const t = await throttle("lookup", ipOf(req, ctx), 40); await t.hit();
      const u = await userByEmail(email);
      return json({ exists: !!u, hasPassword: !!(u && u.passwordHash), google: !!(u && u.googleSub) });
    },

    "POST signup": async (req, b, ctx) => {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) throw new AuthError("bad_email", "Enter a valid email address.");
      const names = checkNames(b), pw = checkPassword(b.password, email);
      const t = await throttle("signup", ipOf(req, ctx), 10, 60); await t.hit();
      const u = await createUser({ email, ...names, passwordHash: await hashPassword(pw), ...(referrals && b.invite ? await referrals.referredFields(b.invite) : {}) });
      if (!u) throw new AuthError("email_taken", "There's already an account with this email. Log in instead.", 409);
      return signedIn(req, u, 201);
    },

    "POST login": async (req, b, ctx) => {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) throw new AuthError("bad_email", "Enter a valid email address.");
      const perEmail = await throttle("login", email, 8), perIp = await throttle("login-ip", ipOf(req, ctx), 30);
      const u = await userByEmail(email);
      const good = u && u.passwordHash && await verifyPassword(String(b.password ?? ""), u.passwordHash);
      if (!good) {
        await perEmail.hit(); await perIp.hit();
        if (u && !u.passwordHash && u.googleSub) throw new AuthError("use_google", "This account uses Google sign-in. Click Continue with Google.", 401);
        throw new AuthError("bad_login", "That email and password don't match. Try again or reset your password.", 401);
      }
      await perEmail.clear();
      return signedIn(req, u);
    },

    "POST google": async (req, b) => {
      if (!verify) throw new AuthError("google_off", "Google sign-in isn't set up yet. Use your email instead.", 503);
      let p;
      try { p = await verify(String(b.credential || "")); }
      catch (e) { log.warn("[auth] Google token rejected:", e && e.message); throw new AuthError("google_bad", "Google sign-in didn't work. Please try again.", 401); }
      const email = normEmail(p.email);
      if (!p.sub || !EMAIL_RE.test(email) || p.email_verified !== true) throw new AuthError("google_unverified", "Your Google account's email isn't verified. Use your email instead.", 401);
      const fromGoogle = { googleSub: String(p.sub), emailVerified: true, ...(p.picture ? { picture: String(p.picture).slice(0, 500) } : {}) };
      const linked = await getJSON(store, `google-${p.sub}`);
      let u = linked && await getJSON(store, `user-${linked.id}`);
      let created = false;
      if (!u) {
        u = await userByEmail(email);
        if (u) {
          // Google proved this person owns the email. If the account was made with a password
          // nobody ever proved control of, remove that password and sign out other sessions.
          u = await saveUser(u.id, cur => ({ ...cur, ...fromGoogle, ...(!cur.emailVerified && cur.passwordHash ? { passwordHash: null, sv: (cur.sv || 0) + 1 } : {}) }));
        } else {
          u = await createUser({ email, firstName: clean(p.given_name || String(p.name || "").split(" ")[0], 50), lastName: clean(p.family_name || String(p.name || "").split(" ").slice(1).join(" "), 50), phone: "", ...fromGoogle,
            ...(referrals && b.invite ? await referrals.referredFields(b.invite) : {}) });
          if (!u) u = await saveUser((await userByEmail(email)).id, cur => ({ ...cur, ...fromGoogle }));   // created a moment ago in another tab
          else created = true;
        }
        await store.setJSON(`google-${p.sub}`, { id: u.id });
      }
      return signedIn(req, u, created ? 201 : 200, { created, needsName: !u.firstName || !u.lastName });
    },

    // Refer a friend
    "GET referral": async req => {
      const u = await userOf(req);
      if (!u) throw new AuthError("login_required", "Log in to get your invite link.", 401);
      if (!referrals) return json({ error: "off" }, 404);
      return json(await referrals.summary(u));
    },
    "GET invite": async req => json(referrals ? await referrals.invite(new URL(req.url).searchParams.get("code")) : { valid: false }),

    "POST logout": async req => json({ ok: true }, 200, { "set-cookie": clearCookie(req) }),

    "POST profile": async (req, b) => {
      const u = await userOf(req);
      if (!u) throw new AuthError("login_required", "Please log in again.", 401);
      const names = checkNames(b);
      return json({ ok: true, user: publicUser(await saveUser(u.id, cur => ({ ...cur, ...names }))) });
    },

    "POST forgot": async (req, b, ctx) => {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) throw new AuthError("bad_email", "Enter a valid email address.");
      if (!mailer) return json({ ok: true, emailEnabled: false });
      const t = await throttle("forgot", ipOf(req, ctx), 10, 60); await t.hit();
      const u = await userByEmail(email);
      if (u) {
        const token = b64u(randomBytes(32));
        await store.setJSON(`reset-${sha(token)}`, { id: u.id, exp: now() + RESET_MINUTES * 60e3 });
        const link = `${siteUrl}/?reset=${token}`;
        try {
          await mailer.send({ to: u.email, subject: "Reset your Ace Fares password",
            text: `Hi ${u.firstName || "there"},\n\nUse this link to choose a new password. It works for ${RESET_MINUTES} minutes:\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\nAce Fares Rental`,
            html: `<p>Hi ${u.firstName ? u.firstName.replace(/[<>&]/g, "") : "there"},</p><p>Use this link to choose a new password. It works for ${RESET_MINUTES} minutes:</p><p><a href="${link}">Reset my password</a></p><p>If you didn't ask for this, you can ignore this email.</p><p>Ace Fares Rental</p>` });
        } catch (e) { log.error("[auth] reset email failed", e && e.message); }
      }
      return json({ ok: true, emailEnabled: true });     // same answer whether or not the account exists
    },

    "POST reset": async (req, b) => {
      const token = String(b.token || "");
      const k = `reset-${sha(token)}`, rec = token && await getJSON(store, k);
      if (!rec || !(rec.exp > now())) throw new AuthError("reset_expired", "This reset link has expired or was already used. Ask for a new one.", 410);
      const u0 = await getJSON(store, `user-${rec.id}`);
      if (!u0) throw new AuthError("reset_expired", "This reset link has expired. Ask for a new one.", 410);
      const pw = checkPassword(b.password, u0.email);
      const hash = await hashPassword(pw);
      await store.setJSON(k, { id: rec.id, exp: 0 });     // one-time link
      // reset proves they control the email; signing out every other session
      const u = await saveUser(rec.id, cur => ({ ...cur, passwordHash: hash, emailVerified: true, sv: (cur.sv || 0) + 1 }));
      return signedIn(req, u);
    },

    // the renter's bookings, newest first
    "GET trips": async req => {
      const u = await userOf(req);
      if (!u) throw new AuthError("login_required", "Please log in to see your trips.", 401);
      if (!bookingsStore) return json({ trips: [] });
      const repo = makeRepo(bookingsStore, { now });
      const trips = [];
      for (const ref of [...(u.bookings || [])].reverse()) {
        const b = await repo.get(ref.car, ref.id);
        if (!b || !["confirmed", "conflict", "cancelled", "hold"].includes(b.status)) continue;
        if (b.status === "hold" && !(Date.parse(b.expiresAt) > now())) continue;
        trips.push({ car: ref.car, carName: CARS[ref.car] ? CARS[ref.car].name : ref.car, photo: CARS[ref.car] && CARS[ref.car].photo, ref: b.id,
          from: b.from, to: b.to, fromTime: b.fromTime, toTime: b.toTime, location: (LOCATIONS[b.location] || {}).name || b.location,
          status: b.status, total: b.amountPaid || b.total, verification: (b.verification && b.verification.status) || "not_started",
          photos: { pickup: !!(b.inspection && b.inspection.pickup && b.inspection.pickup.renter), return: !!(b.inspection && b.inspection.return && b.inspection.return.renter) } });
      }
      return json({ trips });
    },
  };

  /** One Netlify function serves /api/auth/* */
  async function handler(req, ctx) {
    try {
      const url = new URL(req.url), name = url.pathname.replace(/^.*\/api\/auth\/?/, "").replace(/\/$/, "");
      const route = routes[`${req.method} ${name}`];
      if (!route) return json({ error: "not_found" }, 404);
      let body = {};
      if (req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== url.host) return json({ error: "bad_origin" }, 403);
        if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "bad_request" }, 415);
        const text = await req.text();
        if (text.length > 8192) return json({ error: "too_large" }, 413);
        try { body = text ? JSON.parse(text) : {}; } catch { return json({ error: "bad_request", message: "Invalid request." }, 400); }
        if (!body || typeof body !== "object") body = {};
      }
      return await route(req, body, ctx);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.code, message: e.message }, e.status);
      log.error("[auth] error", e);
      return json({ error: "server", message: "Something went wrong. Please try again." }, 500);
    }
  }

  return { handler, userOf, linkBooking, publicUser };
}
