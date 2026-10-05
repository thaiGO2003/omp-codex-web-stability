import { test, expect } from "bun:test";
import { guardResponseStream } from "./sse-watchdog";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const modulesRoot = process.env.OMP_GLOBAL_NODE_MODULES || join(homedir(), ".bun/install/global/node_modules");
const providerPath = join(modulesRoot, "@oh-my-pi/pi-ai/src/providers/openai-codex-responses.ts");
const catalogPath = join(modulesRoot, "@oh-my-pi/pi-catalog/src/models.ts");
const providerTest = existsSync(providerPath) && existsSync(catalogPath) ? test : test.skip;

const encoder = new TextEncoder();
const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
function fixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancels = 0;
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancels++; } });
  return { source, send: (event: object) => controller.enqueue(frame(event)), close: () => controller.close(), cancels: () => cancels };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("heartbeats do not postpone retirement; failure is emitted after scoped cleanup", async () => {
  const f = fixture();
  let retired = 0;
  const stream = guardResponseStream(f.source, { timeoutMs: 60,
    onStall: async () => { retired++; await wait(5); }, onCancel: async () => {} });
  const heartbeat = setInterval(() => f.send({ type: "response.heartbeat" }), 8);
  const output = await new Response(stream).text();
  clearInterval(heartbeat);
  expect(retired).toBe(1);
  expect(f.cancels()).toBe(1);
  expect(output).toContain('"code":"chatgpt_web_semantic_timeout"');
  expect(output).toContain("data: [DONE]");
});

test("real progress resets budget; successful stream bytes are preserved", async () => {
  const f = fixture();
  let retired = 0;
  const output = new Response(guardResponseStream(f.source, { timeoutMs: 90,
    onStall: async () => { retired++; }, onCancel: async () => { retired++; } })).text();
  f.send({ type: "response.created", response: { id: "resp_success" } });
  await wait(50);
  f.send({ type: "response.output_text.delta", delta: "Việt Nam" });
  await wait(50);
  f.send({ type: "response.completed", response: { id: "resp_success", status: "completed" } });
  f.close();
  const text = await output;
  expect(retired).toBe(0);
  expect(text).toContain("Việt Nam");
  expect(text).not.toContain("semantic_timeout");
});

test("downstream cancellation retires a live turn but never retires a completed tool round", async () => {
  for (const completed of [false, true]) {
    const f = fixture();
    let retired = 0;
    const reader = guardResponseStream(f.source, { timeoutMs: 90,
      onStall: async () => { retired++; }, onCancel: async () => { retired++; } }).getReader();
    f.send(completed ? { type: "response.completed", response: { status: "completed" } } : { type: "response.created" });
    await reader.read();
    await reader.cancel();
    expect(retired).toBe(completed ? 0 : 1);
    expect(f.cancels()).toBe(1);
  }
});

providerTest("actual OMP parser receives an explicit error instead of its own idle timeout", async () => {
  const { streamOpenAICodexResponses } = await import(providerPath);
  const { getBundledModels } = await import(catalogPath);
  const base = getBundledModels("openai-codex")[0];
  const model = { ...base, id: "chatgpt-web/gpt-5.6-sol", provider: "codex-chatgpt-web", baseUrl: "http://127.0.0.1:9999/v1" };
  const f = fixture();
  let retired = 0;
  const result = await streamOpenAICodexResponses(model, {
    systemPrompt: "Test", messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
  }, {
    apiKey: "local-test", preferWebsockets: false, streamIdleTimeoutMs: 300,
    fetch: async () => {
      f.send({ type: "response.created", sequence_number: 0, response: { id: "resp_test", status: "in_progress", output: [] } });
      return new Response(guardResponseStream(f.source, { timeoutMs: 30,
        onStall: async () => { retired++; }, onCancel: async () => {} }), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  expect(retired).toBe(1);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("ChatGPT Web made no semantic progress");
  expect(result.errorMessage).not.toContain("SSE stream stalled");
});
