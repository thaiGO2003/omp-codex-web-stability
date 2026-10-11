import { expect, test } from "bun:test";
import { addCodexEnvironment } from "../shim/compatibility";

test("tool evidence guidance preserves successful results and assistant reports", () => {
  const history = [
    { role: "assistant", content: "The patch was blocked by OpenAI." },
    { type: "function_call_output", call_id: "call_read", output: "File contents", isError: false },
    { type: "function_call_output", call_id: "call_edit", output: "Permission denied", isError: true },
  ];
  const before = structuredClone(history);
  const body = {
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-test", turn_id: "turn-test" }) },
    input: [...history, { role: "user", content: "Check the patch" }],
  };
  expect(addCodexEnvironment(body, "/tmp/omp-test")).toBeDefined();
  expect(body.input.slice(0, history.length)).toEqual(before);
  const instructions = body.input.filter(item => item.role === "developer");
  expect(instructions).toHaveLength(2);
  const evidence = JSON.stringify(instructions[1]);
  expect(evidence).toContain("actual tool result");
  expect(evidence).toContain("cause is unverified");
  expect(evidence).toContain("inspect the current diff");
  expect(evidence).toContain("do not resubmit it automatically");
  expect(body.input.at(-1)?.role).toBe("user");

  const rewritten = structuredClone(body);
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body).toEqual(rewritten);
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: "thread-test", turn_id: "turn-next" });
  body.input.push({ role: "user", content: "Continue checking" });
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body.input.filter(item => item.role === "developer")).toEqual(instructions);
  expect(body.input.slice(0, history.length)).toEqual(before);
});

test("missing metadata does not insert guidance into an unrelated request", () => {
  const body = { input: [{ role: "user", content: "Hello" }] };
  const before = structuredClone(body);
  expect(addCodexEnvironment(body, "/tmp/omp-test")).toBeUndefined();
  expect(body).toEqual(before);
});
