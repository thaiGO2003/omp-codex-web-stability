import { expect, test } from "bun:test";
import { updateOmpConfig } from "./omp-config";

test("replaces method order while preserving models, providers and other compaction settings", () => {
  const config = {
    modelRoles: { default: "codex-chatgpt-web/chatgpt-web/gpt-5.6-sol", judge: "9router/oc/jev-1.13-free" },
    providers: { custom: { baseUrl: "http://localhost:20218" } },
    compaction: { methodOrder: ["remote", "soft"], autoContinue: true, keepRecentTokens: 20000 },
    theme: { dark: "example" },
  };
  const result = Bun.YAML.parse(updateOmpConfig(Bun.YAML.stringify(config)));
  expect(result).toEqual({ ...config, compaction: { ...config.compaction, methodOrder: ["shake", "handoff"] } });
});

test("creates minimal config from empty input and accepts flow mappings and CRLF", () => {
  expect(Bun.YAML.parse(updateOmpConfig(""))).toEqual({ compaction: { methodOrder: ["shake", "handoff"] } });
  const updated = updateOmpConfig('compaction: {methodOrder: [soft], autoContinue: true}\r\n');
  expect(Bun.YAML.parse(updated)).toEqual({ compaction: { methodOrder: ["shake", "handoff"], autoContinue: true } });
  expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
});

test("already healthy config is byte-for-byte unchanged including comments", () => {
  const text = '# user comment\r\ncompaction:\r\n  methodOrder: [shake, handoff]\r\n';
  expect(updateOmpConfig(text)).toBe(text);
});

test("invalid YAML and unexpected scalar or list mappings are refused", () => {
  for (const text of ['broken: [', 'false', '- example', 'compaction: false', 'compaction: [soft]']) {
    expect(() => updateOmpConfig(text)).toThrow();
  }
});
