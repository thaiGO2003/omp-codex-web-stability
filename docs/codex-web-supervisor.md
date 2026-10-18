# Codex Web watchdog

`bin/watch-codex-web.ps1` keeps the local Codex Web (ChatGPT Web bridge) reachable
for OMP. It exists because a stopped, hung or half-updated Codex Web surfaces in
OMP as:

```
Unable to connect. Is the computer able to access the url?
  path: "http://127.0.0.1:17841/v1/responses",
  errno: 0, code: "ConnectionRefused"
    at async fetch (…\codex-chatgpt-web-omp-shim\server.ts:208:24)
POST - http://127.0.0.1:3007/v1/codex/responses failed
```

The shim listens on 3007 and forwards to Codex Web on 17841. When 17841 is not
serving, every OMP turn fails at the shim's upstream `fetch`. The watchdog keeps
17841 serving.

## What it does on every poll

The watchdog reads `GET {UpstreamUrl}/healthz` and branch on the result:

| Observation | Action |
| --- | --- |
| `status: ok` **and** `accepting_turns: true` | healthy; reset stall timers; run a due update check when idle |
| reachable, but not accepting turns / not `ok` | record a degraded timestamp; after `-StuckSeconds` close Codex Web and relaunch |
| unreachable | record a down timestamp; if the launcher is not running, start it now; after `-StuckSeconds` close and relaunch |

`-StuckSeconds` (default 90) is the sustained failure window before a restart, so
a normal launcher startup or a brief upgrade window does not trigger a kill.

Closing a stuck instance stops the `Codex Web GPT` launcher processes and the
`bun.exe` daemon running `cli.js` for this home; the OMP shim (`server.ts`) is
never touched. Relaunch starts the launcher executable, which restarts the
browser host and the daemon.

## Auto-update

When enabled (default; disable with `-NoAutoUpdate`), the watchdog queries
`https://api.github.com/repos/miuuyy/codex-chatgpt-web/releases/latest` on the
`-UpdateCheckSeconds` cadence (default 900) and only while Codex Web is idle:

1. Compare the release tag to the installed version
   (`…\Codex Web GPT\resources\runtime\manifest.json` `appVersion`, falling back
   to `~\.codex-chatgpt-web\config.json` `releaseVersion`).
2. If newer, download `codex-web-gpt-<version>-win-x64.exe` and the release's
   `checksums.txt`; require a matching SHA-256 entry before running anything.
3. Run the installer silently (`/S`) and wait for it to finish.

This mirrors the launcher's own updater (`RELEASE_API_URL`, asset naming and
`checksums.txt` verification were read from the installed `app.asar`). Notes and
limits:

- The upstream installer writes under `C:\Program Files`, so it may raise a UAC
  prompt. From a hidden scheduled task, an update that needs elevation can fail;
  run `watch-codex-web.ps1` once interactively to apply it.
- Only a newer, valid release is installed; download, checksum or installer
  failures are logged and the current version keeps running.
- After a successful update the watchdog re-applies the 120-second Send budget to
  the newest `~\.codex-chatgpt-web\versions\<version>` runtime **only** when its
  manifest has no integrity entry for `app/browser-helper.cjs` (patching a
  manifest-guarded bundle would break the runtime's integrity check). Otherwise
  it logs a reminder to rerun `install-and-run.bat` / `apply-send-timeout.ps1` for
  the new version.

## Scheduling

- `-InstallTask` registers the `OMP Codex Web Watchdog` scheduled task to run at
  logon (hidden, unlimited runtime, restart on failure) and starts it immediately.
- `-UninstallTask` removes it.
- `install-and-run.bat` / `install.ps1` install the watchdog and register the task
  automatically on Windows (`-NoWatchdog` skips both; `-NoStart` skips the task).

## Logs and state

`~\.codex-chatgpt-web\diagnostics\omp-watchdog\watchdog.log` records each health
transition, launch, restart, update attempt and failure. It is capped at 2 MiB
with one rotated archive (`.1`). Console output is suppressed with `-Quiet`.

## Options

| Switch | Default | Meaning |
| --- | --- | --- |
| `-UpstreamUrl` | `http://127.0.0.1:17841` | Codex Web origin to supervise |
| `-HomeDirectory` | `%CODEX_CHATGPT_WEB_HOME%` / `~\.codex-chatgpt-web` | Codex Web home |
| `-LauncherPath` | auto-detected | `Codex Web GPT.exe` |
| `-IntervalSeconds` | 15 | poll interval |
| `-StartTimeoutSeconds` | 120 | wait for `/healthz` after launching |
| `-StuckSeconds` | 90 | sustained failure before restart |
| `-UpdateCheckSeconds` | 900 | auto-update check cadence |
| `-NoAutoUpdate` | off | disable the GitHub update check |
| `-InstallTask` / `-UninstallTask` | off | manage the logon task |
| `-Once` | off | run one poll and exit |
| `-DryRun` | off | report actions without launching, closing or updating |
| `-Quiet` | off | no console output |

## Verification

`bin/watch-codex-web.ps1 -Once -DryRun` against a live Codex Web prints
`Codex Web is healthy (v…)`; against a closed port it prints
`Codex Web is not reachable`. `tests/test_codex_web_watchdog.py` covers the
healthy, unreachable, degraded and task-registration paths with a local
`/healthz` fixture.
