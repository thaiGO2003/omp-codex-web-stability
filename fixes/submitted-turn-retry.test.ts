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

test("a rejected recovery or missing recovery handler exposes original structured failure", async () => {
  const input = failedSource();
  let attempted = 0;
  const output = await new Response(retrySubmittedTurnStream(input.input, {
    delay: async () => {},
    onRetry: async () => { attempted++; throw Error("native refusal"); },
  })).text();
  expect(attempted).toBe(1);
  expect(output).toContain("chatgpt_submitted_turn_failed");
  expect(input.cancels()).toBe(1);
  expect(await new Response(retrySubmittedTurnStream(failedSource().input, {})).text())
    .toContain("chatgpt_submitted_turn_failed");
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
