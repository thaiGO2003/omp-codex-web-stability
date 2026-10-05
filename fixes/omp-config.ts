// Serialize a real YAML mapping rather than editing it with line-based regexes.
export function updateOmpConfig(text: string): string {
  let value: unknown;
  try { value = Bun.YAML.parse(text); }
  catch { throw new Error("Cannot parse OMP config YAML; no files changed."); }
  if (value === null || value === undefined) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMP config must be a YAML mapping; no files changed.");
  }
  const config = value as Record<string, unknown>;
  const current = config.compaction;
  if (current !== undefined && current !== null && (typeof current !== "object" || Array.isArray(current))) {
    throw new Error("compaction must be a YAML mapping; no files changed.");
  }
  const compaction = (current ?? {}) as Record<string, unknown>;
  const order = compaction.methodOrder;
  if (Array.isArray(order) && order.length === 2 && order[0] === "shake" && order[1] === "handoff") return text;
  compaction.methodOrder = ["shake", "handoff"];
  config.compaction = compaction;
  let updated = Bun.YAML.stringify(config) + "\n";
  if (text.includes("\r\n")) updated = updated.replaceAll("\n", "\r\n");
  return updated;
}

if (import.meta.main) {
  try {
    const path = Bun.argv[2];
    if (!path) throw new Error("OMP config path required");
    const file = Bun.file(path);
    const original = await file.exists() ? await file.text() : "";
    const updated = updateOmpConfig(original);
    console.log(JSON.stringify({ changed: updated !== original, content: updated }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not prepare OMP config");
    process.exitCode = 1;
  }
}
