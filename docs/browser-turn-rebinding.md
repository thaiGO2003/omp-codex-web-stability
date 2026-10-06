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
Both previous toolkit releases can also be upgraded in place, with a new
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


## Saved rich-text escaping: 2026-10-06 07:48

The forest-thorne turn at 07:48 failed with `chatgpt_submitted_turn_failed`.
Its underlying browser error was still the detached-response ownership rejection.
The previous app-pill layout fix therefore did not cover every saved prompt.

A separate read-only connection test captured its original submitted prompt and
then read its saved user bubble on an independently leased diagnostic surface.
The original payload had 17,706 characters. After removing the verified app label,
its single layout LF and two separator spaces, the saved payload had 17,943.
The entire difference consisted of 237 inserted backslashes at 235 positions.
They occurred around Markdown punctuation, including backticks, existing
backslashes, angle brackets, quotes, colons, underscores and asterisks.
The rendered JSON consequently could not be compared literally to the original.

Replaying that exact saved HTML and original prompt in headless Chromium reproduced
all 17,959 visible characters, including the app prefix. The previously installed
native helper rejected it. The updated native helper rebound to the saved reply.
This proves a missing representation case; the completed original 07:48 turn did
not preserve its baseline, so its exact failing gate cannot be reconstructed.

The new comparison is directional and covers the complete payload. It allows only
extra backslashes before ASCII Markdown punctuation, with at most one escape for
each original backslash or following punctuation character. Original backslashes
must all remain represented. It never decodes JSON escapes, removes payload
characters, folds whitespace or matches only a nonce or prompt suffix. This
allowance is enabled only after the saved bubble's exact selected app identity is
verified. Accepted-user-ID and competing-turn checks retain their existing rules.

Ownership rejections now include non-content diagnostics: whether the replacement
shape was valid, whether an accepted user ID was observed and matched, whether
an app identity was captured, and the submitted character count. No prompt text,
capability token, connector URL or turn ID is included in these details. Temporary
private prompt capture used for this investigation is not part of the patch.

The synthetic browser fixture covers escaped punctuation and existing JSON
backslashes, altered tasks, wrong apps, escapes before letters, changed JSON
escapes and a 199K escaped payload. Installer tests exercise upgrades from both
prior releases through Python and standalone PowerShell. A private real-DOM
replay is kept out of this repository because it contains runtime task context.


On the installed bundle, both browser fixtures passed all 22 scenarios (75
assertions), including the 199K escaped payload. The source connector fixture
passed after increasing its test-only limit to 60 seconds for the expanded set;
the large source fixture and all four existing binding tests also passed. The
repository suite passed 13 Bun tests and 25 Python tests, including PowerShell 7.
Both installed helpers retain their earlier capability-probe and Send budgets.
The temporary private diagnostic hooks were removed before installation.


A fresh OMP session on GPT-5.6 Sol Web/high read a temporary marker through the
read tool and completed normally. `omp --continue` resumed that same saved
session, read the marker again and completed normally. Both turns had a
successful read result, the expected final marker after Markdown display
escaping, no assistant error and empty stderr. These isolated checks did not
resume the user's forest-thorne session. Private prompt/DOM captures were deleted.


## Nested link targets and unrecognized approvals: 2026-10-06 08:45–09:00

The 08:45 trace `0b4eacac6d21-748a811a` still rejected ownership, reporting a
valid replacement shape, no accepted user ID, a captured app identity and 97,618
submitted characters. Its saved user bubble contained an inline `pnpm@11.25.0`
link that also carried `data-search-result-target`. The helper counted the outer
message target and the nested link as two independent payloads and rejected both.
The link's block-layout label also inserted presentation LFs inside `innerText`.

On a separately leased diagnostic surface, opening the saved message's editor
and cancelling it recovered 97,618 payload characters, matching the original
submission count. Headless replay of its exact HTML reproduced the rejection in
the installed helper. The final candidate rebound successfully. Private runtime
context is not included in these public fixtures.

The matcher now selects only outermost targets within the user bubble. If the
verified app and complete rendered text do not match, a single-paragraph transport
can be compared using all its text nodes and explicit BRs, removing only the
verified app node. It requires the paragraph to contain all the content target's
text. Nested links remain part of the compared payload; actual line breaks,
changed text, multiple outer content roots and competing turns remain rejected.

The 08:55 and 09:00 watchdog failures were also inspected. The 09:00 saved turn
contained a real tool-approval card with a safety warning. The current UI uses
`@container/approval-card` and role=alert, without the old dialog/test-id markers.
Its button labels include keyboard hints (`Allow once ⏎`, `Deny Esc`). The previous
resolver missed the card and waited until the 240-second SSE watchdog cancelled
it. Replaying the actual card confirmed the old resolver returned false; the new
resolver recognized it, notified pending approval and returned the explicit
`chatgpt_tool_approval_required` error when the human did not decide.

The resolver now recognizes this card, accepts its keyboard hints, and is scoped
to the bound assistant turn. Routine one-shot approval still follows the existing
explicit auto-approval setting. Any visible safety-warning aside requires a human
decision, including warnings that hydrate while the button becomes ready. Such a
card is never automatically allowed or denied. The existing 60-second human wait
is retained, followed by a specific non-retryable approval error instead of a
four-minute semantic stall. Historical cards and other connectors are excluded.
This does not override ChatGPT's safety review: the user must review and decide on
any warning in the new active turn.

For upstream tests, also copy `tests/browser-approval-card.upstream.ts` to
`tests/browser-approval-card.test.ts`. Set `CHATGPT_NATIVE_APPROVAL_HELPER` to the
candidate bundle to exercise its real approval function. The fixture covers new
card structure, keyboard hints, wrong apps, permanent-only actions, initial and
late safety warnings, human decisions, history isolation and cancellation.


Final verification: the native candidate passed all three browser fixtures (114
assertions), covering 25 prompt-rendering scenarios and eight approval scenarios.
The source contract suite passed 138 tests (769 assertions); the repository suite
passed 13 Bun tests and 25 Python tests, including real PowerShell execution and
upgrades from the prior published layouts. Both installed helpers were upgraded
while idle and the helper child was reloaded. A real saved OMP session then resumed,
read its temporary marker through the read tool and completed with the expected
marker, no assistant error and empty stderr. It included an inert pnpm email-like
label in the prompt. This did not resume or approve the user's forest-thorne task.
