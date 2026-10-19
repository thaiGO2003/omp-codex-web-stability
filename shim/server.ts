import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { guardResponseStream, hasCompleteRecoveryInput } from "./sse-watchdog";
import { RecoveryIdentityStore } from "./sse-watchdog";
import { record, addCodexEnvironment } from "./compatibility";
import { taskLabelResponse } from "./task-label";
import { translateToolCallIds, translateResponseStream } from "./tool-call-ids";
import { DiagnosticLog, errorFields } from "./diagnostics";
import { retrySubmittedTurnStream, TemporarySubmissionTransportError } from "./submitted-turn-retry";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.OMP_CODEX_WEB_SHIM_PORT || 3007);
const upstreamOrigin = process.env.OMP_CODEX_WEB_UPSTREAM || "http://127.0.0.1:17841";
const cwdHeader = "x-omp-cwd";
const diagnostics = new DiagnosticLog();
// Native releases cancelled browser owners and tombstones their thread/turn IDs.
// Versions outside this verified set must not receive automatic re-submissions.
// 6.1.11 retains /admin/interrupt-turn's scoped cancellation acknowledgement
// and the native owner retirement logic present in 6.1.10.
const verifiedRetirementVersions = new Set(["6.1.7", "6.1.9", "6.1.10", "6.1.11"]);


async function interruptNativeTurn(threadId: string | undefined, turnId: string | undefined) {
  if (!threadId || !turnId) return;
  const configPath = join(process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), ".codex-chatgpt-web"), "config.json");
  const config = await Bun.file(configPath).json();
  if (typeof config.controlToken !== "string") throw new Error("Missing local Web control token");
  const result = await fetch(new URL("/admin/interrupt-turn", upstreamOrigin), {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId, turnId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error(`Native turn interruption HTTP ${result.status}`);
  const acknowledgement = await result.json();
  if (acknowledgement.status !== "ok"
    || !Number.isInteger(acknowledgement.cancelled_http_turns) || acknowledgement.cancelled_http_turns < 0
    || !Number.isInteger(acknowledgement.cancelled_browser_turns) || acknowledgement.cancelled_browser_turns < 0) {
    throw new Error("Native turn interruption returned an invalid acknowledgement");
  }
  return acknowledgement;
}

const threadTails = new Map<string, Promise<void>>();
const recoveryIdentities = new RecoveryIdentityStore();

async function acquireThread(threadId: string) {
  const previous = threadTails.get(threadId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  threadTails.set(threadId, tail);

  await previous.catch(() => {});

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (threadTails.get(threadId) === tail) threadTails.delete(threadId);
  };
}

function releaseWhenDone(stream: ReadableStream<Uint8Array>, release: () => void, finish: (outcome: string) => void) {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          finish("eof");
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        finish("error");
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      finish("cancelled");
      try {
        await reader.cancel(reason);
      } catch {
        // The downstream is already gone; the queue still must be released.
      }
    },
  });
}

function threadIdFromMetadata(raw?: string) {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw)?.thread_id;
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

