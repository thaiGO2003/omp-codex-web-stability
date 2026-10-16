# Dedicated OMP read gateway for Codex Web 6.1.9

The native MCP server previously exposed OMP `read` only through
`codex_tool_call`. That gateway can invoke any advertised OMP tool, so its MCP
annotations correctly declare `readOnlyHint: false`. ChatGPT's tool reviewer can
therefore classify an ordinary file read as ambiguous even when the nested wire
name is `read`.

`patch-read-gateway-619.py` adds `codex_read`, a narrow MCP tool with
`readOnlyHint: true`, `destructiveHint: false`, and no shell or arbitrary-tool
path. It accepts one native read path, including OMP line selectors, verifies
that the current turn advertises exactly the `read` wire name, validates its
arguments against the native schema, and invokes only that tool.

The OMP compatibility instruction routes file reads through `codex_read` and
treats old assistant reports, handoffs, and TODO blockers as historical state.
A current explicit platform rejection is still terminal for that operation.

Apply only to a verified 6.1.9 Linux x64 runtime while it is idle:

```bash
python3 bin/patch-read-gateway-619.py ~/.codex-chatgpt-web/versions/6.1.9-linux-x64 --dry-run
python3 bin/patch-read-gateway-619.py ~/.codex-chatgpt-web/versions/6.1.9-linux-x64
```

The patch updates the manifest record and bundle ID, stores a rollback copy,
and is idempotent.
