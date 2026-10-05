# Message delivery timed out / OMP SSE stalls

## Observed failure

A ChatGPT Web turn stopped progressing after an OMP `read` call. The broker had
already delivered the tool result, but the browser turn continued sending
heartbeats. OMP's semantic SSE watchdog expired after 300 seconds. Retries reused
the same thread/turn identity and stalled again, eventually exhausting ten
retries. Two browser turns remained alive after their clients had stopped.

ChatGPT also displayed **Message delivery timed out. Please try again.** The
internal cause of that ChatGPT delivery failure is unknown. This patch handles
the stuck turn and its recovery; it does not repair ChatGPT's remote service.

## Fix

`fixes/sse-watchdog.ts` wraps the existing shim's Responses SSE stream:

- Actual response, reasoning, text and tool events reset the 240-second budget.
- Comments and `response.heartbeat` do not reset it.
- Before OMP's default 300-second timeout, the shim requests cancellation of the
  exact native `threadId`/`turnId` through the local `/admin/interrupt-turn` API.
- It then emits `response.failed` with `chatgpt_web_semantic_timeout`, followed
  by `[DONE]`. The original response ID and next sequence number are preserved.
- Downstream cancellation also retires an unfinished native turn.
- A completed tool round is never interrupted merely because its client closes.

A timeout is a failure, not a fabricated successful answer. After it, send a
**new** `continue` message to start a new turn. Sessions and repository files
remain available.

## Apply to an existing compatibility shim

Requires Python 3, Bun, an existing `codex-chatgpt-web-omp-shim`, and Codex Web's
local native-turn interruption endpoint. The integration was verified with OMP
18.6.0 and Codex Web 6.1.4. It is scoped to the tested shim layout.

```bash
python3 bin/apply-sse-watchdog.py --dry-run
python3 bin/apply-sse-watchdog.py
```

For a different shim directory:

```bash
python3 bin/apply-sse-watchdog.py --shim-dir /path/to/existing/shim --dry-run
```

The installer validates the complete layout before changing files, backs up each
existing file it changes, and rolls back its writes if installation fails.
Unknown or partially patched layouts are rejected. It does not install the base
compatibility shim or restart a running service.

Once active turns have finished, load the installed change:

```bash
systemctl --user restart codex-chatgpt-web-omp-shim.service
```

The local control token is read at runtime from the installed Codex Web config;
it is not bundled in the patch. Interruption targets the shim's existing local
upstream origin. If local cancellation fails, the shim logs that failure and
still reports the stalled stream; a failed cleanup cannot guarantee that the
browser turn has been retired.

## Validation

```bash
bun run test
```

The stream tests cover heartbeat-only stalls, progress that resets the timer,
successful response preservation, downstream cancellation and completed tool
rounds. An integration test uses OMP's actual parser when its sources are present;
it is skipped on machines without them. Set `OMP_GLOBAL_NODE_MODULES` if global
OMP packages are installed outside `~/.bun/install/global/node_modules`.
Installer tests cover backups, repeated application, dry runs, unsupported
layouts, missing shims and rollback after a write failure.

On the original machine, live tests returned `SSE_OK` and `READ_SSE_OK`, including
reading the same requested file range. Browser diagnostics recorded a completed
turn with no pending tools. These checks demonstrate successful recovery on that
run; they do not establish that ChatGPT delivery failures can never recur.
