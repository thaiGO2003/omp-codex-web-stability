import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDiagnostics } from "../bin/collect-diagnostics";

const encoder = new TextEncoder();
const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

test("actual shim HTTP path preserves full input on bounded silent replacement", async () => {
  for (const scenario of ["complete", "complete_619", "transient_recovery", "missing_result", "new_version", "invalid_ack"]) {
    const dir = await mkdtemp(join(tmpdir(), "omp-silent-http-"));
    const bodies: string[] = [];
    let interrupted = 0;
    const retiredThreads = new Set<string>();
    let firstIdentity = { threadId: "thread_fixture", turnId: "turn_fixture" };
    let first: ReadableStreamDefaultController<Uint8Array> | undefined;
    const native = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return Response.json({ version: scenario === "new_version" ? "6.1.13" : scenario === "complete_619" ? "6.1.9" : "6.1.7" });
        if (url.pathname === "/admin/interrupt-turn") {
          expect(req.headers.get("authorization")).toBe("Bearer fixture-control");
          const metadata = await req.json();
          expect(metadata).toEqual(firstIdentity);
          interrupted++;
          retiredThreads.add(metadata.threadId);
          try { first?.close(); } catch { /* idempotent fixture interruption */ }
          return Response.json({ status: scenario === "invalid_ack" ? "refused" : "ok", cancelled_http_turns: 1, cancelled_browser_turns: 1 });
        }
        expect(url.pathname).toBe("/v1/responses");
        bodies.push(await req.text());
        const requestMetadata = JSON.parse(JSON.parse(bodies.at(-1)!).client_metadata["x-codex-turn-metadata"]);
        const headerMetadata = JSON.parse(req.headers.get("x-codex-turn-metadata")!);
        if (bodies.length === 1 || scenario === "transient_recovery" && bodies.length === 2)
          firstIdentity = { threadId: requestMetadata.thread_id, turnId: requestMetadata.turn_id };
        expect(headerMetadata.turn_id).toBe(requestMetadata.turn_id);
        expect(headerMetadata.thread_id).toBe(requestMetadata.thread_id);
        // Native 6.1.9 remembers cancelled identities; the old chat's MCP
        // session may be gone as well. Reusing either cannot recover.
        if (retiredThreads.has(requestMetadata.thread_id)) return new Response(null, { status: 499 });
        if (scenario === "transient_recovery" && bodies.length === 2) return new Response("overloaded", { status: 503 });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(frame({ type: "response.created", response: { id: `resp_${bodies.length}`, status: "in_progress", output: [] } }));
          if (bodies.length === 1) first = controller;
          else {
            // Body generation outlives the header-only connection deadline.
            setTimeout(() => {
              controller.enqueue(frame({ type: "response.output_text.delta", delta: "HTTP_RECOVERED" }));
              controller.enqueue(frame({ type: "response.completed", response: { id: "resp_2", status: "completed" } }));
              controller.close();
            }, 150);
          }
        } }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(join(dir, "config.json"), JSON.stringify({ controlToken: "fixture-control" }));
      let source = await readFile(resolve("shim/server.ts"), "utf8");
      source = source.replace(/from "\.\/([^"]+)"/g, (_match, name) => `from ${JSON.stringify(pathToFileURL(resolve("shim", name + ".ts")).href)}`);
      source = source.replace("Bun.serve({", "const fixtureServer = Bun.serve({");
      // Accelerate the canonical timer only in this isolated fixture.
      source = source.replace("guardResponseStream(source, {", "guardResponseStream(source, { timeoutMs: 300,");
      source = source.replace("setTimeout(() => connect.abort(), 20_000)", "setTimeout(() => connect.abort(), 100)");
      if (scenario === "transient_recovery") source = source.replace("attempt === 1 ? 2_000 : attempt === 2 ? 5_000", "attempt === 1 ? 10 : attempt === 2 ? 10");
      source += '\nconsole.log("FIXTURE_PORT=" + fixtureServer.port);\n';
      await writeFile(join(dir, "server.ts"), source);
      child = Bun.spawn([process.execPath, join(dir, "server.ts")], {
        env: { ...process.env, OMP_CODEX_WEB_SHIM_PORT: "0", OMP_CODEX_WEB_UPSTREAM: `http://127.0.0.1:${native.port}`, CODEX_CHATGPT_WEB_HOME: dir,
          OMP_CODEX_WEB_LOG_DIR: join(dir, "logs") },
        stdout: "pipe", stderr: "pipe",
      });
      const reader = child.stdout.getReader();
      let startup = "";
      const port = await Promise.race([
        (async () => {
          while (!startup.includes("FIXTURE_PORT=")) {
            const next = await reader.read();
            if (next.done) throw Error("fixture shim exited before listening");
            startup += new TextDecoder().decode(next.value);
          }
          return Number(startup.match(/FIXTURE_PORT=(\d+)/)![1]);
        })(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error("fixture startup deadline")), 3000)),
      ]);
      // Drain diagnostic output so pipes cannot affect the experiment.
      void (async () => { while (!(await reader.read()).done) {} })();
      void new Response(child.stderr).text();
      const input: object[] = [{ role: "user", content: "Continue the isolated fixture" },
        { type: "function_call", call_id: "call_done_omp", name: "bash", arguments: "{}" }];
      if (scenario !== "missing_result") input.push({ type: "function_call_output", call_id: "call_done_omp", output: "failed: exit 7" });
      const requestBody = { model: "chatgpt-web/gpt-5.6-sol", __omp_cwd: dir,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_fixture", turn_id: "turn_fixture" }) }, input };
      const send = (value = requestBody) => fetch(`http://127.0.0.1:${port}/v1/codex/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(4000),
      });
      const response = await send();
      const output = await response.text();
      expect(interrupted).toBe(scenario === "transient_recovery" ? 2 : 1);
      const eligible = ["complete", "complete_619", "transient_recovery", "new_version"].includes(scenario);
      const recoveryIndex = scenario === "transient_recovery" ? 2 : 1;
      expect(bodies.length).toBe(eligible ? recoveryIndex + 1 : 1);
      if (eligible) {
        const firstBody = JSON.parse(bodies[0]), recoveredBody = JSON.parse(bodies[recoveryIndex]);
        const firstMetadata = JSON.parse(firstBody.client_metadata["x-codex-turn-metadata"]);
        const recoveredMetadata = JSON.parse(recoveredBody.client_metadata["x-codex-turn-metadata"]);
        expect(recoveredMetadata.thread_id).not.toBe(firstMetadata.thread_id);
        expect(recoveredMetadata.turn_id).not.toBe(firstMetadata.turn_id);
        // Only ownership may differ. All task content and completed tool
        // results must survive, including failures; no tool is replayed here.
        const withoutOwner = (value: any) => {
          const copy = structuredClone(value);
          const metadata = JSON.parse(copy.client_metadata["x-codex-turn-metadata"]);
          delete metadata.thread_id; delete metadata.turn_id;
          copy.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
          for (const item of copy.input) {
            if (item.role === "user" && item.internal_chat_message_metadata_passthrough) {
              delete item.internal_chat_message_metadata_passthrough.turn_id;
            }
          }
          return copy;
        };
        expect(withoutOwner(recoveredBody)).toEqual(withoutOwner(firstBody));
        expect(JSON.parse(bodies[recoveryIndex]).input).toContainEqual({ type: "function_call_output", call_id: "call_done", output: "failed: exit 7" });
        expect(output).toContain("HTTP_RECOVERED");
        expect(output).not.toContain("chatgpt_web_recovery_stopped");
        const continuation = await send();
        expect(await continuation.text()).toContain("HTTP_RECOVERED");
        const continuedMetadata = JSON.parse(JSON.parse(bodies[recoveryIndex + 1]).client_metadata["x-codex-turn-metadata"]);
        expect(continuedMetadata).toEqual(recoveredMetadata);
        const nextTurn = await send({ ...requestBody, client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_fixture", turn_id: "turn_next" }),
        } });
        expect(await nextTurn.text()).toContain("HTTP_RECOVERED");
        const nextMetadata = JSON.parse(JSON.parse(bodies[recoveryIndex + 2]).client_metadata["x-codex-turn-metadata"]);
        expect(nextMetadata.thread_id).toBe(recoveredMetadata.thread_id);
        expect(nextMetadata.turn_id).not.toBe(recoveredMetadata.turn_id);
      } else expect(output).toContain(scenario === "missing_result" ? "chatgpt_web_recovery_context_incomplete"
        : "chatgpt_web_interrupt_invalid_ack");
      const health = await (await fetch(`http://127.0.0.1:${port}/omp-shim-health`)).json();
      expect(health.diagnostics.enabled).toBe(true);
      expect(health.diagnostics.failedWrites).toBe(0);
      const rows = readDiagnostics(join(dir, "logs"), 0).records;
      const firstRequest = rows.find(row => row.event === "request_received")!.requestId;
      const requestRows = rows.filter(row => row.requestId === firstRequest);
      expect(requestRows.find(row => row.event === "upstream_headers")?.httpStatus).toBe(200);
      expect(requestRows.some(row => row.event === "semantic_timeout")).toBe(true);
      expect(requestRows.some(row => row.event === "request_finished")).toBe(true);
      expect(requestRows.some(row => row.event === "recovery_connected")).toBe(eligible);
      if (eligible) {
        const owners = new Set(requestRows.filter(row => row.event === "upstream_headers").map(row => row.nativeThreadId));
        expect(owners.size).toBe(recoveryIndex + 1);
        if (scenario === "transient_recovery") expect(requestRows.some(row => row.event === "recovery_connect_deferred")).toBe(true);
        expect(requestRows.filter(row => row.event === "stream_terminal").at(-1)?.eventType).toBe("response.completed");
      }
      const diagnosticText = JSON.stringify(rows);
      for (const secret of ["fixture-control", "Continue the isolated fixture", "HTTP_RECOVERED", "failed: exit 7", "thread_fixture", dir]) {
        expect(diagnosticText).not.toContain(secret);
      }
    } finally {
      child?.kill();
      if (child) await child.exited;
      await native.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 15_000);
