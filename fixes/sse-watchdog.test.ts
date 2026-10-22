import { test, expect } from "bun:test";
import { guardResponseStream, hasCompleteRecoveryInput, RecoveryIdentityStore } from "./sse-watchdog";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeComposerFailure, translateResponseStream } from "../shim/tool-call-ids";

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
  return { source, send: (event: object) => controller.enqueue(frame(event)), close: () => controller.close(), error: () => controller.error(Error("retired transport")), cancels: () => cancels };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("fresh owners isolate threads and preserve historical turn metadata", () => {
  const store = new RecoveryIdentityStore();
  const first = store.rotate("logical-a", "turn-a");
  expect(store.resolve("logical-a", "turn-a")).toEqual(first);
  expect(store.resolve("logical-b", "turn-a")).toBeUndefined();
  const next = store.resolve("logical-a", "turn-b")!;
  expect(next.threadId).toBe(first.threadId);
  expect(next.turnId).not.toBe(first.turnId);
  const rotated = store.rotate("logical-a", "turn-b");
  expect(rotated.threadId).not.toBe(first.threadId);
  const history = { role: "user", content: "history", internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } };
  const current = { role: "user", content: "continue", internal_chat_message_metadata_passthrough: { turn_id: "turn-b" } };
  const request = { client_metadata: { turn_id: "turn-b", "x-codex-turn-metadata": JSON.stringify({ thread_id: "logical-a", turn_id: "turn-b", tool_namespaces_info: { example: true } }) }, input: [history, current] };
  const headers = new Headers();
  const result = JSON.parse(store.rebind(JSON.stringify(request), headers, rotated));
  expect(result.input[0]).toEqual(history);
  expect(result.input[1].content).toBe(current.content);
  expect(result.input[1].internal_chat_message_metadata_passthrough.turn_id).toBe(rotated.turnId);
  expect(result.client_metadata.turn_id).toBe(rotated.turnId);
  expect(JSON.parse(headers.get("x-codex-turn-metadata")!).tool_namespaces_info).toBeUndefined();
  expect(JSON.parse(result.client_metadata["x-codex-turn-metadata"]).tool_namespaces_info).toEqual({ example: true });
  expect(request.input[1]).toEqual(current);
});

test("recovery input requires full context with one result for every historical call", () => {
  const call = { type: "function_call", call_id: "call_one", name: "bash", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "call_one", output: "failed: exit 7" };
  expect(hasCompleteRecoveryInput({ input: [{ role: "user", content: "Continue" }] })).toBe(true);
  expect(hasCompleteRecoveryInput({ input: [call, result] })).toBe(true);
  for (const input of [[call], [result], [call, result, result], [call, call, result], [{ type: "computer_call" }]]) {
    expect(hasCompleteRecoveryInput({ input })).toBe(false);
  }
  expect(hasCompleteRecoveryInput({ input: [call, result], previous_response_id: "resp_old" })).toBe(false);
});

test("silent stall retires first, replaces once and preserves successful replacement bytes", async () => {
  const first = fixture();
  const second = fixture();
  const order: string[] = [];
  const output = new Response(guardResponseStream(first.source, { timeoutMs: 30,
    onStall: async () => { order.push("retire"); await wait(5); }, onCancel: async () => {},
    onRecover: async () => {
      order.push("replace");
      second.send({ type: "response.created", response: { id: "resp_new" } });
      second.send({ type: "response.output_text.delta", delta: "RECOVERED" });
      second.send({ type: "response.completed", response: { id: "resp_new", status: "completed" } });
      second.close();
      return second.source;
    },
  })).text();
  first.send({ type: "response.created", response: { id: "resp_old" } });
  const text = await output;
  expect(order).toEqual(["retire", "replace"]);
  expect(first.cancels()).toBe(1);
  expect(text).toContain("RECOVERED");
  expect(text).not.toContain("chatgpt_web_recovery_stopped");
});

test("multiple silent stalls recover until output, while forwarded work prevents replay", async () => {
  {
    const f = fixture();
    let replacements = 0;
    let retired = 0;
    const output = new Response(guardResponseStream(f.source, { timeoutMs: 25,
      onStall: async () => { retired++; }, onCancel: async () => {},
      onRecover: async () => {
        replacements++;
        const next = fixture();
        if (replacements === 3) {
          next.send({ type: "response.output_text.delta", delta: "DONE_AFTER_THREE_STALLS" });
          next.send({ type: "response.completed", response: { status: "completed" } });
          next.close();
        }
        return next.source;
      },
    })).text();
    expect(await output).toContain("DONE_AFTER_THREE_STALLS");
    expect(replacements).toBe(3);
    expect(retired).toBe(3);
  }
  for (const event of [
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_new" } },
  ]) {
    const f = fixture();
    let replacements = 0;
    let retired = 0;
    const output = new Response(guardResponseStream(f.source, { timeoutMs: 25,
      onStall: async () => { retired++; }, onCancel: async () => {},
      onRecover: async () => { replacements++; return fixture().source; },
    })).text();
    if (event) f.send(event);
    expect(await output).toContain("chatgpt_web_semantic_progress_stalled");
    expect(replacements).toBe(0);
    expect(retired).toBe(1);
  }
});

