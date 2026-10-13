// Refer a friend: give $50, get $100.
//  - Every account has an invite link: /?invite=CODE
//  - A friend who signs up through it gets $50 off their first trip.
//  - When that friend's first trip of 3+ days has ended without being cancelled,
//    the person who invited them gets $100 of Ace Fares credit. Once per friend.
//  - Credit is used automatically at checkout (before tax) and taken from the balance when the trip is paid.
//
// Storage (the "users" store): user.refCode, user.referredBy, user.credit (cents), user.creditLog [],
//   user.welcomeUsed, user.hasBooked, user.referralRewards [friend ids]; refcode-<CODE> -> { id }
import { randomBytes } from "node:crypto";
import { getJSON, createJSON, updateJSON } from "./kv.mjs";
import { makeRepo } from "./bookings.mjs";
import { CARS, REFERRAL } from "./catalog.mjs";
import { daysBetween } from "./pricing.mjs";
import { localMs } from "./deposits.mjs";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
export const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
const money = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function referralTerms() {
  return `Share your link. A friend who signs up with it gets ${money(REFERRAL.friendDiscount)} off their first trip. ` +
    `When their first trip of ${REFERRAL.minDays}+ days is completed, you get ${money(REFERRAL.reward)} in Ace Fares credit, ` +
    `once per friend. Credit is applied automatically to your next booking before tax, has no cash value, can't be transferred, ` +
    `and doesn't apply to deposits, fees or damage charges. Referring yourself or using fake accounts cancels the reward. ` +
    `Ace Fares may change or end this program; credit you've already earned stays usable.`;
}

