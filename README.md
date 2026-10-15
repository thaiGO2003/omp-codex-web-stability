# OMP + Codex Web Stability Fix

A small recovery toolkit for Oh My Pi (OMP) sessions using the ChatGPT Web / Codex Web transport when long sessions become sluggish, freeze on `continue`, or fail with errors such as:

- `chatgpt_submission_ambiguous`
- `context_length_exceeded`
- `OpenAI Codex SSE stream stalled while waiting for the next event`
- ChatGPT Web `Message delivery timed out` followed by stuck retries
- ChatGPT Web `Failed to fetch` with no automatic recovery
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
   keep the turn alive indefinitely. On the verified 6.1.7 lifecycle, a silent
   round with complete context can recover automatically once; current-round
   output prevents replay. See [Message delivery timeout recovery](docs/message-delivery-timeout.md).

5. Provides browser turn rebinding fixes for Codex Web 6.1.4 and 6.1.7 Windows/Linux x64
   when ChatGPT saves
   an Activity response and the helper reports `another user turn while the bound
   assistant response was detached`. It preserves ownership across the selected
   connector's rendered prefix, layout newline and delayed hydration. See
   [Browser turn rebinding](docs/browser-turn-rebinding.md).

The script is intentionally conservative: unknown helper layouts are reported instead of rewritten.

## Codex Web 6.1.9: stops after accepted or saved turns

The 6.1.9 update replaces the previously patched browser bundles. Its saved-turn
ownership comparison can reject a rendered connector mention even when the
entire submitted task is unchanged. The shim also used to refuse silent
replacement on every runtime except 6.1.7.

For the verified **6.1.9 Linux x64** runtime:

```bash
python3 bin/patch-browser-rebinding-619.py ~/.codex-chatgpt-web/versions/6.1.9-linux-x64 --dry-run
python3 bin/patch-browser-rebinding-619.py ~/.codex-chatgpt-web/versions/6.1.9-linux-x64
python3 bin/apply-sse-watchdog.py
python3 bin/reload-runtime-619.py
systemctl --user restart codex-chatgpt-web-omp-shim.service
```

Apply while idle. Reload the daemon with the command above rather than reopening
the launcher: a full launcher restart restores its packaged runtime and removes
local browser patches. Reapply after a launcher restart or update.
The browser patch checks
both bundle hashes, backs up both bundles and the manifest, and updates integrity
records together. It preserves complete-payload and selected-connector checks;
it does not accept arbitrary replacement user turns. Windows browser bundles are
not covered by this new patch. The regenerated PowerShell shim installers include
the 6.1.9 lifecycle guard and cancellation acknowledgement validation.

See [the 6.1.9 investigation and limits](docs/recovery-619.md). A submitted-turn
failure does not by itself prove that tools never ran; the shim does not blindly
replay that terminal error.

## Fix Failed to fetch without losing the OMP session

The new [6.1.7 fetch recovery patch](docs/fetch-recovery.md) recognizes failed
ChatGPT conversation requests and retries eligible turns inside the same OMP
request. It revokes the old tool capability, retires the old browser execution,
then opens a replacement ChatGPT chat with the existing context. It makes at
most two retries, waiting 2 seconds and then 5 seconds.

Recovery requires no output or new tool calls in the current native HTTP round.
After a completed tool batch, it can restore a broken browser execution only
when the request includes every known tool result; it preserves those results
instead of replaying the tools. Missing results, races, authentication errors,
oversized context, ambiguous Send and user cancellation prevent recovery.
Terminal recovery errors stop OMP's generic network retry loop. These scripts support the known
**Codex Web 6.1.7 linux-x64** bundles; the existing Windows installer does not
include this new patch. Follow the linked instructions to patch a writable
packaged runtime and preserve its integrity manifest.

For reported platform tool blocks, see [tool outcome evidence](docs/tool-outcome-evidence.md).
The shim distinguishes tool results from assistant claims in its guidance;
explicit platform rejections are terminal and excluded from network recovery.

For AionUI `Incoming transport closed` / `UNKNOWN_UPSTREAM_ERROR`, first check
whether the OMP ACP process exited. See the [earlyoom interruption diagnosis](docs/acp-memory-interruption.md)
for a confirmed Linux memory termination incident and the host configuration
changes used to prevent repeated replacement-agent termination.

