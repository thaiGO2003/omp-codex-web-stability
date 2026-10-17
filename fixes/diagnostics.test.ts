import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DiagnosticLog, diagnosticFields, errorFields } from "../shim/diagnostics";
import { collect, readDiagnostics, safeHealth } from "../bin/collect-diagnostics";
import { guardResponseStream } from "./sse-watchdog";

test("bounded logging and export discard content, credentials and unrecognized fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-log-test-"));
  try {
    const logger = new DiagnosticLog(dir);
    const secret = "SECRET_PROMPT_TOKEN_TOOL_RESULT";
    logger.log("request_received", { requestId: crypto.randomUUID(), logicalThreadId: secret,
      prompt: secret, authorization: secret, toolResult: secret, eventType: secret, errorCode: secret, errorName: secret });
    logger.log("upstream_error", errorFields(Object.assign(new Error(secret), { code: "ECONNRESET", cause: { token: secret } })));
    logger.log(secret, { prompt: secret });
    // A malformed/legacy record and an injected field must not escape via export.
    const original = readFileSync(join(dir, "shim.jsonl"), "utf8");
    expect(original).not.toContain(secret);
    const row = JSON.parse(original.split("\n")[0]);
    writeFileSync(join(dir, "shim.jsonl.1"), JSON.stringify({ ...row, seq: 99, text: secret, errorCode: secret }) + "\n" + secret + "\n");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ controlToken: secret }));
    const result = readDiagnostics(dir, 0);
    expect(result.records).toHaveLength(3);
    expect(result.skipped).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    const health = safeHealth({ status: "ok", version: secret, token: secret, active_http_turns: 2,
      diagnostics: { enabled: true, directory: secret, failedWrites: 0 } }, true);
    expect(health).toEqual({ status: "ok", active_http_turns: 2, diagnosticsEnabled: true, failedWrites: 0 });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok", token: secret }) });
    try {
      const output = join(dir, "report.json.gz");
      await collect({ directory: dir, output, hours: 24, upstream: `http://127.0.0.1:${server.port}`, shimPort: server.port! });
      const report = gunzipSync(readFileSync(output)).toString("utf8");
      expect(report).not.toContain(secret);
      expect(JSON.parse(report).logs.records).toHaveLength(3);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      await expect(collect({ directory: dir, output, hours: 24, upstream: `http://127.0.0.1:${server.port}`, shimPort: server.port! })).rejects.toThrow();
    } finally { await server.stop(true); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rotation bounds disk usage, restricts permissions and logging failures are nonfatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-log-rotation-"));
  try {
    const logger = new DiagnosticLog(dir, 1024, 3);
    for (let i = 0; i < 100; i++) logger.log("request_received", { requestId: crypto.randomUUID(), logicalThreadId: "fixture" });
    const files = readdirSync(dir);
    expect(files).toHaveLength(3);
    expect(files.sort()).toEqual(["shim.jsonl", "shim.jsonl.1", "shim.jsonl.2"]);
    for (const file of files) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(1024);
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      for (const line of readFileSync(join(dir, file), "utf8").trim().split("\n")) expect(JSON.parse(line).schema).toBe(1);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const oneDir = join(dir, "single");
    const one = new DiagnosticLog(oneDir, 512, 1);
    for (let i = 0; i < 30; i++) one.log("shim_started");
    expect(readdirSync(oneDir)).toEqual(["shim.jsonl"]);
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "fixture");
    const broken = new DiagnosticLog(file);
    expect(() => broken.log("shim_started")).not.toThrow();
    expect(broken.status().failedWrites).toBe(1);
    expect(diagnosticFields({ elapsedMs: Infinity, bytes: -1, prompt: "secret" })).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("watchdog records heartbeat-only timeout, fresh recovery and terminal failure without payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-log-watchdog-"));
  const encode = (value: object) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  try {
    const logger = new DiagnosticLog(dir);
    const stream = guardResponseStream(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } }), {
      timeoutMs: 20, onStall: async () => {}, onCancel: async () => {}, onDiagnostic: (event, fields) => logger.log(event, fields),
      onRecover: async () => new ReadableStream({ start(c) {
        c.enqueue(encode({ type: "response.created", response: { id: "SECRET_ID", output: [] } }));
        c.enqueue(encode({ type: "response.failed", response: { error: { code: "chatgpt_fetch_failed", message: "SECRET_BODY" } } }));
        c.close();
      } }),
    });
    expect(await new Response(stream).text()).toContain("SECRET_BODY");
    const raw = readFileSync(join(dir, "shim.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET_BODY");
    expect(raw).not.toContain("SECRET_ID");
    const rows = readDiagnostics(dir, 0).records;
    expect(rows.map(r => r.event)).toEqual(["stream_started", "semantic_timeout", "recovery_started", "recovery_connected", "stream_progress", "stream_terminal", "stream_eof"]);
    const timeout = rows.find(r => r.event === "semantic_timeout")!;
    expect(timeout.sawOutput).toBe(false);
    expect(timeout.recoveryEligible).toBe(true);
    expect(timeout.events).toBe(0);
    const terminal = rows.find(r => r.event === "stream_terminal")!;
    expect(terminal.errorCode).toBe("chatgpt_fetch_failed");
    expect(terminal.eventType).toBe("response.failed");
    // A throwing diagnostic sink cannot change successful transport bytes.
    const bytes = encode({ type: "response.completed", response: { id: "fixture" } });
    const guarded = guardResponseStream(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), {
      onStall: async () => {}, onCancel: async () => {}, onDiagnostic: () => { throw Error("unwritable"); },
    });
    expect(new Uint8Array(await new Response(guarded).arrayBuffer())).toEqual(bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
