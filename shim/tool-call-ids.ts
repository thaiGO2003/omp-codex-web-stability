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
