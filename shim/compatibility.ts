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

  const bridgeInstruction = {
    type: "message",
    id: stableMessageId("omp-tool-routing", threadId),
    role: "developer",
    content: [{ type: "input_text", text: [
      "The outer runtime is Oh My Pi (OMP). Its tools use their own names and schemas, including bash, read, write, edit and task.",
      "For OMP tools, discover the exact wire_name and schema with codex_tool_inventory, then invoke it with codex_tool_call using those exact arguments.",
      "Run shell commands through the advertised bash tool. Use codex_exec only when inventory actually advertises exec_command or shell_command; it cannot invoke OMP bash.",
      "Launch OMP subagents through the advertised task tool, using the selected custom provider model. Follow task's schema for batching and isolation.",
      "When task returns background job handles, yield a brief pending status for OMP's automatic result delivery. Avoid blocking wait calls while child Web turns are starting; they share the connector channel.",
    ].join("\n") }],
  };
  if (!input.some(value => record(value)?.id === bridgeInstruction.id)) {
    input.splice(activeUserIndex, 0, bridgeInstruction);
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
