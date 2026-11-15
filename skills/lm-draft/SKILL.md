---
name: lm-draft
description: Draft Living Manual doc scenarios for the first area from the case inventory or from the writer's material (a manual, plain text, their own Gherkin, a click recording), up to the scenario limit, with test code that passes parity.
disable-model-invocation: true
---

Draft turns the case inventory into **draft doc scenarios** (`scenarios/<area>.feature`) and their test code (`tests/<area>.spec.ts`) for the product's first area, never more than `limits.scenariosPerRun` per run. Run every command from the workspace root. The inventory comes from `lm-collect`; run it first when `facts/cases.json` is missing.

## 1. Plan

```
node living-manual/kit/bin/lm-draft.mjs plan <product>
```

It prints one `draft <ID> <title> …` line per case to draft and one `not drafted: <title> (<case>): <reason>` per case left out (limit reached, outside the first area), and writes `facts/draft-plan.json` and `facts/draft-report.md`. Tell the user the last line and every `not drafted` line. Nothing to draft → stop.

## 2. Draft

```
node living-manual/kit/bin/lm-agent.mjs <product> planner --log <log> -- Draft the scenarios in facts/draft-plan.json.
```

The planner writes exactly the planned scenarios, each with a `Sources:` line and, when only `app` and `code` showed the case, `Note: no human text stated the intent.` (the writer session asks about those first). Then:

```
node living-manual/kit/bin/lm-draft.mjs check <product>
```

`draft PASS` → step 3. `draft FAIL` → each line names a scenario and the rule it breaks; a line `not in this run's draft plan` means a draft past the limit: remove that scenario. Resume the planner with the lines and check again.

## 3. Generate

```
node living-manual/kit/bin/lm-agent.mjs <product> generator --log <log> -- Write the specs for <IDs>.
node living-manual/kit/bin/lm-parity.mjs <product>
```

Done when parity prints `parity PASS` and `lm-run` (the `lm-run` skill) runs the new scenarios green. A scenario that will not go green: run the healer (`lm-agent … healer -- <IDs> fail`), which repairs locators and waits only and marks a behaviour change `@broken`.

Every drafted scenario stays `@draft` until the writer confirms it.

## Material from the writer

When the writer hands in material, draft from it instead of (or before) the planner:

```
node living-manual/kit/bin/lm-draft.mjs from <product> manual <folder|URL> --current "<who confirmed it is the live manual, when>"
node living-manual/kit/bin/lm-draft.mjs from <product> text <file>
node living-manual/kit/bin/lm-draft.mjs from <product> gherkin <file.feature>
node living-manual/kit/bin/lm-draft.mjs from <product> recording <codegen.ts> --title "<scenario title>"
```

Add `--role <role> --screen <start screen>` when the material does not name them (a recording never does). A recording comes from `npx playwright codegen <baseUrl>`; ask the writer to finish it with the recorder's "Assert text" or "Assert visibility" on what the user sees at the end.

Each draft lands in `scenarios/<area>.feature` with `Sources: <kind> <where>` (the page and heading, the text's lines, the Gherkin's line, the recording file), and every correction lands in `scenarios/<area>.corrections.json` (`rule`, `before`, `after`) for the writer session. Drafts count against `limits.scenariosPerRun`.

- `manual`: never fetch a manual from the product's own site without asking the user which manual is live (spec risk "Which manual is current"). Without `--current` every draft carries that open question.
- `open: <ID> …` lines are open questions; exit 1. Answer the ones you can from the material, else leave them for the writer session. Edit the `.feature` to match the answer.
- Then run `lm-draft check` (it refuses UI-level steps such as "I click the Save button") and go on with step 3.
