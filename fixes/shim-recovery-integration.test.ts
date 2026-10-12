import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const encoder = new TextEncoder();
const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

test("actual shim HTTP path preserves full input on bounded silent replacement", async () => {
  for (const scenario of ["complete", "missing_result", "unsupported_version"]) {
    const dir = await mkdtemp(join(tmpdir(), "omp-silent-http-"));
    const bodies: string[] = [];
    let interrupted = 0;
    let first: ReadableStreamDefaultController<Uint8Array> | undefined;
    const native = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return Response.json({ version: scenario === "unsupported_version" ? "6.1.8" : "6.1.7" });
        if (url.pathname === "/admin/interrupt-turn") {
          expect(req.headers.get("authorization")).toBe("Bearer fixture-control");
          const metadata = await req.json();
          expect(metadata).toEqual({ threadId: "thread_fixture", turnId: "turn_fixture" });
          interrupted++;
          try { first?.close(); } catch { /* idempotent fixture interruption */ }
          return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 1 });
        }
        expect(url.pathname).toBe("/v1/responses");
        bodies.push(await req.text());
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
      source = source.replace("guardResponseStream(upstream.body!, {", "guardResponseStream(upstream.body!, { timeoutMs: 300,");
      source = source.replace("setTimeout(() => connect.abort(), 20_000)", "setTimeout(() => connect.abort(), 100)");
      source += '\nconsole.log("FIXTURE_PORT=" + fixtureServer.port);\n';
      await writeFile(join(dir, "server.ts"), source);
      child = Bun.spawn([process.execPath, join(dir, "server.ts")], {
        env: { ...process.env, OMP_CODEX_WEB_SHIM_PORT: "0", OMP_CODEX_WEB_UPSTREAM: `http://127.0.0.1:${native.port}`, CODEX_CHATGPT_WEB_HOME: dir },
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
      const response = await fetch(`http://127.0.0.1:${port}/v1/codex/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", __omp_cwd: dir,
          client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_fixture", turn_id: "turn_fixture" }) }, input }),
        signal: AbortSignal.timeout(4000),
      });
      const output = await response.text();
      expect(interrupted).toBe(scenario === "unsupported_version" ? 2 : 1);
      expect(bodies.length).toBe(scenario === "complete" ? 2 : 1);
      if (scenario === "complete") {
        expect(bodies[1]).toBe(bodies[0]);
        expect(JSON.parse(bodies[1]).input).toContainEqual({ type: "function_call_output", call_id: "call_done", output: "failed: exit 7" });
        expect(output).toContain("HTTP_RECOVERED");
        expect(output).not.toContain("chatgpt_web_recovery_stopped");
      } else expect(output).toContain("chatgpt_web_recovery_stopped");
    } finally {
      child?.kill();
      if (child) await child.exited;
      await native.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 15_000);
