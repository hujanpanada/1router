import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pub = (f: string) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8"); // dist/test -> project root
const html = pub("index.html");
const loginHtml = pub("login.html");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("default-password banner never leaks the password in HTML", () => {
  const banner = html.slice(html.indexOf('id="default-banner"'), html.indexOf('id="status"'));
  assert.ok(!banner.includes("<code>1router</code>") && !banner.includes(">1router<"));
});

test("login page links to the shared stylesheet", () => {
  assert.match(loginHtml, /<link rel="stylesheet" href="style\.css">/);
});

test("providers table lists models only; capabilities live in How to Use", () => {
  assert.match(html, /providers-table/);
  assert.match(html, /<th>Models<\/th>/);
  assert.doesNotMatch(html, /Models &amp; capabilities/);
  const providersTab = html.slice(html.indexOf('id="tab-providers"'), html.indexOf('id="tab-keys"'));
  const guideTab = html.slice(html.indexOf('id="tab-guide"'));
  assert.ok(!providersTab.includes('id="p-model-meta"'), "capability editor must not be in Providers tab");
  assert.ok(guideTab.includes('id="p-model-meta"'), "capability editor belongs in How to Use");
});

test("capabilities are explained as config metadata, not model behavior", () => {
  const guideTab = html.slice(html.indexOf('id="tab-guide"'));
  assert.match(guideTab, /only used to generate config/i);
  assert.match(guideTab, /do not change how the model or provider behaves/i);
});

test("period selector defaults to Today", () => {
  assert.match(html, /<option value="daily" selected>Today<\/option>/);
  assert.doesNotMatch(html, /<option value="daily"[^>]*>Daily<\/option>/);
});

test("Settings offers SQLite export; README keeps its screenshot and documents 1.5.0 features", () => {
  assert.match(html, /id="export-db"/);
  assert.match(html, /Download SQLite backup/);
  assert.ok(readme.includes("images/1router-dashboard.png"));
  assert.match(readme, /Asia\/Kuala_Lumpur/);
  assert.match(readme, /key:create/);
});

test("Settings page has timezone configuration with default GMT+8 Asia/Kuala_Lumpur using standard HTML select", () => {
  assert.match(html, /<select[^>]*id="tz-input"/);
  assert.match(html, /Asia\/Kuala_Lumpur/);
});
