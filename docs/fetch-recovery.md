# ChatGPT fetch failure recovery (Codex Web 6.1.7)

When ChatGPT accepted a message but failed to create an assistant response,
the bridge eventually reported `chatgpt_submitted_turn_failed`, which prevented
automatic retry. Its submission observer discarded failed conversation
requests without preserving the network failure.

The fetch patch tracks only browser-issued POST requests to
`https://chatgpt.com/backend-api/f/conversation` from the owned main frame.
It reports `chatgpt_fetch_failed` for transport failure and recognizes a new
visible `Failed to fetch` alert for the exact accepted user turn. Background
requests, cancelled requests, stale alerts and ordinary quoted text are ignored.
Error messages expose a network error category without copying arbitrary URLs.

The retry patch recovers inside the same API request, retaining the OMP session
and context. Before a replacement ChatGPT chat starts, it revokes the old tool
capability, checks for a racing tool batch, and waits for physical browser
retirement. It allows two retries with 2-second and 5-second backoff.
Heartbeat events continue during recovery. Exhaustion is reported as a terminal
error so a separate client retry loop cannot multiply the attempts.

Automatic resubmission is excluded when output, a tool batch, active tools or
pending tools exist. Authentication, context-size errors, ambiguous Send,
manual mode, compaction and cancellation are excluded. An upstream error after
tool execution also cannot open a client resend loop. This patch does not repair
an upstream outage or automatically restart a task whose error was already
delivered before installation.

## Apply

Requires Python 3 and the known **6.1.7 linux-x64** bundles. Unknown versions,
platforms, layouts and mismatched file hashes are rejected before writes.
Windows and other releases are not validated by this patch.

Use a writable extracted launcher package, for example a copy of an AppDir.
The runtime path must contain `manifest.json`, `app/cli.js` and
`app/browser-helper.cjs`. Finish active turns and close the launcher first.

```bash
runtime=/path/to/writable/AppDir/resources/runtime
python3 bin/patch-fetch-failure.py "$runtime" --dry-run
python3 bin/patch-fetch-failure.py "$runtime"
python3 bin/patch-fetch-retry.py "$runtime" --dry-run
python3 bin/patch-fetch-retry.py "$runtime"
```

Run both scripts in that order. The retry preview requires the first patch to
have been applied. Scripts update file sizes, SHA-256 hashes and the bundle ID
using the runtime's existing manifest. Backups are saved outside the validated
runtime, under its parent's `codex-web-stability-backups` folder. Reapplying the
scripts to a fully patched bundle makes no changes or new backups.

Start the launcher from the patched package. Editing only the installed
`~/.codex-chatgpt-web/versions` copy is insufficient: the launcher can restore
it from its original packaged runtime on startup. Keep the original package
for rollback. A vendor upgrade requires revalidation; do not force these
replacements into a different release.

## Validation

The regression harnesses execute the actual compiled observer, DOM reader,
assistant wait, cancellation guard, retry handler and retry loop:

```bash
bun tests/verify-fetch-failure.ts "$runtime"
bun tests/verify-fetch-retry.ts "$runtime"
```

They cover 48 detection/cancellation scenarios and 23 recovery scenarios,
including stale alerts, unrelated requests, size rejection, successful SSE,
retry exhaustion, abort during backoff, tool activity and a tool/revocation race.
Installer tests also cover dry-run, manifest integrity, backup placement,
idempotence and rejection of an invalid second bundle before any file changes.
To run those tests against an unmodified vendor runtime without changing it:

```bash
CODEX_WEB_617_RUNTIME=/path/to/original/6.1.7/resources/runtime \
  python3 -m unittest discover -s tests -p test_fetch_installer.py -v
```

The tests copy the two original bundles into a temporary fixture. Without this
environment variable, version and integrity rejection tests still run.

On Linux, an isolated real OMP session ran bash successfully across three
turns, retained the previous marker on continuation and completed a final-build
check. All 6,030 installed manifest records matched. An actual upstream fetch
failure was not forced during this smoke; recovery was validated with
deterministic faults in the compiled handler tests.
