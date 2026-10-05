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
