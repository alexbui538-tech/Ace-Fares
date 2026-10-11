// Ace Fares rental agreement: one source for the web page (/rental-agreement),
// the confirmation email, and the checkout "I agree" link.
// DRAFT FOR REVIEW: this is a starting template, not legal advice. Have a Texas
// attorney review it before relying on it. Fill in the POLICY values marked null.
import { CARS, LOCATIONS, TAX } from "./catalog.mjs";

export const AGREEMENT_VERSION = "2026-10-11-draft";

// Values the owner sets. null shows as "[to be set]" so nothing is invented.
export const POLICY = {
  minAge: 21,
  extraMileRate: null,          // e.g. 0.50 -> "$0.50 per mile"
  lateGraceMinutes: null,       // e.g. 30
  lateFeePerHour: null,         // e.g. 25
  fuelServiceFee: null,         // e.g. 25, plus the cost of fuel
  cleaningFee: null,            // e.g. 150 for excessive dirt, sand or pet hair
  smokingFee: null,             // e.g. 250
  ticketAdminFee: null,         // e.g. 25 per toll or ticket handled
  cancellationPolicy: null,     // e.g. "Full refund if cancelled 48 hours or more before pickup; 50% within 48 hours."
  outOfStateAllowed: null,      // true / false
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TBD = "[to be set]";
const money = n => (n == null ? TBD : "$" + Number(n).toFixed(2).replace(/\.00$/, ""));
const val = v => (v == null ? TBD : v);
export const policyComplete = () => Object.values(POLICY).every(v => v !== null);

const niceDate = s => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
const t12 = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

/** The agreement as sections of [heading, [paragraphs]]. booking is optional (fills in renter and trip details). */
export function agreementSections(booking) {
  const b = booking || {}, c = b.customer || {}, car = CARS[b.car], loc = LOCATIONS[b.location];
  return [
    ["1. Parties and vehicle", [
      `This Rental Agreement is between Ace Fares Rental Company, Dallas, Texas ("Ace Fares", "we") and the renter named below ("Renter", "you").`,
      booking ? `Renter: ${c.name || ""}${c.email ? ", " + c.email : ""}${c.phone ? ", " + c.phone : ""}.` : `Renter: the person who books and pays through acefaresrental.netlify.app.`,
      booking ? `Vehicle: ${car ? car.name : b.car}. Rental period: ${niceDate(b.from)} at ${t12(b.fromTime)} to ${niceDate(b.to)} at ${t12(b.toTime)}. Handoff: ${loc ? loc.name : ""}.` : `Vehicle, rental period and handoff location: as shown in your booking confirmation.`,
    ]],
    ["2. Who may drive", [
      `You must be at least ${POLICY.minAge} years old and hold a valid driver's license. Only you may drive the vehicle unless we approve another driver in writing before the trip. Anyone who drives must meet the same requirements.`,
    ]],
    ["3. Payment, taxes and discounts", [
      `You paid the trip total shown at checkout, which includes the daily rate for each day (weekday and weekend rates may differ), any discount, any delivery or airport fee, and the ${TAX.label} (${TAX.shortPct}% for rentals of ${TAX.shortMaxDays} days or less, ${TAX.longPct}% for longer rentals).`,
      `Charges that can only be known after the trip, such as extra miles, fuel, tolls, tickets, late return, cleaning or damage, will be billed to you afterward and are due on receipt.`,
    ]],
    ["4. Insurance and responsibility for the vehicle", [
      `You must have valid personal auto insurance that covers rental vehicles and show proof at handoff. Your insurance is primary while you have the vehicle. You are responsible for loss of or damage to the vehicle, and for injury or damage to others, during the rental period to the extent not covered by insurance.`,
    ]],
    ["5. Mileage", [
      `Each day includes ${car ? car.miles : "the"} miles${car ? "" : " shown on the listing"}. Miles beyond the total included for your trip are charged at ${money(POLICY.extraMileRate)} per mile.`,
    ]],
    ["6. Fuel", [
      `Return the vehicle with the same fuel level as at pickup. Otherwise you pay the cost of fuel plus a ${money(POLICY.fuelServiceFee)} service fee.`,
    ]],
    ["7. Late return", [
      `Return the vehicle on time. After a ${val(POLICY.lateGraceMinutes)}-minute grace period, late returns are charged ${money(POLICY.lateFeePerHour)} per hour, up to the daily rate for each day or part day late. A vehicle not returned and not extended with our agreement may be reported stolen.`,
    ]],
    ["8. Tolls, tickets and fines", [
      `You are responsible for all tolls (including NTTA and TxTag), parking and traffic tickets, impound and towing charges incurred during your rental, plus a ${money(POLICY.ticketAdminFee)} handling fee for each one we process.`,
    ]],
    ["9. Rules of use", [
      `No smoking or vaping in the vehicle (fee: ${money(POLICY.smokingFee)}). No pets unless we agree in advance. No racing, off-road driving, towing, or use for rideshare, delivery or other commercial purposes. Do not drive under the influence of alcohol or drugs. ${POLICY.outOfStateAllowed == null ? "Travel outside Texas: " + TBD + "." : POLICY.outOfStateAllowed ? "Travel outside Texas is allowed." : "Do not take the vehicle outside Texas without our written permission."}`,
    ]],
    ["10. Condition and cleaning", [
      `We document the vehicle's condition with photos at pickup and return. Return it in the same condition, apart from normal wear. Excessive dirt, sand, stains or pet hair is charged a cleaning fee of ${money(POLICY.cleaningFee)}.`,
    ]],
    ["11. Accidents, damage and breakdowns", [
      `If there is an accident, theft or damage, contact the police if required and tell us right away at (972) 994-6413. Do not admit fault or arrange repairs yourself. If the vehicle breaks down through no fault of yours, we will work with you on a fix, a replacement or a prorated refund.`,
    ]],
    ["12. Cancellations and changes", [
      `Cancellation policy: ${val(POLICY.cancellationPolicy)}. To change dates, contact us; changes depend on availability and may change the price.`,
    ]],
    ["13. Ending the rental early", [
      `We may end this rental and recover the vehicle if you break this agreement, use the vehicle illegally or unsafely, or give false information. You remain responsible for charges incurred.`,
    ]],
    ["14. General", [
      `This agreement is governed by the laws of the State of Texas. If any part is found unenforceable, the rest still applies. This agreement, your booking confirmation and the listing describe the whole agreement between us.`,
      `You agreed to this agreement electronically by ticking the agreement box at checkout and paying. A copy is emailed to you with your booking confirmation.`,
    ]],
  ];
}

export function agreementHTML(booking) {
  return agreementSections(booking).map(([h, ps]) => `<h3 style="font-size:16px;margin:18px 0 6px">${esc(h)}</h3>${ps.map(p => `<p style="margin:0 0 8px;line-height:1.55">${esc(p)}</p>`).join("")}`).join("");
}
export function agreementText(booking) {
  return agreementSections(booking).map(([h, ps]) => `${h}\n${ps.join("\n")}`).join("\n\n");
}

/** Full web page for /rental-agreement */
export function agreementPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rental Agreement | Ace Fares</title><link rel="icon" href="/images/logo.png">
<style>body{margin:0;background:#FBF8F1;color:#15130F;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:#0F1A34;padding:14px 20px;display:flex;align-items:center;gap:14px}header img{height:40px;background:#FBF8F1;border-radius:6px;padding:3px}
header a{margin-left:auto;color:#DAA336;text-decoration:none;font-weight:600}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}h1{font-family:Georgia,serif;font-weight:400;font-size:2.1rem;margin:0 0 6px}
.meta{color:#6F6757;margin:0 0 18px}${policyComplete() ? "" : ".draft{background:#FBE3D9;color:#8A2D14;border-radius:10px;padding:10px 14px;margin:0 0 18px}"}</style></head>
<body><header><a href="/"><img src="/images/logo@2x.png" alt="Ace Fares"></a><a href="/">Back to rentals</a></header>
<main><h1>Rental Agreement</h1><p class="meta">Ace Fares Rental Company, Dallas, Texas. Version ${AGREEMENT_VERSION}.</p>
${policyComplete() ? "" : `<p class="draft">Draft: some terms are still being finalized.</p>`}
${agreementHTML(null)}</main></body></html>`;
}
