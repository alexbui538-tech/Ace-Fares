// Reminder emails, sent by the 15-minute job (netlify/functions/deposit-holds.mjs):
//  - to the renter about 24 hours before pickup (only if they booked earlier than that)
//  - to the renter on return day (8 AM, or 3 hours before an early return)
//  - to the owner when a car's oil change, inspection, registration or insurance is coming due (lib/admin-tools.mjs)
import { CARS, LOCATIONS, DEPOSITS, placeText } from "./catalog.mjs";
import { POLICY } from "./agreement.mjs";
import { makeRepo } from "./bookings.mjs";
import { localMs } from "./deposits.mjs";
import { niceDate } from "./pricing.mjs";
import { simpleEmail } from "./trips.mjs";

const H = 3600e3;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t12 = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#DAA336;color:#15130F;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:10px;margin:4px 6px 4px 0">${esc(label)}</a>`;
const idDone = b => b.verification && ["verified", "review", "processing"].includes(b.verification.status);

export function pickupReminder(car, b, siteUrl) {
  const c = b.customer || {}, first = (c.name || b.accountName || "").split(" ")[0] || "there", loc = LOCATIONS[b.location];
  const where = b.handoff && b.handoff.address ? `Delivery to ${b.handoff.address}` : b.handoff && b.handoff.flight ? `${loc.name}, flight ${b.handoff.flight}` : placeText(b.location);
  const q = `car=${car}&ref=${b.id}`;
  const photos = `${siteUrl}/inspect.html?${q}&stage=pickup`, verify = `${siteUrl}/verify.html?${q}`;
  const body = simpleEmail(`See you tomorrow, ${first}!`, [
    `Your ${CARS[car].name} is ready for ${niceDate(b.from)} at ${t12(b.fromTime)}. We'll text you to confirm the exact meeting spot.`,
    ...(idDone(b) ? [] : [{ html: `<b>Your driver's license check isn't finished.</b> We can't hand over the car until it's done. It takes about 2 minutes:<br>${btn(verify, "Verify your license")}`,
      text: `Your driver's license check isn't finished. We can't hand over the car until it's done (about 2 minutes): ${verify}` }]),
    "Bring: your physical driver's license, proof of auto insurance (card or app), and the card you booked with.",
    { html: `At pickup, take your photos of the car on our site: all four sides, the odometer, the fuel gauge and the interior.<br>${btn(photos, "Pickup photos")}`,
      text: `At pickup, take your photos of the car on our site (all four sides, odometer, fuel gauge, interior): ${photos}` },
    `Reminders: no smoking or vaping (a $${POLICY.smokingFee} fee applies), no travel outside Texas, and tolls are billed after the trip.`,
  ], [["Car", CARS[car].name], ["Pickup", `${niceDate(b.from)}, ${t12(b.fromTime)}`], ["Where", where], ["Return", `${niceDate(b.to)}, ${t12(b.toTime)}`],
    ...(DEPOSITS[car] ? [["Deposit hold", `$${DEPOSITS[car]} (refundable, released after return)`]] : [])]);
  return { subject: `Tomorrow: your ${CARS[car].name} pickup at ${t12(b.fromTime)}`, ...body };
}

export function returnReminder(car, b, siteUrl) {
  const c = b.customer || {}, first = (c.name || b.accountName || "").split(" ")[0] || "there";
  const photos = `${siteUrl}/inspect.html?car=${car}&ref=${b.id}&stage=return`;
  const body = simpleEmail(`Return day, ${first}`, [
    `Your ${CARS[car].name} is due back today, ${niceDate(b.to)}, at ${t12(b.toTime)}.`,
    `Before you return it: refill the fuel to the level it had at pickup (otherwise fuel plus a $${POLICY.fuelServiceFee} fee), take out your belongings and trash, and bring the keys.`,
    { html: `When you drop it off, take your return photos so we both have a record:<br>${btn(photos, "Return photos")}`, text: `When you drop it off, take your return photos: ${photos}` },
    { html: `Running late? There's a ${POLICY.lateGraceMinutes}-minute grace period, then a $${POLICY.lateFee} late fee. Need more time? <a href="${esc(siteUrl)}/?trips=1">Request an extension in My trips</a> or text us.`,
      text: `Running late? There's a ${POLICY.lateGraceMinutes}-minute grace period, then a $${POLICY.lateFee} late fee. Need more time? Request an extension in My trips (${siteUrl}/?trips=1) or text us.` },
  ]);
  return { subject: `Today: return your ${CARS[car].name} by ${t12(b.toTime)}`, ...body };
}

export function makeReminders({ store, mailer = null, siteUrl = "", now = () => Date.now(), log = console }) {
  const repo = makeRepo(store, { now });
  async function sweep() {
    if (!mailer) return [];
    const t = now(), done = [];
    for (const car of Object.keys(CARS)) for (const b of await repo.all(car)) {
      if (b.status !== "confirmed") continue;
      const to = (b.customer && b.customer.email) || b.accountEmail;
      if (!to) continue;
      const start = localMs(b.from, b.fromTime), end = localMs(b.to, b.toTime);
      try {
        const pickAt = start - 24 * H;
        if (!b.pickupReminderAt && t >= pickAt && t < start && Date.parse(b.confirmedAt || 0) < pickAt) {
          await repo.note(car, b.id, { pickupReminderAt: new Date(t).toISOString() });
          await mailer.send({ to, ...pickupReminder(car, b, siteUrl) });
          done.push(["pickup-reminder", car, b.id]);
        }
        const retAt = Math.min(localMs(b.to, "08:00"), end - 3 * H);
        if (!b.returnReminderAt && t >= retAt && t < end && t >= start) {
          await repo.note(car, b.id, { returnReminderAt: new Date(t).toISOString() });
          await mailer.send({ to, ...returnReminder(car, b, siteUrl) });
          done.push(["return-reminder", car, b.id]);
        }
      } catch (e) { log.error(`[reminders] ${car} ${b.id}`, e && e.message); }
    }
    return done;
  }
  return { sweep };
}
