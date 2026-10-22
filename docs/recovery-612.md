# OMP recovery with Codex Web 6.1.12

The shim preserves the full OMP input and completed historical tool results.
It retries verified pre-Send ChatGPT mention failures, submitted-turn failures,
premature *fully framed* SSE EOF, and silent turns with no forwarded semantic
output. Transient HTTP 429/5xx and connection failures are retried with bounded
backoff and no total attempt limit. Every possibly submitted native turn must
receive a settled scoped cancellation acknowledgement before it is replayed.

Refusals, permission failures, explicit cancellations, unknown/incomplete SSE
frames, semantic output, incomplete tool history, and unconfirmed cancellation
stop replay. Their original OMP context is preserved for manual continuation.

Codex Web 6.1.12 requires the patch in
`bin/patch-native-interrupt-612.py`. Only a patched **running** native daemon
advertises `scoped_interrupt_settled: true` at `/healthz`; an on-disk patch is
not enough. `bin/reload-runtime-612.py` validates the launcher ownership,
native PID, patched binary, manifest SHA-256, and zero HTTP/browser turns,
then drains and reloads through the launcher. It refuses to reload while busy.

The optional user service and timer in `systemd/user/` call the guarded reload
every few minutes until it succeeds. Once running native health advertises
`scoped_interrupt_settled: true`, the reload script disables that timer.
The launcher and browser profile are retained.

The optional `omp-recovery-health-watch.timer` polls the installed native and
shim health endpoints every five minutes. Two consecutive failures trigger a
transition notification (desktop notification when available, otherwise the
user journal). A subsequent successful check reports recovery. It only records
redacted health conditions at
`~/.local/state/omp-codex-web-stability/health-watch.json` and never restarts
an active turn. Inspect alerts with
`journalctl --user -u omp-recovery-health-watch.service`.
The supplied user service expects the checkout at `~/omp-codex-web-stability`.
To enable the health monitor after verifying this path, copy the two
`omp-recovery-health-watch.*` units into `~/.config/systemd/user/`, run
`systemctl --user daemon-reload`, then run
`systemctl --user enable --now omp-recovery-health-watch.timer`.

Verification:

```sh
cd ~/omp-codex-web-stability
bun test fixes
python3 -m unittest discover -s tests -q
python3 bin/patch-native-interrupt-612.py ~/.codex-chatgpt-web/versions/6.1.12-linux-x64/app/cli.js
python3 bin/reload-runtime-612.py --check-only --if-idle
systemctl --user status codex-chatgpt-web-omp-shim.service
systemctl --user status omp-native-612-safe-reload.timer
curl -fsS http://127.0.0.1:17841/healthz
curl -fsS http://127.0.0.1:3007/omp-shim-health
```

For troubleshooting, inspect only redacted diagnostics at
`~/.codex-chatgpt-web/diagnostics/omp-shim/`. Expected safe recovery events
include `cleanup_started`, `cleanup_completed`, `recovery_connect_deferred`,
`submitted_retry_started`, `submitted_retry_resumed`, and `stream_terminal`.
No retry flow can guarantee completion if ChatGPT never makes progress or
denies the request; it preserves the current OMP session when replay is unsafe.
