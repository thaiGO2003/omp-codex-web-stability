# Codex Web 6.1.9 recovery investigation

Investigated on 16 October 2026 with OMP 18.8.7 and Codex Web 6.1.9 Linux x64.

## Observed causes

The OMP log at 22:45:04 +07 on 15 October ended with
`chatgpt_submitted_turn_failed`. Browser trace `4364c2410921-0526ebb5` reported
that ChatGPT accepted the prompt but did not expose an assistant DOM turn.
An idle recap later failed with `ChatGPT opened another user turn while the
bound assistant response was detached` (trace `1203004a329d-aa2a66f3`). Its DOM
had changed from a fallback assistant identity to a saved user/assistant group.

The installed 6.1.9 bundle still used a literal text comparison. A saved user
bubble includes the selected connector's rendered mention and may include
layout newlines or Markdown escape characters. Comparing this rendered text
directly to the unadorned task rejects the same task. The earlier 6.1.7 patch
does not apply after an upstream version update.

Separately, the shim's silent recovery checked for exactly version 6.1.7.
It therefore refused a replacement on 6.1.9 even at an otherwise eligible
silent boundary. This is distinct from the upstream submitted-turn error:
changing the version guard alone cannot fix browser DOM ownership.

## Changes

- `patch-browser-rebinding-619.py` ports the complete-payload ownership check
  to the exact 6.1.9 CLI/helper layouts. Before Send it captures the uniquely
  selected app mention's exact path. During a saved-turn transition it verifies
  that app and the entire task; an incompletely hydrated mention remains pending.
  Foreign apps, changed/extra instructions, duplicate roots, multiple mentions
  and competing user turns still fail. It performs no Send retry.
- The shim permits one silent replacement on the inspected 6.1.7 and 6.1.9
  lifecycles, which retire the previous owner before replacing it. Other versions
  remain unsupported. Historical tool results must be complete; current-round
  text, reasoning or tool output still prevents replay.
- A successful HTTP response from `/admin/interrupt-turn` is no longer enough:
  `status: ok` and nonnegative integer cancellation counts must be present.
  Malformed/refused acknowledgements prevent replacement.
- Python and generated PowerShell installers upgrade the existing 6.1.7 guard
  while preserving the rest of the installed shim.
- `reload-runtime-619.py` validates the idle launcher-owned daemon and patched
  bundle hashes, drains it atomically, then reloads only that daemon through its
  supervisor. A full launcher restart reinstalls its original packaged runtime,
  silently discarding browser patches. The reload script keeps the launcher and
  profile alive, refuses a busy runtime, and reverses a failed drain/shutdown.

## Validation

The actual unmodified 6.1.9 bundles reproduced the ownership failure in a local
browser fixture (4 scenarios across CLI/helper). After patching those bundles,
44 browser scenarios passed, including the rejection cases above and pre-Send
mention capture. These are compiled vendor methods executed against DOM fixtures,
not a claim that a real ChatGPT turn cannot fail.

The HTTP shim fixture covers byte-identical full-input replacement with completed
tool results on 6.1.7 and 6.1.9, refusal on unsupported versions, missing results,
and invalid cancellation acknowledgements. Existing watchdog tests continue to
cover cancellation races, output/refusal exclusions and the one-replacement limit.

After applying to the installed runtime and reloading only the daemon, a real
request through port 17842 to ChatGPT returned exactly `SHIM619OK` in 23.6 seconds
with no SSE error. The patched bundle hashes remained intact after that request.
All 6,030 manifest entries and both bundle syntax checks passed before cutover.
The final suite passed 26 Bun tests and 27 Python tests; 30 optional Python tests
were skipped because PowerShell or vendor fixtures were unavailable. A short
smoke does not establish that an hours-long OMP merge will never stop.

On October 16, a long OMP merge exposed a second 6.1.9 DOM layout. ChatGPT
accepted a 242,501-character handoff, completed a 10,365-character assistant
answer, then rendered only the first 10,179 characters of the submitted Codex
Native2 payload in the saved user bubble. The complete-payload comparator
therefore rejected the correct saved turn. The 6.1.9 installer now accepts this
specific UI truncation only when at least 8,192 rendered characters match the
start of a payload of at least 65,536 characters, at least 1,024 expected
characters remain hidden, the captured app href is identical, and the existing
single replacement and turn-structure guards pass. Short prefixes, changed
prefixes, wrong apps, duplicate roots and competing turns remain rejected.

To repeat the real-bundle DOM regression on a disposable runtime copy, set
`CHATGPT_DOM_TEST_BROWSER` to a local Chromium executable, then run:

```bash
bun tests/verify-browser-rebinding-617.ts /path/to/6.1.9-copy --version-619 --expect-unpatched
python3 bin/patch-browser-rebinding-619.py /path/to/6.1.9-copy
bun tests/verify-browser-rebinding-617.ts /path/to/6.1.9-copy --version-619
```

## Limits

The absent-assistant-DOM failure was observed, but its remote ChatGPT cause is
unverified. This patch fixes the reproduced saved-turn ownership defects and the
shim version mismatch. It does not reclassify every `chatgpt_submitted_turn_failed`
as safe to retry: the error alone cannot rule out native tool side effects.
Explicit platform rejections, user cancellation and ambiguous submission remain
terminal. It does not change approval settings or extend the semantic timeout.

Reapply the browser patch after closing/reopening or updating the official
launcher. The custom runtime is not repacked into its AppImage by this toolkit.
