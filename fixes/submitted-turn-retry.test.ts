import { expect, test } from "bun:test";
import { retrySubmittedTurnStream, TemporarySubmissionTransportError } from "../shim/submitted-turn-retry";

const encoder = new TextEncoder();
const created = { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } };
const submittedFailure = { type: "response.failed", response: { id: "resp_fixture", status: "failed", output: [],
  error: { code: "chatgpt_submitted_turn_failed", message: "ChatGPT stopped responding after the task started" } } };
const completed = { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [] } };
const event = (value: unknown, crlf = false) => `event: ${(value as any).type}\ndata: ${JSON.stringify(value)}\n\n`.replace(/\n/g, crlf ? "\r\n" : "\n");
function source(frames: string[], split = false, keepOpen = false) {
  let cancelled = 0;
  const text = frames.join("");
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      if (split) {
        // Split in the middle of CRLF boundaries, not just SSE frames.
        for (let i = 0; i < text.length; i++) controller.enqueue(encoder.encode(text[i]));
      } else controller.enqueue(encoder.encode(text));
      if (!keepOpen) controller.close();
    },
    cancel() { cancelled++; },
  });
  return { input, cancels: () => cancelled };
}
const failedSource = (crlf = false, split = false) => source([event(created, crlf), event(submittedFailure, crlf)], split, true);

const connectorFailure = { type: "response.failed", response: { id: "resp_fixture", status: "failed", output: [],
  error: { code: "connector_not_found", message: "ChatGPT connector menu did not open after 3 complete mention trigger attempt(s)" } } };

test("retries a connector lookup failure before Send without losing the task history", async () => {
  let attempts = 0;
  const output = await new Response(retrySubmittedTurnStream(source([event(created), event(connectorFailure)]).input, {
    delay: async () => {},
    onRetry: async attempt => {
      attempts = attempt;
      if (attempt < 4) return source([event(created), event(connectorFailure)]).input;
      return source([event(created), event({ type: "response.output_text.delta", delta: "CONNECTOR_RECOVERED" }), event(completed)]).input;
    },
  })).text();
  expect(attempts).toBe(4);
  expect(output).toContain("CONNECTOR_RECOVERED");
  expect(output).not.toContain("connector_not_found");
});

test("blocks connector lookup retry after a tool event or without safe replay ownership", async () => {
  let calls = 0;
  const exposed = await new Response(retrySubmittedTurnStream(source([event(created),
    event({ type: "response.output_item.added", item: { type: "function_call", call_id: "danger" } }),
    event(connectorFailure)]).input, {
    delay: async () => {}, onRetry: async () => { calls++; return failedSource().input; },
  })).text();
  expect(calls).toBe(0);
  expect(exposed).toContain("connector_not_found");
  const incomplete = await new Response(retrySubmittedTurnStream(source([event(created), event(connectorFailure)]).input, {})).text();
  expect(incomplete).toContain("chatgpt_submitted_retry_context_incomplete");
});

test("does not replay unrelated connector_not_found failures", async () => {
  let calls = 0;
  const unsafe = { type: "response.failed", response: { id: "resp_fixture", status: "failed", output: [],
    error: { code: "connector_not_found", message: "Connector catalog became unavailable after send" } } };
  const output = await new Response(retrySubmittedTurnStream(source([event(created), event(unsafe)]).input, {
    delay: async () => {}, onRetry: async () => { calls++; return failedSource().input; },
  })).text();
  expect(calls).toBe(0);
  expect(output).toContain("Connector catalog became unavailable after send");
});

test("retries repeated submitted-turn failures until actual completion; hides retired preambles", async () => {
  const first = failedSource(true, true);
  let attempts = 0;
  const output = await new Response(retrySubmittedTurnStream(first.input, {
    delay: async () => {},
    onRetry: async attempt => {
      attempts = attempt;
      if (attempt < 3) return failedSource().input;
      return source([event(created), event({ type: "response.output_text.delta", delta: "RECOVERED" }), event(completed)]).input;
    },
  })).text();
  expect(attempts).toBe(3);
  expect(first.cancels()).toBe(1);
  expect(output).toContain("RECOVERED");
  expect(output).toContain("response.completed");
  expect(output).not.toContain("chatgpt_submitted_turn_failed");
  expect((output.match(/event: response.created/g) ?? []).length).toBe(1);
});

test("recovers premature SSE EOF until a real completion event arrives", async () => {
  let attempts = 0;
  const output = await new Response(retrySubmittedTurnStream(source([event(created)]).input, {
    delay: async () => {},
    onRetry: async () => {
      attempts++;
      return attempts < 3 ? source([event(created)]).input
        : source([event(created), event({ type: "response.output_text.delta", delta: "COMPLETE" }), event(completed)]).input;
    },
  })).text();
  expect(attempts).toBe(3);
  expect(output).toContain("COMPLETE");
  expect(output).toContain("response.completed");
  expect(output).not.toContain("Upstream SSE closed");
});

