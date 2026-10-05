type Mapping = Record<string, any>;
function mapping(value: unknown, name: string): Mapping {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a YAML mapping`);
  return value as Mapping;
}
function parse(text: string, name: string): Mapping {
  try { return mapping(Bun.YAML.parse(text), name); }
  catch { throw new Error(`Invalid ${name} YAML; no files changed`); }
}
function serialize(value: Mapping, original: string): string {
  // Leave healthy configs byte-for-byte unchanged, including comments.
  if (JSON.stringify(value) === JSON.stringify(parse(original, "config"))) return original;
  const text = Bun.YAML.stringify(value) + "\n";
  return original.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
}
const sol = "chatgpt-web/gpt-5.6-sol";
const instant = "chatgpt-web/gpt-5.6-sol-instant";
export function configureOmpWeb(configText: string, modelsText: string, baseUrl: string, judgeUrl?: string) {
  const config = parse(configText, "OMP config");
  const models = parse(modelsText, "OMP models");
  const roles = mapping(config.modelRoles, "modelRoles");
  Object.assign(roles, {
    default: `codex-chatgpt-web/${sol}:high`,
    vision: `codex-chatgpt-web/${sol}:high`,
    plan: `codex-chatgpt-web/${sol}:high`,
    task: `codex-chatgpt-web/${sol}:high`,
    commit: `codex-chatgpt-web/${instant}:auto`,
    web: `openai-codex/${sol}:high`,
  });
  config.modelRoles = roles;
  const providers = mapping(models.providers, "providers");
  const definitions = [
    { id: sol, name: "GPT-5.6 Sol (Web)", preferWebsockets: false, reasoning: true,
      thinking: { mode: "effort", efforts: ["medium", "high", "xhigh"], defaultLevel: "high" },
      input: ["text"], supportsTools: true, contextWindow: 90000, maxTokens: 16384 },
    { id: instant, name: "GPT-5.6 Sol Instant (Web)", preferWebsockets: false, reasoning: true,
      thinking: { mode: "effort", efforts: ["low"], defaultLevel: "low" },
      input: ["text"], supportsTools: true, contextWindow: 41000, maxTokens: 16384 },
  ];
  for (const name of ["codex-chatgpt-web", "openai-codex"]) {
    const previous = mapping(providers[name], name);
    if (previous.models !== undefined && !Array.isArray(previous.models)) throw new Error(`${name}.models must be a list`);
    const entries = previous.models ?? [];
    const headers = mapping(previous.headers, `${name}.headers`);
    const provider = { ...previous, baseUrl, api: "openai-codex-responses", auth: "none",
      // This header marks OMP requests; the extension supplies each session's actual cwd.
      headers: { ...headers, "x-omp-cwd": "OMP_WORKSPACE_CWD" },
      models: [...entries.filter((model: any) => !definitions.some(d => d.id === model?.id)), ...definitions],
    } as Mapping;
    delete provider.apiKey;
    delete provider.oauth;
    delete provider.authHeader;
    for (const key of Object.keys(provider.headers)) {
      if (key.toLowerCase() === "authorization") delete provider.headers[key];
    }
    providers[name] = provider;
  }
  // Existing judge settings are retained unless the user supplies a router URL.
  if (judgeUrl) {
    const previous = mapping(providers["9router"], "9router");
    const entries = previous.models ?? [];
    if (!Array.isArray(entries)) throw new Error("9router.models must be a list");
    const provider = { ...previous, baseUrl: judgeUrl, api: "typesafe",
      models: [...entries.filter((m: any) => m?.id !== "oc/jev-1.13-free"),
        { id: "oc/jev-1.13-free", name: "JEV 1.13 Free (9Router)", reasoning: false, input: ["text"], supportsTools: false }],
    } as Mapping;
    if (!previous.apiKey && previous.auth !== "none") provider.apiKey = "NINE_ROUTER_API_KEY";
    providers["9router"] = provider;
    roles.judge = "9router/oc/jev-1.13-free";
  }
  models.providers = providers;
  return { config: serialize(config, configText), models: serialize(models, modelsText) };
}

if (import.meta.main) {
  try {
    const [configPath, modelsPath, baseUrl, judgeUrl] = Bun.argv.slice(2);
    if (!configPath || !modelsPath || !baseUrl) throw new Error("Config paths and shim URL required");
    const read = async (path: string) => await Bun.file(path).exists() ? await Bun.file(path).text() : "";
    const originalConfig = await read(configPath), originalModels = await read(modelsPath);
    const updated = configureOmpWeb(originalConfig, originalModels, baseUrl, judgeUrl);
    console.log(JSON.stringify({ changes: [
      ...(updated.config !== originalConfig ? [{ path: configPath, text: updated.config }] : []),
      ...(updated.models !== originalModels ? [{ path: modelsPath, text: updated.models }] : []),
    ] }));
  } catch (error) {
    // Never print config content or credentials in diagnostics.
    console.error(error instanceof Error ? error.message : "Cannot prepare OMP Web configuration");
    process.exitCode = 1;
  }
}