test("failed retirement and structured platform errors never open a replacement", async () => {
  for (const platform of [false, true]) {
    const f = fixture();
    let replacements = 0;
    const output = new Response(guardResponseStream(f.source, { timeoutMs: 25,
      onStall: async () => { throw Error("local interruption unavailable"); }, onCancel: async () => {},
      onRecover: async () => { replacements++; return fixture().source; },
    })).text();
    if (platform) {
      f.send({ type: "error", code: "chatgpt_platform_tool_blocked", retryable: false });
      f.close();
    }
    expect(await output).toContain(platform ? "chatgpt_platform_tool_blocked" : "chatgpt_web_cleanup_unconfirmed");
    expect(replacements).toBe(0);
  }
});

test("downstream cancellation during replacement aborts fetch and retires only that turn", async () => {
  const f = fixture();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = 0;
  const reader = guardResponseStream(f.source, { timeoutMs: 20,
    onStall: async () => {}, onCancel: async () => { cancelled++; },
    onRecover: async signal => {
      entered();
      return await new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
      });
    },
  }).getReader();
  const pending = reader.read();
  await ready;
  await reader.cancel();
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(1);
});

test("retired source errors do not kill the replacement; late refusal blocks recovery", async () => {
  for (const refusal of [false, true]) {
    const f = fixture();
    let replacements = 0;
    const output = new Response(guardResponseStream(f.source, { timeoutMs: 25,
      onStall: async () => {
        if (refusal) f.send({ type: "error", code: "chatgpt_platform_tool_blocked", retryable: false });
        else f.error();
        await wait(5);
      }, onCancel: async () => {},
      onRecover: async () => {
        replacements++;
        const next = fixture();
        next.send({ type: "response.completed", response: { id: "resp_recovered", status: "completed" } });
        next.close();
        return next.source;
      },
    })).text();
    expect(await output).toContain(refusal ? "chatgpt_platform_tool_blocked" : "resp_recovered");
    expect(replacements).toBe(refusal ? 0 : 1);
  }
});

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
  expect(output).toContain('"code":"chatgpt_web_recovery_context_incomplete"');
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
  expect(text).not.toContain("chatgpt_web_recovery_stopped");
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
  expect(result.errorMessage).toContain("ChatGPT Web stalled");
  expect(result.errorMessage).not.toContain("SSE stream stalled");
  const AIError = await import(join(modulesRoot, "@oh-my-pi/pi-ai/src/error/index.ts"));
  expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
});

