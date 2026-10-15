// Old acefares.com links (still in Google) must land on a real part of this site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = f => readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
const html = read("index.html");
const rules = read("_redirects").split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => l.trim().split(/\s+/));

test("old site links: /browse and /signup are redirected for good (301)", () => {
  const to = p => (rules.find(r => r[0] === p) || [])[1];
  assert.equal(to("/browse"), "/?s=fleet"); assert.equal(to("/signup"), "/?login=1");
  for (const r of rules) assert.equal(r[2], "301", r.join(" "));
});

test("every redirect points to a section or page that exists", () => {
  for (const [from, to] of rules) {
    const s = to.match(/^\/\?s=([a-z]+)$/);
    if (s) assert.ok(html.includes(`id="${s[1]}"`), `${from} -> section #${s[1]}`);
    else if (to.endsWith(".html")) assert.ok(existsSync(new URL("../public" + to, import.meta.url)), `${from} -> ${to}`);
    else assert.ok(["/", "/?login=1", "/?trips=1", "/rental-agreement"].includes(to), `${from} -> ${to}`);
  }
});

test("Google sees acefares.com and the card icon", () => {
  assert.ok(html.includes('<link rel="canonical" href="https://acefares.com/">'));
  assert.ok(html.includes('href="/favicon.ico"') && existsSync(new URL("../public/favicon.ico", import.meta.url)));
  assert.ok(read("sitemap.xml").includes("https://acefares.com/") && !read("sitemap.xml").includes("netlify.app"));
  assert.ok(existsSync(new URL("../public/404.html", import.meta.url)));
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) JSON.parse(m[1]);
});
