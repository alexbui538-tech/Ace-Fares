// Pickup and return photo inspections, for the renter and for the host (Ace Fares).
// Each side photographs all four sides, the odometer, the fuel gauge and the interior, and types in the
// mileage and fuel level. Every picture is kept in the "inspections" Netlify Blobs store (the photo
// database) with when it was taken, who took it, its size and a SHA-256 fingerprint, plus a JSON record
// per booking listing every photo and reading. Once a side submits a stage it's locked, so the
// photos can't be changed afterwards.
//
//   img/<bookingId>/<stage>/<role>/<shot>/<time>-<rand>   the image bytes (metadata: who/when/fingerprint)
//   rec-<bookingId>                                        { car, bookingId, photos: [...], stages: { pickup: { renter: {...}, host: {...} }, return: {...} } }
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getJSON, updateJSON } from "./kv.mjs";
import { makeRepo } from "./bookings.mjs";
import { CARS, LOCATIONS } from "./catalog.mjs";

export const STAGES = ["pickup", "return"];
export const ROLES = ["renter", "host"];
export const SHOTS = [
  { id: "front", label: "Front", hint: "Whole front of the car, bumper to roof" },
  { id: "back", label: "Back", hint: "Whole back of the car, including the plate" },
  { id: "driver", label: "Driver side", hint: "Step back so the whole side fits" },
  { id: "passenger", label: "Passenger side", hint: "Step back so the whole side fits" },
  { id: "odometer", label: "Odometer (mileage)", hint: "Car on, so the mileage is readable", reading: "odometer" },
  { id: "fuel", label: "Fuel gauge", hint: "Car on, so the needle is visible", reading: "fuel" },
  { id: "interior_front", label: "Front seats and dashboard", hint: "From the back seat, looking forward" },
  { id: "interior_back", label: "Back seats and trunk", hint: "Rear seats, then open the trunk" },
  { id: "damage", label: "Damage close-ups", hint: "Any scratch, dent, chip, stain or warning light", optional: true, multiple: true },
];
export const FUEL_LEVELS = ["E", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "F"];
export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DAMAGE = 12, MAX_RETAKES = 6;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
class InspError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** What kind of image the bytes really are (not what the browser claims). */
export function sniffImage(buf) {
  const b = new Uint8Array(buf.slice ? buf.slice(0, 16) : buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const s = String.fromCharCode(...b);
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") return "image/webp";
  if (s.slice(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(s.slice(8, 12))) return "image/heic";
  return null;
}

const current = (photos, stage, role) => {
  const out = {};
  for (const p of photos) if (p.stage === stage && p.role === role) {
    if (p.shot === "damage") (out.damage ||= []).push(p); else out[p.shot] = p;    // a retake replaces the earlier one
  }
  return out;
};

export function makeInspections({ photos, bookingsStore, now = () => Date.now(), notify = null, log = console }) {
  const repo = makeRepo(bookingsStore, { now });
  const recKey = id => `rec-${id}`;
  const empty = (car, b) => ({ car, bookingId: b.id, photos: [], stages: {} });

  async function addPhoto({ car, b, stage, role, shot, bytes, by = "", ip = "", clientTime = null }) {
    if (!STAGES.includes(stage)) throw new InspError("bad_stage", "Unknown inspection step.");
    const def = SHOTS.find(s => s.id === shot);
    if (!def) throw new InspError("bad_shot", "Unknown photo.");
    const size = bytes.byteLength;
    if (!size) throw new InspError("empty", "That photo didn't upload. Please try again.");
    if (size > MAX_BYTES) throw new InspError("too_big", "That photo is too large. Please try again.", 413);
    const type = sniffImage(bytes);
    if (!type) throw new InspError("not_image", "That file isn't a photo. Use a JPG, PNG, HEIC or WebP picture.", 415);
    const rec0 = (await getJSON(photos, recKey(b.id))) || empty(car, b);
    const st = rec0.stages[stage] && rec0.stages[stage][role];
    if (st && st.completedAt) throw new InspError("locked", "These photos were already submitted and can't be changed.", 409);
    const mine = rec0.photos.filter(p => p.stage === stage && p.role === role && p.shot === shot);
    if (shot === "damage" && mine.length >= MAX_DAMAGE) throw new InspError("too_many", `You can add up to ${MAX_DAMAGE} damage photos.`);
    if (shot !== "damage" && mine.length >= MAX_RETAKES) throw new InspError("too_many", "That's a lot of retakes. Please text us if the camera isn't working.");
    const takenAt = new Date(now()).toISOString(), sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const key = `img/${b.id}/${stage}/${role}/${shot}/${now()}-${randomBytes(3).toString("hex")}`;
    const meta = { car, bookingId: b.id, stage, role, shot, takenAt, by: clean(by, 80), ip: clean(ip, 64), sha256, size, contentType: type,
      ...(clientTime ? { clientTime } : {}) };
    await photos.set(key, bytes, { metadata: meta });
    const entry = { key, ...meta };
    delete entry.car; delete entry.bookingId;
    await updateJSON(photos, recKey(b.id), cur => {
      const r = cur || empty(car, b);
      if (r.stages[stage] && r.stages[stage][role] && r.stages[stage][role].completedAt) throw new InspError("locked", "These photos were already submitted and can't be changed.", 409);
      return { ...r, photos: [...r.photos, entry] };
    });
    return entry;
  }

  async function complete({ car, b, stage, role, odometer, fuel, notes = "", by = "" }) {
    if (!STAGES.includes(stage)) throw new InspError("bad_stage", "Unknown inspection step.");
    const miles = Number(String(odometer ?? "").replace(/[, ]/g, ""));
    if (!Number.isInteger(miles) || miles < 0 || miles > 999999) throw new InspError("bad_odometer", "Enter the mileage shown on the odometer.");
    if (!FUEL_LEVELS.includes(fuel)) throw new InspError("bad_fuel", "Choose the fuel level.");
    const rec = (await getJSON(photos, recKey(b.id))) || empty(car, b);
    const cur = current(rec.photos, stage, role);
    const missing = SHOTS.filter(s => !s.optional && !cur[s.id]).map(s => s.label);
    if (missing.length) throw new InspError("missing_photos", `Still needed: ${missing.join(", ")}.`);
    const t = new Date(now()).toISOString();
    const done = { completedAt: t, odometer: miles, fuel, notes: clean(notes, 1000), by: clean(by, 80),
      photos: Object.values(cur).flat().map(p => p.key) };
    const saved = await updateJSON(photos, recKey(b.id), r0 => {
      const r = r0 || empty(car, b);
      if (r.stages[stage] && r.stages[stage][role] && r.stages[stage][role].completedAt) throw new InspError("locked", "These photos were already submitted.", 409);
      return { ...r, stages: { ...r.stages, [stage]: { ...(r.stages[stage] || {}), [role]: done } } };
    });
    // short summary on the booking, for the bookings page and My trips
    const sum = {};
    for (const s of STAGES) for (const ro of ROLES) { const x = saved.stages[s] && saved.stages[s][ro]; if (x) (sum[s] ||= {})[ro] = { at: x.completedAt, odometer: x.odometer, fuel: x.fuel }; }
    await repo.note(car, b.id, { inspection: sum });
    if (role === "renter" && notify) {
      try { await notify(`${stage === "pickup" ? "Pickup" : "Return"} photos done: ${CARS[car].name}, ${b.from}`,
        `${(b.customer && b.customer.name) || "The renter"} submitted their ${stage} photos.\nOdometer: ${miles.toLocaleString()} miles\nFuel: ${fuel}${done.notes ? `\nNotes: ${done.notes}` : ""}\n\nSee them on your bookings page (Photos).`); }
      catch (e) { log.error("[inspection] notice failed", e && e.message); }
    }
    return saved;
  }

  /** The record for the page: photos grouped by stage and side, and the readings. */
  async function view(car, b) {
    const rec = (await getJSON(photos, recKey(b.id))) || empty(car, b);
    const out = {};
    for (const s of STAGES) for (const ro of ROLES) {
      const cur = current(rec.photos, s, ro), st = (rec.stages[s] || {})[ro] || null;
      (out[s] ||= {})[ro] = { done: st, shots: Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Array.isArray(v) ? v.map(pub) : pub(v)])),
        all: rec.photos.filter(p => p.stage === s && p.role === ro).length };
    }
    const pick = s => (out[s].host.done || out[s].renter.done);
    const milesDriven = pick("pickup") && pick("return") ? pick("return").odometer - pick("pickup").odometer : null;
    return { stages: out, milesDriven, totalPhotos: rec.photos.length };
  }
  const pub = p => ({ key: p.key, takenAt: p.takenAt, sha256: p.sha256, size: p.size, by: p.by, role: p.role });

  async function image(b, key) {
    if (typeof key !== "string" || !key.startsWith(`img/${b.id}/`)) return null;
    return photos.getWithMetadata(key, { type: "arrayBuffer" });
  }

  return { addPhoto, complete, view, image, repo };
}

