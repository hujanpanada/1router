import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUsage, StreamUsageCollector } from "../src/usage.js";

test("openai-completions non-streaming: cached tokens are not double-counted as input", () => {
  const u = extractUsage("openai-completions", {
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
  });
  assert.deepEqual(u, { input: 600, output: 200, cacheRead: 400, cacheWrite: 0 });
});

test("openai-responses non-streaming: input_tokens includes cached", () => {
  const u = extractUsage("openai-responses", {
    usage: { input_tokens: 1000, output_tokens: 300, input_tokens_details: { cached_tokens: 250 } },
  });
  assert.deepEqual(u, { input: 750, output: 300, cacheRead: 250, cacheWrite: 0 });
});

test("anthropic-messages non-streaming: input already excludes cache", () => {
  const u = extractUsage("anthropic-messages", {
    usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
  });
  assert.deepEqual(u, { input: 500, output: 120, cacheRead: 800, cacheWrite: 100 });
});

test("missing usage -> null", () => {
  assert.equal(extractUsage("openai-completions", { choices: [] }), null);
  assert.equal(extractUsage("anthropic-messages", {}), null);
});

test("stream openai-completions: usage from final chunk, split across TCP chunks", () => {
  const c = new StreamUsageCollector("openai-completions");
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":400}}}\n\n' +
    "data: [DONE]\n\n";
  c.push(sse.slice(0, 37));
  c.push(sse.slice(37, 90));
  c.push(sse.slice(90));
  assert.deepEqual(c.result(), { input: 600, output: 200, cacheRead: 400, cacheWrite: 0 });
});

test("stream openai-responses: usage from response.completed", () => {
  const c = new StreamUsageCollector("openai-responses");
  c.push('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
  c.push('data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":300,"input_tokens_details":{"cached_tokens":250}}}}\n\n');
  assert.deepEqual(c.result(), { input: 750, output: 300, cacheRead: 250, cacheWrite: 0 });
});

test("stream anthropic-messages: message_start input/cache + message_delta output", () => {
  const c = new StreamUsageCollector("anthropic-messages");
  c.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":500,"output_tokens":1,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}\n\n');
  c.push('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
  c.push('data: {"type":"message_delta","usage":{"output_tokens":120}}\n\n');
  assert.deepEqual(c.result(), { input: 500, output: 120, cacheRead: 800, cacheWrite: 100 });
});

test("stream with no usage at all -> null", () => {
  const c = new StreamUsageCollector("openai-completions");
  c.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(c.result(), null);
});

test("stream parses multi-line SSE data events and string token counts", () => {
  const c = new StreamUsageCollector("openai-completions");
  c.push('data: {"choices":[],"usage":{"prompt_tokens":"1000","completion_tokens":"50","prompt_tokens_details":{"cached_tokens":"100"}}}\n\n');
  assert.deepEqual(c.result(), { input: 900, output: 50, cacheRead: 100, cacheWrite: 0 });
  const multi = new StreamUsageCollector("openai-completions");
  multi.push('data: {"choices":[],\ndata: "usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
  assert.deepEqual(multi.result(), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("oversized SSE data is ignored instead of buffering forever", () => {
  const c = new StreamUsageCollector("openai-completions");
  c.push('data: ' + 'x'.repeat(70_000) + '\n\n');
  c.push('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
  assert.deepEqual(c.result(), { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 });
});