Bun.serve({
  hostname: listenHost,
  port: listenPort,
  // Browser generation can remain silent while ChatGPT loads or reasons.
  idleTimeout: 0,
  async fetch(req) {
    const incoming = new URL(req.url);
    if (incoming.pathname === "/omp-shim-health") {
      return Response.json({ service: "omp-codex-web-shim", upstreamOrigin, listenPort, diagnostics: diagnostics.status() });
    }
    let pathname = incoming.pathname;

    if (pathname === "/v1/codex/responses") pathname = "/v1/responses";
    if (pathname === "/v1/codex/responses/compact") pathname = "/v1/responses/compact";

    const upstreamUrl = new URL(pathname + incoming.search, upstreamOrigin);
    const headers = new Headers(req.headers);
    const requestCwd = headers.get(cwdHeader)?.trim();
    const headerTurnMetadata = headers.get("x-codex-turn-metadata") ?? undefined;
    let threadId = threadIdFromMetadata(headerTurnMetadata);
    let turnId: string | undefined;
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let logLogicalThreadId = threadId;
    let logLogicalTurnId: string | undefined;
    const log = (event: string, fields: Record<string, unknown> = {}) => diagnostics.log(event, {
      requestId, logicalThreadId: logLogicalThreadId, logicalTurnId: logLogicalTurnId,
      nativeThreadId: threadId, nativeTurnId: turnId, elapsedMs: Date.now() - startedAt, ...fields,
    });
    let finished = false;
    const finish = (outcome: string) => { if (!finished) { finished = true; log("request_finished", { outcome }); } };
    const interrupt = async (phase: string) => {
      log("cleanup_started", { phase });
      try {
        const ack = await interruptNativeTurn(threadId, turnId);
        log("cleanup_completed", { phase, cancelledHttpTurns: ack?.cancelled_http_turns, cancelledBrowserTurns: ack?.cancelled_browser_turns });
      } catch (error) { log("cleanup_failed", { phase, ...errorFields(error) }); throw error; }
    };
    log("request_received");
    headers.delete("host");
    headers.delete(cwdHeader);

    let body: BodyInit | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const bytes = new Uint8Array(await req.arrayBuffer().catch(error => { log("upstream_error", errorFields(error)); finish("error"); throw error; }));
      body = bytes;
      if (incoming.pathname === "/v1/codex/responses"
        && headers.get("content-type")?.includes("application/json")) {
        try {
          const parsed = record(JSON.parse(new TextDecoder().decode(bytes)));
          const labelResponse = parsed && taskLabelResponse(parsed);
          if (labelResponse) {
            log("local_response");
            finish("local");
            return labelResponse;
          }
          const sessionCwd = typeof parsed?.__omp_cwd === "string" && isAbsolute(parsed.__omp_cwd)
            ? parsed.__omp_cwd : requestCwd;
          if (parsed) delete parsed.__omp_cwd;
          if (parsed) translateToolCallIds(parsed, "to-web");
          const rewrittenTurnMetadata = parsed && sessionCwd
            ? addCodexEnvironment(parsed, sessionCwd, headerTurnMetadata)
            : undefined;
          const environmentAdded = Boolean(rewrittenTurnMetadata);
          if (parsed && environmentAdded) {
            body = JSON.stringify(parsed);
            // Keep the header projection small; the tool registry belongs in the body.
            const metadata = JSON.parse(rewrittenTurnMetadata!);
            if (typeof metadata.turn_id === "string") turnId = metadata.turn_id;
            if (typeof metadata.thread_id === "string" && metadata.thread_id) threadId = metadata.thread_id;
            const { tool_namespaces_info: _tools, ...headerMetadata } = metadata;
            headers.set("x-codex-turn-metadata", JSON.stringify(headerMetadata).replace(
              /[\x7f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
            ));
            logLogicalThreadId = threadId;
            logLogicalTurnId = turnId;
            headers.delete("content-length");
          }
        } catch (error) {
          log("request_rewrite_failed", errorFields(error));
          // Forward the original body unchanged; upstream will return the real protocol error.
        }
      }
    }

    const shouldSerialize = Boolean(threadId)
      && (incoming.pathname === "/v1/codex/responses" || incoming.pathname === "/v1/codex/responses/compact");
    const queueStartedAt = Date.now();
    const queued = Boolean(shouldSerialize && threadTails.has(threadId!));
    if (queued) log("queue_wait", { queued });
    const releaseThread = shouldSerialize ? await acquireThread(threadId!) : undefined;
    log("queue_acquired", { queued, queueMs: Date.now() - queueStartedAt });

    const logicalThreadId = threadId;
    const logicalTurnId = turnId;
    // Resolve after acquiring the logical queue: another round may have rotated
    // the owner while this request waited. Never attach to that retired session.
    let upstream: Response;
    try {
      if (logicalThreadId && logicalTurnId && typeof body === "string") {
        const owner = recoveryIdentities.resolve(logicalThreadId, logicalTurnId)
          ?? (hasCompleteRecoveryInput(JSON.parse(body)) ? recoveryIdentities.rotate(logicalThreadId, logicalTurnId) : undefined);
        if (owner) {
          body = recoveryIdentities.rebind(body, headers, owner);
          threadId = owner.threadId;
          turnId = owner.turnId;
        }
      }
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: req.signal,
      });
    } catch (error) {
      log("upstream_error", errorFields(error));
      finish("error");
      releaseThread?.();
      throw error;
    }

    const isOmpStream = incoming.pathname === "/v1/codex/responses"
      && upstream.headers.get("content-type")?.includes("text/event-stream") && upstream.body;
    log("upstream_headers", { httpStatus: upstream.status, sse: Boolean(isOmpStream) });
    const responseHeaders = new Headers(upstream.headers);
    if (isOmpStream) responseHeaders.delete("content-length");
    let eligibleHistory = false;
    if (isOmpStream && typeof body === "string") {
      try { eligibleHistory = hasCompleteRecoveryInput(JSON.parse(body)); }
      catch { /* The upstream response owns invalid requests. */ }
    }
    const guardedBody = isOmpStream && threadId && turnId ? guardResponseStream(upstream.body!, {
      onDiagnostic: log,
      onStall: () => interrupt("stall"),
      onCancel: () => interrupt("cancel"),
      onRecover: eligibleHistory
        ? async signal => {
          // This native version waits for the old owner's physical retirement.
          const health = await fetch(new URL("/healthz", upstreamOrigin), {
            signal: AbortSignal.any([req.signal, signal, AbortSignal.timeout(5000)]),
          });
          log("upstream_headers", { phase: "health", httpStatus: health.status });
          const lifecycleVerified = health.ok && verifiedRetirementVersions.has((await health.json()).version);
          log("recovery_lifecycle", { lifecycleVerified });
          if (!lifecycleVerified) {
            throw new Error("Silent recovery requires a verified Codex Web retirement lifecycle");
          }
          // The old identity is permanently cancelled by the native runtime.
          // Fresh thread ownership also prevents reuse of its terminated MCP chat.
          const owner = recoveryIdentities.rotate(logicalThreadId!, logicalTurnId!);
          body = recoveryIdentities.rebind(body as string, headers, owner);
          threadId = owner.threadId;
          turnId = owner.turnId;
          const connect = new AbortController();
          const deadline = setTimeout(() => connect.abort(), 20_000);
          log("recovery_connecting", { phase: "connect", attempt: 1 });
          let replacement: Response;
          try {
            replacement = await fetch(upstreamUrl, {
              method: req.method, headers, body, redirect: "manual",
              signal: AbortSignal.any([req.signal, signal, connect.signal]),
            });
          } finally { clearTimeout(deadline); }
          // The connection deadline ends at headers; generation keeps its semantic budget.
          log("upstream_headers", { httpStatus: replacement.status, sse: Boolean(replacement.headers.get("content-type")?.includes("text/event-stream")), attempt: 1 });
          if (!replacement.ok || !replacement.body || !replacement.headers.get("content-type")?.includes("text/event-stream")) {
            await replacement.body?.cancel();
            throw new Error(`Silent recovery upstream HTTP ${replacement.status}; expected SSE`);
          }
          return replacement.body;
        } : undefined,
    }) : upstream.body;
    const submittedRetry = isOmpStream && upstream.status === 200 && threadId && turnId && guardedBody
      ? retrySubmittedTurnStream(guardedBody, {
        signal: req.signal,
        onDiagnostic: log,
        onRetry: eligibleHistory ? async (attempt, signal) => {
          // A failed submission is not evidence that its old browser has stopped.
          // Require the verified retirement lifecycle before allocating a new
          // native identity; old thread/turn IDs may be tombstoned after abort.
          let health: Response;
          try {
            health = await fetch(new URL("/healthz", upstreamOrigin), {
              signal: AbortSignal.any([req.signal, signal, AbortSignal.timeout(5000)]),
            });
          } catch (error) {
            if (req.signal.aborted || signal.aborted) throw error;
            throw new TemporarySubmissionTransportError();
          }
          if (health.status === 429 || health.status >= 500) {
            await health.body?.cancel().catch(() => {});
            throw new TemporarySubmissionTransportError(health.status);
          }
          if (!health.ok || !verifiedRetirementVersions.has((await health.json()).version)) {
            throw new Error("Submitted-turn recovery requires a verified native retirement lifecycle");
          }
          await interrupt("submitted_failure");
          const owner = recoveryIdentities.rotate(logicalThreadId!, logicalTurnId!);
          body = recoveryIdentities.rebind(body as string, headers, owner);
          threadId = owner.threadId;
          turnId = owner.turnId;
          const connect = new AbortController();
          const deadline = setTimeout(() => connect.abort(), 20_000);
          let replacement: Response;
          try {
            replacement = await fetch(upstreamUrl, {
              method: req.method, headers, body, redirect: "manual",
              signal: AbortSignal.any([req.signal, signal, connect.signal]),
            });
          } catch (error) {
            if (req.signal.aborted || signal.aborted) throw error;
            throw new TemporarySubmissionTransportError();
          } finally { clearTimeout(deadline); }
          const isStream = replacement.headers.get("content-type")?.includes("text/event-stream");
          log("upstream_headers", { httpStatus: replacement.status, sse: Boolean(isStream), attempt });
          if (replacement.status === 429 || replacement.status >= 500) {
            await replacement.body?.cancel().catch(() => {});
            throw new TemporarySubmissionTransportError(replacement.status);
          }
          if (replacement.status !== 200 || !replacement.body || !isStream) {
            await replacement.body?.cancel();
            throw new Error(`Submitted-turn replacement HTTP ${replacement.status}; expected 200 SSE`);
          }
          return guardResponseStream(replacement.body, {
            onDiagnostic: log,
            onStall: () => interrupt("stall"),
            onCancel: () => interrupt("cancel"),
          });
        } : undefined,
      }) : guardedBody;
    const responseBody = isOmpStream ? translateResponseStream(submittedRetry!) : submittedRetry;
    const serializedBody = responseBody
      ? releaseWhenDone(responseBody, releaseThread ?? (() => {}), finish)
      : responseBody;
    if (releaseThread && !serializedBody) releaseThread();
    if (!serializedBody) finish(upstream.ok ? "no_body" : "http_error");
    return new Response(serializedBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
});

diagnostics.log("shim_started");
console.log(`OMP shim listening on http://${listenHost}:${listenPort}; diagnostics: ${diagnostics.status().directory}`);
