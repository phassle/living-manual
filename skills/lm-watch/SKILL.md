---
name: lm-watch
description: After the product changed, rerun every Living Manual doc scenario, let the healer repair locators and waits only, regenerate what changed, and report what changed, was healed, broke or was not reached.
disable-model-invocation: true
---

A watch is the run you start after a product change (a release candidate, a relabelled button, a new dialog). `lm-watch.mjs` does all of it under the product's **run lock**; you start it and report. Run from the workspace root.

```
node living-manual/kit/bin/lm-watch.mjs <product> [--minutes <n>] [--no-heal]
```

For each doc scenario in turn it runs the gate (reset once, verify once) and the scenario. A failing scenario goes to the kit's healer agent; the guard (`lm-heal-guard.mjs`) then accepts the healer's change only when it touches locators and waits, and the scenario runs again. Any other change (an action added, removed or reordered, an assertion removed, inverted or changed, a filled value or a step title changed, a file added or deleted under `tests/`) is undone, the scenario is marked broken, a broken-scenario issue is filed, and its last published page stays on the site. Then it regenerates the outputs: facts pack, issues, the manual pages whose step record or screenshots changed, site and preview, the guide index, and the video of a changed scenario that already has one and is still confirmed.

The time limit is the product's `limits.runMinutes` (or `--minutes`); the healer gets at most `limits.healMinutes` (default 15) per scenario. At the limit it stops whatever runs, undoes an unfinished repair, and lists the rest as not reached.

Read `living-manual/products/<product>/build/watch/report.md` and tell the user:

| Section | Tell the user |
|---|---|
| Changed | each scenario and its first changes (a label `… → …`, a screenshot changed). A confirmed scenario whose label changed stays confirmed |
| Healed | each scenario and the files the healer changed. Its confirmation lapsed: the writer must confirm it again |
| Broken | each scenario, the reason and the issue path. The writer decides whether the change is intended |
| Not reached | the scenarios the time limit cut off; offer a rerun with a longer `--minutes` |
| Outputs | the pages, videos and guide index that were regenerated |

| Exit | Meaning |
|---|---|
| 0 | every scenario ran, none broken |
| 1 | a scenario is broken, or parity failed (nothing ran) |
| 4 | the time limit stopped the watch; none of the scenarios it ran is broken |

Another run holding the lock makes it wait (`lock: waiting …`); let it wait. Never confirm a scenario yourself: only the writer confirms (`lm-writer-session`).

Done when you have reported every section of the report and the exit code.
