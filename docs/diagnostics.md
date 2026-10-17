# OMP shim diagnostics

## Activate and verify

`python3 bin/apply-diagnostics.py` upgrades known shims with fresh native
ownership support. It preserves local port/upstream/cwd customizations, backs
up changed files and rolls back if writing fails. Unknown or partially patched
layouts are refused before writing. It never restarts processes.

Restart the shim **after its active requests finish**. Restarting an active
shim disconnects OMP; neither the native daemon nor OMP needs restarting to
enable these logs. On Linux:

```bash
systemctl --user restart codex-chatgpt-web-omp-shim.service
curl -fsS http://127.0.0.1:17842/omp-shim-health
```

The health response must contain `diagnostics.enabled: true` and
`diagnostics.failedWrites: 0`. On Windows, stop the idle shim window and rerun
its `start-shim.ps1`. New full Windows setup payloads include `diagnostics.ts`.

## Files and retention

Default: `~/.codex-chatgpt-web/diagnostics/omp-shim/shim.jsonl`. The logger uses
`CODEX_CHATGPT_WEB_HOME` instead of `~/.codex-chatgpt-web` if set. Set
`OMP_CODEX_WEB_LOG_DIR` to override the complete log directory; supply the same
directory to the collector using `--log-dir` or the environment variable.

The active file and `.1` through `.4` retain approximately the newest **10 MiB**.
Rotation occurs before a write would exceed 2 MiB. This bounds these new shim
logs only; it does not remove existing OMP sessions or native browser diagnostics.
Unix directories/files use modes `0700`/`0600`; Windows permissions follow the
user profile's ACLs. Use a separate directory per shim instance.

Logging is local and synchronous at lifecycle milestones, the first response,
the first output and at most every 30 seconds of subsequent progress. It never
logs every token. If writing fails, the request continues and health exposes a
failure counter; the journal receives one fixed warning without error details.

## Export

From this repository, on Linux or PowerShell with Bun:

```bash
bun bin/collect-diagnostics.ts --hours 24
```

The command creates `omp-diagnostics-<UTC timestamp>.json.gz` in the current
directory. It refuses to overwrite an existing report. It includes sanitized
events plus two bounded, read-only health requests and memory/platform metadata.
It does not send prompts, interrupt turns or upload anything. To select a time
window (maximum 168 hours), directory or report path:

```bash
bun bin/collect-diagnostics.ts --hours 2 --log-dir /path/to/logs --output incident.json.gz
```

With custom ports, set `OMP_CODEX_WEB_SHIM_PORT` and `OMP_CODEX_WEB_UPSTREAM` to
the same values used by the shim. Defaults are 17842 and `http://127.0.0.1:17841`.
Collection still produces available logs when an endpoint is down; unavailable
logs produce a health-only report. Rotation may discard older events even when
they fall inside the requested time window. Collect soon after an incident.

The exporter revalidates every record against a positive schema. It excludes
raw journals, browser DOM snapshots, OMP conversation JSONL, configuration files,
error messages and stack traces. Unknown error codes become `unknown`.

## Reading an incident

Each record has a UTC timestamp, process/run ID, sequence and event. Request
events also share a random `requestId`. Thread, turn and response IDs are
SHA-256 prefixes (16 hex characters), allowing correlation without saving their
original values. `logicalThreadId` stays stable while `nativeThreadId` changes
when silent recovery replaces ownership. To compare an original ID from a
separately inspected native diagnostic, hash it with SHA-256 and take its first
16 hexadecimal characters.

| Event | Meaning |
| --- | --- |
| `request_received`, `queue_wait`, `queue_acquired` | Request entry and queue duration; a waiting request has not yet reached upstream. |
| `upstream_headers` | Upstream HTTP status and SSE flag; `phase: health` marks the recovery lifecycle probe. |
| `stream_progress` | First semantic event, first output or subsequent progress summary; includes event/byte counters. |
| `stream_terminal` | Completion, failure or incomplete event and a recognized provider error code, if present. |
| `semantic_timeout` | Semantic silence duration, last event type, whether output was sent and replay eligibility. |
| `cleanup_completed`, `cleanup_failed` | Scoped interruption acknowledgement or failure; includes cancellation counts when available. |
| `recovery_lifecycle`, `recovery_connecting`, `recovery_connected` | Verified lifecycle result, new owner and replacement stream connection. |
| `recovery_failed`, `recovery_stopped` | Replacement failed or bounded recovery stopped; it does not replay partially emitted output. |
| `stream_eof`, `stream_error`, `stream_cancelled` | Upstream close, read error or downstream cancellation. EOF with `terminal: false` is a premature close. |
| `request_finished` | Transport exit; `outcome: eof` alone does not prove provider success—check `stream_terminal`. |

These events show what the local shim observed. They do not independently prove
why ChatGPT's remote service stopped responding. Requests that failed before
reaching the shim require OMP/native diagnostics as additional evidence.
