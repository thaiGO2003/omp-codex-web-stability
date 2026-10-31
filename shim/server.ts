import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

// Native Codex Web authenticates with the local Codex CLI ChatGPT session.
// OMP configured with auth: none sends the placeholder "Bearer N/A", so the
// shim substitutes the current access token from ~/.codex/auth.json.
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
let cachedCodexToken: { value: string; at: number } | undefined;
async function codexAccessToken(): Promise<string | undefined> {
  try {
    const data = await Bun.file(join(codexHome, "auth.json")).json();
    const token = typeof data?.tokens?.access_token === "string" ? data.tokens.access_token : undefined;
    if (token) cachedCodexToken = { value: token, at: Date.now() };
    return token;
  } catch {
    return cachedCodexToken?.value;
  }
}
import { guardResponseStream, hasCompleteRecoveryInput } from "./sse-watchdog";
import { RecoveryIdentityStore } from "./sse-watchdog";
import { record, addCodexEnvironment } from "./compatibility";
import { taskLabelResponse } from "./task-label";
import { translateToolCallIds, translateResponseStream } from "./tool-call-ids";
import { DiagnosticLog, errorFields } from "./diagnostics";
import { retrySubmittedTurnStream, TemporarySubmissionTransportError } from "./submitted-turn-retry";
import { attachTurnMetadata, decodeJsonRequestBody, turnIdentity } from "./request-identity";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.OMP_CODEX_WEB_SHIM_PORT || 3007);
const upstreamOrigin = process.env.OMP_CODEX_WEB_UPSTREAM || "http://127.0.0.1:17841";
const cwdHeader = "x-omp-cwd";
const diagnostics = new DiagnosticLog();
// Recovery is version-independent. Every replacement still requires complete
// input history and a valid acknowledgement from the scoped interrupt endpoint.
class NativeInterruptionError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) { super(message); this.name = "NativeInterruptionError"; }
}

