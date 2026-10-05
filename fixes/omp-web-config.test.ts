import { expect, test } from "bun:test";
import { configureOmpWeb } from "./omp-web-config";
import installExtension from "../shim/omp-extension";

test("Web roles and both providers are configured without changing compaction or other providers", () => {
  const config = { modelRoles: { default: "old/model", judge: "existing/judge", speech: "local/kokoro" },
    compaction: { methodOrder: ["soft"] }, theme: { dark: "mine" } };
  const models = { providers: { existing: { apiKey: "keep-local-value", models: [] } } };
  const result = configureOmpWeb(Bun.YAML.stringify(config), Bun.YAML.stringify(models), "http://127.0.0.1:18842/v1");
  const c = Bun.YAML.parse(result.config) as any, m = Bun.YAML.parse(result.models) as any;
  expect(c.modelRoles.default).toBe("codex-chatgpt-web/chatgpt-web/gpt-5.6-sol:high");
  expect(c.modelRoles.web).toBe("openai-codex/chatgpt-web/gpt-5.6-sol:high");
  expect(c.modelRoles.commit).toEndWith(":auto");
  expect(c.modelRoles.judge).toBe("existing/judge");
  expect(c.modelRoles.speech).toBe("local/kokoro");
  expect(c.compaction).toEqual(config.compaction);
  expect(c.theme).toEqual(config.theme);
  expect(m.providers.existing).toEqual(models.providers.existing);
  expect(m.providers["codex-chatgpt-web"].api).toBe("openai-codex-responses");
  expect(m.providers["codex-chatgpt-web"].baseUrl).toBe("http://127.0.0.1:18842/v1");
  expect(m.providers["openai-codex"].models).toHaveLength(2);
  expect(configureOmpWeb(result.config, result.models, "http://127.0.0.1:18842/v1")).toEqual(result);
});

test("overwriting a Web provider drops stale remote auth and keeps unrelated models", () => {
  const models = { providers: { "codex-chatgpt-web": { apiKey: "stale", auth: "apiKey",
    headers: { Authorization: "stale", custom: "keep" }, models: [{ id: "custom" }] } } };
  const result = Bun.YAML.parse(configureOmpWeb("", Bun.YAML.stringify(models), "http://localhost:17842/v1").models) as any;
  const p = result.providers["codex-chatgpt-web"];
  expect(p.apiKey).toBeUndefined();
  expect(p.headers.Authorization).toBeUndefined();
  expect(p.headers.custom).toBe("keep");
  expect(p.models[0].id).toBe("custom");
  expect(p.auth).toBe("none");
});

test("optional router judge uses the supplied URL and local environment credentials", () => {
  const result = configureOmpWeb("", "", "http://localhost:17842/v1", "http://localhost:20218");
  const c = Bun.YAML.parse(result.config) as any, m = Bun.YAML.parse(result.models) as any;
  expect(c.modelRoles.judge).toBe("9router/oc/jev-1.13-free");
  expect(m.providers["9router"].apiKey).toBe("NINE_ROUTER_API_KEY");
  expect(m.providers["9router"].baseUrl).toBe("http://localhost:20218");
});

test("invalid config structures prevent provider and role preparation", () => {
  for (const [config, models] of [["broken: [", ""], ["modelRoles: []", ""], ["", "providers: []"],
    ["", "providers: {codex-chatgpt-web: {models: false}}"]]) {
    expect(() => configureOmpWeb(config, models, "http://localhost:17842/v1")).toThrow();
  }
});

test("request extension follows Windows cwd for both Web providers and ignores unrelated providers", () => {
  const handlers = new Map<string, Function>();
  installExtension({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
  const handler = handlers.get("before_provider_request")!;
  const payload = { input: [] };
  for (const provider of ["codex-chatgpt-web", "openai-codex"]) {
    expect(handler({ payload }, { model: { provider }, cwd: "C:\\work\\Việt Nam" }).__omp_cwd).toBe("C:\\work\\Việt Nam");
  }
  expect(handler({ payload }, { model: { provider: "openai" }, cwd: "/tmp" })).toBeUndefined();
  expect(payload).toEqual({ input: [] });
});
