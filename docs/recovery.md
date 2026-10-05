# Recovery checklist

## Recognize the bad state

Common symptoms:

- OMP looks alive but `continue` appears to freeze.
- Context gauge is near or above 100%.
- Logs contain `context_length_exceeded` or `chatgpt_submission_ambiguous`.
- OMP reports a compaction that increased tokens, for example `84K -> 172K`.

## Inspect without dumping giant session entries

Session JSONL compaction summaries can be huge. Extract only metadata instead of printing complete entries.

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / '.omp/agent/sessions'
for f in p.rglob('*.jsonl'):
    for line in f.open(errors='ignore'):
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get('type') == 'compaction':
            print(f, {k: row.get(k) for k in ('id','parentId','timestamp','method','tokensBefore','tokensAfter')})
PY
```

## Recover with OMP's supported session tree

Use `/rewind` and choose the user turn immediately before the bad compaction. OMP keeps the abandoned path as a branch, so this is safer than hand-editing JSONL.

After rewind, send a small prompt. With `shake -> handoff`, OMP can first drop recoverable heavy blocks and then create a handoff if the session remains above threshold.

## Distinguish UI latency from context failure

A slow ChatGPT response can cross a 60-second diagnostic threshold and still complete successfully. Treat UI latency as a secondary issue unless fresh logs continue to show submission ambiguity after context is healthy.

Useful evidence in Codex Web diagnostics includes checkpoints such as:

- `send-accepted`
- `response-visible`
- `response-stalled-60s`
- `turn-completed`

If `turn-completed` eventually appears and OMP continues, the browser transport did not actually lose the turn.
