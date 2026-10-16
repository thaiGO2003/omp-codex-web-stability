#!/usr/bin/env python3
"""Add a dedicated read-only OMP gateway to verified Codex Web 6.1.9 Linux bundles."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil


VERSION = "6.1.9"
TOOL_MARKER = 'n.registerTool("codex_read"'
INSERT_BEFORE = 'n.registerTool("codex_tool_call"'
READ_TOOL = '''n.registerTool("codex_read",{title:"Read a file through native Codex",description:Xo(t,"Invoke only the read tool advertised by the current outer Codex harness. This gateway cannot call shell, write, edit, patch, network, or arbitrary tools. The path may include the line selectors supported by the native read tool."),inputSchema:{...zr(t),path:ue.string().min(1).max(16384)},annotations:{readOnlyHint:!0,destructiveHint:!1,idempotentHint:!0,openWorldHint:!1}},async(c,l)=>i("codex_read",jr(t,c),l,async(u)=>{let{path:d}=c,p=u.environment,h=im(p,t).find((m)=>ut(m)==="read");if(!h)throw Error("This Codex turn did not advertise the native read tool");if(h.freeform)return a(u.bindingId,p,h,{input:d},l.signal);let f={path:d};return zy(h,f),a(u.bindingId,p,h,{arguments:f},l.signal)})),'''


def patch_text(source: str) -> str:
    if source.count(TOOL_MARKER) == 1:
        if source.count(READ_TOOL) != 1:
            raise ValueError("cli.js: unknown or partially patched codex_read layout")
        return source
    if source.count(TOOL_MARKER) != 0 or source.count(INSERT_BEFORE) != 1:
        raise ValueError("cli.js: expected one codex_tool_call registration and no codex_read registration")
    return source.replace(INSERT_BEFORE, READ_TOOL + INSERT_BEFORE, 1)


def bundle_id(manifest: dict) -> str:
    digest = hashlib.sha256()
    for record in manifest["files"]:
        for value in (record["path"], str(record["size"]), record["sha256"]):
            digest.update(value.encode() + b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Add codex_read to Codex Web 6.1.9 Linux x64.")
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = args.runtime.resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("appVersion"), manifest.get("platform"), manifest.get("arch")) != (VERSION, "linux", "x64"):
        raise ValueError(f"Supported runtime: Codex Web {VERSION} linux-x64; no files changed")

    cli_path = root / "app/cli.js"
    records = [record for record in manifest["files"] if record["path"] == "app/cli.js"]
    if len(records) != 1:
        raise ValueError("cli.js: expected one manifest record; no files changed")
    source = cli_path.read_text()
    record = records[0]
    encoded = source.encode()
    if len(encoded) != record["size"] or hashlib.sha256(encoded).hexdigest() != record["sha256"]:
        raise ValueError("cli.js: existing manifest mismatch; no files changed")

    patched = patch_text(source)
    if patched == source:
        print("6.1.9 read-only gateway already patched")
        return
    record["size"] = len(patched.encode())
    record["sha256"] = hashlib.sha256(patched.encode()).hexdigest()
    manifest["bundleId"] = bundle_id(manifest)
    if args.dry_run:
        print("Would patch cli.js; new bundleId", manifest["bundleId"])
        return

    backup = root.parent / "codex-web-stability-backups" / ("read-gateway-619-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    backup.mkdir(parents=True)
    shutil.copy2(cli_path, backup / "cli.js")
    shutil.copy2(manifest_path, backup / "manifest.json")
    try:
        cli_path.write_text(patched)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    except BaseException:
        shutil.copy2(backup / "cli.js", cli_path)
        shutil.copy2(backup / "manifest.json", manifest_path)
        raise
    print("Patched cli.js; backup", backup, "bundleId", manifest["bundleId"])


if __name__ == "__main__":
    main()
