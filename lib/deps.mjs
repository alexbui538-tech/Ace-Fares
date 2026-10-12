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
export const publishableKey = () => process.env.STRIPE_PUBLISHABLE_KEY || "";
export async function mailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;   // email off until configured
  const { gmailMailer } = await import("./email.mjs");
  return gmailMailer({ user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD, ownerEmail: process.env.OWNER_EMAIL });
}
