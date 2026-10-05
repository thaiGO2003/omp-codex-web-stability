import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { guardResponseStream } from "./sse-watchdog";
import { record, addCodexEnvironment } from "./compatibility";
import { taskLabelResponse } from "./task-label";
import { translateToolCallIds, translateResponseStream } from "./tool-call-ids";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.OMP_CODEX_WEB_SHIM_PORT || 17842);
const upstreamOrigin = process.env.OMP_CODEX_WEB_UPSTREAM || "http://127.0.0.1:17841";
const cwdHeader = "x-omp-cwd";


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
  console.log("OMP interrupted native Web turn", { thread: threadId.slice(0, 8), turn: turnId.slice(0, 8), ...await result.json() });
}

const threadTails = new Map<string, Promise<void>>();

async function acquireThread(threadId: string) {
  const previous = threadTails.get(threadId) ?? Promise.resolve();
  const queued = threadTails.has(threadId);
  let releaseCurrent!: () => void;
  const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  threadTails.set(threadId, tail);

  if (queued) console.log("OMP queue wait", { thread: threadId.slice(0, 8) });
  await previous.catch(() => {});
  if (queued) console.log("OMP queue start", { thread: threadId.slice(0, 8) });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (threadTails.get(threadId) === tail) threadTails.delete(threadId);
  };
}

function releaseWhenDone(stream: ReadableStream<Uint8Array>, release: () => void) {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
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
      return Response.json({ service: "omp-codex-web-shim", upstreamOrigin, listenPort });
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
    headers.delete("host");
    headers.delete(cwdHeader);

    let body: BodyInit | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      body = bytes;
      if (incoming.pathname === "/v1/codex/responses"
        && headers.get("content-type")?.includes("application/json")) {
        try {
          const parsed = record(JSON.parse(new TextDecoder().decode(bytes)));
          const labelResponse = parsed && taskLabelResponse(parsed);
          if (labelResponse) {
            console.log("OMP local task label", { model: parsed!.model });
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
            console.log("OMP request", {
              model: parsed.model, cwd: sessionCwd,
              thread: String(metadata.thread_id).slice(0, 8),
              turn: String(metadata.turn_id).slice(0, 8),
              inputItems: Array.isArray(parsed.input) ? parsed.input.length : 0,
            });
            headers.delete("content-length");
          }
        } catch {
          // Forward the original body unchanged; upstream will return the real protocol error.
        }
      }
    }

    const shouldSerialize = Boolean(threadId)
      && (incoming.pathname === "/v1/codex/responses" || incoming.pathname === "/v1/codex/responses/compact");
    const releaseThread = shouldSerialize ? await acquireThread(threadId!) : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: req.signal,
      });
    } catch (error) {
      releaseThread?.();
      throw error;
    }

    const isOmpStream = incoming.pathname === "/v1/codex/responses"
      && upstream.headers.get("content-type")?.includes("text/event-stream") && upstream.body;
    const responseHeaders = new Headers(upstream.headers);
    if (isOmpStream) responseHeaders.delete("content-length");
    const guardedBody = isOmpStream && threadId && turnId ? guardResponseStream(upstream.body!, {
      onStall: () => interruptNativeTurn(threadId, turnId),
      onCancel: () => interruptNativeTurn(threadId, turnId),
    }) : upstream.body;
    const responseBody = isOmpStream ? translateResponseStream(guardedBody!) : guardedBody;
    const serializedBody = releaseThread && responseBody
      ? releaseWhenDone(responseBody, releaseThread)
      : responseBody;
    if (releaseThread && !serializedBody) releaseThread();
    return new Response(serializedBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
});

console.log(`OMP shim listening on http://${listenHost}:${listenPort}`);
