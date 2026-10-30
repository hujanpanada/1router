"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");
let providers = [];

async function api(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401) { location.href = "/login"; throw new Error("Logged out"); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || ("HTTP " + res.status));
  return data;
}
const apiJson = (path, method, body) => api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

// ---------- universal button feedback ----------
// Every click gets an immediate visual pulse; copy buttons additionally say so.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button, a.btn");
  if (!btn) return;
  btn.classList.remove("clicked");
  void btn.offsetWidth; // restart the animation on rapid repeat clicks
  btn.classList.add("clicked");
  setTimeout(() => btn.classList.remove("clicked"), 500);
});
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.classList.add("busy");
    if (label) btn.textContent = label;
  } else {
    btn.disabled = false;
    btn.classList.remove("busy");
    if (btn.dataset.label !== undefined) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }
}
function showCopied(btn) {
  if (!btn || btn.dataset.copying) return;
  const original = btn.textContent;
  btn.dataset.copying = "1";
  btn.textContent = "✓ Copied";
  setTimeout(() => { btn.textContent = original; delete btn.dataset.copying; }, 1200);
}

// ---------- tabs ----------
document.querySelectorAll("button.tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("button.tab").forEach((x) => x.classList.toggle("active", x === b));
  for (const t of ["dashboard", "providers", "keys", "guide", "settings"]) $("tab-" + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === "dashboard") loadStats();
  if (b.dataset.tab === "guide") renderGuide();
}));

// ---------- dashboard ----------
/** Weekly buckets arrive as the Monday's date (YYYY-MM-DD); show the full week range. */
function formatPeriod(value, period) {
  if (period !== "weekly") return value;
  const start = new Date(value + "T00:00:00"); // local time, no UTC shift
  if (Number.isNaN(start.getTime())) return value;
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fmtDate = (d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const isCurrentWeek = today >= start && today <= end;
  return `${fmtDate(start)} – ${isCurrentWeek ? "Today" : fmtDate(end)}`;
}
async function loadRequests() {
  const limit = $("req-limit")?.value ?? "50";
  const reqs = await api(`/api/requests?limit=${limit}`);
  $("req-body").innerHTML = reqs.map((e) =>
    `<tr><td>${new Date(e.ts).toLocaleString()}</td><td>${esc(e.provider)}/${esc(e.model)}${e.streaming ? " (stream)" : ""}</td><td class="num">${fmt(e.input)}</td><td class="num">${fmt(e.output)}</td><td class="num">${fmt(e.cacheRead)}/${fmt(e.cacheWrite)}</td><td class="num">${e.httpStatus}${e.usageMissing ? " (no usage)" : ""}</td><td class="num">${e.latencyMs} ms</td></tr>`
  ).join("") || '<tr><td colspan="7" class="muted">—</td></tr>';
}
async function loadStats() {
  const period = $("period").value, groupBy = $("groupBy").value;
  $("th-group").textContent = { provider: "Provider", key: "API key", model: "Model" }[groupBy];
  const rows = await api(`/api/stats?period=${period}&groupBy=${groupBy}`);
  const t = rows.reduce((a, r) => ({ req: a.req + r.requests, i: a.i + r.input, o: a.o + r.output, cr: a.cr + r.cacheRead, cw: a.cw + r.cacheWrite }), { req: 0, i: 0, o: 0, cr: 0, cw: 0 });
  $("c-req").textContent = fmt(t.req); $("c-in").textContent = fmt(t.i); $("c-out").textContent = fmt(t.o);
  $("c-cache").textContent = fmt(t.cr) + " / " + fmt(t.cw);
  $("stats-body").innerHTML = rows.map((r) =>
    `<tr><td>${esc(formatPeriod(r.period, period))}</td><td>${esc(r.group)}</td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.input)}</td><td class="num">${fmt(r.output)}</td><td class="num">${fmt(r.cacheRead)}</td><td class="num">${fmt(r.cacheWrite)}</td></tr>`
  ).join("") || '<tr><td colspan="7" class="muted">No data yet — add a provider, create a key, and make a request.</td></tr>';
  await loadRequests();
}
$("refresh-stats").addEventListener("click", () => loadStats().catch(showErr));
$("period").addEventListener("change", () => loadStats().catch(showErr));
$("groupBy").addEventListener("change", () => loadStats().catch(showErr));
$("req-limit").addEventListener("change", () => loadRequests().catch(showErr));

// ---------- providers ----------
function slugify(s) { return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); }
function renderProviders() {
  $("providers-body").innerHTML = providers.map((p) =>
    `<tr><td>${esc(p.name)}</td><td><code>${esc(p.slug)}</code></td><td>${esc(p.api)}</td><td>${esc(p.baseUrl)}</td><td>${esc(p.apiKeyMasked || "—")}</td>` +
    `<td>${p.models.map(esc).join("<br>") || '<span class="muted">none</span>'}</td>` +
    `<td class="actions-col"><div class="actions"><button class="btn btn-small" data-edit="${p.id}">Edit</button><button class="btn btn-small btn-danger" data-del="${p.id}">Delete</button></div></td></tr>`
  ).join("") || '<tr><td colspan="7" class="muted">None yet.</td></tr>';
  document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editProvider(Number(b.dataset.edit))));
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this provider? (Usage history is kept.)")) return;
    await api("/api/providers/" + b.dataset.del, { method: "DELETE" });
    await loadProviders();
  }));
  renderGuideModelOptions();
}
async function loadProviders() { providers = await api("/api/providers"); renderProviders(); }

