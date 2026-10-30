import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pub = (f: string) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8"); // dist/test -> project root
const html = pub("index.html");
const js = pub("app.js");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("Try-it-now key field stays plain text (it is visible in the curl below anyway)", () => {
  assert.match(html, /id="g-key"[^>]*type="text"/);
});

test("Pi config declares image input so multimodal models can receive images", () => {
  assert.match(js, /input: \["text", "image"\]/);
});

test("weekly breakdown rows use YYYY-MM-DD ranges like every other period", () => {
  assert.match(js, /setDate\(start\.getDate\(\) \+ 6\)/);
  assert.match(js, /padStart\(2, "0"\)/);
  assert.doesNotMatch(js, /"Today"/);
});

test("default-password banner never shows the password itself", () => {
  const banner = html.slice(html.indexOf('id="default-banner"'), html.indexOf('id="status"'));
  assert.ok(!banner.includes("<code>1router</code>") && !banner.includes(">1router<"));
});

test("Settings offers SQLite export; README keeps its screenshot", () => {
  assert.match(html, /id="export-db"/);
  assert.match(html, /Download SQLite backup/);
  assert.ok(readme.includes("images/1router-dashboard.png"));
});
