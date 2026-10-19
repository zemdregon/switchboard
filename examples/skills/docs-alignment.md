---
name: docs-alignment
description: Check README, ROADMAP and ADRs against the code at this commit; write docs_alignment.json with aligned or conflict.
---
# Docs alignment

You are checking whether this repository's documentation still matches its code at the commit you are working on.

## What to compare

1. Run `git rev-parse HEAD` and note the full commit SHA. If the task names a published branch, use the commit of
   that branch instead.
2. Read `README.md`, the roadmap (`docs/ROADMAP.md` or the nearest equivalent) and the architecture decision records
   (`docs/adr/`), if they exist.
3. For each concrete claim they make about behaviour, commands, configuration keys, file paths or status, look at the
   code that implements it. Note every claim the code contradicts, and every claim that names something that does not
   exist.

## What to write

Write exactly one file, `docs_alignment.json`, at the root of your working directory:

```json
{
  "head_sha": "<the full 40 or 64 character commit SHA from step 1>",
  "verdict": "aligned",
  "notes": "<short plain-text list of the conflicts you found, or an empty string>"
}
```

- `verdict` is `aligned` when you found no contradiction, and `conflict` when you found at least one.
- Keep `notes` under 8000 characters. Name the document, the claim and the file that contradicts it.
- Do not commit `docs_alignment.json`. Switchboard takes it out of the working directory when you finish and stores it
  as the run's report.

## Fixes

Only fix documentation when the task asks for it. A fix is an ordinary commit through Switchboard's `commit` tool on
this work item's own branch. Never push to, merge into or open a change against a protected branch such as `main`.
