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
submitted task is unchanged. Long tasks add another layout: ChatGPT may retain
the complete submission while rendering only a long prefix in the saved user
bubble. The shim also used to refuse silent replacement on every runtime except
6.1.7.

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
records together. It preserves complete-payload and selected-connector checks.
For payloads of at least 65,536 characters, it also accepts a saved UI prefix
only after at least 8,192 characters match and the app/turn structure matches;
short, changed, foreign-app and competing turns are rejected. Windows browser
bundles are not covered by this new patch. The regenerated PowerShell shim
installers include the 6.1.9 lifecycle guard and cancellation acknowledgement
validation.

See [the 6.1.9 investigation and limits](docs/recovery-619.md). A submitted-turn
failure does not by itself prove that tools never ran; the shim does not blindly
replay that terminal error.

For a silent stall followed by `Silent recovery upstream HTTP 499` or later
`McpServerError: Session terminated`, upgrade the existing idle shim with
`python3 bin/apply-recovery-identity.py`, then restart only the shim service.
Recovery must use fresh native ownership because 6.1.9 remembers cancelled
thread/turn identities. See the October 17 section of the investigation for
validation and limits. The generated full Windows Web setup includes this fix.

## Composer errors and repeated overload retries

If OMP retries `ChatGPT composer is unavailable` ten times, first verify that
ChatGPT is signed in in the Codex Web GPT browser. A known case reached the
logged-out homepage with a `mobile-composer-prompt` textarea, while the helper
expected the authenticated composer. Retrying did not restore authentication.
Run `python3 bin/apply-composer-check.py` on a known existing shim, then restart
only the idle shim. Full Windows setups include the fix. The exact UI error
becomes `chatgpt_composer_check_required`, which stops OMP's misleading outer
overload retry loop; genuine provider overload errors retain their behavior.
After fixing the browser session, continue the existing OMP conversation.

## Bounded diagnostic logs

The full shim now records request/queue timing, upstream HTTP status, semantic
progress, terminal error codes, scoped interruption and recovery ownership in
structured JSONL. Conversation content, tool arguments/results, file contents,
paths and authentication headers are excluded. Thread/turn/response identifiers
are hashed for correlation. Retention is **five files of up to 2 MiB each**.

Upgrade an existing shim (does not restart it):

```bash
python3 bin/apply-diagnostics.py --dry-run
python3 bin/apply-diagnostics.py
# Only after its requests finish:
systemctl --user restart codex-chatgpt-web-omp-shim.service
```

New Windows full installs include the logger automatically. The default log
directory on both platforms is `~/.codex-chatgpt-web/diagnostics/omp-shim/`;
`CODEX_CHATGPT_WEB_HOME` or `OMP_CODEX_WEB_LOG_DIR` can change it.

When an interruption occurs, export recent sanitized events and local health
snapshots from the repository directory:

```bash
bun bin/collect-diagnostics.ts --hours 24
```

This creates a local `omp-diagnostics-*.json.gz` report without uploading it.
The same command works in PowerShell. See [diagnostic logging](docs/diagnostics.md)
for custom ports, event interpretation, retention and activation checks.

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

## BrowserPanel missing from the direct tool inventory

OMP can expose only a small set of direct tools while mounting MCP tools under
`xd://`. No `onedevtool/browser_list_tabs` match in `codex_tool_inventory` is
therefore insufficient evidence that the BrowserPanel connection is missing.

The shim's routing guidance now requires reading the live `xd://` catalog,
reading the returned device path for its schema, then sending JSON arguments
through OMP's advertised `write` tool. This invokes the original MCP tool with
its existing approval policy. For BrowserPanel, start with the discovered
`browser_list_tabs` device and retain its returned project/tab IDs.

If the live catalog also lacks the devices (for example it lists only
`ast_edit`, `debug`, and `lsp`), run `/mcp reload` in that OMP terminal. This
rediscovers configured servers and refreshes the session's registered tools.
Then read `xd://` again and invoke the discovered `browser_list_tabs` device
before clearing the blocker. A successful call from a different Codex session
does not verify the affected OMP session. On the investigated host, a reload
restored 38 onedevtool devices, including 16 browser tools; the exact reason
the earlier session registration disappeared has not been established.

