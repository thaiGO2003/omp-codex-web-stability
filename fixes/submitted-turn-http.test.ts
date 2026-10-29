import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const encoder = new TextEncoder();
const frame = (value: object) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

test("real shim HTTP route retries structured submission failures with fresh ownership", async () => {
  for (const [scenario, version] of [
    ["repeated", "6.1.10"],
    ["repeated", "6.1.9"],
    ["repeated", "6.1.11"],
    ["stall_after_submit", "6.1.11"],
    ["settled_612", "6.1.12"],
    ["invalid_ack", "6.1.10"],
    ["missing_result", "6.1.10"],
    ["new_version", "6.1.13"],
    ["future_version", "99.0.0"],
    ["transient_http", "6.1.10"],
    ["transient_health", "6.1.10"],
    ["permanent_http", "6.1.10"],
    ["slow_interrupt", "6.1.10"],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), "omp-submitted-http-"));
    const inputs: any[] = [];
    const interrupted: { threadId: string; turnId: string }[] = [];
    let healthChecks = 0;
    let currentOwner: { threadId: string; turnId: string } | undefined;
    const native = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          healthChecks++;
          if (scenario === "transient_health" && healthChecks === 1)
            return new Response("overloaded", { status: 503 });
          return Response.json({ version, scoped_interrupt_settled: scenario === "settled_612" });
        }
        if (url.pathname === "/admin/interrupt-turn") {
          expect(req.headers.get("authorization")).toBe("Bearer fixture-control");
          const owner = await req.json();
          expect(owner).toEqual(currentOwner);
          interrupted.push(owner);
          if (scenario === "slow_interrupt" && interrupted.length === 1) await Bun.sleep(170);
          return Response.json({ status: scenario === "invalid_ack" ? "refused" : "ok",
            cancelled_http_turns: 1, cancelled_browser_turns: 1 });
        }
        expect(url.pathname).toBe("/v1/responses");
        const body = await req.json();
        inputs.push(body);
        const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
        currentOwner = { threadId: metadata.thread_id, turnId: metadata.turn_id };
        expect(JSON.parse(req.headers.get("x-codex-turn-metadata")!)).toMatchObject({
          thread_id: currentOwner.threadId, turn_id: currentOwner.turnId,
        });
        const n = inputs.length;
        if (scenario === "transient_http" && (n === 2 || n === 3))
          return new Response("rate limited", { status: n === 2 ? 502 : 429 });
        if (scenario === "permanent_http" && n === 2)
          return new Response("forbidden", { status: 403 });
        const failed = scenario === "repeated" ? n < 3 : n === 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame({ type: "response.created", response: { id: `resp_${n}`, output: [] } }));
            if (failed) controller.enqueue(frame({ type: "response.failed", response: {
              id: `resp_${n}`, status: "failed", output: [], error: { code: "chatgpt_submitted_turn_failed" },
            } }));
            else if (!(scenario === "stall_after_submit" && n === 2)) {
              controller.enqueue(frame({ type: "response.output_text.delta", delta: "FINISHED_AFTER_RETRY" }));
              controller.enqueue(frame({ type: "response.completed", response: { id: `resp_${n}`, status: "completed" } }));
            }
            if (!(scenario === "stall_after_submit" && n === 2)) controller.close();
          },
          cancel() { /* The timed-out second turn is retired. */ },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(join(dir, "config.json"), JSON.stringify({ controlToken: "fixture-control" }));
      let serverSource = await readFile(resolve("shim/server.ts"), "utf8");
      serverSource = serverSource.replace(/from "\.\/([^"]+)"/g, (_match, name) =>
        `from ${JSON.stringify(pathToFileURL(resolve("shim", name + ".ts")).href)}`);
      serverSource = serverSource.replace("Bun.serve({", "const fixtureServer = Bun.serve({");
      if (scenario === "stall_after_submit") serverSource = serverSource.replace(
        "guardResponseStream(source, {", "guardResponseStream(source, { timeoutMs: 180,");
      if (scenario === "slow_interrupt") serverSource = serverSource.replace("AbortSignal.timeout(12_000)", "AbortSignal.timeout(100)");
      serverSource += '\nconsole.log("FIXTURE_PORT=" + fixtureServer.port);\n';
      await writeFile(join(dir, "server.ts"), serverSource);
      child = Bun.spawn([process.execPath, join(dir, "server.ts")], {
        env: { ...process.env, OMP_CODEX_WEB_SHIM_PORT: "0",
          OMP_CODEX_WEB_UPSTREAM: `http://127.0.0.1:${native.port}`,
          CODEX_CHATGPT_WEB_HOME: dir, OMP_CODEX_WEB_LOG_DIR: join(dir, "logs") },
        stdout: "pipe", stderr: "pipe",
      });
      const stdout = child.stdout.getReader();
      let log = "";
      const port = await Promise.race([
        (async () => {
          while (!log.includes("FIXTURE_PORT=")) {
            const read = await stdout.read();
            if (read.done) throw Error("shim exited before listening");
            log += new TextDecoder().decode(read.value);
          }
          return Number(log.match(/FIXTURE_PORT=(\d+)/)![1]);
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(Error("shim startup timeout")), 4000)),
      ]);
      void (async () => { while (!(await stdout.read()).done) {} })();
      void new Response(child.stderr).text();
      const call = { type: "function_call", call_id: "call_tool", name: "bash", arguments: "{}" };
      const history = [{ role: "user", content: "Resume one task" }, call,
        ...(scenario === "missing_result" ? [] : [{ type: "function_call_output", call_id: "call_tool", output: "exit 1" }])];
      const request = { model: "chatgpt-web/gpt-6", __omp_cwd: dir, input: history,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "logical-fixture", turn_id: "turn-fixture" }) } };
      const response = await fetch(`http://127.0.0.1:${port}/v1/codex/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(42_000),
      });
      expect(response.status).toBe(200);
      const result = await response.text();
      if (["repeated", "stall_after_submit", "settled_612", "new_version", "future_version", "transient_http", "transient_health", "slow_interrupt"].includes(scenario)) {
        expect(inputs).toHaveLength(scenario === "transient_http" ? 4 : scenario === "repeated" || scenario === "stall_after_submit" ? 3 : 2);
        expect(interrupted).toHaveLength(scenario === "transient_http" ? 3 : scenario === "repeated" || scenario === "stall_after_submit" || scenario === "slow_interrupt" ? 2 : 1);
        expect(result).toContain("FINISHED_AFTER_RETRY");
        expect(result).toContain("response.completed");
        expect(result).not.toContain("chatgpt_submitted_turn_failed");
        const owners = inputs.map(input => JSON.parse(input.client_metadata["x-codex-turn-metadata"]));
        expect(new Set(owners.map(owner => owner.thread_id)).size).toBe(inputs.length);
        expect(new Set(owners.map(owner => owner.turn_id)).size).toBe(inputs.length);
        const withoutCurrentOwner = (input: any) => input.input.map((item: any) => {
          const copy = structuredClone(item);
          if (copy.role === "user" && copy.internal_chat_message_metadata_passthrough)
            delete copy.internal_chat_message_metadata_passthrough.turn_id;
          return copy;
        });
        for (const input of inputs) expect(withoutCurrentOwner(input)).toEqual(withoutCurrentOwner(inputs[0]));
      } else {
        expect(inputs).toHaveLength(scenario === "permanent_http" ? 2 : 1);
        expect(interrupted).toHaveLength(scenario === "invalid_ack" || scenario === "permanent_http" ? 1 : 0);
        expect(result).toContain(scenario === "invalid_ack" ? "chatgpt_web_interrupt_invalid_ack"
          : scenario === "missing_result" ? "chatgpt_submitted_retry_context_incomplete"
          : "chatgpt_submitted_retry_http_rejected");
        if (scenario === "permanent_http") expect(result).toContain("HTTP 403");
        expect(result).not.toContain("chatgpt_submitted_turn_failed");
      }
    } finally {
      child?.kill();
      if (child) await child.exited;
      await native.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 65_000);
