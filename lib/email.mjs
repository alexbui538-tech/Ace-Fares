// Booking confirmation email with the rental agreement.
// Sent from the business Gmail through Google's SMTP using an App Password
// (GMAIL_USER, GMAIL_APP_PASSWORD). OWNER_EMAIL optionally gets a copy.
import { CARS, LOCATIONS, DEPOSITS, DEPOSIT_RELEASE_HOURS, SMOKING_FEE, IDENTITY_DUE_MINUTES } from "./catalog.mjs";
import { agreementHTML, agreementText } from "./agreement.mjs";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const niceDate = s => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const t12 = t => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const money = c => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function confirmationEmail(car, booking, siteUrl) {
  const c = booking.customer || {}, carName = CARS[car] ? CARS[car].name : car, loc = LOCATIONS[booking.location];
  const b = { ...booking, car };
  const first = (c.name || "").split(" ")[0] || "there";
  const rows = [
    ["Car", carName],
    ["Pickup", `${niceDate(b.from)}, ${t12(b.fromTime)}`],
    ["Return", `${niceDate(b.to)}, ${t12(b.toTime)}`],
    ["Where", loc ? loc.name : b.location],
    ["Paid", b.amountPaid ? money(b.amountPaid) : ""],
    ["Deposit hold", DEPOSITS[car] ? `$${DEPOSITS[car]} refundable hold on your card, ${b.deposit && b.deposit.status === "held" ? "placed now" : "placed about 24 hours before pickup"}; released within ${DEPOSIT_RELEASE_HOURS} hours after return if nothing is owed` : ""],
    ["No smoking", `Zero tolerance: $${SMOKING_FEE} fee for any sign of smoking or vaping`],
    ["Your Ace Fares account", booking.accountCreatedAtCheckout ? `We created an account for ${c.email || booking.accountEmail || "you"} so you can see your trip and verify your license. To log in later, choose Log in on our site and we'll email you a link to set your password (or use Continue with Google).` : ""],
    ["Verify your license", `Required within ${IDENTITY_DUE_MINUTES} minutes of booking (about 2 minutes): ${siteUrl}/verify.html?car=${car}&ref=${booking.id}`],
  ].filter(r => r[1]);
  const sig = booking.signature;
  const sigRows = sig ? [
    ["Signed electronically", new Date(sig.signedAt).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "long" })],
    ["Signer", `${c.name || ""}, IP address ${sig.ip}`],
    ["Agreement version", sig.agreementVersion],
    ["Document fingerprint (SHA-256)", sig.sha256],
  ] : [];
  const subject = `Booking confirmed: ${carName}, ${niceDate(b.from)} to ${niceDate(b.to)}`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#15130F;max-width:640px;margin:0 auto">
  <div style="background:#0F1A34;color:#F4EFE4;padding:16px 20px;border-radius:12px 12px 0 0"><strong style="color:#DAA336">Ace Fares</strong> Rental Company</div>
  <div style="background:#FBF8F1;padding:22px 20px;border:1px solid #E4DCCB;border-top:0;border-radius:0 0 12px 12px">
    <h2 style="margin:0 0 8px;font-family:Georgia,serif;font-weight:400">You're booked, ${esc(first)}!</h2>
    <p style="margin:0 0 16px">Thanks for booking with Ace Fares. We'll text you to set up the handoff.</p>
    <table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #E4DCCB;border-radius:10px">
      ${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:#6F6757;border-top:1px solid #E4DCCB">${esc(k)}</td><td style="padding:8px 12px;font-weight:600;border-top:1px solid #E4DCCB">${esc(v)}</td></tr>`).join("")}
    </table>
    <p style="margin:16px 0 4px"><strong>Bring to the handoff:</strong> your driver's license, proof of auto insurance, and the card you paid with.</p>
    <p style="margin:0 0 16px">Questions or changes? Text or call <a href="tel:+19729946413">(972) 994-6413</a> or reply to this email.</p>
    <h2 style="margin:24px 0 4px;font-family:Georgia,serif;font-weight:400">Your rental agreement</h2>
    <p style="margin:0 0 8px;color:#6F6757">You agreed to these terms when you booked. Keep this email for your records. Also online at <a href="${esc(siteUrl)}/rental-agreement">${esc(siteUrl.replace(/^https?:\/\//, ""))}/rental-agreement</a>.</p>
    ${agreementHTML(b)}
    ${sigRows.length ? `<h3 style="font-size:16px;margin:22px 0 6px">Signature record</h3><table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #E4DCCB;font-size:13px">
      ${sigRows.map(([k, v]) => `<tr><td style="padding:6px 10px;color:#6F6757;border-top:1px solid #E4DCCB">${esc(k)}</td><td style="padding:6px 10px;border-top:1px solid #E4DCCB;word-break:break-all">${esc(v)}</td></tr>`).join("")}
    </table><p style="font-size:13px;color:#6F6757">You agreed: "${esc(sig.clickwrap)}"</p>` : ""}
  </div></div>`;
  const text = `You're booked, ${first}!\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nBring your driver's license, proof of auto insurance and the card you paid with.\nQuestions: (972) 994-6413\n\nYOUR RENTAL AGREEMENT\n\n${agreementText(b)}\n${sigRows.length ? `\nSIGNATURE RECORD\n${sigRows.map(([k, v]) => `${k}: ${v}`).join("\n")}\nYou agreed: "${sig.clickwrap}"\n` : ""}`;
  return { subject, html, text };
}

/** "New booking" alert for the business inbox. */
export function ownerBookingEmail(car, b, siteUrl) {
  const c = b.customer || {}, carName = CARS[car] ? CARS[car].name : car, loc = LOCATIONS[b.location];
  const ins = b.insurance ? (b.insurance.choice === "roamly" ? "Getting Roamly coverage" : `Own insurance: ${b.insurance.company || ""}${b.insurance.policy ? `, policy ${b.insurance.policy}` : ""}`) : "";
  const rows = [
    ["Car", carName],
    ["Pickup", `${niceDate(b.from)}, ${t12(b.fromTime)}`],
    ["Return", `${niceDate(b.to)}, ${t12(b.toTime)}`],
    ["Where", loc ? loc.name : b.location],
    ["Renter", c.name || b.accountName || ""],
    ["Phone", c.phone || ""],
    ["Age", c.age ? (c.age === "25+" ? "25 or older" : c.age) : ""],
    ["Email", c.email || b.accountEmail || ""],
    ["Paid", b.amountPaid ? money(b.amountPaid) : ""],
    ["Credits used", (b.credits || []).map(x => `${x.label} ${money(x.amount)}`).join(", ")],
    ["Insurance", ins],
    ["Deposit hold", DEPOSITS[car] ? `$${DEPOSITS[car]}, ${b.deposit && b.deposit.status === "held" ? "placed" : "goes on about 24 hours before pickup"}` : ""],
    ["Booking ref", b.id],
  ].filter(r => r[1]);
  const photos = `${siteUrl}/inspect.html?car=${car}&ref=${b.id}&as=host`;
  const subject = `New booking: ${carName}, ${niceDate(b.from)} to ${niceDate(b.to)}${c.name ? ` (${c.name})` : ""}`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#15130F;max-width:600px">
  <h2 style="margin:0 0 10px">New booking 🎉</h2>
  <table style="border-collapse:collapse;width:100%;border:1px solid #E4DCCB">${rows.map(([k, v]) => `<tr><td style="padding:7px 10px;color:#6F6757;border-top:1px solid #E4DCCB">${esc(k)}</td><td style="padding:7px 10px;font-weight:600;border-top:1px solid #E4DCCB">${esc(v)}</td></tr>`).join("")}</table>
  <p style="margin:14px 0 6px"><a href="${esc(siteUrl)}/admin.html">Open your bookings page</a> · <a href="${esc(photos)}">Your pickup photos for this trip</a></p>
  <p style="margin:0;color:#6F6757;font-size:13px">The renter has been emailed their confirmation and rental agreement.</p></div>`;
  const text = `New booking\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nBookings page: ${siteUrl}/admin.html\nYour pickup photos: ${photos}\n`;
  return { subject, html, text };
}

export function gmailMailer({ user, pass, ownerEmail }) {
  let transport;
  return {
    ownerEmail: ownerEmail || user,      // gets the "New booking" alert
    async send({ to, subject, html, text }) {
      if (!transport) {
        const nodemailer = (await import("nodemailer")).default;
        transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
      }
      return transport.sendMail({ from: `"Ace Fares Rental" <${user}>`, replyTo: user, to, subject, html, text });
    },
  };
}