async function interruptNativeTurn(threadId: string | undefined, turnId: string | undefined,
  onRetry?: (attempt: number, reason: string) => void) {
  if (!threadId || !turnId) return;
  const configPath = join(process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), ".codex-chatgpt-web"), "config.json");
  const config = await Bun.file(configPath).json().catch(() => undefined);
  if (typeof config?.controlToken !== "string") {
    throw new NativeInterruptionError("chatgpt_web_interrupt_auth_unavailable", "Local Codex Web control token is unavailable");
  }
  // A repeated scoped interrupt targets the SAME old turn; it never sends a
  // second model request. Retry only transport ambiguity, not refusal or a
  // malformed acknowledgement. Keep the current OMP session intact.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result: Response;
    try {
      result = await fetch(new URL("/admin/interrupt-turn", upstreamOrigin), {
        method: "POST",
        headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId, turnId }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      if (attempt < 2) { onRetry?.(attempt, timedOut ? "timeout" : "transport"); continue; }
      throw new NativeInterruptionError(timedOut ? "chatgpt_web_interrupt_timeout" : "chatgpt_web_interrupt_unreachable",
        timedOut ? "Native interruption timed out without acknowledgement" : "Native interruption connection failed without acknowledgement");
    }
    if (!result.ok) {
      const temporary = result.status === 429 || result.status >= 500;
      await result.body?.cancel().catch(() => {});
      if (temporary && attempt < 2) { onRetry?.(attempt, "http_transient"); continue; }
      throw new NativeInterruptionError("chatgpt_web_interrupt_http_rejected", `Native interruption returned HTTP ${result.status}`);
    }
    const acknowledgement = await result.json().catch(() => undefined);
    if (acknowledgement?.status !== "ok"
      || !Number.isInteger(acknowledgement.cancelled_http_turns) || acknowledgement.cancelled_http_turns < 0
      || !Number.isInteger(acknowledgement.cancelled_browser_turns) || acknowledgement.cancelled_browser_turns < 0) {
      throw new NativeInterruptionError("chatgpt_web_interrupt_invalid_ack", "Native interruption returned no valid cancellation acknowledgement");
    }
    return acknowledgement;
  }
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
    const route = incoming.pathname;

    if (pathname === "/v1/codex/responses") pathname = "/v1/responses";
    if (pathname === "/v1/codex/responses/compact") pathname = "/v1/responses/compact";

    // Both OMP and Codex CLI reach the same native Responses bridge. They differ only in how they
    // carry ownership: OMP sends `x-omp-cwd` plus body metadata, Codex CLI sends headers.
    const responsesPath = route === "/v1/codex/responses" || route === "/v1/responses";
    const compactionPath = route === "/v1/codex/responses/compact" || route === "/v1/responses/compact";
    const ompPath = route.startsWith("/v1/codex/");

    const upstreamUrl = new URL(pathname + incoming.search, upstreamOrigin);
    const headers = new Headers(req.headers);
    const requestCwd = headers.get(cwdHeader)?.trim();
    const headerTurnMetadata = headers.get("x-codex-turn-metadata") ?? undefined;
    const clientKind = headers.get("originator")?.startsWith("codex_exec") || headers.get("originator")?.includes("codex_cli")
      ? "codex-cli" : ompPath ? "omp" : "http";
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
        const ack = await interruptNativeTurn(threadId, turnId,
          (attempt, reason) => log("cleanup_retrying", { phase, attempt, reason }));
        log("cleanup_completed", { phase, cancelledHttpTurns: ack?.cancelled_http_turns, cancelledBrowserTurns: ack?.cancelled_browser_turns });
      } catch (error) { log("cleanup_failed", { phase, ...errorFields(error) }); throw error; }
    };
    log("request_received", { client: clientKind });
    headers.delete("host");
    headers.delete(cwdHeader);
    const incomingAuth = headers.get("authorization") ?? "";
    if (incomingAuth.length <= 7 || incomingAuth.startsWith("Bearer N/A")) {
      const token = await codexAccessToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }

    let body: BodyInit | undefined;
    let jsonText: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const bytes = new Uint8Array(await req.arrayBuffer().catch(error => { log("upstream_error", errorFields(error)); finish("error"); throw error; }));
      body = bytes;
      const contentEncoding = headers.get("content-encoding");
      if ((responsesPath || compactionPath) && headers.get("content-type")?.includes("application/json")) {
        // Codex CLI compresses this body. Upstream accepts plain JSON, and only a readable body can
        // be inspected, rebound for a silent retry, or replayed after a transport failure.
        const decoded = decodeJsonRequestBody(bytes, contentEncoding);
        if (decoded) {
          body = decoded;
          jsonText = decoded;
          headers.delete("content-encoding");
          headers.delete("content-length");
          log("request_decoded", { encoding: contentEncoding ?? "identity", chars: decoded.length });
        }
      }
      if (responsesPath && jsonText !== undefined) {
        try {
          const parsed = record(JSON.parse(jsonText));
          if (parsed) {
            const metadata = attachTurnMetadata(parsed, headerTurnMetadata);
            if (ompPath) {
              const labelResponse = taskLabelResponse(parsed);
              if (labelResponse) {
                log("local_response");
                finish("local");
                return labelResponse;
              }
              const sessionCwd = typeof parsed.__omp_cwd === "string" && isAbsolute(parsed.__omp_cwd)
                ? parsed.__omp_cwd : requestCwd;
              delete parsed.__omp_cwd;
              translateToolCallIds(parsed, "to-web");
              const rewrittenTurnMetadata = sessionCwd
                ? addCodexEnvironment(parsed, sessionCwd, headerTurnMetadata)
                : undefined;
              if (rewrittenTurnMetadata) {
                jsonText = JSON.stringify(parsed);
                body = jsonText;
                // Keep the header projection small; the tool registry belongs in the body.
                const headerMetadata = JSON.parse(rewrittenTurnMetadata);
                if (typeof headerMetadata.turn_id === "string") turnId = headerMetadata.turn_id;
                if (typeof headerMetadata.thread_id === "string" && headerMetadata.thread_id) threadId = headerMetadata.thread_id;
                const { tool_namespaces_info: _tools, ...headerOnly } = headerMetadata;
                headers.set("x-codex-turn-metadata", JSON.stringify(headerOnly).replace(
                  /[\x7f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
                ));
              }
            } else if (metadata) {
              // Codex CLI keeps its turn metadata in a header. Mirror it into the body so recovery
              // can rebind the same exact turn identity it already presented.
              jsonText = JSON.stringify(parsed);
              body = jsonText;
            }
            const identity = turnIdentity(metadata);
            if (identity.threadId) threadId = identity.threadId;
            if (identity.turnId) turnId = identity.turnId;
            logLogicalThreadId = threadId;
            logLogicalTurnId = turnId;
            headers.delete("content-length");
          }
        } catch (error) {
          log("request_rewrite_failed", errorFields(error));
          // Forward the decoded body unchanged; upstream will return the real protocol error.
        }
      }
    }

    const shouldSerialize = Boolean(threadId) && (responsesPath || compactionPath);
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

    const isGuardedStream = responsesPath
      && upstream.headers.get("content-type")?.includes("text/event-stream") && upstream.body;
    log("upstream_headers", { httpStatus: upstream.status, sse: Boolean(isGuardedStream) });
    const responseHeaders = new Headers(upstream.headers);
    if (isGuardedStream) responseHeaders.delete("content-length");
    let eligibleHistory = false;
    if (isGuardedStream && jsonText !== undefined) {
      try { eligibleHistory = hasCompleteRecoveryInput(JSON.parse(jsonText)); }
      catch { /* The upstream response owns invalid requests. */ }
    }
    let recoveryAttempt = 0;
    const recoverSilently = eligibleHistory
        ? async (signal: AbortSignal) => {
          // A replacement may have reached native even when its HTTP response
          // was lost. Retire that identity BEFORE any subsequent submission.
          let maybeSubmitted = false;
          for (let attempt = 1; ; attempt++) {
            if (signal.aborted || req.signal.aborted) throw signal.reason ?? req.signal.reason;
            try {
              let health: Response;
              try {
                health = await fetch(new URL("/healthz", upstreamOrigin), {
                  signal: AbortSignal.any([req.signal, signal, AbortSignal.timeout(5000)]),
                });
              } catch (error) {
                if (signal.aborted || req.signal.aborted) throw error;
                throw new TemporarySubmissionTransportError();
              }
              log("upstream_headers", { phase: "health", httpStatus: health.status });
              if (health.status === 429 || health.status >= 500) {
                await health.body?.cancel().catch(() => {});
                throw new TemporarySubmissionTransportError(health.status);
              }
              await health.body?.cancel().catch(() => {});
              if (!health.ok) {
                throw new NativeInterruptionError("chatgpt_web_recovery_connect_failed", "Codex Web health check rejected silent recovery", health.status);
              }
              if (maybeSubmitted) {
                await interrupt("recovery_connect_failure");
                maybeSubmitted = false;
              }
              // The old identity is permanently cancelled by the native runtime.
              // Fresh thread ownership also prevents reuse of its terminated MCP chat.
              const owner = recoveryIdentities.rotate(logicalThreadId!, logicalTurnId!);
              body = recoveryIdentities.rebind(body as string, headers, owner);
              threadId = owner.threadId;
              turnId = owner.turnId;
              const connect = new AbortController();
              const deadline = setTimeout(() => connect.abort(), 20_000);
              log("recovery_connecting", { phase: "connect", attempt: ++recoveryAttempt });
              let replacement: Response;
              maybeSubmitted = true;
              try {
                replacement = await fetch(upstreamUrl, {
                  method: req.method, headers, body, redirect: "manual",
                  signal: AbortSignal.any([req.signal, signal, connect.signal]),
                });
              } catch (error) {
                if (signal.aborted || req.signal.aborted) throw error;
                throw new TemporarySubmissionTransportError();
              } finally { clearTimeout(deadline); }
              // The connection deadline ends at headers; generation keeps its semantic budget.
              log("upstream_headers", { httpStatus: replacement.status, sse: Boolean(replacement.headers.get("content-type")?.includes("text/event-stream")), attempt: recoveryAttempt });
              if (replacement.status === 429 || replacement.status >= 500) {
                await replacement.body?.cancel().catch(() => {});
                throw new TemporarySubmissionTransportError(replacement.status);
              }
              if (!replacement.ok || !replacement.body || !replacement.headers.get("content-type")?.includes("text/event-stream")) {
                await replacement.body?.cancel();
                throw new NativeInterruptionError("chatgpt_web_recovery_connect_failed", "Silent recovery could not obtain a valid SSE response", replacement.status);
              }
              return replacement.body;
            } catch (error) {
              if (!(error instanceof TemporarySubmissionTransportError) || signal.aborted || req.signal.aborted) throw error;
              log("recovery_connect_deferred", { attempt, httpStatus: error.httpStatus });
              const wait = attempt === 1 ? 2_000 : attempt === 2 ? 5_000 : Math.min(30_000, 10_000 * 2 ** Math.min(attempt - 3, 2));
              await new Promise<void>((resolve, reject) => {
                const combined = AbortSignal.any([req.signal, signal]);
                const stop = () => { clearTimeout(timer); combined.removeEventListener("abort", stop); reject(combined.reason); };
                const timer = setTimeout(() => { combined.removeEventListener("abort", stop); resolve(); }, wait);
                if (combined.aborted) stop(); else combined.addEventListener("abort", stop, { once: true });
              });
            }
          }
        } : undefined;
    // Submitted-turn replacements need the same repeated semantic-stall
    // recovery as the original stream; every replacement gets fresh ownership.
    const guardNativeStream = (source: ReadableStream<Uint8Array>) => guardResponseStream(source, {
      onDiagnostic: log,
      onStall: () => interrupt("stall"),
      onCancel: () => interrupt("cancel"),
      onRecover: recoverSilently,
    });
    const guardedBody = isGuardedStream && threadId && turnId ? guardNativeStream(upstream.body!) : upstream.body;
    const submittedRetry = isGuardedStream && upstream.status === 200 && threadId && turnId && guardedBody
      ? retrySubmittedTurnStream(guardedBody, {
        signal: req.signal,
        onDiagnostic: log,
        onRetry: eligibleHistory ? async (attempt, signal) => {
          // A failed submission is not evidence that its old browser has stopped.
          // Require scoped cancellation before allocating a new native identity;
          // old thread/turn IDs may be tombstoned after abort.
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
          if (!health.ok) {
            throw new NativeInterruptionError("chatgpt_submitted_retry_health_rejected", "Codex Web health check rejected automatic retry", health.status);
          }
          await health.body?.cancel().catch(() => {});
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
            throw new NativeInterruptionError(replacement.status !== 200
              ? "chatgpt_submitted_retry_http_rejected" : "chatgpt_submitted_retry_invalid_stream",
            "Submitted-turn replacement did not return 200 SSE", replacement.status);
          }
          return guardNativeStream(replacement.body);
        } : undefined,
      }) : guardedBody;
    // Tool-call id translation belongs to the OMP client contract only; Codex CLI reads the native
    // ids it sent and must keep them verbatim.
    const responseBody = ompPath && isGuardedStream ? translateResponseStream(submittedRetry!) : submittedRetry;
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
