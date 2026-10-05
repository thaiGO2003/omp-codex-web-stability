import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Command-backed model headers cache `!pwd` across subagents. Use the actual
// session cwd at request time so each isolated worker gets its own workspace.
export default function codexChatGptWebWorkspace(pi: ExtensionAPI) {
  // A title inference would open another ChatGPT tab alongside the worker.
  // Child sessions already have useful agent IDs; retain any existing name.
  pi.on("session_start", async (_event, ctx) => {
    if (["codex-chatgpt-web", "openai-codex"].includes(ctx.model?.provider ?? "") && ctx.agent.kind === "sub" && !pi.getSessionName()) {
      await pi.setSessionName(ctx.agent.id);
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!["codex-chatgpt-web", "openai-codex"].includes(ctx.model?.provider ?? "")) return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    return { ...event.payload, __omp_cwd: ctx.cwd };
  });
}
