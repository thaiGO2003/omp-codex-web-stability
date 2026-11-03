import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDiagnostics } from "../bin/collect-diagnostics";

const encoder = new TextEncoder();
const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const SUPERSEDED = "A newer Codex instruction superseded this ChatGPT response.";

/** A client cancellation and a native 499 both leave an old ChatGPT conversation
 * active. The shim must replay the turn under fresh ownership instead of returning a
 * terminal supersede error the client retries into a loop. */
for (const scenario of ["client_cancelled", "native_superseded"] as const) {
  test(`the shim replays a superseded turn under fresh ownership after ${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-supersede-"));
    const bodies: string[] = [];
    const interrupted: Array<{ threadId: string; turnId: string }> = [];
    let firstOwner: { threadId: string; turnId: string } | undefined;
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    let submissions = 0;
    const native = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return Response.json({ version: "6.1.7" });
        if (url.pathname === "/admin/interrupt-turn") {
          const metadata = await req.json();
          interrupted.push(metadata);
          try { held?.close(); } catch { /* the fixture stream is already gone */ }
          return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 1 });
        }
        expect(url.pathname).toBe("/v1/responses");
        const text = await req.text();
        bodies.push(text);
        submissions++;
        const metadata = JSON.parse(JSON.parse(text).client_metadata["x-codex-turn-metadata"]);
        firstOwner ??= { threadId: metadata.thread_id, turnId: metadata.turn_id };
        if (scenario === "native_superseded" && submissions === 1) {
          return Response.json({ error: { message: SUPERSEDED } }, { status: 499 });
        }
        // The old conversation still owns a live turn: any new instruction for it is
        // exactly what the native bridge answers with 499.
        if (metadata.thread_id === firstOwner.threadId && submissions > 1) {
          return Response.json({ error: { message: SUPERSEDED } }, { status: 499 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame({ type: "response.created", response: { id: "resp_fresh", status: "in_progress", output: [] } }));
            if (scenario === "client_cancelled" && submissions === 1) { held = controller; return; }
            controller.enqueue(frame({ type: "response.output_text.delta", delta: "FRESH_OK" }));
            controller.enqueue(frame({ type: "response.completed", response: { id: "resp_fresh", status: "completed" } }));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(join(dir, "config.json"), JSON.stringify({ controlToken: "fixture-control" }));
      let source = await readFile(resolve("shim/server.ts"), "utf8");
      source = source.replace(/from "\.\/([^"]+)"/g, (_match, name) => `from ${JSON.stringify(pathToFileURL(resolve("shim", name + ".ts")).href)}`);
      source = source.replace("Bun.serve({", "const fixtureServer = Bun.serve({");
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
      void (async () => { while (!(await reader.read()).done) {} })();
      void new Response(child.stderr).text();

      const requestBody = { model: "chatgpt-web/gpt-5.6-sol", __omp_cwd: dir,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_fixture", turn_id: "turn_fixture" }) },
        input: [{ role: "user", content: "finish the isolated fixture" }] };
      const send = (signal?: AbortSignal) => fetch(`http://127.0.0.1:${port}/v1/codex/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody), signal,
      });

      if (scenario === "client_cancelled") {
        // The client walks away mid-turn (Pi abort, SIGTERM, transport reset).
        await send(AbortSignal.timeout(700)).then(response => response.text()).catch(() => {});
        // Wait for the shim to register the cancellation before replaying.
        for (let attempt = 0; attempt < 150 && interrupted.length === 0; attempt++) {
          await new Promise(done => setTimeout(done, 20));
        }
        expect(interrupted).toHaveLength(1);
      }

      const response = await send(AbortSignal.timeout(4000));
      const output = await response.text();
      expect(response.status).toBe(200);
      expect(output).toContain("FRESH_OK");
      expect(output).not.toContain(SUPERSEDED);
      expect(bodies).toHaveLength(2);
      const firstMetadata = JSON.parse(JSON.parse(bodies[0]).client_metadata["x-codex-turn-metadata"]);
      const replayedMetadata = JSON.parse(JSON.parse(bodies[1]).client_metadata["x-codex-turn-metadata"]);
      expect(replayedMetadata.thread_id).not.toBe(firstMetadata.thread_id);
      expect(replayedMetadata.turn_id).not.toBe(firstMetadata.turn_id);
      expect(interrupted[0]).toEqual({ threadId: firstMetadata.thread_id, turnId: firstMetadata.turn_id });
      // Only ownership moves; the task content is byte-for-byte the same.
      const withoutOwner = (value: any) => {
        const copy = structuredClone(value);
        const metadata = JSON.parse(copy.client_metadata["x-codex-turn-metadata"]);
        delete metadata.thread_id; delete metadata.turn_id;
        copy.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
        delete copy.client_metadata.turn_id;
        for (const item of copy.input) {
          if (item.role === "user" && item.internal_chat_message_metadata_passthrough) {
            delete item.internal_chat_message_metadata_passthrough.turn_id;
          }
        }
        return copy;
      };
      expect(withoutOwner(JSON.parse(bodies[1]))).toEqual(withoutOwner(JSON.parse(bodies[0])));

      const rows = readDiagnostics(join(dir, "logs"), 0).records;
      const request = rows.find(row => row.event === "request_received")!.requestId;
      const requestRows = rows.filter(row => row.requestId === request);
      expect(requestRows.some(row => row.event === "supersede_detected")).toBe(scenario === "native_superseded");
      expect(requestRows.some(row => row.event === "supersede_replayed")).toBe(scenario === "native_superseded");
    } finally {
      child?.kill();
      if (child) await child.exited;
      await native.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