function editProvider(id) {
  const p = providers.find((x) => x.id === id); if (!p) return;
  $("p-id").value = p.id; $("p-name").value = p.name; $("p-slug").value = p.slug;
  $("p-api").value = p.api; $("p-baseurl").value = p.baseUrl; $("p-apikey").value = "";
  $("p-models").value = p.models.join("\n");
  $("provider-form-title").textContent = "Edit provider: " + p.name;
  $("p-cancel").hidden = false; window.scrollTo({ top: 0, behavior: "smooth" });
}
function resetProviderForm() {
  $("provider-form").reset(); $("p-id").value = "";
  $("provider-form-title").textContent = "Add a provider"; $("p-cancel").hidden = true; $("p-msg").textContent = "";
}
$("p-cancel").addEventListener("click", resetProviderForm);
$("p-name").addEventListener("input", () => { if (!$("p-id").value) $("p-slug").value = slugify($("p-name").value); });

$("p-fetch").addEventListener("click", async () => {
  const btn = $("p-fetch");
  setBusy(btn, true, "Fetching…");
  $("p-msg").textContent = "Fetching models from the provider…";
  try {
    const body = { baseUrl: $("p-baseurl").value, api: $("p-api").value, apiKey: $("p-apikey").value };
    if ($("p-id").value) body.providerId = Number($("p-id").value);
    const r = await apiJson("/api/providers/fetch-models", "POST", body);
    $("p-models").value = r.models.join("\n");
    $("p-msg").textContent = r.models.length ? `Found ${r.models.length} models.` : "Provider returned no models — type them manually, one per line.";
  } catch (e) { $("p-msg").textContent = "Could not fetch: " + e.message + " (you can still type model names manually)"; }
  finally { setBusy(btn, false); }
});

$("provider-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = $("p-slug").value.trim() || slugify($("p-name").value);
  const body = {
    slug, name: $("p-name").value, baseUrl: $("p-baseurl").value, api: $("p-api").value,
    apiKey: $("p-apikey").value, models: $("p-models").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
  };
  const btn = $("p-save");
  setBusy(btn, true, "Saving…");
  try {
    if ($("p-id").value) await apiJson("/api/providers/" + $("p-id").value, "PUT", body);
    else await apiJson("/api/providers", "POST", body);
    resetProviderForm(); await loadProviders();
    $("p-msg").textContent = "✓ Provider saved.";
  } catch (err) { $("p-msg").textContent = "Error: " + err.message; }
  finally { setBusy(btn, false); }
});

// ---------- keys ----------
function renderKeys(keys) {
  $("keys-body").innerHTML = keys.map((k) =>
    `<tr><td>${esc(k.name)}</td><td>${new Date(k.createdAt).toLocaleString()}</td><td>${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>` +
    `<td>${k.revokedAt ? "revoked" : "active"}</td><td class="actions-col">${k.revokedAt ? "" : `<div class="actions"><button class="btn btn-small btn-danger" data-revoke="${k.id}">Revoke</button></div>`}</td></tr>`
  ).join("") || '<tr><td colspan="5" class="muted">None yet.</td></tr>';
  document.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Revoke this key? Apps using it will stop working.")) return;
    await api("/api/keys/" + b.dataset.revoke, { method: "DELETE" }); loadKeys();
  }));
}
async function loadKeys() { renderKeys(await api("/api/keys")); }
$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  setBusy(btn, true, "Creating…");
  try {
    const created = await apiJson("/api/keys", "POST", { name: $("k-name").value });
    $("new-key-value").textContent = created.key;
    $("new-key").hidden = false;
    $("k-name").value = "";
    await loadKeys();
  } finally { setBusy(btn, false); }
});
$("copy-new-key").addEventListener("click", async (e) => { await navigator.clipboard.writeText($("new-key-value").textContent); showCopied(e.currentTarget); });

