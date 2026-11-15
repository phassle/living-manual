---
name: lm-run
description: Run a product's Living Manual doc scenarios against the demo environment and report what passed.
disable-model-invocation: true
---

A run turns the doc scenarios into step records, screenshots and manual pages. `lm-run.mjs` does all of it under the product's **run lock**; you start it and report. Run from the workspace root.

```
node living-manual/kit/bin/lm-run.mjs <product> [--grep <ID>] [--no-manual]
```

It checks parity, resets, runs verify (the gate), runs the scenarios (each reset and verified again first), compares with the previous run, writes the facts pack (`facts/pack.json` and `facts/pack.md` in the product folder, versioned), files batched issues and writes the changed manual pages. A line `<ID>: confirmation lapsed: … now broken` means a confirmed scenario's text or actions changed: tell the user the writer must confirm it again; its last published page stays published. Lines `issues: filed <file> (N item(s))` name each new issue in the workspace's tracker (one per kind per feature: broken scenarios, missing cases, missing test IDs, unanswered guide questions; an item already in an open issue is not filed again): list them for the user. `issues refused: …` means the tracker could not be written; tell the user why, the run still counts. Another run holding the lock makes it wait (`lock: waiting …`); let it wait.

| Exit | Meaning | Tell the user |
|---|---|---|
| 0 | every scenario green | the Playwright summary line and the `compare:` line |
| 1 | parity failed, or a scenario failed | the parity lines, or each failing test's first error line; offer the healer (`lm-draft` step 3) |
| 3 | verify refused the run | the `verify FAIL` lines; the demo database holds something else, nothing ran |

Before a run, read `facts/queue.json` in the product folder if it exists: the facts the writer session needed (kind `fact`) and the scenario changes the writer asked for (kind `change`). Tell the user how many wait; the `lm-collect` and `lm-draft` skills act on them.

Done when you have reported the exit and those lines. Two green runs in a row with `compare: no differences` is a repeatable run.
