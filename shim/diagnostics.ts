import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const diagnosticEvents = new Set([
  "shim_started", "request_received", "request_rewrite_failed", "local_response", "queue_wait", "queue_acquired",
  "upstream_headers", "upstream_error", "stream_started", "stream_progress", "stream_terminal", "stream_eof",
  "stream_error", "stream_cancelled", "semantic_timeout", "cleanup_started", "cleanup_completed", "cleanup_failed", "cleanup_retrying",
  "recovery_started", "recovery_lifecycle", "recovery_connecting", "recovery_connect_deferred", "recovery_connected", "recovery_failed", "recovery_stopped", "request_finished",
  "submitted_retry_started", "submitted_retry_deferred", "submitted_retry_resumed", "submitted_retry_failed", "submitted_retry_blocked",
]);
const eventTypes = new Set([
  "response.created", "response.completed", "response.incomplete", "response.done", "response.failed", "error",
  ...["output_item", "content_part", "reasoning_summary_part"].flatMap(t => ["added", "done"].map(s => `response.${t}.${s}`)),
  ...["output_text", "reasoning_text", "reasoning_summary_text", "refusal", "function_call_arguments", "custom_tool_call_input"]
    .flatMap(t => ["delta", "done"].map(s => `response.${t}.${s}`)),
]);
const errorCodes = new Set([
  "chatgpt_fetch_failed", "chatgpt_submission_ambiguous", "chatgpt_submitted_turn_failed", "model_version_unavailable",
  "connector_not_found", "chatgpt_web_semantic_timeout", "chatgpt_web_recovery_stopped", "network_error",
  "chatgpt_web_interrupt_timeout", "chatgpt_web_interrupt_unreachable", "chatgpt_web_interrupt_http_rejected",
  "chatgpt_web_interrupt_invalid_ack", "chatgpt_web_interrupt_auth_unavailable", "chatgpt_web_cleanup_unconfirmed",
  "chatgpt_web_native_unverified", "chatgpt_web_recovery_connect_failed", "chatgpt_web_semantic_progress_stalled",
  "chatgpt_web_recovery_exhausted", "chatgpt_web_recovery_context_incomplete",
  "chatgpt_submitted_retry_context_incomplete", "chatgpt_submitted_retry_blocked",
  "chatgpt_submitted_retry_health_rejected", "chatgpt_submitted_retry_http_rejected", "chatgpt_submitted_retry_invalid_stream",
  "server_is_overloaded", "chatgpt_composer_check_required",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "UND_ERR_SOCKET",
]);
const numericFields = new Set([
  "elapsedMs", "queueMs", "timeoutMs", "idleMs", "events", "bytes", "recoveries", "httpStatus", "inputItems",
  "cancelledHttpTurns", "cancelledBrowserTurns", "attempt",
]);
const booleanFields = new Set(["sawOutput", "terminal", "recoveryEligible", "lifecycleVerified", "queued", "sse"]);
const identityFields = new Set(["logicalThreadId", "logicalTurnId", "nativeThreadId", "nativeTurnId", "responseId"]);
// Mirror state transitions and occasional progress to the visible PowerShell
// window. The same allowlisted fields used on disk prevent prompt/tool leaks.
const consoleEvents = new Set([
  "shim_started", "request_received", "upstream_headers", "upstream_error", "stream_started",
  "stream_progress", "stream_terminal", "stream_error", "semantic_timeout", "request_finished",
  "cleanup_failed", "cleanup_retrying", "recovery_started", "recovery_connect_deferred", "recovery_connected", "recovery_failed", "recovery_stopped",
  "submitted_retry_started", "submitted_retry_deferred", "submitted_retry_resumed", "submitted_retry_failed", "submitted_retry_blocked",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A positive schema, rather than a secret-pattern blacklist: never accept text,
// paths, headers, messages, tool data, or arbitrary error strings.
export function diagnosticFields(fields: Record<string, unknown>, alreadyHashed = false) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = Math.round(value);
    else if (booleanFields.has(key) && typeof value === "boolean") safe[key] = value;
    else if (identityFields.has(key) && typeof value === "string" && value) {
      if (!alreadyHashed) safe[key] = createHash("sha256").update(value).digest("hex").slice(0, 16);
      else if (/^[a-f0-9]{16}$/.test(value)) safe[key] = value;
    } else if (key === "requestId" && typeof value === "string" && uuid.test(value)) safe[key] = value;
    else if (key === "eventType") safe[key] = eventTypes.has(String(value)) ? value : "unknown";
    else if (key === "errorCode") safe[key] = errorCodes.has(String(value)) ? value : "unknown";
    else if (key === "errorName") safe[key] = ["Error", "TypeError", "AbortError", "TimeoutError", "SyntaxError", "TemporarySubmissionTransportError", "NativeInterruptionError"].includes(String(value)) ? value : "Error";
    else if (key === "outcome") safe[key] = ["eof", "error", "cancelled", "no_body", "local", "http_error"].includes(String(value)) ? value : "unknown";
    else if (key === "phase") safe[key] = ["stall", "cancel", "retire", "health", "connect", "submitted_failure"].includes(String(value)) ? value : "unknown";
    else if (key === "reason") safe[key] = ["timeout", "transport", "http_transient"].includes(String(value)) ? value : "unknown";
  }
  return safe;
}