// ---------- guide ----------
const ENDPOINT = { "openai-completions": "/chat/completions", "openai-responses": "/responses", "anthropic-messages": "/messages" };
function providerOfModel(fullId) { return providers.find((p) => fullId.startsWith(p.slug + "/")); }
function renderGuideModelOptions() {
  const sel = $("g-model"); if (!sel) return;
  const current = sel.value;
  sel.innerHTML = providers.flatMap((p) => p.models.map((m) => `<option value="${esc(p.slug)}/${esc(m)}">${esc(p.slug)}/${esc(m)}</option>`)).join("");
  if (current) sel.value = current;
  renderGuide();
}
function testBody(apiType, fullId) {
  if (apiType === "anthropic-messages") return { model: fullId, max_tokens: 50, messages: [{ role: "user", content: "Say hi in 3 words" }] };
  if (apiType === "openai-responses") return { model: fullId, input: "Say hi in 3 words" };
  return { model: fullId, messages: [{ role: "user", content: "Say hi in 3 words" }] };
}
function renderGuide() {
  if (!$("g-base")) return;
  const origin = location.origin;
  $("g-base").textContent = origin + "/v1";
  const fullId = $("g-model").value || "provider/model";
  const p = providerOfModel(fullId);
  const apiType = p?.api || "openai-completions";
  const key = $("g-key").value.trim() || "sk-1r-YOUR_KEY";
  $("g-model-example").textContent = fullId;
  const isAnthropic = apiType === "anthropic-messages";
  $("g-curl").textContent =
    `curl ${origin}/v1${ENDPOINT[apiType]} \\\n` +
    (isAnthropic
      ? `  -H "x-api-key: ${key}" -H "anthropic-version: 2023-06-01" \\\n`
      : `  -H "Authorization: Bearer ${key}" \\\n`) +
    `  -H "content-type: application/json" \\\n  -d '${JSON.stringify(testBody(apiType, fullId))}'`;
  const piProviders = {};
  for (const pr of providers) {
    piProviders["1router-" + pr.slug] = {
      baseUrl: origin + "/v1", api: pr.api, apiKey: key,
      models: pr.models.map((m) => ({ id: `${pr.slug}/${m}`, input: ["text", "image"] })),
    };
  }
  $("g-pi").textContent = JSON.stringify({ providers: piProviders }, null, 2) || "// Add a provider first";
}
$("g-model").addEventListener("change", renderGuide);
$("g-key").addEventListener("input", renderGuide);
$("g-test").addEventListener("click", async () => {
  const out = $("g-test-result");
  const fullId = $("g-model").value;
  const key = $("g-key").value.trim();
  if (!fullId) { out.textContent = "Add a provider with a model first (Providers tab)."; return; }
  if (!key) { out.textContent = "Paste a 1Router key from the API Keys tab first."; return; }
  const btn = $("g-test");
  setBusy(btn, true, "Sending…");
  out.textContent = "Sending… (the server makes the test request for you)";
  try {
    // Server-side test: the browser never calls /v1/* directly, so it can only
    // fail to reach 1Router itself — everything else comes back as a message.
    const r = await apiJson("/api/test-request", "POST", { model: fullId, clientKey: key });
    out.textContent = (r.ok ? "✅ " : "❌ ") + r.message + (r.status ? ` (HTTP ${r.status}, ${r.latencyMs} ms)` : "");
    if (r.ok) setTimeout(() => loadStats().catch(() => {}), 300);
  } catch (e) {
    out.textContent = "❌ Couldn't reach the 1Router server itself. Is it still running? Start it with: npm start — then reload this page.";
  } finally { setBusy(btn, false); }
});
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => { await navigator.clipboard.writeText($(b.dataset.copy).textContent); showCopied(b); }));

$("default-banner-settings").addEventListener("click", () => {
  document.querySelector('button.tab[data-tab="settings"]')?.click();
});

$("export-db").addEventListener("click", () => {
  const msg = $("export-msg");
  if (msg) msg.textContent = "Downloading your database backup…";
  setTimeout(() => { if (msg) msg.textContent = "Downloaded. Restore by replacing the database file while 1Router is stopped."; }, 800);
});

// ---------- settings / logout ----------
$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await apiJson("/api/change-password", "POST", { currentPassword: $("pw-current").value, newPassword: $("pw-new").value });
    $("pw-msg").textContent = "Password changed."; $("pw-form").reset(); $("default-banner").hidden = true;
  } catch (err) { $("pw-msg").textContent = "Error: " + err.message; }
});
$("logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; });

// ---------- init ----------
function showErr(e) { $("status").textContent = "Error: " + e.message; }
(async () => {
  try {
    const me = await api("/api/me");
    $("default-banner").hidden = !me.passwordIsDefault;
    await loadProviders();
    await loadKeys();
    await loadStats();
  } catch (e) { /* api() redirects to /login on 401 */ }
})();
