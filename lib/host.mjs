// "Become a host" form: emails the application to the business inbox (OWNER_EMAIL, or the Gmail the site
// sends from), with Reply-To set to the applicant so the owner can answer directly. A copy is also kept
// in the site's storage (host-app-<time>-<id>) so nothing is lost if email isn't set up or fails.
import { randomBytes, createHash } from "node:crypto";
import { getJSON } from "./kv.mjs";
import { simpleEmail } from "./trips.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_HOUR = 5;

export function hostHandler({ store, mailer = null, now = () => Date.now(), log = console }) {
  return async (req, ctx) => {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const url = new URL(req.url), o = req.headers.get("origin");
    if (o && new URL(o).host !== url.host) return json({ error: "bad_origin" }, 403);
    try {
      const raw = await req.text();
      if (raw.length > 6000) return json({ error: "too_large", message: "That's too long. Please shorten your message." }, 413);
      let b; try { b = JSON.parse(raw || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); }
      if (clean(b.website, 200)) return json({ ok: true, emailed: true });      // honeypot field humans never see: quietly drop bots
      const app = { name: clean(b.name, 100), phone: clean(b.phone, 40), email: clean(b.email, 200).toLowerCase(), car: clean(b.car, 120), miles: clean(b.miles, 40), note: clean(b.note, 2000) };
      const bad = app.name.length < 2 ? ["name", "Enter your name."] : app.phone.replace(/\D/g, "").length < 7 ? ["phone", "Enter a phone number."]
        : app.email && !EMAIL_RE.test(app.email) ? ["email", "Enter a valid email address, or leave it blank."] : app.car.length < 3 ? ["car", "Tell us which car."] : null;
      if (bad) return json({ error: "bad_" + bad[0], field: bad[0], message: bad[1] }, 400);

      // a few per hour from one network, so the inbox can't be flooded
      const ip = (ctx && ctx.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
      const tk = `host-throttle-${createHash("sha256").update(ip).digest("hex").slice(0, 24)}-${Math.floor(now() / 3600e3)}`;
      const n = ((await getJSON(store, tk)) || {}).n || 0;
      if (n >= PER_HOUR) return json({ error: "too_many", message: "We've received several forms from you. Please text or call us instead." }, 429);
      await store.setJSON(tk, { n: n + 1 });

      const at = new Date(now()).toISOString(), id = `host-app-${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
      const rec = { ...app, at, ip };
      let emailed = false;
      const to = mailer && mailer.ownerEmail;
      if (to) {
        try {
          await mailer.send({ to, ...(app.email ? { replyTo: app.email } : {}), subject: `New host application: ${app.car} (${app.name})`,
            ...simpleEmail("Someone wants to host their car", [
              `${app.name} filled out the Become a host form on your website.${app.email ? " Reply to this email to answer them directly." : ""}`,
            ], [["Name", app.name], ["Phone", app.phone], ["Email", app.email || "not given"], ["Car", app.car], ["Mileage", app.miles || "not given"], ["Notes", app.note || "none"], ["Sent", new Date(now()).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })]]) });
          emailed = true;
        } catch (e) { log.error("[host] application email failed", e && e.message); rec.emailError = String(e && e.message || e).slice(0, 200); }
      }
      await store.setJSON(id, { ...rec, emailed });
      return json({ ok: true, emailed });
    } catch (e) {
      log.error("[host] error", e);
      return json({ error: "server_error", message: "Something went wrong. Please text or call us instead." }, 500);
    }
  };
}
