import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pub = (f: string) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8"); // dist/test -> project root
const html = pub("index.html");
const css = pub("style.css");
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

test("providers table is readable: no crushed columns or run-together capabilities", () => {
  assert.match(html, /providers-table/);
  assert.match(html, /Models &amp; capabilities/);
  assert.doesNotMatch(html, /<th>Models<\/th><th>Capabilities<\/th>/);
  assert.match(css, /\.providers-table\s*\{[^}]*min-width:\s*980px/);
  assert.match(css, /\.provider-model-row/);
  assert.match(js, /provider-model-row/);
});

test("reasoning controls use a structured grid layout", () => {
  assert.match(css, /\.reasoning-controls\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.reasoning-levels\s*\{/);
  assert.match(js, /reasoning-levels/);
  assert.doesNotMatch(css, /\.reasoning-controls\s*\{[^}]*display:\s*contents/);
});

test("thinking toggle disables reasoning controls when off", () => {
  assert.match(js, /Thinking allowed/);
  assert.match(js, /data-meta-thinking/);
  assert.match(js, /syncThinkingControls/);
  assert.match(js, /thinking,/);
  assert.match(css, /\.model-meta-item\.thinking-off/);
});

test("capabilities are explained as config metadata, not model behavior", () => {
  assert.match(html, /only used to generate config/i);
  assert.match(html, /do not change how the model or provider behaves/i);
  assert.match(html, /To test what a model actually accepts, use <b>Try it now<\/b> in <b>How to Use<\/b>/i);
});

test("dashboard labels totals and model settings stay manual", () => {
  assert.match(html, /Totals below add up every row shown/);
  assert.match(html, /id="p-model-meta"/);
  assert.match(html, /id="g-thinking"/);
  assert.match(html, /Try a thinking level/);
  assert.doesNotMatch(js, /reasoningProfileFor/);
  assert.match(js, /thinkingLevel/);
  assert.match(js, /thinkingLevelMap/);
});

test("Settings offers SQLite export; README keeps its screenshot", () => {
  assert.match(html, /id="export-db"/);
  assert.match(html, /Download SQLite backup/);
  assert.ok(readme.includes("images/1router-dashboard.png"));
});
