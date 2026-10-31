import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { attachTurnMetadata, decodeJsonRequestBody, readTurnMetadata, turnIdentity } from "../shim/request-identity";
import { hasCompleteRecoveryInput } from "../shim/sse-watchdog";

const body = { model: "chatgpt-web/gpt-6-sol", stream: true, input: [{ type: "message", role: "user", content: [] }] };
const text = JSON.stringify(body);
const bytes = new TextEncoder().encode(text);

test("Codex CLI zstd bodies become readable JSON and unknown encodings stay untouched", () => {
  expect(decodeJsonRequestBody(Bun.zstdCompressSync(bytes), "zstd")).toBe(text);
  expect(decodeJsonRequestBody(gzipSync(bytes), "gzip")).toBe(text);
  expect(decodeJsonRequestBody(bytes, null)).toBe(text);
  expect(decodeJsonRequestBody(bytes, "compress")).toBeUndefined();
  expect(decodeJsonRequestBody(new TextEncoder().encode("not json"), "zstd")).toBeUndefined();
});

test("CLI header ownership is mirrored into the body without changing existing metadata", () => {
  const header = JSON.stringify({ thread_id: "01a19248-f6c2-7892-8ac7-558667a413b8", turn_id: "01a19248-fa36-7f81-b894-db30dc85e5d2" });
  const request: Record<string, unknown> = { ...body, client_metadata: { session_id: "s" } };
  expect(readTurnMetadata(request, header)).toMatchObject({ thread_id: "01a19248-f6c2-7892-8ac7-558667a413b8" });
  const metadata = attachTurnMetadata(request, header);
  expect(turnIdentity(metadata)).toEqual({
    threadId: "01a19248-f6c2-7892-8ac7-558667a413b8",
    turnId: "01a19248-fa36-7f81-b894-db30dc85e5d2",
  });
  expect(JSON.parse((request.client_metadata as Record<string, string>)["x-codex-turn-metadata"]!)).toEqual(JSON.parse(header));

  // A native body value always wins; recovery must rebind the identity the request already carries.
  const native = { ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "body-thread", turn_id: "body-turn" }) } };
  expect(turnIdentity(attachTurnMetadata(native, header))).toEqual({ threadId: "body-thread", turnId: "body-turn" });
});

test("a CLI turn with complete history is eligible for silent replacement", () => {
  const cliTurn = {
    ...body,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ],
  };
  expect(hasCompleteRecoveryInput(cliTurn)).toBe(true);
  expect(hasCompleteRecoveryInput({ ...cliTurn, previous_response_id: "resp_1" })).toBe(false);
  expect(hasCompleteRecoveryInput({ ...cliTurn, input: cliTurn.input.slice(0, 2) })).toBe(false);
});
