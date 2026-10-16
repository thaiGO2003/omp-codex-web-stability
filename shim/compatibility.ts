import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function messageText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function stableMessageId(...identity: unknown[]): string {
  return `msg_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

export function addCodexEnvironment(
  body: Record<string, unknown>,
  cwd: string,
  headerTurnMetadata?: string,
): string | undefined {
  if (!isAbsolute(cwd)) return undefined;

  const clientMetadata = record(body.client_metadata);
  if (!clientMetadata) return undefined;
  const bodyTurnMetadata = clientMetadata["x-codex-turn-metadata"];
  const rawTurnMetadata = typeof bodyTurnMetadata === "string"
    ? bodyTurnMetadata
    : headerTurnMetadata;
  if (typeof rawTurnMetadata !== "string") {
    console.log("codex-env reject", { stage: "turn-metadata", clientMetadataKeys: Object.keys(clientMetadata).sort(), bodyTurnMetadataType: typeof bodyTurnMetadata, hasHeaderTurnMetadata: Boolean(headerTurnMetadata) });
    return undefined;
  }

  let turnMetadata: Record<string, unknown>;
  try {
    turnMetadata = record(JSON.parse(rawTurnMetadata)) ?? {};
  } catch {
    console.log("codex-env reject", { stage: "turn-metadata-json", rawTurnMetadataLength: rawTurnMetadata.length });
    return undefined;
  }
  const turnId = typeof turnMetadata.turn_id === "string"
    ? turnMetadata.turn_id
    : typeof clientMetadata.turn_id === "string"
      ? clientMetadata.turn_id
      : undefined;
  if (!turnId) {
    console.log("codex-env reject", { stage: "turn-id", turnMetadataKeys: Object.keys(turnMetadata).sort(), clientMetadataKeys: Object.keys(clientMetadata).sort() });
    return undefined;
  }

  turnMetadata.sandbox = "none";
  turnMetadata.workspaces = { [cwd]: {} };
  clientMetadata["x-codex-turn-metadata"] = JSON.stringify(turnMetadata);

  const input = Array.isArray(body.input) ? body.input : undefined;
  if (!input) {
    console.log("codex-env reject", { stage: "input" });
    return undefined;
  }

  // EasyInputMessage omits type/id. Native browser replay needs the same item ID
  // on every tool continuation, retry and later turn containing this history.
  const threadId = turnMetadata.thread_id ?? clientMetadata.thread_id ?? body.prompt_cache_key;
  let userOrdinal = 0;
  for (const value of input) {
    const item = record(value);
    if (!item || item.role !== "user" || (item.type !== undefined && item.type !== "message")) continue;
    item.type = "message";
    if (typeof item.id !== "string" || !item.id) {
      item.id = stableMessageId("omp-user", threadId, userOrdinal, item.content);
    }
    userOrdinal += 1;
  }

  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item || item.role !== "user") continue;
    if (/^<environment_context\b/i.test(messageText(item).trimStart())) continue;
    if (item.type === undefined) item.type = "message";
    if (item.type !== "message") continue;
    activeUserIndex = index;
    break;
  }
  if (activeUserIndex < 0) {
    console.log("codex-env reject", { stage: "active-user", inputLength: input.length, itemKinds: input.map(value => { const item = record(value); return `${String(item?.type ?? "?")}:${String(item?.role ?? "?")}`; }) });
    return undefined;
  }

  const activeUser = record(input[activeUserIndex])!;
  const userPassthrough = record(activeUser.internal_chat_message_metadata_passthrough) ?? {};
  activeUser.internal_chat_message_metadata_passthrough = {
    ...userPassthrough,
    turn_id: turnId,
  };

  const escapedCwd = xmlEscape(cwd);
  const environmentText = [
    "<environment_context>",
    `  <cwd>${escapedCwd}</cwd>`,
    "  <filesystem>",
    "    <workspace_roots>",
    `      <root>${escapedCwd}</root>`,
    "    </workspace_roots>",
    '    <permission_profile type="disabled">',
    '      <file_system type="unrestricted" />',
    "    </permission_profile>",
    "  </filesystem>",
    "</environment_context>",
  ].join("\n");

  // Version routing guidance too: retained browser history can otherwise keep
  // the old lead/member wording beside the current instruction.
  const previousBridgeIds = new Set([
    stableMessageId("omp-tool-routing", threadId),
    stableMessageId("omp-tool-routing-v2", threadId),
  ]);
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (item?.role !== "developer" || item.type !== "message" || !previousBridgeIds.has(String(item.id))) continue;
    input.splice(index, 1);
    if (index < activeUserIndex) activeUserIndex -= 1;
  }
  const bridgeInstruction = {
    type: "message",
    id: stableMessageId("omp-tool-routing-v3", threadId),
    role: "developer",
    content: [{ type: "input_text", text: [
      "The outer runtime is Oh My Pi (OMP). Its tools use their own names and schemas, including bash, read, write, edit and task.",
      "When codex_read is advertised, use it directly for OMP file reads. It is a dedicated read-only gateway and accepts the same path selector as OMP read; otherwise use the discovered read wire_name through codex_tool_call.",
      "For other OMP tools, discover the exact wire_name and schema with codex_tool_inventory, then invoke it with codex_tool_call using those exact arguments.",
      "OMP may mount MCP tools as xd:// devices instead of exposing them in the direct tool inventory. A small direct registry, or no onedevtool/browser_* match there, does not prove that BrowserPanel MCP is unavailable.",
      "Before reporting a missing MCP capability, read the live xd:// catalog through codex_read (or the discovered OMP read tool). Use the exact device path returned by that catalog; read that path for its current documentation and JSON schema.",
      "Execute a discovered MCP device through the advertised OMP write tool: path is the exact xd:// device path and content is a JSON string of arguments matching its schema. Discover write's wire_name and schema with codex_tool_inventory and dispatch it through codex_tool_call; do not invent a direct browser tool or a device path.",
      "For 1DevTool BrowserPanel, discover the onedevtool browser_list_tabs device first, invoke it, then reuse the returned projectId/tabId for the remaining browser devices. This device route calls the same 1DevTool MCP tools; it is not generic browser automation. Preserve the mounted tool's approval policy and honor any current explicit rejection.",
      "Only report MCP as unavailable when current catalog discovery or the discovered MCP call supplies evidence of the failure. A historical TODO or handoff claiming that the direct registry lacks MCP tools must be rechecked against the current xd:// catalog.",
      "Run shell commands through the advertised bash tool. Use codex_exec only when inventory actually advertises exec_command or shell_command; it cannot invoke OMP bash.",
      "Launch OMP subagents through the advertised task tool, using the selected custom provider model. Follow task's schema for batching and isolation.",
      "When task returns background job handles, yield a brief pending status for OMP's automatic result delivery. Avoid blocking wait calls while child Web turns are starting; they share the connector channel.",
      "Keep delegated ownership distinct: the assigned member executes the delegated browser or implementation work; the lead tracks task-board/mailbox results and dependencies. Do not have the lead reopen, rerun, or duplicate a member's assigned browser or implementation work. Start dependent waves only after the member reports the prerequisite acceptance evidence.",
    ].join("\n") }],
  };
  if (!input.some(value => record(value)?.id === bridgeInstruction.id)) {
    input.splice(activeUserIndex, 0, bridgeInstruction);
    activeUserIndex += 1;
  }

  // Version the instruction ID so retained browser turns receive the update.
  // Remove only our previous developer item, never a quoted assistant report.
  const previousEvidenceIds = new Set([
    stableMessageId("omp-tool-evidence-v1", threadId),
    stableMessageId("omp-tool-evidence-v2", threadId),
    stableMessageId("omp-tool-evidence-v3", threadId),
  ]);
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (item?.role !== "developer" || item.type !== "message" || !previousEvidenceIds.has(String(item.id))) continue;
    input.splice(index, 1);
    if (index < activeUserIndex) activeUserIndex -= 1;
  }
  const evidenceInstruction = {
    type: "message",
    id: stableMessageId("omp-tool-evidence-v4", threadId),
    role: "developer",
    content: [{ type: "input_text", text: [
      "Report tool outcomes from the actual tool result. Distinguish a successful read from an attempted edit, a failed tool invocation, and a patch that was never submitted.",
      "Earlier assistant statements or quoted error messages are conversation history, not evidence that a current tool call failed. If platform rejection details are unavailable, say the cause is unverified.",
      "A platform rejection recorded only in earlier assistant text, a handoff, or a TODO is historical state. Re-evaluate the current read with codex_read; a successful current result clears that historical blocker for the path.",
      "Before claiming that a patch changed a file or made no changes, inspect the current diff or file contents; existing changes may belong to another agent. Preserve successful tool results and existing edits.",
      "Use authorization already given in this conversation. Do not request generic permission again for routine local inspection, scoped edits or targeted tests already authorized by the user. Keep required approvals for new scope, destructive actions or an explicit safety review.",
      "Honor an explicit platform tool rejection. Report the affected operation and available error details; do not resubmit it automatically or suggest that local Always allow/YOLO overrides platform controls.",
      "A current explicit platform rejection is not a missing generic local permission: do not ask the user to say continue or confirm all repository work as its remedy. Report that current operation once and preserve completed work. Do not repeat, repackage or route that same rejected operation through another tool. Continue independent authorized work; if none remains, give a concise blocked status.",
      "If a Team coordination action is platform-blocked, do not treat the block as proof that a delegated task or its acceptance is complete. Record that coordination blocker once. Continue only other independent, already-authorized coordination that neither duplicates the assigned member's work nor circumvents the rejection.",
    ].join("\n") }],
  };
  if (!input.some(value => record(value)?.id === evidenceInstruction.id)) {
    input.splice(activeUserIndex, 0, evidenceInstruction);
    activeUserIndex += 1;
  }

  const environment = {
    type: "message",
    id: stableMessageId("omp-environment", threadId, turnId, activeUser.id, cwd),
    role: "user",
    content: [{ type: "input_text", text: environmentText }],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      content_item_kinds: ["environments.environment_context"],
    },
  };
  if (record(input[activeUserIndex - 1])?.id === environment.id) {
    input[activeUserIndex - 1] = environment;
  } else {
    input.splice(activeUserIndex, 0, environment);
  }
  return JSON.stringify(turnMetadata);
}
