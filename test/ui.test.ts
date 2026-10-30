import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pub = (f: string) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8"); // dist/test -> project root
const html = pub("index.html");
const css = pub("style.css");
const js = pub("app.js");

test("Try-it-now key field is plain text (it is visible in the curl below anyway)", () => {
  assert.match(html, /id="g-key"[^>]*type="text"/);
  assert.doesNotMatch(html, /id="g-key"[^>]*type="password"/);
});

test("provider models textarea cannot be resized", () => {
  assert.match(css, /textarea\s*\{[^}]*resize:\s*none/);
});

test("every button gives click feedback", () => {
  assert.match(css, /button[^{]*:active\s*\{/);
  assert.match(css, /\.clicked\s*\{/);
  assert.match(js, /closest\("button, a\.btn"\)/);
  assert.match(js, /classList\.add\("clicked"\)/);
});

test("recent requests can show 10, 20, 50 or 100 entries", () => {
  assert.match(html, /id="req-limit"/);
  for (const n of ["10", "20", "50", "100"]) assert.match(html, new RegExp(`<option value="${n}"`));
  assert.match(js, /api\/requests\?limit=\$\{/);
});

test("default-password banner never shows the password and has an aligned action", () => {
  const banner = html.slice(html.indexOf('id="default-banner"'), html.indexOf('id="status"'));
  assert.ok(!banner.includes("<code>1router</code>"), "banner must not display the default password");
  assert.ok(!banner.includes(">1router<"), "banner must not display the default password");
  assert.match(banner, /id="default-banner-settings"/);
  assert.match(css, /\.alert-banner\s*\{/);
  assert.match(css, /\.alert-text\s*\{[^}]*flex:\s*1/);
  assert.match(js, /default-banner-settings/);
});

test("weekly breakdown rows show Monday-to-end-of-week range in the UI", () => {
  assert.match(js, /function formatPeriod\(value, period\)/);
  assert.match(js, /period !== "weekly"/);
  assert.match(js, /setDate\(start\.getDate\(\) \+ 6\)/);
  assert.match(js, /"Today"/);
  assert.match(js, /formatPeriod\(r\.period, period\)/);
});

test("brand subheading says API token usage dashboard", () => {
  assert.ok(html.includes("API token usage dashboard"), "brand subheading must say 'API token usage dashboard'");
});

test("Settings offers SQLite export", () => {
  assert.match(html, /id="export-db"/);
  assert.match(html, /Download SQLite backup/);
  assert.match(js, /export-db/);
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("images/1router-dashboard.png"));
});

test("layout primitives exist for aligned panels/tables/forms", () => {
  for (const cls of ["topbar", "panel", "table-wrap", "form-grid", "cards"]) {
    assert.ok(css.includes("." + cls), `style.css missing .${cls}`);
    assert.ok(html.includes(cls) || cls === "table-wrap", `index.html missing ${cls}`);
  }
});
