# Investigating reported tool rejections

An assistant sentence saying a patch was blocked is not a protocol error or
a local tool result. A successful `read` also does not prove that a later edit
was attempted or succeeded. Keep those observations separate when diagnosing
an interrupted AionUI/OMP task.

In the supplied October 10 report, the two referenced OMP logs contain
successful `read` results (`isError: false`) followed by ordinary assistant
messages describing a platform block. No rejected edit event is present in
those cited entries. An internal ChatGPT tool might have been rejected before
it reached OMP, but these logs cannot establish that cause, or that it was
random. The working copy of `src/app/screens.ts` later had a diff, so an earlier
claim that it remained unchanged cannot establish its current state or identify
which agent changed it.

The shim now inserts stable developer guidance to report actual tool outcomes,
verify the current diff, preserve existing edits and successful results, and
label an unverified cause as such. The guidance survives tool continuations
without duplicating itself or changing tool outputs. It is a reporting aid;
it cannot repair a platform rejection or guarantee model compliance.

Version 2 also distinguishes existing local authorization from platform
decisions. It asks the model to avoid re-requesting permission for routine
work already authorized, while retaining approvals for new scope, destructive
actions and explicit safety reviews. A platform rejection must be reported as
such, not answered with a generic "confirm all repository work" question.
Only independent authorized work may continue; the blocked operation must not
be retried, repackaged or routed through another tool. Existing version 1
shim-owned developer guidance is replaced using a new stable message ID so
retained turns receive the updated instruction. Other developer messages,
assistant reports and tool results are preserved.

The fetch recovery patch handles only eligible transport failures. An explicit
platform rejection in an error object receives a distinct terminal code,
`chatgpt_platform_tool_blocked`, and is not automatically resubmitted. Assistant
prose and quoted history are not classified as errors. Normal network recovery
remains available when the existing no-output/no-tool-progress checks pass.

When the symptom recurs, compare the assistant claim with the tool call ID,
tool result/error and current diff. If the ChatGPT tab reports an internal
rejection, record the affected operation and time. Preserve the event type and
error code where available; do not publish full prompts, credentials or tool
arguments. Local Always allow/YOLO affects OMP permissions, not platform
decisions. Changing or retrying a blocked operation solely to bypass that
decision is not part of this fix.

## Validation on October 11

The installed Linux bridge completed an isolated real OMP turn using `read`,
`edit` and `bash`: it changed a temporary `screens.ts` constant from 1 to 2,
verified the diff and returned a success marker. All three tool results had
`isError: false`. The installed runtime's 6,030 manifest entries matched after
the idle restart. This confirms the ordinary edit path works; it does not
reproduce or resolve an internal platform rejection.

Sixteen Bun tests passed, including the actual installed OMP parser handling a
structured platform rejection with one request and no retry. The installer
suite passed 15 tests (23 PowerShell-dependent tests were skipped because that
runtime was unavailable); the real 6.1.7 bundle harnesses passed 48 detection
and 29 recovery scenarios. Windows payloads were regenerated from the updated
shim, but native Windows execution was not tested.

Version 2 passed 17 Bun tests and the generated installer payload consistency
check. A separate real OMP session completed two consecutive turns: first
`read` plus `git status/diff`, then a continuation that performed the previously
authorized `edit` and checked the resulting diff with `bash`. All four tool
results succeeded, the file changed from 1 to 2, and neither turn requested
permission again. No platform rejection was forced or automatically resumed
in this test. The shim was updated and restarted only while the bridge was idle.