export function errorFields(error: unknown) {
  // Deliberately discard message/stack; inspect only a whitelisted cause code.
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
  return diagnosticFields({ errorName: value.name, errorCode: value.code ?? cause.code });
}

export function defaultLogDirectory() {
  return process.env.OMP_CODEX_WEB_LOG_DIR || join(process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), ".codex-chatgpt-web"), "diagnostics", "omp-shim");
}

export function sanitizeLogRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!diagnosticEvents.has(String(row.event)) || typeof row.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.at)
    || !Number.isFinite(Date.parse(row.at)) || typeof row.runId !== "string" || !uuid.test(row.runId)) return undefined;
  return { schema: 1, at: row.at, runId: row.runId, event: row.event,
    ...(Number.isSafeInteger(row.seq) && Number(row.seq) >= 0 ? { seq: row.seq } : {}),
    ...(Number.isSafeInteger(row.pid) && Number(row.pid) > 0 ? { pid: row.pid } : {}),
    ...diagnosticFields(row, true) };
}

export class DiagnosticLog {
  readonly runId = randomUUID();
  private sequence = 0;
  private failedWrites = 0;
  constructor(readonly directory = defaultLogDirectory(), private maxBytes = 2 * 1024 * 1024,
    private fileCount = 5, private mirrorConsole = process.env.OMP_CODEX_WEB_CONSOLE_LOG !== "0") {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 20) throw new Error("Invalid diagnostic retention");
  }
  status() { return { enabled: true, consoleEnabled: this.mirrorConsole, runId: this.runId, directory: this.directory,
    maxBytes: this.maxBytes, fileCount: this.fileCount, failedWrites: this.failedWrites }; }
  log(event: string, fields: Record<string, unknown> = {}) {
    if (!diagnosticEvents.has(event)) return;
    const safeFields = diagnosticFields(fields);
    if (this.mirrorConsole && consoleEvents.has(event)) {
      try { console.info(`[OMP shim] ${event}`, safeFields); }
      catch { /* Console mirroring is best-effort, just like disk diagnostics. */ }
    }
    try {
      const line = JSON.stringify({ schema: 1, at: new Date().toISOString(), runId: this.runId, pid: process.pid,
        seq: ++this.sequence, event, ...safeFields }) + "\n";
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("Diagnostic record exceeds retention budget");
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      const path = join(this.directory, "shim.jsonl");
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > this.maxBytes) {
        const last = this.fileCount === 1 ? path : `${path}.${this.fileCount - 1}`;
        if (existsSync(last)) unlinkSync(last);
        for (let i = this.fileCount - 2; i >= 0; i--) {
          const from = i === 0 ? path : `${path}.${i}`;
          if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
        }
      }
      appendFileSync(path, line, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Observability must never abort or change a model request.
      if (++this.failedWrites === 1) console.warn("OMP diagnostics_write_failed");
    }
  }
}
