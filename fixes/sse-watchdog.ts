export class RecoveryIdentityStore {
  private owners = new Map<string, { threadId: string; logicalTurnId: string; turnId: string }>();

  rotate(threadId: string, turnId: string) {
    const owner = { threadId: crypto.randomUUID(), logicalTurnId: turnId, turnId: crypto.randomUUID() };
    this.owners.set(threadId, owner);
    return { threadId: owner.threadId, turnId: owner.turnId };
  }

  resolve(threadId: string, turnId: string) {
    const owner = this.owners.get(threadId);
    if (!owner) return undefined;
    if (owner.logicalTurnId !== turnId) {
      owner.logicalTurnId = turnId;
      owner.turnId = crypto.randomUUID();
    }
    return { threadId: owner.threadId, turnId: owner.turnId };
  }

  rebind(body: string, headers: Headers, owner: { threadId: string; turnId: string }) {
    const request = JSON.parse(body);
    const client = request.client_metadata;
    if (!client || typeof client["x-codex-turn-metadata"] !== "string") throw new Error("Recovery requires native metadata");
    const metadata = JSON.parse(client["x-codex-turn-metadata"]);
    const previousTurnId = metadata.turn_id;
    if (!metadata.thread_id || !previousTurnId) throw new Error("Recovery requires native ownership");
    metadata.thread_id = owner.threadId;
    metadata.turn_id = owner.turnId;
    client["x-codex-turn-metadata"] = JSON.stringify(metadata);
    if (client.turn_id === previousTurnId) client.turn_id = owner.turnId;
    // Rebind only the current turn's user/environment records; keep historical
    // tool calls, results, messages, instructions and content byte-for-byte.
    for (const item of request.input ?? []) {
      if (item?.role === "user" && item.internal_chat_message_metadata_passthrough?.turn_id === previousTurnId) {
        item.internal_chat_message_metadata_passthrough.turn_id = owner.turnId;
      }
    }
    const { tool_namespaces_info: _tools, ...headerMetadata } = metadata;
    headers.set("x-codex-turn-metadata", JSON.stringify(headerMetadata).replace(
      /[\x7f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ));
    return JSON.stringify(request);
  }
}

// Heartbeats prove transport liveness, not model progress.
export function hasCompleteRecoveryInput(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  if (request.previous_response_id || !Array.isArray(request.input) || !request.input.length) return false;
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const value of request.input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const type = item.type;
    if (type === undefined || type === "message" || type === "reasoning") continue;
    if (!["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(type))) return false;
    if (typeof item.call_id !== "string" || !item.call_id) return false;
    const map = String(type).endsWith("_output") ? results : calls;
    map.set(item.call_id, (map.get(item.call_id) ?? 0) + 1);
    if (map === results && item.output === undefined) return false;
  }
  return calls.size === results.size && [...calls].every(([id, count]) => count === 1 && results.get(id) === 1);
}

// Supply onRecover only for a full request with completed historical tool results.
// Never replay a request after forwarding text, reasoning, refusal or a tool item.
export function guardResponseStream(source: ReadableStream<Uint8Array>, options: {
  timeoutMs?: number;
  onStall: () => Promise<void>;
  onCancel: () => Promise<void>;
  onRecover?: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  onDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
}): ReadableStream<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  let reader = source.getReader();
  let decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const recoveryAbort = new AbortController();
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let terminal = false;
  let sawOutput = false;
  let recoveries = 0;
  let responseId = "";
  let sequence = 0;
  let cleanup: Promise<boolean> | undefined;
  let cleanupError: unknown;
  let recoveryError: unknown;
  let recovering: Promise<void> | undefined;
  let observe: (chunk: Uint8Array) => void = () => {};
  const startedAt = Date.now();
  let lastSemanticAt = startedAt;
  let lastReportAt = startedAt;
  let events = 0;
  let bytes = 0;
  let eventType = "unknown";
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    try { options.onDiagnostic?.(event, { elapsedMs: Date.now() - startedAt, idleMs: Date.now() - lastSemanticAt,
      events, bytes, sawOutput, recoveries, terminal, responseId, eventType, ...fields }); } catch { /* logging is optional */ }
  };
  const errorInfo = (error: unknown) => {
    const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
    return { errorName: value.name, errorCode: value.code ?? cause.code };
  };
  emit("stream_started", { timeoutMs, recoveryEligible: Boolean(options.onRecover) });
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const retire = (callback: () => Promise<void>) => cleanup ??= Promise.resolve().then(callback).then(() => true, error => {
    cleanupError = error;
    console.warn("OMP Web turn cleanup failed");
    emit("cleanup_failed", errorInfo(error));
    return false;
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = () => {
        clear();
        if (closed || terminal) return;
        timer = setTimeout(() => {
          if (closed || terminal || recovering) return;
          console.warn("OMP Web semantic timeout", { timeoutMs, sawOutput, recoveries });
          emit("semantic_timeout", { timeoutMs, recoveryEligible: !sawOutput && Boolean(options.onRecover) });
          recovering = (async () => {
            // Revoke the old native turn before opening a replacement browser.
            const retired = await retire(options.onStall);
            await reader.cancel("ChatGPT Web semantic timeout").catch(() => {});
            if (closed) return;
            if (retired && !terminal && !sawOutput && options.onRecover) {
              recoveries++;
              cleanup = undefined;
              cleanupError = undefined;
              emit("recovery_started");
              try {
                const next = await options.onRecover(recoveryAbort.signal);
                if (closed) { await next.cancel().catch(() => {}); return; }
                reader = next.getReader();
                decoder = new TextDecoder();
                pending = "";
                responseId = "";
                sequence = 0;
                console.log("OMP Web silent recovery", { attempt: recoveries });
                emit("recovery_connected", { attempt: recoveries });
                arm();
                return;
              } catch (error) {
                if (closed) return;
                recoveryError = error;
                console.warn("OMP Web silent recovery failed");
                emit("recovery_failed", errorInfo(error));
                await retire(options.onCancel);
              }
            }
            if (closed) return;
            closed = true;
            const reasonCode = (error: unknown) => {
              const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
              return typeof code === "string" && [
                "chatgpt_web_interrupt_timeout", "chatgpt_web_interrupt_unreachable",
                "chatgpt_web_interrupt_http_rejected", "chatgpt_web_interrupt_invalid_ack",
                "chatgpt_web_interrupt_auth_unavailable", "chatgpt_web_native_unverified",
              ].includes(code) ? code : undefined;
            };
            const code = !retired || cleanupError ? reasonCode(cleanupError) ?? "chatgpt_web_cleanup_unconfirmed"
              : recoveryError ? reasonCode(recoveryError) ?? "chatgpt_web_recovery_connect_failed"
              : sawOutput ? "chatgpt_web_semantic_progress_stalled"
              : "chatgpt_web_recovery_context_incomplete";
            const message = !retired || cleanupError
              ? "ChatGPT Web made no semantic progress. Native turn cancellation was not confirmed; a task may still be running. Automatic replay paused to avoid duplicate tool calls. Check the ChatGPT tab and OMP shim diagnostics."
              : recoveryError
                ? code === "chatgpt_web_native_unverified"
                  ? "ChatGPT Web stalled and the old turn was cancelled, but this Codex Web version has not been verified for safe automatic recovery. Check for a supported shim update before continuing."
                  : "ChatGPT Web stalled; the old turn was cancelled, but replacement could not start. Check the ChatGPT tab and OMP shim diagnostics before continuing."
                : sawOutput
                  ? "ChatGPT Web stopped making semantic progress after sending output. The native turn was cancelled; automatic replay was disabled to avoid repeating tool calls. Continue from the existing OMP session."
                  : "ChatGPT Web stalled and the native turn was cancelled, but complete tool history was unavailable for safe replay. Continue from the existing OMP session.";
            emit("recovery_stopped", { errorCode: code });
            const failure = { type: "response.failed", sequence_number: sequence++, retryable: false, response: {
              id: responseId || "resp_omp_stalled", status: "failed", output: [],
              error: { type: "invalid_request_error", code, retryable: false, status: 409, message },
            } };
            try {
              controller.enqueue(encoder.encode(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`));
              controller.close();
            } catch { /* downstream may already be gone */ }
          })().finally(() => { recovering = undefined; });
        }, timeoutMs);
      };
      observe = (chunk: Uint8Array) => {
        bytes += chunk.byteLength;
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            events++;
            if (typeof event.sequence_number === "number") sequence = Math.max(sequence, event.sequence_number + 1);
            if (typeof event.response?.id === "string") responseId = event.response.id;
            if (["response.completed", "response.incomplete", "response.done", "response.failed", "error"].includes(event.type)) {
              terminal = true;
              eventType = event.type;
              clear();
              emit("stream_terminal", { eventType: event.type, errorCode: event.response?.error?.code ?? event.error?.code ?? event.code });
            } else if (event.type === "response.created" || /^response\.(output_item|content_part|reasoning_summary_part)\.(added|done)$/.test(event.type)
              || /^response\.(output_text|reasoning_text|reasoning_summary_text|refusal|function_call_arguments|custom_tool_call_input)\.(delta|done)$/.test(event.type)) {
              const hadOutput = sawOutput;
              if (event.type !== "response.created") sawOutput = true;
              // A created event that already carries output is also unsafe to replay.
              if (Array.isArray(event.response?.output) && event.response.output.length) sawOutput = true;
              const firstProgress = eventType === "unknown";
              eventType = event.type;
              lastSemanticAt = Date.now();
              if (firstProgress || (!hadOutput && sawOutput) || Date.now() - lastReportAt >= 30_000) {
                emit("stream_progress");
                lastReportAt = Date.now();
              }
              arm();
            }
          } catch { /* keep original bytes intact */ }
        }
      };
      arm();
    },
    async pull(controller) {
      while (!closed) {
        const activeReader = reader;
        try {
          const { done, value } = await activeReader.read();
          // A late refusal/failure must never be hidden by replacement. Observe
          // late tool output too so retirement races cannot trigger replay.
          if (recovering && !done && activeReader === reader) {
            observe(value);
            if (terminal) {
              controller.enqueue(value);
              closed = true;
              clear();
              controller.close();
            }
          }
          if (recovering) await recovering;
          if (closed) return;
          if (activeReader !== reader) continue;
          if (done) {
            closed = true;
            clear();
            emit("stream_eof");
            controller.close();
          } else {
            observe(value);
            controller.enqueue(value);
          }
          return;
        } catch (error) {
          if (recovering) await recovering;
          if (closed) return;
          if (activeReader !== reader) continue;
          closed = true;
          clear();
          emit("stream_error", errorInfo(error));
          if (!terminal) await retire(options.onCancel);
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      clear();
      emit("stream_cancelled");
      recoveryAbort.abort(reason);
      if (!terminal) await retire(options.onCancel);
      await reader.cancel(reason).catch(() => {});
    },
  });
}