export function makeReferrals({ users, bookingsStore = null, now = () => Date.now(), mailer = null, siteUrl = "", log = console }) {
  const saveUser = (id, fn) => updateJSON(users, `user-${id}`, cur => cur ? fn(cur) : undefined);

  /** The user's invite code (created the first time it's needed). */
  async function ensureCode(u) {
    if (u.refCode) return u.refCode;
    for (let i = 0; i < 8; i++) {
      const code = Array.from(randomBytes(7), b => ALPHABET[b % ALPHABET.length]).join("");
      if (await createJSON(users, `refcode-${code}`, { id: u.id })) {
        const saved = await saveUser(u.id, cur => cur.refCode ? undefined : { ...cur, refCode: code });
        return (saved && saved.refCode) || code;
      }
    }
    throw new Error("Could not create an invite code");
  }

  async function referrerOf(code) {
    const c = normCode(code); if (!c) return null;
    const ix = await getJSON(users, `refcode-${c}`);
    return ix ? getJSON(users, `user-${ix.id}`) : null;
  }

  /** For the "You've been invited" banner. */
  async function invite(code) {
    const r = await referrerOf(code);
    return r ? { valid: true, firstName: r.firstName || "", friendDiscount: REFERRAL.friendDiscount } : { valid: false };
  }

  /** Fields to put on a brand-new account created through an invite link. */
  async function referredFields(code) {
    const r = await referrerOf(code);
    return r ? { referredBy: r.id, referredAt: new Date(now()).toISOString() } : {};
  }

  /** Discounts this renter gets on the booking they're making now. */
  function creditsFor(u) {
    if (!u) return [];
    const out = [];
    if (u.referredBy && !u.welcomeUsed && !u.hasBooked) out.push({ code: "welcome", label: "Friend referral: first trip", amount: REFERRAL.friendDiscount });
    if (u.credit > 0) out.push({ code: "credit", label: "Ace Fares credit", amount: u.credit });
    return out;
  }

  /** A trip was paid: use up the credit it applied and mark the first trip. Runs once per booking. */
  async function onConfirmed(car, b) {
    if (!b || !b.userId) return;
    const used = b.credits || [];
    await saveUser(b.userId, u => {
      if ((u.creditLog || []).some(l => l.booking === b.id && l.type === "used")) return u.hasBooked ? undefined : { ...u, hasBooked: true };
      const c = used.find(x => x.code === "credit"), w = used.find(x => x.code === "welcome");
      const next = { ...u, hasBooked: true };
      if (w) next.welcomeUsed = true;
      if (c) {
        next.credit = Math.max(0, (u.credit || 0) - c.amount);
        next.creditLog = [...(u.creditLog || []), { type: "used", amount: c.amount, booking: b.id, car, at: new Date(now()).toISOString() }].slice(-100);
      }
      return next;
    });
  }

  /** A paid trip was cancelled: give back the Ace Fares credit it used (once). */
  async function onCancelled(car, b) {
    if (!b || !b.userId) return;
    await saveUser(b.userId, u => {
      const log = u.creditLog || [];
      const used = log.find(l => l.booking === b.id && l.type === "used");
      if (!used || log.some(l => l.booking === b.id && l.type === "restored")) return undefined;
      return { ...u, credit: (u.credit || 0) + used.amount,
        creditLog: [...log, { type: "restored", amount: used.amount, booking: b.id, car, at: new Date(now()).toISOString() }].slice(-100) };
    });
  }

  /** Hourly: pay referrers whose friends have finished a qualifying trip. */
  async function sweep() {
    if (!bookingsStore) return [];
    const repo = makeRepo(bookingsStore, { now }), done = [], t = now();
    for (const car of Object.keys(CARS)) for (const b of await repo.all(car)) {
      if (b.status !== "confirmed" || !b.userId || b.referralChecked) continue;
      if (daysBetween(b.from, b.to) < REFERRAL.minDays || localMs(b.to, b.toTime) > t) continue;
      try {
        const friend = await getJSON(users, `user-${b.userId}`);
        let paid = null;
        if (friend && friend.referredBy && friend.referredBy !== friend.id) {
          const at = new Date(t).toISOString();
          paid = await saveUser(friend.referredBy, r => (r.referralRewards || []).includes(friend.id) ? undefined : {
            ...r, credit: (r.credit || 0) + REFERRAL.reward, referralRewards: [...(r.referralRewards || []), friend.id],
            creditLog: [...(r.creditLog || []), { type: "earned", amount: REFERRAL.reward, friend: friend.firstName || "", booking: b.id, at }].slice(-100) });
          paid = paid && (paid.creditLog || []).some(l => l.booking === b.id && l.type === "earned") ? paid : null;   // null: this friend already earned a reward
          if (paid) {
            done.push(["rewarded", paid.id, b.id]);
            if (mailer && paid.email) {
              try {
                await mailer.send({ to: paid.email, subject: `You earned ${money(REFERRAL.reward)} in Ace Fares credit`,
                  text: `Hi ${paid.firstName || "there"},\n\n${friend.firstName || "Your friend"} just finished their trip with Ace Fares, so you've earned ${money(REFERRAL.reward)} in credit. It comes off your next booking automatically.\n\nYour credit balance: ${money(paid.credit)}\nBook: ${siteUrl}/#fleet\n\nThanks for spreading the word!\nAce Fares Rental`,
                  html: `<p>Hi ${String(paid.firstName || "there").replace(/[<>&]/g, "")},</p><p>${String(friend.firstName || "Your friend").replace(/[<>&]/g, "")} just finished their trip with Ace Fares, so you've earned <b>${money(REFERRAL.reward)}</b> in credit. It comes off your next booking automatically.</p><p>Your credit balance: <b>${money(paid.credit)}</b><br><a href="${siteUrl}/#fleet">Book your next trip</a></p><p>Thanks for spreading the word!<br>Ace Fares Rental</p>` });
              } catch (e) { log.error("[referral] email failed", e && e.message); }
            }
          }
        }
        await repo.note(car, b.id, { referralChecked: true, ...(paid ? { referralRewardedAt: new Date(t).toISOString() } : {}) });
      } catch (e) { log.error(`[referral] ${car} ${b.id}`, e && e.message); }
    }
    return done;
  }

  /** What the "Refer a friend" window shows. */
  async function summary(u) {
    const code = await ensureCode(u), fresh = await getJSON(users, `user-${u.id}`) || u;
    return { code, link: `${siteUrl}/?invite=${code}`, credit: fresh.credit || 0, friendsRewarded: (fresh.referralRewards || []).length,
      reward: REFERRAL.reward, friendDiscount: REFERRAL.friendDiscount, minDays: REFERRAL.minDays, terms: referralTerms(),
      welcome: fresh.referredBy && !fresh.welcomeUsed && !fresh.hasBooked ? REFERRAL.friendDiscount : 0 };
  }

  return { ensureCode, invite, referredFields, creditsFor, onConfirmed, onCancelled, sweep, summary };
}