Existing sessions receive the updated guidance on their next request after
the shim reloads. Old routing messages are replaced without deleting tool
results or other conversation instructions. A current catalog error or MCP
failure still needs to be reported; this change does not replay rejected tools
or mark browser acceptance complete. The standalone Windows installers contain
the same routing update.

For AionUI `Incoming transport closed` / `UNKNOWN_UPSTREAM_ERROR`, first check
whether the OMP ACP process exited. See the [earlyoom interruption diagnosis](docs/acp-memory-interruption.md)
for a confirmed Linux memory termination incident and the host configuration
changes used to prevent repeated replacement-agent termination.

## Install / apply

### Windows: double-click installer

1. Install OMP, then open Codex Web and sign in to ChatGPT. Bun is installed automatically if it is missing.
2. Download the [repository ZIP](https://github.com/thaiGO2003/omp-codex-web-stability/archive/refs/heads/main.zip) and **extract it**.
3. Double-click **[install-and-run.bat](install-and-run.bat)** in the extracted folder. Python is not required. The window stays open so you can read the result.
4. Accept the Windows administrator (UAC) prompt. Codex Web lives under `C:\Program Files\Codex Web GPT`, so the browser-helper fix and the logon task need elevation; `install-and-run.bat` re-launches itself elevated automatically. If you decline, nothing is installed.

`install-and-run.bat` installs the shim and browser fixes **and** starts the
[Codex Web watchdog](#keep-codex-web-running-auto-update--watchdog) that keeps
17841 alive. It also registers the watchdog as a logon scheduled task so it
survives reboots.

Helper paths that cannot be written (for example a Codex Web installed elsewhere
without elevation) are skipped with a `needs Administrator` warning instead of
aborting the whole installation.

You can also download `install-and-run.bat` alone. When `install.ps1` is missing
or has an older bundle revision, BAT downloads the matching installer from this
repository, checks its revision and PowerShell syntax, then saves a backup before
replacing the old file. A failed download leaves the old file intact and stops
installation. It prefers PowerShell 7 and falls back to Windows PowerShell.
If Bun is missing, the installer downloads the official Bun PowerShell installer
over HTTPS, runs it, checks `bun.exe`, then resumes setup automatically. An
explicit `-BunPath` is always honored; a missing explicit path reports an error.
The installer also exposes the new Bun directory to its PowerShell child steps
immediately, without requiring a new terminal or Windows sign-in.

The bundled **[install.ps1](install.ps1)** also works when downloaded alone. It
installs the full compatibility shim with the SSE watchdog, configures OMP model
roles and providers, sets compaction to `shake -> handoff`, and restores the
120-second Send budget plus the 30-second selector probe where supported.
The saved-turn rebinding fix also supports verified 6.1.7 Windows x64 bundles,
updating both CLI/helper and their integrity manifest together with the Send
budgets. The older approval-card and model-picker patch remains specific to
6.1.4. Unknown layouts are reported; mismatched 6.1.7 manifests stop installation.
Changed files get timestamped backups. Other model roles and provider credentials
are preserved; the default connection uses local ports 3007 -> 17841.

From PowerShell, preview or customize the installation:

```powershell
.\install-and-run.bat -DryRun
.\install-and-run.bat -JudgeBaseUrl "http://127.0.0.1:20218"
.\install-and-run.bat -UpstreamUrl "http://127.0.0.1:17841" -ShimPort 17843 -NoStart
```

`-BunPath`, `-AgentDirectory`, `-ShimDirectory`, `-HelperPath`, `-SkipBrowserFixes`
and `-NoWatchdog` are also supported. A custom helper path receives the guarded
timeout fix; 6.1.4 rebinding requires a `6.1.4-*/app/browser-helper.cjs`
installation path, while 6.1.7 requires the runtime's `manifest.json` and both
bundles. `-DryRun` leaves installation files unchanged and starts no
shim. Existing shim processes are not interrupted; restart their window after
active turns finish. Close/reopen Codex Web while idle and restart OMP to load
the changes. `-DryRun` requires Bun to be available already and never downloads
it. A signed-in, running Codex Web is still required; this bundle installs the
bridge and fixes rather than Codex Web or OMP.

The bundle does not configure a Windows memory guard. Running out of RAM can
still interrupt a browser turn. PowerShell 7 integration tests run on Linux;
Windows PowerShell 5.1 and double-click execution need native Windows validation.

## Keep Codex Web running (auto-update + watchdog)

The watchdog lives at
`%USERPROFILE%\.local\share\codex-chatgpt-web-omp-shim\watch-codex-web.ps1`
(installed by `install-and-run.bat`). It polls the local Codex Web origin and:

1. **Auto-updates** Codex Web from its GitHub releases (`miuuyy/codex-chatgpt-web`,
   `releases/latest`) when a newer version exists. It downloads the
   `codex-web-gpt-<version>-win-x64.exe` asset, verifies it against the release's
   `checksums.txt` (SHA-256), then runs it silently (`/S`). Updates are only
   attempted while Codex Web is idle (no active HTTP/browser turns).
2. **Relaunches when down** so OMP never hits
   `Unable to connect ... ConnectionRefused` at `http://127.0.0.1:17841/v1`.
3. **Restarts a stuck daemon**: if `/healthz` stops responding or stops
   accepting turns for `-StuckSeconds`, it closes the launcher/daemon and
   starts a fresh one.

Run it directly, register it at logon, or remove the task:

```powershell
# Run in the foreground (one polling loop)
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1

# Register (and immediately start) the logon scheduled task
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1 -InstallTask

# Remove the scheduled task
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1 -UninstallTask

# One-shot checks
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1 -Once -DryRun
```

Useful switches: `-UpstreamUrl`, `-LauncherPath`, `-IntervalSeconds` (default 15),
`-StuckSeconds` (default 90), `-NoAutoUpdate`, `-Once`, `-DryRun`, `-Quiet`. Logs
are written to `%USERPROFILE%\.codex-chatgpt-web\diagnostics\omp-watchdog\watchdog.log`
(2 MiB, one rotated archive). This installs no third-party dependencies beyond
Windows PowerShell.

Auto-update runs the upstream installer, which needs to write under
`C:\Program Files` and therefore may show a Windows UAC prompt. If the watchdog
runs hidden under the scheduled task, a silent update that needs elevation can
fail; run the command above once interactively to apply it. After an update the
newest runtime under `~\.codex-chatgpt-web\versions` is re-patched with the Send
budget only when it has no integrity manifest entry for `browser-helper.cjs`;
otherwise rerun `install-and-run.bat` (or `apply-send-timeout.ps1`) to re-apply
the browser fixes to the new version.

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
changed files. Default, vision, plan, task and web roles use GPT-6 Sol Web High;
advisor uses GPT-6 Sol Web XHigh for careful reviews, while commit and judge use GPT-6 Sol Instant Auto. It preserves compaction settings and other roles
and providers. The shim is installed under
`%USERPROFILE%\.local\share\codex-chatgpt-web-omp-shim` and starts in a separate
PowerShell window. Keep that window open, then restart OMP.

The connection is `OMP -> http://127.0.0.1:3007/v1 -> Codex Web :17841`.
Running `start-shim.ps1` again while a compatible shim is already listening on
the same port now reuses it and exits successfully. Concurrent launcher attempts
are serialized with a Windows mutex. If another process owns that port, setup
fails before writing configuration and reports the conflicting port. Existing
OMP sessions and the running shim are never killed to solve this collision.
Windows validation: `powershell -NoProfile -File .\tests\test_shim_single_instance.ps1`.
Use `-UpstreamUrl "http://127.0.0.1:YOUR_PORT"` if Codex Web uses another port,
`-ShimPort 17843` if the shim port is occupied, or `-AgentDirectory "C:\path\agent"`
for a custom OMP profile. `PI_CODING_AGENT_DIR` is respected.
`-DryRun` previews changes and `-NoStart` installs without opening the shim window.

The judge role now always uses GPT-6 Sol Instant. The legacy option
`-JudgeBaseUrl "http://127.0.0.1:YOUR_ROUTER_PORT"` still configures the 9router
provider without assigning it as judge. Existing router authentication is retained;
a new router provider uses `NINE_ROUTER_API_KEY` from your environment.

The installer checks whether the Codex Web API lists GPT-6 Sol and Instant (requires
Codex Web GPT 6.1.6 or newer). A reachable model API
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
