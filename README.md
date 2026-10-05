# OMP + Codex Web Stability Fix

A small recovery toolkit for Oh My Pi (OMP) sessions using the ChatGPT Web / Codex Web transport when long sessions become sluggish, freeze on `continue`, or fail with errors such as:

- `chatgpt_submission_ambiguous`
- `context_length_exceeded`
- `OpenAI Codex SSE stream stalled while waiting for the next event`
- ChatGPT Web `Message delivery timed out` followed by stuck retries
- repeated compaction loops
- a soft compaction that makes the context *larger* instead of smaller

The failure that motivated this repo was a soft compaction that expanded a session from about 84K tokens to 172K tokens on a 90K context window. ChatGPT Web UI latency made the symptom worse, but oversized session context was the main cause.

## What this changes

1. Sets OMP automatic compaction preference to:

   ```text
   shake -> handoff
   ```

   This avoids falling through to `soft` compaction for this workflow.

2. Optionally patches known Codex Web browser-helper installs so the ChatGPT capability DOM probe waits up to 30 seconds and the send stage waits up to 120 seconds.

3. Creates timestamped backups before changing browser-helper files.

4. Provides a separate SSE watchdog installer for an existing OMP compatibility
   shim. It interrupts a Web turn after 240 seconds without meaningful response
   progress, before OMP's default 300-second timeout. Heartbeats alone cannot
   keep the turn alive indefinitely. See [Message delivery timeout recovery](docs/message-delivery-timeout.md).

The script is intentionally conservative: unknown helper layouts are reported instead of rewritten.

## Install / apply

```bash
git clone https://github.com/thaiGO2003/omp-codex-web-stability.git
cd omp-codex-web-stability
./bin/apply.sh
```

Preview only:

```bash
./bin/apply.sh --dry-run
```

Check current state:

```bash
./bin/check.sh
```

## Apply the SSE stall recovery patch

For an existing OMP compatibility shim:

```bash
python3 bin/apply-sse-watchdog.py --dry-run
python3 bin/apply-sse-watchdog.py
```

On Windows, the standalone PowerShell installer updates OMP's compaction config
and installs the SSE patch. It uses Bun to read YAML and needs no Python:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-sse-watchdog.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-sse-watchdog.ps1
```

You can download just [apply-sse-watchdog.ps1](bin/apply-sse-watchdog.ps1).
It includes the patch, module and config updater. For a custom installation path, add
`-ShimDirectory "C:\tools\codex-chatgpt-web-omp-shim"`.

To update only OMP config, without requiring an existing shim:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-sse-watchdog.ps1 -ConfigOnly
```

By default it updates `%USERPROFILE%\.omp\agent\config.yml` (or an existing
`config.yaml`), backing up the original before setting
`compaction.methodOrder` to `[shake, handoff]`. Existing model/provider values
are preserved. Add `-OmpConfigPath "C:\path\config.yml"` for a custom config,
`-BunPath "C:\path\bun.exe"` if Bun is outside PATH, or `-SkipOmpConfig` to
install only the shim patch. `PI_CODING_AGENT_DIR` is also respected.

Then restart the shim once active turns have finished. Full requirements and
validation are in [docs/message-delivery-timeout.md](docs/message-delivery-timeout.md).
This handles stalled-turn cleanup; ChatGPT's internal delivery failure remains
outside the patch's scope.

## Connect OMP to Codex Web on Windows

Use **setup-omp-codex-web.ps1** to configure the model roles and provider connection.
This includes the full base shim, so it works without an existing compatible shim.
Requires Bun and an installed, running Codex Web with a signed-in ChatGPT browser.

```powershell
Invoke-WebRequest "https://raw.githubusercontent.com/thaiGO2003/omp-codex-web-stability/main/bin/setup-omp-codex-web.ps1" -OutFile ".\setup-omp-codex-web.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-omp-codex-web.ps1
```

It updates `%USERPROFILE%\.omp\agent\config.yml` and `models.yml`, backing up
changed files. Default, vision, plan, task and web roles use GPT-5.6 Sol Web High;
commit uses Sol Instant Auto. It preserves compaction settings and other roles
and providers. The shim is installed under
`%USERPROFILE%\.local\share\codex-chatgpt-web-omp-shim` and starts in a separate
PowerShell window. Keep that window open, then restart OMP.

The connection is `OMP -> http://127.0.0.1:17842/v1 -> Codex Web :17841`.
Use `-UpstreamUrl "http://127.0.0.1:YOUR_PORT"` if Codex Web uses another port,
`-ShimPort 17843` if the shim port is occupied, or `-AgentDirectory "C:\path\agent"`
for a custom OMP profile. `PI_CODING_AGENT_DIR` is respected.
`-DryRun` previews changes and `-NoStart` installs without opening the shim window.

To also set the judge role to your running 9router instance, add
`-JudgeBaseUrl "http://127.0.0.1:YOUR_ROUTER_PORT"`. Existing router authentication
is retained; a new router provider uses `NINE_ROUTER_API_KEY` from your environment.
Otherwise the judge role is left as configured.

The installer checks whether the Codex Web API lists Sol. A reachable model API
does not verify a complete browser turn. Runtime tests cover fresh installation,
request forwarding, backups and rollback using PowerShell 7 on Linux; native
Windows and a signed-in Windows ChatGPT session have not been tested here.

## Recover an already bloated OMP session

If the current session is already over its context window, changing future compaction settings cannot shrink the bad summary that is already in history.

1. Keep the session alive in `tmux` if possible.
2. In OMP run `/rewind` (alias of `/branch`).
3. Rewind to the user turn immediately before the bad soft-compaction.
4. Continue with a small prompt such as `continue`.
5. OMP should auto-shake first and then use handoff if more context must be reclaimed.

A healthy recovery should reduce the context gauge substantially and stop fresh `context_length_exceeded` / `chatgpt_submission_ambiguous` failures.

See [docs/recovery.md](docs/recovery.md) for a diagnostic checklist.

## Safety

- No credentials, cookies, session files, or browser profiles are copied into this repo.
- The helper patch is version-sensitive and uses exact guarded replacements.
- Each changed helper file gets a `.pre-stability-fix-<timestamp>.bak` backup.
- The Linux script changes OMP configuration through its CLI. PowerShell parses
  the YAML config with Bun and backs it up before writing. Changed YAML may be
  reformatted and comments removed; session history is not edited.

## License

MIT
