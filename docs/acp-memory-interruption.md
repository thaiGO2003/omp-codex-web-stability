# AionUI: Incoming transport closed after earlyoom terminates OMP

`UNKNOWN_UPSTREAM_ERROR`, JSON-RPC `-32603` and `Incoming transport closed`
describe an ACP connection failure. They do not identify the component that
caused it. Check the agent's exit status and system memory logs before changing
ChatGPT network retry behavior.

## Observed Linux incident

On 2026-10-12, this host's earlyoom journal recorded these events (UTC+7):

| Time | Event |
| --- | --- |
| 20:15:33 | earlyoom sent SIGTERM to OMP PID 925780. |
| 20:17:15 | AionUI tried the closed ACP connection and reported exit code 143. |
| 20:17:34 | earlyoom sent SIGTERM to replacement OMP PID 928282. |
| 20:17:44 | AionUI reported that replacement's closed transport. |
| 20:17:49 | earlyoom terminated OMP PID 929494 during `session/load`. |

AionUI also logged automatic recovery attempts. Starting another agent did not
solve the memory pressure; replacement agents were terminated too. In this
incident, exit code 143 correlates with explicit SIGTERM records, rather than a
ChatGPT fetch failure or a platform tool rejection.

The machine has approximately 7.5 GiB RAM and initially had 4 GiB swap. Earlyoom
used `-m 15,8 -s 100,100`, so low RAM could trigger termination regardless of
remaining swap. OMP had `oom_score_adj=200`; the avoid rule included Codex Web
and ChatGPT but omitted OMP and AionUI. Repeatedly replacing ACP agents could
not address that selection policy.

## Diagnose before applying a memory fix

```bash
journalctl -u earlyoom --since '30 minutes ago' --no-pager
systemctl cat earlyoom
cat /etc/default/earlyoom
free -h
swapon --show
ps -eo pid,ppid,rss,comm --sort=-rss | head -20
```

Correlate the PIDs and timestamps with AionUI's `ACP send_message failed`,
`ACP session warmup failed` and `CLI process exited` log entries. A closed ACP
pipe without a matching memory termination requires another investigation.

## Changes applied on this host

- Kept earlyoom enabled, including the existing SSH, desktop and 1DevTool
  exclusions.
- Kept the RAM thresholds at 15% for SIGTERM and 8% for SIGKILL, and changed
  the swap thresholds to 20% and 10%. Both conditions must hold to act.
- Extended the soft avoid expression to
  `^(codex-web-gpt-l|ChatGPT|omp|aioncore)$`. These processes remain eligible as
  a last resort; this is not an unconditional ignore rule.
- Added an 8 GiB, mode-0600 swap file at `/var/swap-omp-stability`, on an ext4
  filesystem with ample free space. `swapon` accepted it. An fstab entry using
  `sw,nofail` makes it available after reboot.
- Reloaded systemd and restarted only earlyoom. AionUI, OMP and the browser
  bridge were not restarted.

Backups were created before changing `/etc/default/earlyoom` and `/etc/fstab`.
This is a host-specific memory configuration, not part of the Windows installer
or an automatically applied setting in `apply.sh`.

Verify the running daemon's startup log actually shows the updated regex and
thresholds, and that `swapon --show` lists the additional space. A separate ACP
smoke test can check the agent connection without sending messages to an
existing team. It cannot prove behavior under future sustained memory pressure.

Extra swap provides headroom, not additional physical RAM. A larger concurrent
workload can still exhaust memory or become slow while swapping. Reducing
concurrent agents/browser sessions or adding RAM addresses that remaining
capacity constraint.

## Rollback

Restore the saved earlyoom configuration and restart earlyoom. To remove the
additional swap, first stop memory-intensive work and ensure enough capacity
to move its used pages; then disable that swap file, remove its fstab entry,
reload systemd and delete the file. Do not disable active swap while the machine
is already under memory pressure.
