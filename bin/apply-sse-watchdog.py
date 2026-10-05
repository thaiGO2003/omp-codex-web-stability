#!/usr/bin/env python3
"""Install the tested SSE guard into an existing OMP compatibility shim."""
import argparse
from datetime import datetime
from pathlib import Path
import shutil
import sys

WATCHDOG_IMPORT = 'import { guardResponseStream } from "./sse-watchdog";'
OLD_BODY = 'const responseBody = isOmpStream ? translateResponseStream(upstream.body!) : upstream.body;'
NEW_BODY = '''const guardedBody = isOmpStream && threadId && turnId ? guardResponseStream(upstream.body!, {
      onStall: () => interruptNativeTurn(threadId, turnId),
      onCancel: () => interruptNativeTurn(threadId, turnId),
    }) : upstream.body;
    const responseBody = isOmpStream ? translateResponseStream(guardedBody!) : guardedBody;'''
INTERRUPT_FUNCTION = '''async function interruptNativeTurn(threadId: string | undefined, turnId: string | undefined) {
  if (!threadId || !turnId) return;
  const configPath = join(process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), ".codex-chatgpt-web"), "config.json");
  const config = await Bun.file(configPath).json();
  if (typeof config.controlToken !== "string") throw new Error("Missing local Web control token");
  const result = await fetch(new URL("/admin/interrupt-turn", upstreamOrigin), {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId, turnId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error(`Native turn interruption HTTP ${result.status}`);
  console.log("OMP interrupted native Web turn", { thread: threadId.slice(0, 8), turn: turnId.slice(0, 8), ...await result.json() });
}
'''


def replace_once(text, old, new):
    count = text.count(old)
    if count != 1:
        raise ValueError(f"Unsupported shim layout: expected one {old!r}, got {count}; no files changed")
    return text.replace(old, new, 1)


def patched_server(text):
    # Refuse partial installs/custom integration rather than guessing boundaries.
    if WATCHDOG_IMPORT in text:
        for marker in [NEW_BODY, INTERRUPT_FUNCTION.strip(), 'let turnId: string | undefined;',
                       'if (typeof metadata.turn_id === "string") turnId = metadata.turn_id;']:
            if marker not in text:
                raise ValueError("Existing watchdog integration differs from the tested layout; no files changed")
        return text
    text = replace_once(text, 'import { isAbsolute } from "node:path";',
                        'import { isAbsolute, join } from "node:path";\nimport { homedir } from "node:os";\n' + WATCHDOG_IMPORT)
    text = replace_once(text, 'const threadTails =', INTERRUPT_FUNCTION + '\nconst threadTails =')
    text = replace_once(text, 'let threadId = threadIdFromMetadata(headerTurnMetadata);',
                        'let threadId = threadIdFromMetadata(headerTurnMetadata);\n    let turnId: string | undefined;')
    text = replace_once(text, 'const metadata = JSON.parse(rewrittenTurnMetadata!);',
                        'const metadata = JSON.parse(rewrittenTurnMetadata!);\n            if (typeof metadata.turn_id === "string") turnId = metadata.turn_id;')
    return replace_once(text, OLD_BODY, NEW_BODY)


def install(shim_dir, dry_run=False):
    server = shim_dir / 'server.ts'
    if not server.is_file():
        raise ValueError(f"Existing compatibility shim required: {server}")
    module_source = Path(__file__).resolve().parent.parent / 'fixes/sse-watchdog.ts'
    original = server.read_text()
    updated = patched_server(original)  # Validate everything before writes/backups.
    module = shim_dir / 'sse-watchdog.ts'
    files = []
    if updated != original:
        files.append((server, updated))
    module_text = module_source.read_text()
    if not module.exists() or module.read_text() != module_text:
        files.append((module, module_text))
    if not files:
        print('SSE watchdog already installed (240 seconds without semantic progress).')
        return
    if dry_run:
        for path, _ in files:
            print(f'Would install: {path}')
        return
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    snapshots = {path: path.read_bytes() if path.exists() else None for path, _ in files}
    try:
        for path, text in files:
            if path.exists():
                backup = path.with_name(path.name + '.pre-sse-watchdog-' + stamp + '.bak')
                shutil.copy2(path, backup)
                print(f'Backup: {backup}')
            path.write_text(text)
    except Exception:
        for path, content in snapshots.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(content)
        raise
    print('Installed. Restart the compatibility shim when its active turns have finished:')
    print('  systemctl --user restart codex-chatgpt-web-omp-shim.service')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shim-dir', type=Path, default=Path.home() / '.local/share/codex-chatgpt-web-omp-shim')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        install(args.shim_dir, args.dry_run)
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
