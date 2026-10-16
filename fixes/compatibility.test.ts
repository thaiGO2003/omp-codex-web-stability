import { expect, test } from "bun:test";
import { addCodexEnvironment } from "../shim/compatibility";
import { createHash } from "node:crypto";

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
  expect(evidence).toContain("historical state");
  expect(evidence).toContain("successful current result clears");
  expect(evidence).toContain("inspect the current diff");
  expect(evidence).toContain("do not resubmit it automatically");
  expect(evidence).toContain("Team coordination action is platform-blocked");
  const routing = JSON.stringify(instructions[0]);
  expect(routing).toContain("When codex_read is advertised");
  expect(routing).toContain("Keep delegated ownership distinct");
  expect(routing).toContain("Do not have the lead reopen");
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

test("retained routing and evidence guidance is upgraded without removing other conversation items", () => {
  const legacyRoutingId = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-routing", "thread-test"])).digest("hex").slice(0, 32)}`;
  const legacyRoutingV2Id = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-routing-v2", "thread-test"])).digest("hex").slice(0, 32)}`;
  const legacyRoutingV3Id = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-routing-v3", "thread-test"])).digest("hex").slice(0, 32)}`;
  const legacyEvidenceV1Id = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-evidence-v1", "thread-test"])).digest("hex").slice(0, 32)}`;
  const legacyEvidenceV2Id = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-evidence-v2", "thread-test"])).digest("hex").slice(0, 32)}`;
  const legacyEvidenceV3Id = `msg_${createHash("sha256").update(JSON.stringify(["omp-tool-evidence-v3", "thread-test"])).digest("hex").slice(0, 32)}`;
  const quotedReport = { type: "message", role: "assistant", id: "report", content: "Please confirm that I may continue with local repository work." };
  const otherDeveloper = { type: "message", role: "developer", id: "other", content: "Require approval before deployment." };
  const body = {
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-test", turn_id: "turn-new" }) },
    input: [
      { type: "message", role: "developer", id: legacyRoutingId, content: "Previous tool routing guidance" },
      { type: "message", role: "developer", id: legacyRoutingV2Id, content: "Previous direct-inventory-only guidance" },
      { type: "message", role: "developer", id: legacyRoutingV3Id, content: "Previous catalog-only guidance" },
      { type: "message", role: "developer", id: legacyEvidenceV1Id, content: "Previous tool evidence guidance" },
      { type: "message", role: "developer", id: legacyEvidenceV2Id, content: "Current old tool evidence guidance" },
      { type: "message", role: "developer", id: legacyEvidenceV3Id, content: "Previous platform-block guidance" },
      otherDeveloper, quotedReport,
      { role: "user", content: "Check the already authorized work" },
    ],
  };
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body.input.some(item => item.id === legacyRoutingId || item.id === legacyRoutingV2Id || item.id === legacyEvidenceV1Id || item.id === legacyEvidenceV2Id || item.id === legacyEvidenceV3Id)).toBe(false);
  expect(body.input.some(item => item.id === legacyRoutingV3Id)).toBe(false);
  expect(body.input).toContainEqual(otherDeveloper);
  expect(body.input).toContainEqual(quotedReport);
  const guidance = body.input.filter(item => item.role === "developer" && item.id !== "other");
  expect(guidance).toHaveLength(2);
  expect(JSON.stringify(guidance)).toContain("Keep delegated ownership distinct");
  expect(JSON.stringify(guidance)).toContain("When codex_read is advertised");
  expect(JSON.stringify(guidance)).toContain("historical state");
  expect(JSON.stringify(guidance)).toContain("Team coordination action is platform-blocked");
  const rewritten = structuredClone(body);
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body).toEqual(rewritten);
  expect(body.input.at(-1)?.role).toBe("user");
});

test("missing metadata does not insert guidance into an unrelated request", () => {
  const body = { input: [{ role: "user", content: "Hello" }] };
  const before = structuredClone(body);
  expect(addCodexEnvironment(body, "/tmp/omp-test")).toBeUndefined();
  expect(body).toEqual(before);
});

test("mounted MCP discovery remains available with a small direct registry", () => {
  const directTools = ["bash", "read", "write", "edit", "grep", "find", "ls", "task", "todo", "ask", "web_search", "fetch", "python"]
    .map(name => ({ type: "function", name, parameters: { type: "object" } }));
  const catalogResult = {
    type: "function_call_output", call_id: "catalog",
    output: "onedevtool/browser_list_tabs → xd://mcp__onedevtool_browser_list_tabs",
  };
  const body = {
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "mounted-test", turn_id: "turn-test" }) },
    tools: structuredClone(directTools),
    input: [catalogResult, { role: "user", content: "Continue BrowserPanel acceptance" }],
  };
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body.tools).toEqual(directTools);
  expect(body.input[0]).toEqual(catalogResult);
  const routing = JSON.stringify(body.input.find(item => item.role === "developer"));
  expect(routing).toContain("read the live xd:// catalog");
  expect(routing).toContain("exact device path returned by that catalog");
  expect(routing).toContain("advertised OMP write tool");
  expect(routing).toContain("content is a JSON string");
  expect(routing).toContain("browser_list_tabs device first");
  expect(routing).toContain("honor any current explicit rejection");
  expect(routing).toContain("/mcp reload");
  expect(routing).toContain("neither a reload receipt nor another successful Codex session proves");
  const rewritten = structuredClone(body);
  addCodexEnvironment(body, "/tmp/omp-test");
  expect(body).toEqual(rewritten);
});
