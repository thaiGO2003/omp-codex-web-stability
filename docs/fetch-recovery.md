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

Recovery is excluded when the current native HTTP round has emitted text,
thinking or any native tool-call event (`tool_call_start/delta/end` included).
At a completed tool boundary, historical commentary and tool activity from
earlier rounds no longer prevent recovery: the new request must contain exactly
one result for every known delivered or outstanding tool ID. Successful and
errored tool results are both preserved. Missing, duplicate or unrelated results
cannot authorize a replacement. Other active calls and batch revisions that
change during capability revocation or physical retirement also prevent replay.

Authentication, context-size errors, ambiguous Send, manual mode, compaction
and cancellation are excluded. An upstream error with unaccounted tool activity
also cannot open a client resend loop. This patch does not repair
an upstream outage or automatically restart a task whose error was already
delivered before installation.

When recovery is unsafe or its two replacement attempts are exhausted, the
bridge emits `chatgpt_recovery_stopped` and logs a reason without request content.
It removes the failed browser execution from the replay cache. OMP's generic
error classifier recognizes the old `network_error` wording even when
`retryable: false`, so terminal messages use distinct wording as well as a
distinct code. This prevents ten client retries against the same failed turn.

Explicit platform tool rejections in an error object or its cause chain are
classified as `chatgpt_platform_tool_blocked` (HTTP 403, non-retryable). They
cannot enter the transport recovery loop, even if initially wrapped as an
`upstream_server_error` or `chatgpt_fetch_failed`. This check never scans
assistant output or quoted history. Local OMP approval settings do not override
platform controls.

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
bun tests/verify-fetch-continuation.ts "$runtime"
```

They cover 48 detection/cancellation scenarios and 44 recovery scenarios,
including stale alerts, unrelated requests, size rejection, successful SSE,
retry exhaustion, abort during backoff, tool activity and a tool/revocation race.
Eight additional scenarios run the actual compiled native `runTurn` handler and
session journal with fixture browser/broker transports. They reproduce a
settled browser error before delivery of a completed tool result, preserve the
full context on replacement, and reject missing results, current-round output,
revocation/retirement races and platform rejections. The installed OMP provider
and generic error classifier also confirm that terminal recovery does not enter
the outer network retry loop.
Installer tests also cover dry-run, manifest integrity, backup placement,
idempotence, upgrade of the previous recovery helper, and rejection of an
invalid second bundle before any file changes.
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

The October 11 AionUI incident occurred after a `find` tool batch: the browser
failed at 04:03:24 UTC, OMP received the errored tool result at 04:03:30 UTC, then
replayed the same failure ten times. The previous guard required all browser
execution tool counters to be zero and had no completed-boundary recovery path.
The continuation regression suite specifically covers that ordering. Network
failure is injected in local transport fixtures; it was not forced in the live
ChatGPT browser during validation.

After installation, a real isolated OMP smoke wrote one marker, received an
intentional `bash` exit-7 tool error, then completed `bash` and `read`
verification. The marker occurred exactly once. This validates ordinary
continuation after an errored tool result on the installed runtime; network
replacement is validated separately with the compiled transport fault tests.