providerTest("actual OMP parser accepts replacement response identity within one request", async () => {
  const { streamOpenAICodexResponses } = await import(providerPath);
  const { getBundledModels } = await import(catalogPath);
  const model = { ...getBundledModels("openai-codex")[0], id: "chatgpt-web/gpt-5.6-sol", provider: "codex-chatgpt-web", baseUrl: "http://127.0.0.1:9999/v1" };
  let providerRequests = 0;
  let replacements = 0;
  const result = await streamOpenAICodexResponses(model, {
    messages: [{ role: "user", content: "Continue", timestamp: Date.now() }],
  }, {
    apiKey: "local-test", preferWebsockets: false, streamIdleTimeoutMs: 300,
    fetch: async () => {
      providerRequests++;
      const first = fixture();
      first.send({ type: "response.created", sequence_number: 0, response: { id: "resp_old", status: "in_progress", output: [] } });
      return new Response(guardResponseStream(first.source, { timeoutMs: 30,
        onStall: async () => {}, onCancel: async () => {},
        onRecover: async () => {
          replacements++;
          const second = fixture();
          const item = { type: "message", id: "msg_new", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RECOVERED", annotations: [] }] };
          second.send({ type: "response.created", sequence_number: 0, response: { id: "resp_new", status: "in_progress", output: [] } });
          second.send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
          second.send({ type: "response.content_part.added", item_id: "msg_new", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          second.send({ type: "response.output_text.delta", item_id: "msg_new", output_index: 0, content_index: 0, delta: "RECOVERED" });
          second.send({ type: "response.output_item.done", output_index: 0, item });
          second.send({ type: "response.completed", response: { id: "resp_new", status: "completed", output: [item] } });
          second.close();
          return second.source;
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  expect(providerRequests).toBe(1);
  expect(replacements).toBe(1);
  expect(result.stopReason).not.toBe("error");
  expect(result.content).toContainEqual({ type: "text", text: "RECOVERED", textSignature: expect.any(String) });
});

providerTest("actual OMP parser treats a structured platform rejection as terminal", async () => {
  const { streamOpenAICodexResponses, isRetryableCodexFailureEvent } = await import(providerPath);
  const { getBundledModels } = await import(catalogPath);
  const model = { ...getBundledModels("openai-codex")[0], id: "chatgpt-web/gpt-5.6-sol", provider: "codex-chatgpt-web", baseUrl: "http://127.0.0.1:9999/v1" };
  const event = {
    type: "error", code: "chatgpt_platform_tool_blocked", retryable: false,
    message: "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.",
  };
  expect(isRetryableCodexFailureEvent(event)).toBe(false);
  let requests = 0;
  const result = await streamOpenAICodexResponses(model, {
    messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
  }, {
    apiKey: "local-test", preferWebsockets: false,
    fetch: async () => {
      requests++;
      return new Response(frame(event), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  expect(requests).toBe(1);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("blocked by OpenAI");
});

providerTest("exhausted browser recovery does not enter OMP's generic network retry loop", async () => {
  const { streamOpenAICodexResponses } = await import(providerPath);
  const AIError = await import(join(modulesRoot, "@oh-my-pi/pi-ai/src/error/index.ts"));
  const { getBundledModels } = await import(catalogPath);
  const model = { ...getBundledModels("openai-codex")[0], id: "chatgpt-web/gpt-5.6-sol", provider: "codex-chatgpt-web", baseUrl: "http://127.0.0.1:9999/v1" };
  const previous = "Codex response failed: ChatGPT conversation request failed in the browser (network_error). The prompt may already have reached ChatGPT. (code=chatgpt_fetch_failed, status=failed)";
  expect(AIError.retriable(AIError.classifyMessage({ api: model.api, errorMessage: previous }))).toBe(true);
  const event = { type: "error", code: "chatgpt_recovery_stopped", status: 409, retryable: false,
    message: "ChatGPT browser recovery stopped (attempt_budget_exhausted). Tool outcomes already received by OMP remain in its session. See local recovery diagnostics." };
  let requests = 0;
  const result = await streamOpenAICodexResponses(model, {
    messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
  }, {
    apiKey: "local-test", preferWebsockets: false,
    fetch: async () => { requests++; return new Response(frame(event), { headers: { "content-type": "text/event-stream" } }); },
  }).result();
  expect(requests).toBe(1);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("chatgpt_recovery_stopped");
  expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
});

test("only the exact composer UI failure is normalized; real overload and tool content survive", () => {
  const message = "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.";
  for (const event of [
    { type: "error", code: "server_is_overloaded", message, retryable: true },
    { type: "error", error: { code: "server_is_overloaded", message }, message, retryable: true },
    { type: "response.failed", response: { error: { code: "server_is_overloaded", message } } },
  ]) {
    expect(normalizeComposerFailure(event)).toBe(true);
    const error = event.type === "error" ? event.error ?? event : event.response!.error;
    expect(error.code).toBe("chatgpt_composer_check_required");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("overload");
  }
  for (const event of [
    { type: "error", code: "server_is_overloaded", message: "Service is overloaded. Try later." },
    { type: "error", code: "chatgpt_tool_approval_required", message },
    { type: "response.output_text.delta", delta: message },
    { type: "response.output_item.done", item: { type: "function_call", arguments: JSON.stringify({ code: "server_is_overloaded", message }) } },
  ]) {
    const before = structuredClone(event);
    expect(normalizeComposerFailure(event)).toBe(false);
    expect(event).toEqual(before);
  }
});

providerTest("composer precondition stops OMP's outer overload retry loop after translation", async () => {
  const { streamOpenAICodexResponses } = await import(providerPath);
  const AIError = await import(join(modulesRoot, "@oh-my-pi/pi-ai/src/error/index.ts"));
  const { getBundledModels } = await import(catalogPath);
  const model = { ...getBundledModels("openai-codex")[0], id: "chatgpt-web/gpt-5.6-sol", provider: "codex-chatgpt-web", baseUrl: "http://127.0.0.1:9999/v1" };
  const message = "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.";
  expect(AIError.retriable(AIError.classifyMessage({ api: model.api, errorMessage: `Codex response failed: ${message} (code=server_is_overloaded, status=failed)` }))).toBe(true);
  for (const event of [
    { type: "error", code: "server_is_overloaded", message, retryable: true },
    { type: "error", error: { code: "server_is_overloaded", message }, message, retryable: true },
    { type: "response.failed", response: { status: "failed", error: { code: "server_is_overloaded", message } } },
  ]) {
    let requests = 0;
    const result = await streamOpenAICodexResponses(model, { messages: [{ role: "user", content: "Test", timestamp: Date.now() }] }, {
      apiKey: "local-test", preferWebsockets: false,
      fetch: async () => { requests++; return new Response(translateResponseStream(new Response(frame(event)).body!), { headers: { "content-type": "text/event-stream" } }); },
    }).result();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("chatgpt_composer_check_required");
    expect(AIError.retriable(AIError.classifyMessage(result))).toBe(false);
  }
});
