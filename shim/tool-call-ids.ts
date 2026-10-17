import { record } from "./compatibility";

const suffix = "_omp";
const callTypes = new Set([
  "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
  "computer_call", "computer_call_output",
]);

// OMP strips a trailing underscore and hashes lossy IDs. Browser broker IDs
// are base64url and can end in '_', so use a reversible safe suffix on the wire.
export function translateToolCallIds(value: unknown, direction: "to-omp" | "to-web"): void {
  if (Array.isArray(value)) {
    for (const item of value) translateToolCallIds(item, direction);
    return;
  }
  const item = record(value);
  if (!item) return;
  if (callTypes.has(String(item.type)) && typeof item.call_id === "string") {
    if (direction === "to-omp" && /^call_[A-Za-z0-9_-]{1,50}$/.test(item.call_id)) {
      item.call_id += suffix;
    } else if (direction === "to-web" && item.call_id.endsWith(suffix)) {
      item.call_id = item.call_id.slice(0, -suffix.length);
    }
  }
  // Do not rewrite tool arguments or user-supplied metadata.
  for (const key of ["input", "output", "item", "response"]) {
    if (item[key] !== undefined) translateToolCallIds(item[key], direction);
  }
}

export function translateResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  function rewriteLine(line: string): string {
    if (!line.startsWith("data:")) return line;
    try {
      const value = JSON.parse(line.slice(5).trim());
      normalizeComposerFailure(value);
      translateToolCallIds(value, "to-omp");
      return "data: " + JSON.stringify(value);
    } catch {
      return line;
    }
  }
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        controller.enqueue(encoder.encode(rewriteLine(line) + "\n"));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewriteLine(pending)));
    },
  }));
}

// This UI precondition is often mislabeled as server overload. OMP also scans
// the rendered error text, so retryable:false alone does not stop its outer
// retry loop. Do not claim sign-out universally: slow/changed UI can also hide
// the composer. Preserve every other provider error, including real overload.
export function normalizeComposerFailure(value: unknown): boolean {
  const event = record(value);
  if (!event) return false;
  const error = event.type === "error" ? record(event.error) ?? event
    : event.type === "response.failed" ? record(record(event.response)?.error) : undefined;
  if (!error || error.code !== "server_is_overloaded"
    || error.message !== "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.") return false;
  error.code = "chatgpt_composer_check_required";
  error.message = "ChatGPT input needs attention. Open the ChatGPT tab and verify sign-in, then continue the existing OMP session. Automatic attempts have stopped.";
  error.retryable = false;
  error.status = 409;
  error.type = error === event ? "error" : "invalid_request_error";
  if (event.type === "error" && error !== event) {
    // Both fields can be present; OMP's formatter reads the outer message.
    event.message = error.message;
    event.code = error.code;
  }
  event.retryable = false;
  return true;
}
