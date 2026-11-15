---
name: lm-collect
description: Collect every case a user can perform in a product into the Living Manual case inventory.
disable-model-invocation: true
---

Collect turns a product's sources and the running product into the **case inventory**: `living-manual/products/<product>/facts/cases.json` (written by the planner) and `facts/cases.md` (what is and is not yet covered by a doc scenario). The planner agent does the reading and exploring; you start it and check what it wrote. Run every command from the workspace root.

## 1. Agents ready

```
node living-manual/kit/bin/lm-agents.mjs apply
```

`agents OK` → go on. `agents FAIL: … does not apply` → Playwright was upgraded: run `lm-agents.mjs init` once; if it still fails, the kit's agent changes need merging by hand into the new stock files, then `lm-agents.mjs make-patch`. No agent files yet → `lm-agents.mjs init`.

## 2. Explore

Ask the user for the product unless named. Then start the planner in the background:

```
node living-manual/kit/bin/lm-agent.mjs <product> planner --log <log> -- Collect the case inventory for every area; draft nothing.
```

`lm-agent` takes the product's **run lock**, resets the demo data and starts the agent only after verify passes: exploration is a run, because the model sees the screen. Its last line is `agent planner done: exit N` or `agent refused: verify failed …` (exit 3: tell the user, reset with `lm-env.mjs <product> reset`, and stop).

Done when the agent exited 0.

## 3. Check

```
node living-manual/kit/bin/lm-collect.mjs <product>
```

`collect PASS: N case(s) …` → tell the user the counts and point at `facts/cases.md`. `collect FAIL` → each indented line names a case and what it lacks; resume the planner (`lm-agent … planner -- Fix facts/cases.json: <the lines>`) and check again.

Done when collect prints `collect PASS`.

Drafting the scenarios is `lm-draft`.
