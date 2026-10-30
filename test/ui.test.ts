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

test("Pi config declares image input only when the model explicitly allows images", () => {
  assert.match(js, /input: meta\.imageInput \? \["text", "image"\] : \["text"\]/);
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

test("dashboard labels totals as all displayed rows and guides show explicit model guards", () => {
  assert.match(html, /Totals below add up every row shown/);
  assert.match(html, /id="p-model-meta"/);
  assert.match(html, /Reasoning \(optional\)/);
  assert.match(js, /p-model-meta/);
  assert.match(js, /thinkingLevelMap/);
  assert.match(js, /effort/);
});

test("Settings offers SQLite export; README keeps its screenshot", () => {
  assert.match(html, /id="export-db"/);
  assert.match(html, /Download SQLite backup/);
  assert.ok(readme.includes("images/1router-dashboard.png"));
});
