// Real dependencies for the deployed site. Secrets come only from environment variables.
import Stripe from "stripe";
import { getStore } from "@netlify/blobs";

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
export const stripe = () => new Stripe(env("STRIPE_SECRET_KEY"));
export const store = () => getStore({ name: "bookings", consistency: "strong" });
export const siteUrl = () => (process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
export const now = () => Date.now();
export const requireTerms = () => process.env.REQUIRE_TERMS === "true";
// Stripe publishable key (pk_test_... / pk_live_...). Not secret. When set, renters pay on the site's own checkout page.
export const publishableKey = () => matchingPublishableKey(process.env.STRIPE_PUBLISHABLE_KEY, process.env.STRIPE_SECRET_KEY);

/** The publishable key only works with a secret key from the same mode (test with test, live with live).
 *  If they don't match, return "" so checkout falls back to Stripe's hosted page instead of a broken form. */
export function matchingPublishableKey(pk = "", sk = "") {
  pk = pk.trim(); sk = sk.trim();
  if (!pk) return "";
  const pkLive = pk.startsWith("pk_live_"), skLive = /^(sk|rk)_live_/.test(sk);
  if (!/^pk_(test|live)_/.test(pk) || pkLive !== skLive) {
    console.error(`[booking] STRIPE_PUBLISHABLE_KEY is a ${pkLive ? "live" : "test"} key but STRIPE_SECRET_KEY is a ${skLive ? "live" : "test"} key. They must match. Using Stripe's hosted checkout until fixed.`);
    return "";
  }
  return pk;
}
export async function mailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;   // email off until configured
  const { gmailMailer } = await import("./email.mjs");
  return gmailMailer({ user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD, ownerEmail: process.env.OWNER_EMAIL });
}

/** Sends the owner a short notice (e.g. a deposit hold failed). null when email isn't set up. */
export async function ownerNotifier() {
  const m = await mailer(), to = process.env.OWNER_EMAIL || process.env.GMAIL_USER;
  if (!m || !to) return null;
  return (subject, text) => m.send({ to, subject, text, html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>` });
}

// Renter accounts (lib/auth.mjs). GOOGLE_CLIENT_ID is public (it's in the page anyway).
// SESSION_SECRET is optional: without it, a random signing key is created and kept in the site's private storage.
export const usersStore = () => getStore({ name: "users", consistency: "strong" });
export const requireAccount = () => process.env.REQUIRE_ACCOUNT !== "false";
let authInstance = null;
export async function auth() {
  if (authInstance) return authInstance;
  const { makeAuth } = await import("./auth.mjs");
  return authInstance = makeAuth({ store: usersStore(), bookingsStore: store(), now, secret: process.env.SESSION_SECRET || "",
    googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim(), mailer: await mailer(), siteUrl: siteUrl(), referrals: await referrals() });
}

// Refer a friend (lib/referrals.mjs)
let referralsInstance = null;
export async function referrals() {
  if (referralsInstance) return referralsInstance;
  const { makeReferrals } = await import("./referrals.mjs");
  return referralsInstance = makeReferrals({ users: usersStore(), bookingsStore: store(), now, mailer: await mailer(), siteUrl: siteUrl() });
}

// Pickup/return photos: every picture is kept here (lib/inspections.mjs)
export const photosStore = () => getStore({ name: "inspections", consistency: "strong" });
// Roamly link shown as an insurance choice at checkout. Empty = the option is hidden.
export const roamlyUrl = () => { const u = (process.env.ROAMLY_URL || "").trim(); return /^https:\/\//.test(u) ? u : ""; };