test("does not retry a truncated SSE frame with an unknown outcome", async () => {
  let attempts = 0;
  const output = await new Response(retrySubmittedTurnStream(source([event(created), "data: {incomplete"] ).input, {
    delay: async () => {},
    onRetry: async () => { attempts++; return failedSource().input; },
  })).text();
  expect(attempts).toBe(0);
  expect(output).toContain("data: {incomplete");
});

test("transient HTTP and network failures keep the original submission buffered until recovery", async () => {
  const delays: number[] = [];
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const attempts: number[] = [];
  const text = await new Response(retrySubmittedTurnStream(failedSource().input, {
    delay: async ms => { delays.push(ms); },
    onDiagnostic: (event, fields) => events.push({ event, fields }),
    onRetry: async attempt => {
      attempts.push(attempt);
      if (attempt === 1) throw new TemporarySubmissionTransportError(502);
      if (attempt === 2) throw new TemporarySubmissionTransportError();
      return source([event(created), event({ type: "response.output_text.delta", delta: "HTTP_RECOVERED" }), event(completed)]).input;
    },
  })).text();
  expect(attempts).toEqual([1, 2, 3]);
  expect(delays).toEqual([2000, 5000, 10000]);
  expect(events.filter(item => item.event === "submitted_retry_deferred")).toHaveLength(2);
  expect(events.some(item => item.event === "submitted_retry_resumed")).toBe(true);
  expect(text).toContain("HTTP_RECOVERED");
  expect(text).not.toContain("chatgpt_submitted_turn_failed");
});

test("abort interrupts a transient network retry before a new submission", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const deferred = new Promise<void>(resolve => { entered = resolve; });
  let attempts = 0;
  const reader = retrySubmittedTurnStream(failedSource().input, {
    signal: abort.signal,
    delay: async (_ms, signal) => {
      if (attempts === 0) return;
      entered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
    },
    onRetry: async () => { attempts++; throw new TemporarySubmissionTransportError(503); },
  }).getReader();
  const read = reader.read();
  await deferred;
  abort.abort();
  await expect(read).rejects.toThrow();
  expect(attempts).toBe(1);
});

test("does not retry after semantic content, tool calls, refusals, or different errors", async () => {
  for (const extra of [
    { type: "response.output_text.delta", delta: "already started" },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "new_tool" } },
    { type: "response.refusal.delta", delta: "refused" },
    { type: "error", error: { code: "chatgpt_platform_tool_blocked", retryable: false } },
  ]) {
    let attempts = 0;
    const input = source([event(created), event(extra), event(submittedFailure)]).input;
    const result = await new Response(retrySubmittedTurnStream(input, {
      delay: async () => {}, onRetry: async () => { attempts++; return failedSource().input; },
    })).text();
    expect(attempts).toBe(0);
    expect(result).toContain(JSON.stringify(extra));
  }
});

test("rejected recovery and missing history expose distinct actionable errors", async () => {
  const input = failedSource();
  let attempted = 0;
  const output = await new Response(retrySubmittedTurnStream(input.input, {
    delay: async () => {},
    onRetry: async () => { attempted++; throw Error("native refusal"); },
  })).text();
  expect(attempted).toBe(1);
  expect(output).toContain("chatgpt_submitted_retry_blocked");
  expect(output).not.toContain("chatgpt_submitted_turn_failed");
  expect(input.cancels()).toBe(1);
  expect(await new Response(retrySubmittedTurnStream(failedSource().input, {})).text())
    .toContain("chatgpt_submitted_retry_context_incomplete");
});

test("failed scoped cancellation keeps the original OMP session and names the actual blocker", async () => {
  const err = Object.assign(new Error("private upstream detail"), { code: "chatgpt_web_interrupt_timeout" });
  const output = await new Response(retrySubmittedTurnStream(failedSource().input, {
    delay: async () => {}, onRetry: async () => { throw err; },
  })).text();
  expect(output).toContain('"code":"chatgpt_web_interrupt_timeout"');
  expect(output).toContain("cancellation could not be confirmed");
  expect(output).not.toContain("private upstream detail");
});

test("downstream cancellation aborts pending retries", async () => {
  const abort = new AbortController();
  let wake!: () => void;
  const entered = new Promise<void>(resolve => { wake = resolve; });
  let attempts = 0;
  const wrapped = retrySubmittedTurnStream(failedSource().input, {
    signal: abort.signal,
    delay: async (_ms, signal) => {
      wake();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
    },
    onRetry: async () => { attempts++; return failedSource().input; },
  });
  const reader = wrapped.getReader();
  const reading = reader.read();
  await entered;
  abort.abort();
  await expect(reading).rejects.toThrow();
  expect(attempts).toBe(0);
});
