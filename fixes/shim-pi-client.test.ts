import { test, expect } from "bun:test";
import { addCodexEnvironment } from "../shim/compatibility";

const promptBody = (text: string) => ({
  model: "chatgpt-web/gpt-5.6-sol",
  input: [
    { role: "developer", content: [{ type: "input_text", text: "system instructions" }] },
    { role: "user", content: [{ type: "input_text", text }] },
  ],
});

const parse = (value: string | undefined) => JSON.parse(value!);

test("Pi ownership is synthesized, stable across retries, and changes per prompt", () => {
  const first = parse(addCodexEnvironment(promptBody("hello"), "/repo", undefined, { client: "pi", sessionId: "session-a" }));
  const retry = parse(addCodexEnvironment(promptBody("hello"), "/repo", undefined, { client: "pi", sessionId: "session-a" }));
  expect(first.thread_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.turn_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(retry.thread_id).toBe(first.thread_id);
  expect(retry.turn_id).toBe(first.turn_id);

  const nextTurn = parse(addCodexEnvironment(promptBody("a different request"), "/repo", undefined, { client: "pi", sessionId: "session-a" }));
  expect(nextTurn.thread_id).toBe(first.thread_id);
  expect(nextTurn.turn_id).not.toBe(first.turn_id);

  const otherSession = parse(addCodexEnvironment(promptBody("hello"), "/repo", undefined, { client: "pi", sessionId: "session-b" }));
  expect(otherSession.thread_id).not.toBe(first.thread_id);
});

test("Pi requests get the environment envelope but never the OMP tooling instructions", () => {
  const body = promptBody("inspect the repo");
  addCodexEnvironment(body, "/repo", undefined, { client: "pi", sessionId: "session-a" });
  const items = body.input as Array<{ role: string; content: Array<{ text?: string }> }>;
  expect(items.filter(item => item.role === "developer")).toHaveLength(1);
  const texts = items.map(item => item.content?.[0]?.text ?? "").join("\n");
  expect(texts).toContain("<environment_context>");
  expect(texts).toContain("<cwd>/repo</cwd>");
  expect(texts).not.toContain("Oh My Pi");
});

test("OMP clients still require native turn metadata", () => {
  expect(addCodexEnvironment(promptBody("hello"), "/repo")).toBeUndefined();
});
