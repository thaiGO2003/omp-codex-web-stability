# Send timeout after upgrading to Codex Web 6.1.6

On 2026-10-08 at 23:48 and 23:49 (Asia/Ho_Chi_Minh), the helper attached
175,849 and 183,939 characters including the connector prefix, activated Send,
and failed without conclusive submission evidence. The launcher logged
`ChatGPT browser stage timed out: send`; the bridge classified the submission as
`chatgpt_submission_ambiguous`. A further turn at 23:53:55 logged precisely
20,001 milliseconds in the Send stage before the same timeout.

The active daemon had upgraded to 6.1.6. Its installed helper contained
`send:20000`, replacing the previous locally patched `send:120000`. Model and
connector selection had completed successfully in the affected turns.

The patch restores a bounded 120-second ordinary Send budget. It does not repeat
Send or assume that an unacknowledged submission failed to reach ChatGPT. Existing
acceptance evidence, cancellation, DOM recovery and the separate 180-second
multipart budget remain in charge of their original decisions. If the browser
never confirms acceptance, the bridge still reports an ambiguous submission.

This is a correction to the premature deadline, not proof that prompt length
alone causes the UI delay. A separate large-prompt OMP check (195,089 characters
in the composer) completed successfully with the original 20-second budget.
The observed delay is intermittent.

Apply after an update, while Codex Web is idle:

```bash
python3 bin/apply-send-timeout.py --dry-run
python3 bin/apply-send-timeout.py
```

Windows, without Python:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-send-timeout.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-send-timeout.ps1
```

Reload Codex Web while idle. Both installers validate all targets before writing,
back up changed helpers, preserve other patches, accept the known 20/60/120-second
layouts and reject unknown or duplicate markers. The Linux installer skips
read-only mounted AppImage resources and patches the writable installed runtime
helper used by the daemon. `bin/apply.sh` and `bin/check.sh` also recognize the
20-second layout. The separate rebinding installer remains specific to 6.1.4.

Validation: the 6.1.6 submission/send/recovery contract checks passed 17 tests
with 89 assertions. Installer checks passed for Python and PowerShell 7, covering
prevalidation, dry runs, backups, idempotence and preservation of multipart timing.
The patched native helper parsed successfully. After reloading only the idle helper
child, a real OMP `--continue` completed normally. Another continuation explicitly
reattached the large context: its composer contained 195,385 characters, and it
received `SENDCHECKOK` with a normal stop and empty stderr. Both the old-budget
and patched large-prompt checks were separate transport tests; the user's project
was not resumed or automatically resent by this investigation.
