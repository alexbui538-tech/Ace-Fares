// Live checks against the deployed site (Stripe TEST mode only).
// Usage: node scripts/live-checks.mjs https://your-site.netlify.app
// 1) availability endpoint answers  2) five simultaneous checkouts for the same dates: exactly one succeeds
// 3) bad input is rejected. It leaves one test hold that expires on its own within 35 minutes.
const site = (process.argv[2] || "").replace(/\/$/, "");
if (!site) { console.error("Give the site address, e.g. node scripts/live-checks.mjs https://acefares.netlify.app"); process.exit(1); }
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) process.exitCode = 1; };
const day = n => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };

const a = await fetch(site + "/api/availability"); ok(a.ok, `availability answers (${a.status})`);
const body = JSON.stringify({ car: "srx", from: day(300), to: day(302), fromTime: "10:00", toTime: "10:00", location: "dallas-pickup" });
const res = await Promise.all(Array.from({ length: 5 }, () => fetch(site + "/api/checkout", { method: "POST", body, headers: { "content-type": "application/json" } })));
const codes = res.map(r => r.status);
ok(codes.filter(c => c === 200).length === 1, `exactly one of five simultaneous checkouts succeeds (${codes.join(",")})`);
const won = res.find(r => r.status === 200); if (won) { const j = await won.json(); ok(/checkout\.stripe\.com/.test(j.url), "checkout returns a Stripe link"); console.log("      test checkout link (do not pay unless testing):", j.url); }
const bad = await fetch(site + "/api/checkout", { method: "POST", body: JSON.stringify({ car: "srx", from: "2020-01-01", to: "2020-01-02", location: "dallas-pickup" }) });
ok(bad.status === 400, "past dates are rejected");
