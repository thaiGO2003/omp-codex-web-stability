# ChatGPT saved-turn replacement interrupted OMP

On 2026-10-06 the Linux browser diagnostics recorded this error at 01:09, 01:20,
01:25 and 01:28 (Asia/Ho_Chi_Minh):

> ChatGPT opened another user turn while the bound assistant response was detached

The 01:28 trace was `a4ceede02125-0ce5bb86`. Its accepted-send and response-visible
snapshots contained zero user bubbles, one temporary assistant and an active Stop
button. Its failure snapshot contained a user bubble and a completed assistant.
The helper had rejected the change from a temporary Activity group to a saved group.
The daemon and OMP processes remained alive.

The helper normally proves ownership by the accepted user's ID. When Send is
acknowledged before that user bubble exists, it instead compares the entire saved
prompt with the submitted text. The saved prompt includes the selected app mention
(`Codex Native2` on this installation) and one or two UI separator spaces. A hydrated pill with block-layout children
also inserts a layout newline after its label in `innerText`. The old
comparison omitted that presentation prefix. The saved bubble also briefly exposes
a literal `$connector` keyword before the app mention hydrates.

The browser regression reproduced the exact logged error against the unmodified
6.1.4 source. With the patch, the helper captures the selected app's `app://` identity
before activating Send. A replacement is accepted only when that exact app mention
and the entire submitted payload match, there is one replacement exchange and no
competing new turn. Existing accepted-user-ID ownership checks are retained. The payload comparison
uses the same directional Lexical whitespace allowance as prompt attachment:
NBSP may preserve repeated ASCII-space runs, but single-space changes remain
mismatches.
The comparison permits one layout newline only between the verified app label
and its separator spaces; payload newlines are compared exactly.
An unhydrated keyword defers rebinding within the existing missing-response grace;
it does not establish ownership or cause another Send.

This addresses that browser ownership failure. The separate SSE watchdog remains
useful for requests that stop making progress for other reasons.

## Apply to installed Codex Web 6.1.4

Linux/macOS, from this repository:

```bash
python3 bin/apply-browser-rebinding.py --dry-run
python3 bin/apply-browser-rebinding.py
```

Windows, directly in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-browser-rebinding.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\apply-browser-rebinding.ps1
```

The PowerShell file embeds its patch and can be downloaded and run alone. Both
installers find installed version helpers and the launcher descriptor's helper.
For another location, pass `--helper /path/browser-helper.cjs` or
`-HelperPath 'C:\path\browser-helper.cjs'`. They validate all targets before writing,
create timestamped backups, preserve existing timeout patches and are idempotent.
The exact previous toolkit release can also be upgraded in place, with a new
backup. Unknown or partially patched layouts are rejected.

Close and reopen Codex Web when no turn is running to load the helper. Reapplying
files to a newer release requires compatible patch anchors; these scripts do not
silently rewrite unknown versions.

## Source and verification

The upstream project is [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web),
version 6.1.4. The source diff is `fixes/browser-connector-rebinding.patch`; the
installed bundle's guarded replacements are `fixes/browser-rebinding.json`.

For an upstream source checkout, apply the diff and copy
`tests/browser-connector-rebinding.upstream.ts` into upstream's `tests/` as
`browser-connector-rebinding.test.ts`. Run:

```bash
CHATGPT_DOM_TEST_BROWSER=/path/to/chromium bun test tests/browser-connector-rebinding.test.ts tests/browser-turn-binding.test.ts
```

The new browser test exercises the real Send and rebinding methods: one/two UI
separators, repeated-space NBSP preservation, rejected single-space changes, delayed hydration, a different app, changed/truncated payload, duplicate
mentions and a competing turn. Existing tests also reject changed whitespace,
foreign accepted IDs and a surviving old group. The source contract suite checks
submission recovery and time budgets. Set `CHATGPT_NATIVE_REBINDING_HELPER` to a
patched 6.1.4 helper to execute its actual bundled rebinding method in the fixture.
Installer tests cover dry runs, backups, idempotence, unknown layouts and refusal
to partially update multiple targets; PowerShell is executed when available.

## Verification on the affected Linux installation

The final patch was installed into the 6.1.4 runtime helper and the launcher's
bundled helper, retaining the previously applied 30-second capability probe and
120-second Send timeout. The idle helper child was reloaded; the daemon stayed up.

The final source and native-bundle browser fixtures passed all ten scenarios.
The existing four turn-binding tests passed, and the browser contract suite passed
138 tests after updating two mock composers to support the extra pre-Send DOM read.
The repository test command passed 13 Bun tests and 25 Python tests; final
installer guard/backup tests were rerun after the whitespace adjustment, including
the standalone PowerShell installer under PowerShell 7.

A live OMP check used GPT-5.6 Sol Web with high effort through the existing shim:
it read a temporary marker file and reached a normal final answer. A separate
saved OMP session received an initial READY reply; `omp --continue` resumed it,
read the same marker and reached a normal final answer. Both read checks had a
successful read tool result, no stderr, no assistant error and a normal `stop`
completion. These checks did not resume or modify the user's forest-thorne work.
The health endpoint returned to zero active HTTP/browser turns afterward.

## Repeated failure after the first fix: 2026-10-06 07:20

The initial toolkit fix still rejected saved replies in the real forest-thorne
session at 07:19, 07:20 and 07:25. Its short live tests had completed while the
saved user bubble was still absent, so they had not exercised that transition.

The 07:20 saved message exposed 199,417 rendered characters. Its prefix was the
verified app label followed by LF and two ASCII spaces. Removing only that layout
LF made the remaining rendered payload exactly equal to its canonical DOM text.
The composer probe confirmed the selected app's exact `app-mention-path`; the app
identity was captured correctly. The missing case was the layout LF.

A headless replay of the captured HTML reproduced the recorded rendered text
exactly. The previously installed bundle rejected it with the logged error; the
new bundle rebound to the saved assistant. Captured task content was kept out of
this repository. A separate 199K regression fixture uses an inline-flex app pill
with a block child, reproducing the browser's layout newline without an account.
It also rejects a second boundary newline, a payload newline mutation, extra
request text and a different app identity. Both source and bundled code pass it.
The earlier ten connector scenarios and four existing binding tests still pass.
Linux/Python and standalone PowerShell upgrade tests pass for the previous release.

The updated bundle was installed in both known Linux helper locations and its idle
child was reloaded. A live OMP check supplied 229,291 characters of inert context
and successfully read a marker file. This crossed OMP's compaction threshold:
shake correctly found nothing to drop, handoff completed without an assistant
error, and the model returned the marker with normal stop completion and no stderr.
The handoff intentionally cancelled the previous browser turn; its diagnostic
AbortError is distinct from the reported user-session ownership failures.

`omp --continue` then resumed that handoff session, read the marker again and
finished with normal stop completion, no assistant error and no stderr. The
transport returned to zero active HTTP/browser turns. These live checks used a
separate temporary session and did not modify forest-thorne task files.

Final combined source verification: six browser regression tests passed (106
assertions), including all fifteen connector/layout scenarios and the existing
ownership checks. The installed-bundle layout fixture passed its five cases (ten
assertions), and the toolkit suite passed thirteen Bun and twenty-five Python tests.