## Install / apply

### Windows: double-click installer

1. Install OMP and Bun, then open Codex Web and sign in to ChatGPT.
2. Download the [repository ZIP](https://github.com/thaiGO2003/omp-codex-web-stability/archive/refs/heads/main.zip) and **extract it**.
3. Double-click **[install.bat](install.bat)** in the extracted folder. Administrator access and Python are not required. The window stays open so you can read the result.

You can also download `install.bat` alone. When `install.ps1` is missing or has an
older bundle revision, BAT downloads the matching installer from this repository,
checks its revision and PowerShell syntax, then saves a backup before replacing
the old file. A failed download leaves the old file intact and stops installation.
It prefers PowerShell 7 and falls back to Windows PowerShell.

The bundled **[install.ps1](install.ps1)** also works when downloaded alone. It
installs the full compatibility shim with the SSE watchdog, configures OMP model
roles and providers, sets compaction to `shake -> handoff`, and restores the
120-second Send budget plus the 30-second selector probe where supported.
The saved-turn rebinding fix also supports verified 6.1.7 Windows x64 bundles,
updating both CLI/helper and their integrity manifest together with the Send
budgets. The older approval-card and model-picker patch remains specific to
6.1.4. Unknown layouts are reported; mismatched 6.1.7 manifests stop installation.
Changed files get timestamped backups. Other model roles and provider credentials
are preserved; the default connection uses local ports 17842 -> 17841.

From PowerShell, preview or customize the installation:

```powershell
.\install.bat -DryRun
.\install.bat -JudgeBaseUrl "http://127.0.0.1:20218"
.\install.bat -UpstreamUrl "http://127.0.0.1:17841" -ShimPort 17843 -NoStart
```

`-BunPath`, `-AgentDirectory`, `-ShimDirectory`, `-HelperPath` and
`-SkipBrowserFixes` are also supported. A custom helper path receives the guarded
timeout fix; 6.1.4 rebinding requires a `6.1.4-*/app/browser-helper.cjs`
installation path, while 6.1.7 requires the runtime's `manifest.json` and both
bundles. `-DryRun` leaves installation files unchanged and starts no
shim. Existing shim processes are not interrupted; restart their window after
active turns finish. Close/reopen Codex Web while idle and restart OMP to load
the changes. Bun and a signed-in, running Codex Web are prerequisites; this
bundle installs the bridge and fixes rather than those applications.

The bundle does not configure a Windows memory guard. Running out of RAM can
still interrupt a browser turn. PowerShell 7 integration tests run on Linux;
Windows PowerShell 5.1 and double-click execution need native Windows validation.

### Linux

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

## Fix Send timeout after a Codex Web update

An update can replace the locally patched helper and restore the shorter Send
budget. To restore 120 seconds in known helper layouts:

```bash
python3 bin/apply-send-timeout.py
```

Windows (standalone, no Python):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-send-timeout.ps1
```

Reload Codex Web while idle. See [the 6.1.6 logs and limits of this fix](docs/send-budget-upgrade.md).

## Fix saved-turn / connector interruption

```bash
python3 bin/apply-browser-rebinding.py
```

Windows (standalone file; no Python required):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-browser-rebinding.ps1
```

Download [apply-browser-rebinding.ps1](bin/apply-browser-rebinding.ps1), then close
and reopen Codex Web while idle. This patches the browser helper; your OMP model
roles continue to use the existing shim.

The installer also fixes `model_version_unavailable` when the current picker places visibility on the parent view instead of its model-list toggle. It still verifies the requested model and effort before Send.

The saved-turn patch also handles Markdown escape backslashes added by ChatGPT's rich-text renderer; it still verifies the complete payload and selected app. It also handles nested link targets and the current tool-approval card. Safety warnings remain human decisions and are reported explicitly. See [the investigation and regression evidence](docs/browser-turn-rebinding.md).

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

To refresh the standalone Windows bundle after editing the source scripts:

```bash
python3 bin/build-powershell.py
```

## License

MIT
