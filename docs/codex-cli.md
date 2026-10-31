# Codex CLI through the OMP shim

The shim was originally written for OMP, but it sits on the same local Responses bridge that
Codex CLI uses. Codex CLI can point at it directly and inherit the same stall watchdog,
silent replacement and diagnostics.

## What Codex CLI sends

Verified against `codex-cli 0.166.0` on Windows:

- `POST /v1/responses` and `GET /v1/models`.
- `originator: codex_exec` (or `codex_cli_rs`), plus `session-id`, `thread-id` and
  `x-client-request-id` headers.
- The complete turn ownership in the `x-codex-turn-metadata` header: `thread_id`, `turn_id`,
  `root_turn_id`, `workspaces`, `sandbox_mode` and `model`.
- A `content-encoding: zstd` request body. Tool-call history is in the body, not in headers.
- A WebSocket prewarm (`Connection: Upgrade` on `/v1/responses`). The bridge answers `426`, so
  Codex CLI falls back to HTTP SSE and logs one `responses_websocket` reconnect line.

## What the shim does with it

- Decodes `zstd`, `gzip`, `deflate` and `br` JSON bodies, then forwards plain JSON. Only a
  readable body can be inspected, rebound for a silent retry, or replayed after a lost stream.
- Mirrors `x-codex-turn-metadata` into the request body when the body has no copy, so recovery
  rebinds exactly the identity the client already presented. A native body copy always wins.
- Adopts the CLI's `thread_id`/`turn_id` for per-thread serialization, diagnostics and the scoped
  `admin/interrupt-turn` call.
- Applies the same SSE watchdog and submitted-turn retry to `/v1/responses` as to
  `/v1/codex/responses`. Recovery still requires complete historical tool results, so a turn that
  already emitted output is never replayed.
- Leaves tool-call id translation to the OMP path only; Codex CLI sees its native ids.

## Configure Codex CLI

Keep the `openai` provider and only change the base URL. This is the same configuration the
Codex Web desktop app installs, with the shim port instead of `17841`:

```toml
# ~/.codex/config.toml
model = "chatgpt-web/gpt-6-sol"
model_reasoning_effort = "high"
openai_base_url = "http://127.0.0.1:3007/v1"
```

Start the shim first (`shim/start-shim.ps1` on Windows, `shim/start-shim.sh` on Linux), then run
`codex` or `codex exec` as usual. To keep the rest of the machine on the direct bridge, pass the
override per invocation instead of editing the file:

```powershell
codex exec -c 'openai_base_url="http://127.0.0.1:3007/v1"' "hello"
```

## Verify

```powershell
Invoke-WebRequest http://127.0.0.1:3007/omp-shim-health | Select-Object -Expand Content
```

`diagnostics/omp-shim/shim.jsonl` should then contain, for each CLI turn:

- `request_received` with `client: "codex-cli"`
- `request_decoded` with the request's `encoding` (normally `zstd`)
- `stream_started`, `stream_progress` and `stream_terminal` with `sse: true`

The same file stays bounded and allowlisted: no prompt text, no paths, no headers, no bodies.

## Limitations

- WebSocket Responses transport is not proxied; the CLI's HTTP fallback is the supported path.
- The shim never retries a turn that already emitted text, reasoning or a tool item, matching the
  OMP contract. The CLI's own reconnect loop still covers those failures.
- Native interruption needs the Codex Web control token from
  `~/.codex-chatgpt-web/config.json`; without a reachable bridge, recovery fails closed and the
  original error reaches the client.
