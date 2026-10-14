// Ace Fares rental agreement: one source for the web page (/rental-agreement),
// the confirmation email, the checkout clickwrap, and the signature fingerprint.
// DRAFT FOR REVIEW: this is a starting template, not legal advice. Have a Texas
// attorney review it before relying on it. Fill in the POLICY values marked null.
import { createHash } from "node:crypto";
import { CARS, LOCATIONS, TAX, DEPOSITS, SMOKING_FEE, DEPOSIT_LEAD_HOURS, DEPOSIT_RELEASE_HOURS, MIN_AGE, EXTENSION_DAILY_FEE } from "./catalog.mjs";

// Change this whenever the wording changes. Checkout refuses a signature on an older version.
export const AGREEMENT_VERSION = "2026-10-14-draft10";

// Values the owner sets. null shows as "[to be set]" so nothing is invented.
export const POLICY = {
  minAge: MIN_AGE,
  extraMileRates: Object.fromEntries(Object.entries(CARS).map(([k, c]) => [k, c.extraMile])),   // $ per mile over, per car (catalog.mjs)
  lateGraceMinutes: 30,
  lateFee: 50,                  // flat fee after the grace period, plus the daily rate for each extra day late
  fuelServiceFee: 30,           // plus the cost of fuel
  cleaningFee: 30,              // excessive dirt, sand, stains or pet hair
  smokingFee: SMOKING_FEE,      // set in catalog.mjs
  ticketAdminFee: 15,           // handling fee for each toll or ticket we process (null = none)
  extensionDailyFee: EXTENSION_DAILY_FEE, // $ per extra day on top of the daily rate when a trip is extended
  cancellationFee: 20,          // cancelling more than 24 hours after booking
  cancellationPolicy: "You can cancel for a full refund within 24 hours after you book. After that, cancellations are refunded minus a $20 cancellation fee",
  outOfStateAllowed: false,
};

export const BUSINESS = { name: "Ace Fares Rental Company", city: "Dallas, Texas", phone: "(972) 994-6413", email: "acefaresrental@gmail.com", venueCounty: "Dallas County" };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TBD = "[to be set]";
const money = n => (n == null ? TBD : "$" + Number(n).toFixed(2).replace(/\.00$/, ""));
const val = v => (v == null ? TBD : v);
/** "$3 per mile for the 2021 Cadillac Escalade and $0.99 per mile for all other vehicles" */
export function extraMileList() {
  const by = {}; for (const c of Object.values(CARS)) (by[c.extraMile] ||= []).push(c.name);
  const groups = Object.entries(by).sort((a, b) => a[1].length - b[1].length);
  if (groups.length === 1) return `${money(Number(groups[0][0]))} per mile`;
  return groups.map(([rate, names], i) => `${money(Number(rate))} per mile for ${i === groups.length - 1 ? "all other vehicles" : "the " + names.join(" and the ")}`).join(" and ");
}
export const policyComplete = () => Object.entries(POLICY).every(([k, v]) => k === "ticketAdminFee" || v !== null);

const niceDate = s => s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
const t12 = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const depositList = () => Object.entries(DEPOSITS).map(([k, v]) => `${CARS[k].name}: ${money(v)}`).join("; ");

/** The words next to the checkbox at checkout. Same text is fingerprinted with the signature. */
// Short, Turo-style line next to the checkbox. The checkout page turns the named documents into links
// (CLICKWRAP_LINKS). The key terms box right above it shows the deposit amount and smoking fee in full.
export function clickwrapText({ total } = {}) {
  return `I agree to pay the total shown${total ? ` (${total})` : ""} and to the Ace Fares Rental Agreement, including the security deposit hold, ` +
    `no-smoking policy and cancellation policy. I agree to sign and receive records electronically, and I acknowledge the privacy policy.`;
}
export const CLICKWRAP_LINKS = [
  ["Ace Fares Rental Agreement", "/rental-agreement"],
  ["security deposit hold", "/rental-agreement#section-5"],
  ["no-smoking policy", "/rental-agreement#section-12"],
  ["cancellation policy", "/rental-agreement#section-15"],
  ["sign and receive records electronically", "/rental-agreement#section-2"],
  ["privacy policy", "/privacy.html"],
];

