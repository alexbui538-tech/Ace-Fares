// Booking confirmation email with the rental agreement.
// Sent from the business Gmail through Google's SMTP using an App Password
// (GMAIL_USER, GMAIL_APP_PASSWORD). OWNER_EMAIL optionally gets a copy.
import { CARS, LOCATIONS } from "./catalog.mjs";
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
  ].filter(r => r[1]);
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
  </div></div>`;
  const text = `You're booked, ${first}!\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nBring your driver's license, proof of auto insurance and the card you paid with.\nQuestions: (972) 994-6413\n\nYOUR RENTAL AGREEMENT\n\n${agreementText(b)}\n`;
  return { subject, html, text };
}

export function gmailMailer({ user, pass, ownerEmail }) {
  let transport;
  return {
    async send({ to, subject, html, text }) {
      if (!transport) {
        const nodemailer = (await import("nodemailer")).default;
        transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
      }
      return transport.sendMail({ from: `"Ace Fares Rental" <${user}>`, replyTo: user, to, bcc: ownerEmail || undefined, subject, html, text });
    },
  };
}
