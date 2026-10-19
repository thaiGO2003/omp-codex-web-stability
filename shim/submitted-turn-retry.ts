// A submitted ChatGPT turn can fail before it yields any assistant content.
// Hold only its non-semantic SSE preamble until the outcome is known. This lets
// the shim replace that one failed turn without leaking a failed terminal event
// or replaying a tool call/output that was already exposed to OMP.
export class TemporarySubmissionTransportError extends Error {
  constructor(readonly httpStatus?: number) {
    super("Temporary upstream transport failure during submitted-turn recovery");
    this.name = "TemporarySubmissionTransportError";
  }
}

function frameDisposition(frame: string): "preamble" | "submitted_failure" | "forward" {
  const lines = frame.split("\n");
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!data) return lines.every(line => !line || line.startsWith(":") || line.startsWith("event:"))
    ? "preamble" : "forward";
  if (data === "[DONE]") return "forward";
  let value: Record<string, any>;
  try {
    value = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "forward";
  } catch { return "forward"; }
  if (value.type === "response.created" && (!Array.isArray(value.response?.output) || value.response.output.length === 0)) {
    return "preamble";
  }
  if (value.type === "response.heartbeat") return "preamble";
  const error = value.type === "response.failed" ? value.response?.error
    : value.type === "error" ? value.error ?? value : undefined;
  if (error?.code === "chatgpt_submitted_turn_failed"
    && (!Array.isArray(value.response?.output) || value.response.output.length === 0)) return "submitted_failure";
  return "forward";
}

function retryDelay(attempt: number): number {
  return attempt === 1 ? 2_000 : attempt === 2 ? 5_000 : Math.min(30_000, 10_000 * 2 ** Math.min(attempt - 3, 2));
}

function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function retrySubmittedTurnStream(source: ReadableStream<Uint8Array>, options: {
  signal?: AbortSignal;
  onRetry?: (attempt: number, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  onDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  const abort = () => stop.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let reader = source.getReader();
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let pending = "";
  let decoder = new TextDecoder();
  let forwarding = false;
  let retries = 0;
  let cancelled = false;
  const log = (event: string, fields: Record<string, unknown> = {}) => options.onDiagnostic?.(event, fields);
  const clearBuffer = () => { buffered = []; bufferedBytes = 0; pending = ""; decoder = new TextDecoder(); };
  const detach = () => options.signal?.removeEventListener("abort", abort);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const flush = () => {
        forwarding = true;
        for (const part of buffered) controller.enqueue(part);
        clearBuffer();
        if (retries) log("submitted_retry_resumed", { attempt: retries });
      };
      try {
        while (!cancelled) {
          if (stop.signal.aborted) throw stop.signal.reason ?? new DOMException("Cancelled", "AbortError");
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            if (!forwarding && buffered.length) flush();
            detach();
            controller.close();
            return;
          }
          if (forwarding) { controller.enqueue(value); return; }
          buffered.push(value);
          bufferedBytes += value.byteLength;
          // Normalize after appending, since CR and LF can arrive in separate chunks.
          pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          // Never retain arbitrary output in the retry buffer.
          if (bufferedBytes > 65_536) { flush(); return; }
          let retry = false;
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const kind = frameDisposition(frame);
            if (kind === "forward") { flush(); return; }
            if (kind === "submitted_failure") { retry = true; break; }
          }
          if (!retry) continue;
          if (!options.onRetry) {
            flush();
            detach();
            await reader.cancel("Submitted turn cannot be safely retried").catch(() => {});
            controller.close();
            return;
          }
          let attempt = retries + 1;
          log("submitted_retry_started", { attempt, errorCode: "chatgpt_submitted_turn_failed" });
          await reader.cancel("Retiring failed submitted turn").catch(() => {});
          while (true) {
            try {
              await (options.delay ?? cancellableDelay)(retryDelay(attempt), stop.signal);
              if (stop.signal.aborted) throw stop.signal.reason ?? new DOMException("Cancelled", "AbortError");
              const next = await options.onRetry(attempt, stop.signal);
              if (stop.signal.aborted || cancelled) {
                await next.cancel("Cancelled").catch(() => {});
                return;
              }
              reader = next.getReader();
              retries = attempt;
              forwarding = false;
              clearBuffer();
              break;
            } catch (error) {
              if (stop.signal.aborted || cancelled) throw error;
              if (error instanceof TemporarySubmissionTransportError) {
                log("submitted_retry_deferred", { attempt, httpStatus: error.httpStatus });
                retries = attempt;
                attempt++;
                continue;
              }
              log("submitted_retry_failed", { attempt, errorName: error instanceof Error ? error.name : "unknown" });
              // Preserve the structured failure if safe recovery was refused.
              flush();
              detach();
              controller.close();
              return;
            }
          }
        }
      } catch (error) {
        if (!cancelled) { detach(); controller.error(error); }
      }
    },
    async cancel(reason) {
      cancelled = true;
      stop.abort(reason);
      detach();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
