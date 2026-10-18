#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { freemem, totalmem, platform } from "node:os";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { defaultLogDirectory, sanitizeLogRecord } from "../shim/diagnostics";

const maxLogBytes = 2 * 1024 * 1024;
export function readDiagnostics(directory: string, since: number) {
  const records: NonNullable<ReturnType<typeof sanitizeLogRecord>>[] = [];
  let skipped = 0;
  let files = 0;
  let available = true;
  try {
    const names = readdirSync(directory).filter(name => /^shim\.jsonl(?:\.[1-4])?$/.test(name)).sort();
    for (const name of names) {
      try {
        const path = join(directory, name);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > maxLogBytes) { skipped++; continue; }
        files++;
        // Recheck after reading: rotation can happen while collecting.
        const data = readFileSync(path);
        if (data.length > maxLogBytes) { skipped++; continue; }
        for (const line of data.toString("utf8").split("\n")) {
          if (!line) continue;
          try {
            const row = sanitizeLogRecord(JSON.parse(line));
            if (row && Date.parse(row.at) >= since) records.push(row);
            else if (!row) skipped++;
          } catch { skipped++; }
        }
      } catch { skipped++; }
    }
  } catch { available = false; }
  const unique = new Map(records.map(row => [`${row.runId}:${row.seq}:${row.at}`, row]));
  return { records: [...unique.values()].sort((a, b) => a.at.localeCompare(b.at) || Number(a.seq) - Number(b.seq)), files, skipped, available };
}

export function safeHealth(value: unknown, shim = false) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const safe: Record<string, unknown> = {};
  if (row.status === "ok") safe.status = "ok";
  if (typeof row.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(row.version)) safe.version = row.version;
  for (const name of ["pid", "port", "uptime", "active_http_turns", "active_browser_turns"])
    if (typeof row[name] === "number" && Number.isFinite(row[name]) && Number(row[name]) >= 0) safe[name] = row[name];
  if (typeof row.accepting_turns === "boolean") safe.accepting_turns = row.accepting_turns;
  if (shim && row.service === "omp-codex-web-shim") safe.service = row.service;
  const diag = row.diagnostics && typeof row.diagnostics === "object" ? row.diagnostics as Record<string, unknown> : {};
  if (shim) {
    safe.diagnosticsEnabled = diag.enabled === true;
    if (Number.isSafeInteger(diag.failedWrites) && Number(diag.failedWrites) >= 0) safe.failedWrites = diag.failedWrites;
  }
  return safe;
}

async function health(url: string, shim = false) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) return { reachable: true, httpStatus: response.status };
    return { reachable: true, httpStatus: response.status, ...safeHealth(await response.json(), shim) };
  } catch { return { reachable: false }; }
}

export async function collect(options: { directory: string; output: string; hours: number; upstream: string; shimPort: number }) {
  const startedAt = new Date().toISOString();
  const logs = readDiagnostics(options.directory, Date.now() - options.hours * 3600_000);
  const [upstream, shim] = await Promise.all([
    health(new URL("/healthz", options.upstream).href),
    health(`http://127.0.0.1:${options.shimPort}/omp-shim-health`, true),
  ]);
  const bundle = { schema: 1, collectedAt: startedAt, hours: options.hours,
    system: { platform: platform(), bun: Bun.version, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
    upstream, shim, logs };
  // Exclusive creation prevents accidentally overwriting an existing report.
  writeFileSync(options.output, gzipSync(JSON.stringify(bundle)), { flag: "wx", mode: 0o600 });
  chmodSync(options.output, 0o600);
  return { output: options.output, records: logs.records.length, logsAvailable: logs.available };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun bin/collect-diagnostics.ts [--hours 24] [--output report.json.gz] [--log-dir DIRECTORY]");
  } else {
    try {
      const options = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        if (!["--hours", "--output", "--log-dir"].includes(args[i]) || !args[i + 1]) throw new Error("Invalid options; use --help");
        options.set(args[i], args[i + 1]);
      }
      const hours = Number(options.get("--hours") ?? 24);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("--hours must be between 0 and 168");
      const output = resolve(options.get("--output") ?? `omp-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`);
      const result = await collect({ directory: options.get("--log-dir") ?? defaultLogDirectory(), output, hours,
        upstream: process.env.OMP_CODEX_WEB_UPSTREAM || "http://127.0.0.1:17841", shimPort: Number(process.env.OMP_CODEX_WEB_SHIM_PORT || 3007) });
      console.log(`Saved ${result.records} sanitized events: ${result.output}`);
      if (!result.logsAvailable) console.log("No diagnostic log directory was available; health snapshot only.");
    } catch {
      console.error("Diagnostic collection failed; check options, local endpoints and output permissions (--help).");
      process.exitCode = 1;
    }
  }
}
