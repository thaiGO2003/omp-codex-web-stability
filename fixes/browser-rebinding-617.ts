import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

type Patches = Record<string, Array<[string, string]>>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function applyRebinding617(runtime: string, patches: Patches, dryRun = false) {
  const root = resolve(runtime), manifestPath = join(root, "manifest.json");
  const originalManifest = readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest.toString("utf8"));
  if (manifest.appVersion !== "6.1.7" || !["win32", "linux"].includes(manifest.platform) || manifest.arch !== "x64") {
    throw Error("Supported runtime: Codex Web 6.1.7 Windows/Linux x64; no files changed");
  }
  const changes: Array<{ path: string; original: Buffer; bytes: Buffer }> = [];
  for (const name of ["cli.js", "browser-helper.cjs"]) {
    const path = join(root, "app", name), original = readFileSync(path);
    const records = manifest.files.filter((r: any) => r.path === `app/${name}`);
    if (records.length !== 1 || records[0].size !== original.length || records[0].sha256 !== sha(original)) {
      throw Error(`${name}: manifest mismatch; no files changed`);
    }
    let text = original.toString("utf8");
    const pairs = patches[name];
    const count = (needle: string) => text.split(needle).length - 1;
    if (!pairs.every(([, replacement]) => count(replacement) === 1)) {
      if (pairs.some(([old, replacement]) => count(old) !== 1 || text.includes(replacement))) {
        throw Error(`${name}: unknown or partially patched rebinding layout; no files changed`);
      }
      for (const [old, replacement] of pairs) text = text.replace(old, replacement);
    }
    // Keep both bundle budgets and their integrity records in one transaction.
    const sends = ["send:20000,", "send:60000,", "send:120000,"].filter(value => count(value));
    if (sends.length !== 1 || count(sends[0]) !== 1) throw Error(`${name}: ambiguous Send budget`);
    text = text.replace(sends[0], "send:120000,");
    const selectors = ["selectorTimeoutMs??5000", "selectorTimeoutMs??30000"].filter(value => count(value));
    if (selectors.length !== 1 || count(selectors[0]) !== 1) throw Error(`${name}: unknown selector budget`);
    text = text.replace(selectors[0], "selectorTimeoutMs??30000");
    new Bun.Transpiler({ loader: "js" }).transformSync(text);
    const bytes = Buffer.from(text, "utf8");
    records[0].size = bytes.length;
    records[0].sha256 = sha(bytes);
    if (!original.equals(bytes)) changes.push({ path, original, bytes });
  }
  if (!changes.length) { console.log("6.1.7 rebinding and Send budgets already installed"); return; }
  const digest = createHash("sha256");
  for (const record of manifest.files) {
    for (const value of [record.path, String(record.size), record.sha256]) digest.update(value + "\0");
  }
  manifest.bundleId = digest.digest("hex");
  if (dryRun) { console.log(`Would patch ${changes.length} 6.1.7 bundles and update manifest`); return; }
  const backup = join(dirname(root), "codex-web-stability-backups", `rebinding-617-${Date.now()}-${process.pid}`);
  mkdirSync(backup, { recursive: true });
  copyFileSync(manifestPath, join(backup, "manifest.json"));
  for (const change of changes) copyFileSync(change.path, join(backup, change.path.endsWith("cli.js") ? "cli.js" : "browser-helper.cjs"));
  try {
    for (const change of changes) writeFileSync(change.path, change.bytes);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (error) {
    const failures: unknown[] = [];
    for (const change of changes) {
      try { if (!readFileSync(change.path).equals(change.original)) writeFileSync(change.path, change.original); }
      catch (restore) { failures.push(restore); }
    }
    try { if (!readFileSync(manifestPath).equals(originalManifest)) writeFileSync(manifestPath, originalManifest); }
    catch (restore) { failures.push(restore); }
    if (failures.length) throw new AggregateError([error, ...failures], `Write and rollback failed; recover from ${backup}`);
    throw error;
  }
  console.log(`Installed 6.1.7 rebinding, Send=120s, selector=30s; backup: ${backup}`);
}