/** The agreement as sections of [heading, [paragraphs]]. booking is optional (fills in renter and trip details).
 *  A paragraph starting with "!" is shown in bold capitals (conspicuous terms). */
export function agreementSections(booking) {
  const b = booking || {}, c = b.customer || {}, car = CARS[b.car], loc = LOCATIONS[b.location];
  const dep = DEPOSITS[b.car];
  return [
    ["1. Parties, vehicle and direct rental", [
      `This Rental Agreement ("Agreement") is a direct vehicle lease between ${BUSINESS.name} of ${BUSINESS.city} ("Ace Fares", "Lessor", "we", "us"), as the owner and lessor of the vehicle, and the renter named below ("Renter", "Lessee", "you"), as the lessee.`,
      `Ace Fares owns the vehicle or has the legal right to rent it, and rents it to you directly. Ace Fares is not a peer-to-peer car sharing platform, broker or marketplace, and no third-party host is a party to this Agreement. You receive the right to use the vehicle for the rental period only and no ownership interest in it.`,
      booking ? `Renter: ${c.name || ""}${c.email ? ", " + c.email : ""}${c.phone ? ", " + c.phone : ""}.` : `Renter: the person who books and pays through the Ace Fares website.`,
      booking ? `Vehicle: ${car ? car.name : b.car}. Rental period: ${niceDate(b.from)} at ${t12(b.fromTime)} to ${niceDate(b.to)} at ${t12(b.toTime)} (Central Time). Handoff: ${loc ? loc.name : ""}.` : `Vehicle, rental period and handoff location: as shown in your booking confirmation.`,
    ]],
    ["2. Electronic signature and records", [
      `You sign this Agreement electronically by checking the agreement box at checkout and pressing Book trip. You agree that your electronic signature has the same legal effect as a handwritten signature, as provided by the Texas Uniform Electronic Transactions Act (Texas Business and Commerce Code, Chapter 322) and the federal E-SIGN Act (15 U.S.C. section 7001 and following).`,
      `You consent to receive this Agreement, receipts, notices and other records about your rental electronically, by email and on our website. You may ask for a free paper copy at any time, and you may withdraw this consent for future records, by emailing ${BUSINESS.email}. To receive electronic records you need internet access and an email account.`,
      `When you sign, we record the date and time, your IP address, your browser, the version of this Agreement and a digital fingerprint (SHA-256) of the exact text you agreed to, and we store that record with your booking and your payment.`,
    ]],
    ["3. Who may drive", [
      `You must be at least ${POLICY.minAge} years old and hold a valid driver's license. Only you may drive the vehicle unless we approve another driver in writing before the trip. Anyone who drives must meet the same requirements, and you are responsible for anyone you allow to drive.`,
      `Identity check. Within 1 hour after you book, and in any case before handoff, you must complete our online identity check: photos of the front and back of your driver's license and a selfie, checked by our verification provider, Stripe, as explained on the verification page, where you consent to it separately. The license must be valid for the whole trip, and its name and photo must match you and this booking. If you do not complete the check, or it does not pass and you cannot prove your identity to us in person at handoff, we may refuse handoff and the cancellation policy in section 15 applies.`,
    ]],
    ["4. Payment, taxes and saved card", [
      `You paid the trip total shown at checkout, which includes the daily rate for each day (weekday and weekend rates may differ), any discount, any delivery fee, and the ${TAX.label} (${TAX.shortPct}% for rentals of ${TAX.shortMaxDays} days or less, ${TAX.longPct}% for longer rentals).`,
      `You authorize Ace Fares to save the payment method you used at checkout with our payment processor, Stripe, and to use it for the security deposit hold (section 5) and for any amounts you owe under this Agreement. Charges that can only be known after the trip, such as extra miles, fuel, tolls, tickets, late return, cleaning, smoking or damage, are due when we send you an itemized statement.`,
    ]],
    ["5. Security deposit hold", [
      `Amount. A refundable security deposit is required for every rental: ${dep ? money(dep) + " for this vehicle" : depositList()}. It is a temporary authorization hold on your card, not a charge. The held funds are not available to you while the hold is in place (on a debit card, this reduces your available bank balance), but they are not taken from your account unless you owe us money under this Agreement.`,
      `When it is placed. We place the hold through Stripe on the card you paid with: right after you pay if pickup is less than ${DEPOSIT_LEAD_HOURS} hours away, otherwise about ${DEPOSIT_LEAD_HOURS} hours before pickup. Card holds expire after about 7 days (up to 30 days on some cards), so for longer rentals you authorize us to place a new hold for the same amount when an earlier one is about to expire.`,
      `If the hold can't be placed. If your card declines the hold or needs your approval, you must provide another acceptable card before handoff. If no deposit can be secured, we may refuse handoff and cancel the rental, and the cancellation policy in section 15 applies.`,
      `When it is released. After the vehicle is returned, we inspect it. If you owe nothing, we release the full hold within ${DEPOSIT_RELEASE_HOURS} hours after the scheduled return time. Once we release it, your bank removes the hold from your account. Most banks do this within a few business days, but some take up to 10 business days; that timing is controlled by your bank, not by Ace Fares. A hold that expires on its own is removed the same way.`,
      `Charges from the deposit. We may collect all or part of the hold for amounts you owe under this Agreement, including the smoking fee (section 12), cleaning, fuel, extra miles, late return, tolls, tickets and damage. We will send you an itemized statement, with photos where relevant, when we collect. Any part we do not collect is released. The deposit is not a limit on what you owe: if you owe more than the deposit, we will charge the balance to your card on file or bill you for it.`,
    ]],
    ["6. Insurance verification", [
      `You must have a personal auto liability insurance policy that is in force for the entire rental, covers you while driving a rented vehicle, and provides at least the minimum liability limits required by Texas law (currently $30,000 per injured person, $60,000 per accident for injuries, and $25,000 for property damage; Texas Transportation Code section 601.072). We strongly recommend collision and comprehensive coverage that extends to rental vehicles. If you will drive for a rideshare or delivery platform, the extra insurance requirements in section 13 also apply.`,
      `Before handoff you must show a current insurance card or declarations page in your name. You authorize us to contact your insurer or agent to confirm your coverage. If you cannot show proof, or your coverage cannot be confirmed, we may refuse handoff and the cancellation policy in section 15 applies.`,
      `Ace Fares does not sell you insurance or a damage waiver, and this Agreement does not give you any insurance coverage. Any insurance Ace Fares carries is for Ace Fares' protection, except where the law requires otherwise. To the extent permitted by law, your insurance is primary for any loss, damage or injury arising from the rental. Coverage offered by a credit card is usually secondary and may exclude some vehicles; check with your card issuer before you rely on it.`,
    ]],
    ["7. Responsibility for the vehicle and liability", [
      `From handoff until we take the vehicle back, you are responsible for the vehicle and for all loss of or damage to it, whatever the cause and whoever is at fault, including collision, theft, vandalism, hail and flood. To the extent permitted by Texas law, this includes the reasonable cost of repair (or the vehicle's fair market value if it is a total loss or not recovered), towing and storage, appraisal, and the rental income we lose while the vehicle is out of service (loss of use). You are also responsible for injury to people or damage to property caused by your use of the vehicle, to the extent not paid by insurance.`,
      `!Indemnity. To the fullest extent permitted by Texas law, you agree to defend, indemnify and hold harmless Ace Fares and its owners and employees from all claims, losses, fines, costs and reasonable attorney's fees arising from your use of the vehicle, or its use by any driver you allow, except to the extent caused by Ace Fares' own negligence or willful misconduct.`,
      `Ace Fares is not responsible for personal property left in the vehicle, or for indirect or consequential losses such as missed travel or lost earnings, except where the law does not allow this limit. Nothing in this Agreement waives rights you have that cannot be waived under Texas law, including under the Texas Deceptive Trade Practices-Consumer Protection Act.`,
    ]],
    ["8. Mileage", [
      `Each day includes ${car ? car.miles : "the"} miles${car ? "" : " shown on the listing"}. Miles beyond the total included for your trip are charged at ${car ? `${money(car.extraMile)} per mile` : extraMileList()}.`,
    ]],
    ["9. Fuel", [
      `Return the vehicle with the same fuel level as at pickup. Otherwise you pay the cost of fuel plus a ${money(POLICY.fuelServiceFee)} service fee.`,
    ]],
    ["10. Late return", [
      `Return the vehicle on time. After a ${val(POLICY.lateGraceMinutes)}-minute grace period, a ${money(POLICY.lateFee)} late fee applies. If the vehicle is more than 24 hours late, you also pay the daily rate for each additional day or part day. A vehicle not returned and not extended with our agreement may be reported stolen.`,
      `Extending your trip. To keep the vehicle longer, request an extension in My trips on our website (or contact us) before your scheduled return. Extensions depend on availability and need our approval. Each extra day costs that day's daily rate plus a ${money(POLICY.extensionDailyFee)} extension fee, plus tax, and is charged to your card on file when we approve it. Until we approve, your original return time stands.`,
    ]],
    ["11. Tolls, tickets and fines", [
      `Tolls. You pay every toll charged to the vehicle during your rental, including NTTA (TollTag and ZipCash) and TxTag tolls. If the vehicle has a toll tag, we charge the tolls at cost to your card on file after the trip, with an itemized statement. If a toll authority bills us by mail instead, we may give it your name, address and a copy of this Agreement, and it will then bill you directly as the law allows (for example, Texas Transportation Code sections 366.178 and 228.055), or we may pay the toll and charge you.`,
      `Tickets and fines. You are responsible for all parking and traffic tickets, fines, impound, towing and storage charges incurred during your rental. We may transfer a ticket to you by giving the issuing authority your name, address and this Agreement, or pay it and charge your card on file with a copy of the ticket.${POLICY.ticketAdminFee != null ? ` A ${money(POLICY.ticketAdminFee)} handling fee applies to each toll or ticket we process.` : ""}`,
    ]],
    ["12. No smoking or vaping: zero tolerance", [
      `!Smoking or vaping anything in the vehicle, by anyone, at any time during your rental, is prohibited. This includes cigarettes, cigars, marijuana, e-cigarettes and vapes, even with the windows open.`,
      `If we find any evidence of smoking or vaping when the vehicle is returned, including smoke or vapor odor, ash, cigarette or cigar butts, rolling papers, vape devices or cartridges, or burn marks, a smoking remediation fee of ${money(SMOKING_FEE)} applies. This fee is not negotiable. It is a pre-agreed amount reflecting the reasonable cost of odor treatment, deep cleaning and the time the vehicle is out of service, which are hard to measure exactly for each rental; it is not a penalty.`,
      `We will notify you within 48 hours after return, with dated photos and a description of what we found. You authorize us to collect the fee from your security deposit hold or your card on file. Burn holes, stains or other damage are charged separately under section 7.`,
    ]],
    ["13. Rules of use", [
      `No pets unless we agree in advance. No racing, off-road driving or towing. Do not drive under the influence of alcohol or drugs, and do not use the vehicle for anything illegal. ${POLICY.outOfStateAllowed == null ? "Travel outside Texas: " + TBD + "." : POLICY.outOfStateAllowed ? "Travel outside Texas is allowed." : "Do not take the vehicle outside Texas without our written permission."}`,
      `Gig work is allowed. You may use the vehicle to drive for rideshare, delivery and similar app-based gig platforms, such as Uber, Lyft, DoorDash, Uber Eats, Grubhub, Instacart, Amazon Flex and Walmart Spark, on these conditions:`,
      `(a) Only you, the Renter named in this Agreement, may do gig work in the vehicle, and only on platforms that have approved you as a driver. You may not let anyone else drive the vehicle for gig work.`,
      `(b) You must follow each platform's rules, including its requirements for vehicles, rentals and insurance. Whether a platform accepts this vehicle is up to the platform; if it does not, that is not a reason for a refund or an early-return credit.`,
      `(c) Insurance for gig work:`,
      `!Most personal auto policies do not cover driving for pay. Whenever the platform app is on, you must be covered by the platform's insurance and by your own policy with a rideshare or delivery endorsement, or by commercial auto coverage, at no less than the limits in section 6. If any loss is not covered, you are personally responsible for it under section 7.`,
      `(d) Everything else in this Agreement applies during gig work, including the daily mileage limit and extra-mile charges, the cleaning fee and the no-smoking policy. Spilled food or drink, odors and debris left by passengers or deliveries are not normal wear. You are responsible for all tolls, parking and traffic tickets incurred while doing gig work.`,
      `(e) Ace Fares is not a party to your agreement with any platform, does not employ you, and does not receive any of your earnings. You are responsible for your own taxes and platform obligations.`,
      `(f) Commercial uses other than app-based gig work are not allowed without our written permission. These include limousine, charter or private-hire service outside a platform app, carrying goods for a business, subrenting the vehicle, and listing it on car-sharing sites such as Turo or Getaround.`,
    ]],
    ["14. Condition, cleaning, accidents and breakdowns", [
      `At pickup and at return, you and Ace Fares each take photos of the vehicle on our website: all four sides, the odometer, the fuel gauge and the interior, plus close-ups of any damage, and record the mileage and fuel level. The photos are time-stamped and stored, can't be changed once submitted, and are the record of the vehicle's condition, mileage and fuel for this rental. If you don't take your photos, our photos and readings are used. Return the vehicle in the same condition, apart from normal wear. Excessive dirt, sand, stains or pet hair is charged a cleaning fee of ${money(POLICY.cleaningFee)}.`,
      `If there is an accident, theft or damage, contact the police if required and tell us right away at ${BUSINESS.phone}. Do not admit fault or arrange repairs yourself. If the vehicle breaks down through no fault of yours, we will work with you on a fix, a replacement or a prorated refund.`,
    ]],
    ["15. Cancellations and changes", [
      `Cancellation policy: ${val(POLICY.cancellationPolicy)}. You can cancel in My trips on our website any time before your pickup time, or by contacting us. Refunds go back to the payment method you used, and any security deposit hold is released. Once your pickup time has passed, the trip can't be cancelled; see section 16 for ending a rental early. To change your dates, request it in My trips at least 2 hours before pickup, or contact us. Changes depend on availability and our approval. If the new dates cost more, the difference is charged to your card on file when we approve; if they cost less, we refund the difference.`,
    ]],
    ["16. Ending the rental early", [
      `We may end this rental and recover the vehicle if you break this Agreement, use the vehicle illegally or unsafely, fail to keep the required insurance, or gave us false information. You remain responsible for charges incurred.`,
    ]],
    ["17. Governing law and venue", [
      `This Agreement is governed by the laws of the State of Texas. To the extent permitted by law, any lawsuit about this Agreement or the rental must be brought in the state courts located in ${BUSINESS.venueCounty}, Texas, including the justice courts for small claims, and both parties agree to venue there. This does not waive any right Texas law gives you to be sued in the county where you live or where you signed this Agreement.`,
    ]],
    ["18. General", [
      `If any part of this Agreement is found unenforceable, the rest still applies. Our not enforcing a term is not a waiver of it. You may not transfer this Agreement or sublet the vehicle. This Agreement, your booking confirmation and the vehicle listing are the whole agreement between us. We send notices to the email and phone number you gave at checkout; you can reach us at ${BUSINESS.phone} or ${BUSINESS.email}.`,
    ]],
  ];
}

/** SHA-256 of the exact agreement text a renter signed (with their trip filled in) plus the clickwrap words. */
export function agreementFingerprint(booking, clickwrap) {
  return createHash("sha256").update(agreementText(booking) + "\n\n" + (clickwrap || "")).digest("hex");
}

const loud = p => p.startsWith("!");
export function agreementHTML(booking) {
  return agreementSections(booking).map(([h, ps]) => `<h3 id="section-${parseInt(h, 10)}" style="font-size:16px;margin:18px 0 6px;scroll-margin-top:16px">${esc(h)}</h3>${ps.map(p => loud(p)
    ? `<p style="margin:0 0 8px;line-height:1.55;font-weight:700;text-transform:uppercase">${esc(p.slice(1))}</p>`
    : `<p style="margin:0 0 8px;line-height:1.55">${esc(p)}</p>`).join("")}`).join("");
}
export function agreementText(booking) {
  return agreementSections(booking).map(([h, ps]) => `${h}\n${ps.map(p => loud(p) ? p.slice(1).toUpperCase() : p).join("\n")}`).join("\n\n");
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
