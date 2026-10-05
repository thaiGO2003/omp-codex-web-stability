// Transport heartbeats prove the socket is alive, not that a model turn progresses.
// Keep the budget below OMP's 300s semantic watchdog so we can retire the Web turn.
export function guardResponseStream(source: ReadableStream<Uint8Array>, options: {
  timeoutMs?: number;
  onStall: () => Promise<void>;
  onCancel: () => Promise<void>;
}): ReadableStream<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let terminal = false;
  let responseId = "";
  let sequence = 0;
  let cleanup: Promise<void> | undefined;
  let observe: (chunk: Uint8Array) => void = () => {};
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const retire = (callback: () => Promise<void>) => cleanup ??= callback().catch(error => {
    console.warn("OMP Web turn cleanup failed", error instanceof Error ? error.message : String(error));
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = () => {
        clear();
        if (closed || terminal) return;
        timer = setTimeout(async () => {
          if (closed || terminal) return;
          closed = true;
          console.warn("OMP Web semantic timeout", { timeoutMs, responseId });
          // Cancel this native turn before the client can retry into the old broker.
          await retire(options.onStall);
          const failure = { type: "response.failed", sequence_number: sequence++, response: {
            id: responseId || "resp_omp_stalled", status: "failed", output: [],
            error: { type: "server_error", code: "chatgpt_web_semantic_timeout",
              message: "ChatGPT Web made no semantic progress for the configured timeout; the stuck Web turn was interrupted. Send a new continue message to resume." },
          } };
          try {
            controller.enqueue(encoder.encode(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`));
            controller.close();
          } catch { /* downstream may already be gone */ }
          void reader.cancel("ChatGPT Web semantic timeout").catch(() => {});
        }, timeoutMs);
      };
      // Only complete Responses events count. Comments and response.heartbeat do not.
      observe = (chunk: Uint8Array) => {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            if (typeof event.sequence_number === "number") sequence = Math.max(sequence, event.sequence_number + 1);
            if (typeof event.response?.id === "string") responseId = event.response.id;
            if (["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)) {
              terminal = true;
              clear();
            } else if (event.type === "response.created" || /^response\.(output_item|content_part|reasoning_summary_part)\.(added|done)$/.test(event.type)
              || /^response\.(output_text|reasoning_text|reasoning_summary_text|refusal|function_call_arguments|custom_tool_call_input)\.(delta|done)$/.test(event.type)) {
              arm();
            }
          } catch { /* comments, [DONE], or invalid JSON: leave original bytes intact */ }
        }
      };
      arm();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          closed = true;
          clear();
          controller.close();
        } else {
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        clear();
        if (!terminal) await retire(options.onCancel);
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      clear();
      if (!terminal) await retire(options.onCancel);
      await reader.cancel(reason).catch(() => {});
    },
  });
}
