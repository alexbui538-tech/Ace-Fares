// Owner tools on the bookings page (/api/admin/tools, admin key required):
//  - blocked dates (repairs, personal use): stored as a "blocked" entry in the car's booking list
//  - prices and deposits (lib/catalog.mjs applies them)
//  - monthly sales and tax report, and an export of every booking (CSV for Excel/Google Sheets, or a full JSON backup)
//  - vehicle records: mileage from trip photos, oil change / inspection / registration / insurance dates,
//    with an email to the owner when something is coming due
import { randomUUID } from "node:crypto";
import { CARS, LOCATIONS, TAX, TIMEZONE, PRICE_DEFAULTS, applyPrices, currentPrices, loadPriceOverrides } from "./catalog.mjs";
import { makeRepo, isActive, clashes } from "./bookings.mjs";
import { isValidDate, daysBetween, niceDate } from "./pricing.mjs";
import { getJSON, updateJSON } from "./kv.mjs";
import { simpleEmail } from "./trips.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const keyOk = (req, adminKey) => {
  const got = req.headers.get("x-admin-key") || "";
  if (!adminKey || got.length !== adminKey.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ adminKey.charCodeAt(i);
  return diff === 0;
};
class ToolError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const DAY = 864e5;

/* ---------- CSV ---------- */
export function csv(rows) {
  const cell = v => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;      // stop spreadsheet formula injection from renter-typed text
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
const dollars = c => (c / 100).toFixed(2);
/** YYYY-MM-DD in Dallas time */
const day = ms => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/* ---------- monthly sales and tax report ---------- */
const taxPctFor = days => (days <= TAX.shortMaxDays ? TAX.shortPct : TAX.longPct);
const taxIn = (total, pct) => total - Math.round(total / (1 + pct / 100));   // tax inside a tax-included total

/** Every money movement dated in the month (Dallas time): payments, extensions, date changes, charges, refunds. Cents. */
export function monthEntries(byCar, month) {
  const out = [];
  const inMonth = iso => iso && day(Date.parse(iso)).startsWith(month);
  for (const [car, list] of Object.entries(byCar)) for (const b of list) {
    if (!["confirmed", "cancelled", "conflict"].includes(b.status) || !b.confirmedAt) continue;
    const who = (b.customer && b.customer.name) || b.accountName || "", trip = `${b.from} to ${b.to}`;
    const base = { car: CARS[car] ? CARS[car].name : car, renter: who, ref: b.id, trip };
    const changeRefunds = (b.adjustments || []).filter(a => a.amount < 0).reduce((s, a) => s - a.amount, 0);
    const paid = (b.amountPaid || b.total || 0) + changeRefunds;                 // the original rental payment
    const days0 = b.change && b.change.was ? daysBetween(b.change.was.from, b.change.was.to) : daysBetween(b.from, b.to);
    const pct = taxPctFor(days0), fee = ((LOCATIONS[b.location] || {}).fee || 0) * 100;
    const ratio = paid ? taxIn(paid, pct) / paid : 0;
    if (inMonth(b.confirmedAt) && paid) {
      const tax = taxIn(paid, pct);
      out.push({ date: day(Date.parse(b.confirmedAt)), type: "Rental payment", ...base, taxable: paid - tax, fee, charges: 0, tax, total: paid, note: (b.credits || []).length ? "Credits: " + b.credits.map(c => `${c.label} $${dollars(c.amount)}`).join("; ") : "" });
    }
    for (const e of b.extensions || []) if (inMonth(e.approvedAt)) {
      const tax = taxIn(e.amount, pct);
      out.push({ date: day(Date.parse(e.approvedAt)), type: "Trip extension", ...base, taxable: e.amount - tax, fee: 0, charges: 0, tax, total: e.amount, note: `${e.from} to ${e.to}` });
    }
    for (const a of b.adjustments || []) if (inMonth(a.at)) {
      const tax = Math.round(a.amount * ratio);
      out.push({ date: day(Date.parse(a.at)), type: a.amount >= 0 ? "Date change (extra)" : "Date change (refund)", ...base, taxable: a.amount - tax, fee: 0, charges: 0, tax, total: a.amount, note: "" });
    }
    for (const c of b.charges || []) {
      const when = c.status === "paid" ? (c.paidAt || c.at) : null;
      if (when && inMonth(when)) out.push({ date: day(Date.parse(when)), type: `Charge: ${c.label}`, ...base, taxable: 0, fee: 0, charges: c.total, tax: 0, total: c.total, note: [c.note, c.source === "deposit" ? "from deposit" : c.paidVia === "link" ? "paid by link" : ""].filter(Boolean).join("; ") });
    }
    const d = b.deposit;
    if (d && d.status === "captured" && d.capturedAt && inMonth(d.capturedAt) && !(b.charges || []).some(c => c.source === "deposit" && c.status === "paid"))
      out.push({ date: day(Date.parse(d.capturedAt)), type: "Collected from deposit", ...base, taxable: 0, fee: 0, charges: d.capturedAmount || 0, tax: 0, total: d.capturedAmount || 0, note: d.captureNote || "" });
    const x = b.cancellation;
    if (x && x.status === "refunded" && inMonth(x.at) && (x.refund || x.extensionRefund)) {
      const r = (x.refund || 0) + (x.extensionRefund || 0), tax = Math.round((x.refund || 0) * ratio) + taxIn(x.extensionRefund || 0, pct);
      out.push({ date: day(Date.parse(x.at)), type: "Cancellation refund", ...base, taxable: -(r - tax), fee: 0, charges: 0, tax: -tax, total: -r, note: x.fee ? `Cancellation fee kept: $${dollars(x.fee)}` : "" });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function monthSummary(entries) {
  const sum = k => entries.reduce((a, e) => a + (e[k] || 0), 0);
  const trips = new Set(entries.filter(e => e.type === "Rental payment").map(e => e.ref)).size;
  return { trips, gross: sum("total"), taxable: sum("taxable"), tax: sum("tax"), charges: sum("charges"),
    refunds: -entries.filter(e => e.total < 0).reduce((a, e) => a + e.total, 0) };
}

function reportCsv(month, entries, s) {
  const rows = [[`Ace Fares Rental: sales and tax report for ${month}`], ["Amounts in US dollars. Dates in Dallas time. Rental payments include Texas motor vehicle rental tax; the tax column shows the part that is tax. Confirm with your accountant before filing."], [],
    ["Date", "Type", "Car", "Renter", "Booking ref", "Trip", "Rental receipts before tax", "Fees and charges (not taxed)", "Texas rental tax", "Total", "Notes"]];
  for (const e of entries) rows.push([e.date, e.type, e.car, e.renter, e.ref, e.trip, dollars(e.taxable), dollars(e.charges), dollars(e.tax), dollars(e.total), e.note]);
  rows.push([], ["Summary"], ["Trips paid this month", s.trips], ["Rental receipts before tax (net of refunds)", dollars(s.taxable)], ["Texas motor vehicle rental tax collected (net of refunds)", dollars(s.tax)],
    ["Fees and charges after trips", dollars(s.charges)], ["Refunds", dollars(s.refunds)], ["Total received (net)", dollars(s.gross)]);
  return csv(rows);
}

/* ---------- export ---------- */
function exportCsv(byCar) {
  const rows = [["Booking ref", "Car", "Status", "Pickup date", "Pickup time", "Return date", "Return time", "Where", "Delivery address / flight", "Renter", "Email", "Phone", "Age",
    "Insurance", "Paid", "Credits", "Deposit", "Deposit status", "License check", "Extensions", "Charges", "Cancellation", "Booked", "Paid at", "Signed agreement version", "Note"]];
  for (const [car, list] of Object.entries(byCar)) for (const b of [...list].sort((x, y) => (x.from < y.from ? -1 : 1))) {
    const c = b.customer || {}, d = b.deposit || {};
    rows.push([b.id, CARS[car] ? CARS[car].name : car, b.status, b.from, b.fromTime, b.to, b.toTime, (LOCATIONS[b.location] || {}).name || b.location || "",
      b.handoff ? [b.handoff.address, b.handoff.flight].filter(Boolean).join(" ") : "", c.name || b.accountName || "", c.email || b.accountEmail || "", c.phone || "", c.age || "",
      b.insurance ? (b.insurance.choice === "roamly" ? "Roamly" : [b.insurance.company, b.insurance.policy].filter(Boolean).join(" #")) : "",
      b.amountPaid ? dollars(b.amountPaid) : "", (b.credits || []).map(x => `${x.label} ${dollars(x.amount)}`).join("; "),
      d.amount ? dollars(d.amount) : "", d.status || "", (b.verification && b.verification.status) || "",
      (b.extensions || []).map(e => `${e.from}->${e.to} ${dollars(e.amount)}`).join("; "),
      (b.charges || []).map(x => `${x.label} ${dollars(x.total)} ${x.status}`).join("; "),
      b.cancellation ? `${b.cancellation.by} ${b.cancellation.at} refund ${dollars((b.cancellation.refund || 0) + (b.cancellation.extensionRefund || 0))}` : "",
      b.createdAt || "", b.confirmedAt || "", b.agreementVersion || "", b.note || ""]);
  }
  return csv(rows);
}

/* ---------- vehicle records ---------- */
export const SERVICE_DEFAULTS = { oilIntervalMiles: 5000, soonMiles: 500, soonDays: 30 };
const DATE_ITEMS = [["inspectionDue", "State inspection"], ["registrationDue", "Registration"], ["insuranceDue", "Insurance"]];

/** A car's record with the current mileage (from trip photos and the service log) and what's coming due. */
export function vehicleStatus(car, rec, bookings, t) {
  rec = rec || {};
  const readings = [];
  for (const b of bookings || []) for (const st of ["pickup", "return"]) for (const role of ["host", "renter"]) {
    const x = b.inspection && b.inspection[st] && b.inspection[st][role];
    if (x && Number.isFinite(x.odometer)) readings.push({ miles: x.odometer, at: x.at || b.from, source: `${st === "pickup" ? "Pickup" : "Return"} photos, ${b.from}` });
  }
  for (const l of rec.log || []) if (Number.isFinite(l.miles)) readings.push({ miles: l.miles, at: l.date, source: l.text || "Service log" });
  if (Number.isFinite(rec.lastOilMiles)) readings.push({ miles: rec.lastOilMiles, at: rec.lastOilDate || "", source: "Last oil change" });
  const latest = readings.sort((a, b) => b.miles - a.miles)[0] || null;
  const interval = rec.oilIntervalMiles || SERVICE_DEFAULTS.oilIntervalMiles;
  const items = [];
  if (Number.isFinite(rec.lastOilMiles)) {
    const dueAt = rec.lastOilMiles + interval, left = latest ? dueAt - latest.miles : interval;
    items.push({ key: "oil", label: "Oil change", due: `${dueAt.toLocaleString("en-US")} miles`, dueValue: String(dueAt), left: `${left.toLocaleString("en-US")} miles`,
      level: left <= 0 ? "overdue" : left <= SERVICE_DEFAULTS.soonMiles ? "soon" : "ok" });
  } else items.push({ key: "oil", label: "Oil change", due: "", left: "", level: "unknown" });
  for (const [k, label] of DATE_ITEMS) {
    if (!rec[k]) { items.push({ key: k, label, due: "", left: "", level: "unknown" }); continue; }
    const days = Math.ceil((Date.parse(rec[k] + "T12:00:00Z") - t) / DAY);
    items.push({ key: k, label, due: rec[k], dueValue: rec[k], left: days < 0 ? `${-days} days overdue` : `${days} days`, level: days < 0 ? "overdue" : days <= SERVICE_DEFAULTS.soonDays ? "soon" : "ok" });
  }
  const trips = (bookings || []).filter(b => b.inspection && b.inspection.pickup && b.inspection.return);
  const driven = trips.reduce((a, b) => { const p = b.inspection.pickup.host || b.inspection.pickup.renter, r = b.inspection.return.host || b.inspection.return.renter; return a + Math.max(0, (r && p) ? r.odometer - p.odometer : 0); }, 0);
  return { car, name: CARS[car].name, record: { plate: rec.plate || "", vin: rec.vin || "", oilIntervalMiles: interval, lastOilMiles: rec.lastOilMiles ?? null, lastOilDate: rec.lastOilDate || "",
      inspectionDue: rec.inspectionDue || "", registrationDue: rec.registrationDue || "", insuranceDue: rec.insuranceDue || "", notes: rec.notes || "" },
    miles: latest, items, log: (rec.log || []).slice(-20).reverse(), tripsWithPhotos: trips.length, milesDriven: driven };
}

export function makeAdminTools({ store, now = () => Date.now(), notify = null, log = console }) {
  const repo = makeRepo(store, { now });
  const all = async () => { const o = {}; for (const c of Object.keys(CARS)) o[c] = await repo.all(c); return o; };
  const vkey = car => `vehicle-${car}`;

  async function block(car, { from, to, note }) {
    if (!isValidDate(from) || !isValidDate(to) || to < from) throw new ToolError("Choose a start date and an end date (the end can be the same day).");
    if (daysBetween(from, to) > 366) throw new ToolError("Block up to a year at a time.");
    const r = { from, to }, id = "block-" + randomUUID();
    return repo.mutate(car, data => {
      const clash = data.bookings.find(o => isActive(o, now()) && o.status !== "blocked" && clashes(o, r, 0));
      if (clash) throw new ToolError(`That overlaps a trip (${niceDate(clash.from)} to ${niceDate(clash.to)}). Cancel or move the trip first.`, 409);
      const entry = { id, from, to, note: clean(note, 200), status: "blocked", createdAt: new Date(now()).toISOString() };
      data.bookings.push(entry);
      return entry;
    });
  }
  async function unblock(car, id) {
    const out = await repo.change(car, id, x => { if (x.status !== "blocked") return undefined; x.status = "unblocked"; x.unblockedAt = new Date(now()).toISOString(); return x; });
    if (!out) throw new ToolError("That block wasn't found.", 404);
    return out;
  }

  async function setPrices(input) {
    const cars = {}, deposits = {};
    const num = (v, what, min, max) => { const n = Math.round(Number(String(v).replace(/[$,]/g, ""))); if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`${what} must be between $${min} and $${max}.`); return n; };
    for (const k of Object.keys(CARS)) {
      const x = (input.cars || {})[k];
      if (x) cars[k] = { weekday: num(x.weekday, `${CARS[k].name} Mon-Thu price`, 1, 5000), weekend: num(x.weekend, `${CARS[k].name} Fri-Sun price`, 1, 5000) };
      if ((input.deposits || {})[k] !== undefined) deposits[k] = num(input.deposits[k], `${CARS[k].name} deposit`, 0, 10000);
    }
    const saved = await updateJSON(store, "config-prices", cur => ({ cars: { ...((cur || {}).cars || {}), ...cars }, deposits: { ...((cur || {}).deposits || {}), ...deposits }, updatedAt: new Date(now()).toISOString() }));
    applyPrices(saved);
    return currentPrices();
  }
  async function resetPrices() { await store.setJSON("config-prices", { cars: {}, deposits: {}, updatedAt: new Date(now()).toISOString() }); applyPrices({}); return currentPrices(); }

  async function vehicles() {
    const byCar = await all(), t = now(), out = [];
    for (const c of Object.keys(CARS)) out.push(vehicleStatus(c, await getJSON(store, vkey(c)), byCar[c], t));
    return out;
  }
  async function saveVehicle(car, f) {
    const date = v => { v = clean(v, 10); if (v && !isValidDate(v)) throw new ToolError("Use a full date."); return v; };
    const miles = v => { if (v === "" || v === null || v === undefined) return null; const n = Math.round(Number(String(v).replace(/[, ]/g, ""))); if (!Number.isFinite(n) || n < 0 || n > 999999) throw new ToolError("Enter the mileage as a number."); return n; };
    const fields = {};
    if ("plate" in f) fields.plate = clean(f.plate, 20);
    if ("vin" in f) fields.vin = clean(f.vin, 20);
    if ("notes" in f) fields.notes = clean(f.notes, 1000);
    if ("oilIntervalMiles" in f) { const n = miles(f.oilIntervalMiles); if (n !== null && (n < 500 || n > 20000)) throw new ToolError("Oil change interval should be 500 to 20,000 miles."); fields.oilIntervalMiles = n || SERVICE_DEFAULTS.oilIntervalMiles; }
    if ("lastOilMiles" in f) fields.lastOilMiles = miles(f.lastOilMiles);
    if ("lastOilDate" in f) fields.lastOilDate = date(f.lastOilDate);
    for (const [k] of DATE_ITEMS) if (k in f) fields[k] = date(f[k]);
    return updateJSON(store, vkey(car), cur => ({ ...(cur || {}), ...fields, updatedAt: new Date(now()).toISOString() }));
  }
  async function logService(car, { type, miles, date, note }) {
    const m = Math.round(Number(String(miles ?? "").replace(/[, ]/g, "")));
    if (!Number.isFinite(m) || m < 0 || m > 999999) throw new ToolError("Enter the mileage at the time of service.");
    const d = clean(date, 10) || day(now());
    if (!isValidDate(d)) throw new ToolError("Use a full date.");
    const label = { oil: "Oil change", tires: "Tires", brakes: "Brakes", repair: "Repair", other: "Service" }[type] || "Service";
    return updateJSON(store, vkey(car), cur => {
      const v = { ...(cur || {}) };
      v.log = [...(v.log || []), { date: d, miles: m, type: type || "other", text: `${label}${note ? ": " + clean(note, 200) : ""}` }].slice(-200);
      if (type === "oil") { v.lastOilMiles = m; v.lastOilDate = d; }
      return v;
    });
  }

  /** Every 15 minutes: email the owner once when an item becomes due soon, and once when it's overdue. */
  async function sweep() {
    if (!notify) return [];
    const done = [];
    for (const v of await vehicles()) {
      const due = v.items.filter(i => i.level === "soon" || i.level === "overdue");
      if (!due.length) continue;
      const rec = (await getJSON(store, vkey(v.car))) || {}, sent = rec.reminded || {};
      const fresh = due.filter(i => sent[i.key] !== `${i.dueValue}:${i.level}`);
      if (!fresh.length) continue;
      try {
        await notify(`${v.name}: ${fresh.map(i => `${i.label.toLowerCase()} ${i.level === "overdue" ? "overdue" : "due soon"}`).join(", ")}`,
          fresh.map(i => `${i.label}: ${i.level === "overdue" ? "OVERDUE" : "due soon"}. Due ${i.due}${i.left ? ` (${i.left}${i.key === "oil" ? " left" : ""})` : ""}.`).join("\n")
          + `${v.miles ? `\n\nCurrent mileage: ${v.miles.miles.toLocaleString("en-US")} (${v.miles.source}).` : ""}\nUpdate it on your bookings page under Vehicles once it's done.`);
        await updateJSON(store, vkey(v.car), cur => ({ ...(cur || {}), reminded: { ...((cur || {}).reminded || {}), ...Object.fromEntries(fresh.map(i => [i.key, `${i.dueValue}:${i.level}`])) } }));
        done.push(["vehicle-reminder", v.car, fresh.map(i => i.key).join(",")]);
      } catch (e) { log.error("[vehicles] reminder", e && e.message); }
    }
    return done;
  }

  return { all, block, unblock, setPrices, resetPrices, vehicles, saveVehicle, logService, sweep };
}

/** /api/admin/tools  GET ?action=report&month=YYYY-MM[&format=csv] | export&format=csv|json | vehicles
 *                    POST {action: block | unblock | prices | prices-reset | vehicle | service, ...} */
export function adminToolsHandler({ store, adminKey, now = () => Date.now(), notify = null, log = console }) {
  const tools = makeAdminTools({ store, now, notify, log });
  return async (req) => {
    if (!keyOk(req, adminKey)) return json({ error: "unauthorized" }, 401);
    try {
      await loadPriceOverrides(store, { now: now() });
      const url = new URL(req.url);
      if (req.method === "GET") {
        const action = url.searchParams.get("action"), format = url.searchParams.get("format");
        const file = (name, type, body) => new Response(body, { headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
        if (action === "report") {
          const month = url.searchParams.get("month") || day(now()).slice(0, 7);
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ToolError("Choose a month.");
          const entries = monthEntries(await tools.all(), month), summary = monthSummary(entries);
          if (format === "csv") return file(`ace-fares-sales-${month}.csv`, "text/csv; charset=utf-8", reportCsv(month, entries, summary));
          return json({ month, summary, entries });
        }
        if (action === "export") {
          const byCar = await tools.all(), stamp = day(now());
          if (format === "json") {
            const extra = { settings: await getJSON(store, "config-settings"), prices: await getJSON(store, "config-prices"), reviews: await getJSON(store, "reviews"),
              vehicles: Object.fromEntries(await Promise.all(Object.keys(CARS).map(async c => [c, await getJSON(store, `vehicle-${c}`)]))) };
            return file(`ace-fares-backup-${stamp}.json`, "application/json", JSON.stringify({ exportedAt: new Date(now()).toISOString(), bookings: byCar, ...extra }, null, 2));
          }
          return file(`ace-fares-bookings-${stamp}.csv`, "text/csv; charset=utf-8", exportCsv(byCar));
        }
        if (action === "vehicles") return json({ vehicles: await tools.vehicles() });
        if (action === "prices") return json(currentPrices());
        return json({ error: "bad_request" }, 400);
      }
      if (req.method !== "POST") return json({ error: "method" }, 405);
      const text = await req.text(); if (text.length > 8192) return json({ error: "too_large" }, 413);
      let b; try { b = JSON.parse(text || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); }
      const needCar = () => { if (!CARS[b.car]) throw new ToolError("Choose a car."); };
      switch (b.action) {
        case "block": needCar(); return json({ ok: true, block: await tools.block(b.car, b) });
        case "unblock": needCar(); return json({ ok: true, block: await tools.unblock(b.car, String(b.id || "")) });
        case "prices": return json({ ok: true, prices: await tools.setPrices(b) });
        case "prices-reset": return json({ ok: true, prices: await tools.resetPrices() });
        case "vehicle": needCar(); await tools.saveVehicle(b.car, b.fields || {}); return json({ ok: true, vehicles: await tools.vehicles() });
        case "service": needCar(); await tools.logService(b.car, b); return json({ ok: true, vehicles: await tools.vehicles() });
        default: return json({ error: "bad_request" }, 400);
      }
    } catch (e) {
      if (e instanceof ToolError) return json({ error: "bad_request", message: e.message }, e.status);
      log.error("[admin-tools] error", e);
      return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
    }
  };
}
export { PRICE_DEFAULTS };