const keyOk = (got, want) => {
  if (!want || !got) return false;
  const a = Buffer.from(String(got)), b = Buffer.from(String(want));
  return a.length === b.length && timingSafeEqual(a, b);
};

/** /api/inspection (GET record), /api/inspection/photo (POST image bytes), /api/inspection/complete (POST), /api/inspection/img (GET image).
 *  The renter signs in with their account; the host uses the admin key (x-admin-key header). */
export function inspectionHandler({ photos, store, userOf, adminKey, now = () => Date.now(), notify = null }) {
  const insp = makeInspections({ photos, bookingsStore: store, now, notify });
  return async (req, ctx) => {
    try {
      const url = new URL(req.url), action = url.pathname.replace(/^.*\/api\/inspection\/?/, "").replace(/\/$/, "");
      if (req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== url.host) return json({ error: "bad_origin" }, 403);
      }
      let body = {};
      if (req.method === "POST" && action === "complete") { try { body = JSON.parse((await req.text()) || "{}") || {}; } catch { return json({ error: "bad_request" }, 400); } }
      const car = body.car || url.searchParams.get("car"), ref = body.ref || url.searchParams.get("ref");
      if (!CARS[car] || typeof ref !== "string") return json({ error: "not_found", message: "We couldn't find that trip." }, 404);
      const b = await insp.repo.get(car, ref);
      if (!b) return json({ error: "not_found", message: "We couldn't find that trip." }, 404);

      // who is this?
      let role = null, by = "";
      if (keyOk(req.headers.get("x-admin-key"), adminKey)) { role = "host"; by = "Ace Fares"; }
      else {
        const u = userOf ? await userOf(req) : null;
        if (!u) return json({ error: "login_required", message: "Please log in to take your trip photos." }, 401);
        const mine = b.userId ? b.userId === u.id : (b.customer && String(b.customer.email || "").toLowerCase() === u.email);
        if (!mine) return json({ error: "not_found", message: "We couldn't find that trip on your account." }, 404);
        role = "renter"; by = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email;
      }
      if (b.status !== "confirmed") return json({ error: "not_paid", message: "Photos open once the trip is booked and paid." }, 409);
      const ip = (ctx && ctx.ip) || req.headers.get("x-nf-client-connection-ip") || "";

      if (req.method === "GET" && action === "") {
        return json({ role, trip: { car, carName: CARS[car].name, photo: CARS[car].photo, from: b.from, to: b.to, fromTime: b.fromTime, toTime: b.toTime,
            location: (LOCATIONS[b.location] || {}).name, renter: (b.customer && b.customer.name) || b.accountName || "" },
          shots: SHOTS, fuelLevels: FUEL_LEVELS, ...(await insp.view(car, b)) });
      }
      if (req.method === "GET" && action === "img") {
        const r = await insp.image(b, url.searchParams.get("key"));
        if (!r) return json({ error: "not_found" }, 404);
        return new Response(r.data, { status: 200, headers: { "content-type": (r.metadata && r.metadata.contentType) || "image/jpeg", "cache-control": "private, max-age=3600" } });
      }
      if (req.method === "POST" && action === "photo") {
        const len = Number(req.headers.get("content-length") || 0);
        if (len > MAX_BYTES) return json({ error: "too_big", message: "That photo is too large. Please try again." }, 413);
        const bytes = await req.arrayBuffer();
        const ct = url.searchParams.get("clientTime");
        const entry = await insp.addPhoto({ car, b, stage: url.searchParams.get("stage"), role, shot: url.searchParams.get("shot"), bytes, by, ip,
          clientTime: ct && !isNaN(Date.parse(ct)) ? new Date(Date.parse(ct)).toISOString() : null });
        return json({ ok: true, photo: { key: entry.key, takenAt: entry.takenAt, sha256: entry.sha256, size: entry.size } });
      }
      if (req.method === "POST" && action === "complete") {
        await insp.complete({ car, b, stage: body.stage, role, odometer: body.odometer, fuel: body.fuel, notes: body.notes, by });
        return json({ ok: true, ...(await insp.view(car, await insp.repo.get(car, ref))) });
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof InspError) return json({ error: e.code, message: e.message }, e.status);
      console.error("[inspection] error", e);
      return json({ error: "server", message: "Something went wrong. Please try again." }, 500);
    }
  };
}
