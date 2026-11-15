---
name: lm-ask
description: Ask which Living Manual skill fits your situation, or where a product stands and what comes next. A router over the lm-* skills.
disable-model-invocation: true
---

# Ask the Living Manual

Nobody remembers every stage, so ask. Answer in plain words: the person may be a writer, a developer or a product owner, not someone who knows the kit.

Before stating what a skill does, or that a step can be skipped, read that skill's `SKILL.md` in `.claude/skills/`. The summaries here are for orientation only. Run every command from the workspace root.

## 1. Where does the product stand?

When the question is about a product ("what's next?", "where are we?", "can we publish?"), look before you answer. Products are the keys of `products` in `living-manual/living-manual.config.json`; ask which one when there are several and the question doesn't say.

| Look at | It means |
|---|---|
| No section for the product in the config | Not set up: `/lm-setup` |
| `living-manual/products/<product>/facts/cases.json` missing | No case inventory: `/lm-collect` |
| No `.feature` file in `scenarios/` | No scenarios: `/lm-draft` |
| No `build/runs/<ID>/step-record.json`, or one whose `run.status` is not `passed` | Scenario not run, or failing: `/lm-run` |
| `node living-manual/kit/bin/lm-confirm.mjs <product> status` | `draft` → the writer hasn't confirmed: `/lm-writer-session`. `broken` → a mismatch or a changed flow waits for the writer |
| `build/site/` empty while scenarios are confirmed | Manual not built: `/lm-generate-manual` |
| No `build/videos/<ID>.mp4` for a confirmed scenario | `/lm-generate-video` |
| `build/guide/guide-index.json` missing or older than the last confirmation | `/lm-build-guide` |
| Open issues labelled `living-manual` in the tracker (`docs/agents/issue-tracker.md` says where) | Work for people: broken scenarios, missing cases, missing test IDs, product bugs, unanswered guide questions |

Say where the product stands in two or three sentences, then the one next step and **who** takes it: a developer, the kit, the writer, or a reader.

## 2. The main flow: product → published manual

The route every product travels. The kit does the legwork; the writer makes every decision.

1. **`/lm-setup`**: a developer answers eight questions, once per product. The demo data must be synthetic, in a database only the kit uses; the installer answers that, never you.
2. **`/lm-collect`**: the kit lists every task a user can perform.
3. **`/lm-draft`**: the kit writes the first area's tasks as plain-English scenarios, with their test code. The writer may hand in an old manual, notes, Gherkin or a click recording as the starting point.
4. **`/lm-run`**: the kit runs them in the real product on demo data and records what happened. Repeat until they pass.
5. **`/lm-writer-session`**: the writer decides (page types, readers, task boundaries, words, mismatches) and confirms. **Nothing is published before this, and AI never confirms.**
6. **`/lm-generate-manual`** and **`/lm-generate-video`**: the manual and one narrated video per confirmed scenario. Before confirmation they build only drafts (a preview, `--draft-preview` videos), clearly marked as drafts.
7. **`/lm-build-guide`**: the in-product helper, from confirmed scenarios.

Then the next area: back to step 3.

## 3. On-ramps

- **A new product release** → **`/lm-watch`**. It reruns every scenario: a changed label flows into the manual by itself; a changed flow is marked broken and goes back to the writer at step 5.
- **Issues piling up** → read them first. A missing case goes to `/lm-draft`; missing test IDs and product bugs go to the developers; a broken scenario goes to `/lm-writer-session`; unanswered guide questions show which tasks readers want next.
- **The writer has an old manual** → `/lm-draft` with it as material, not `/lm-collect` alone.
- **"Can I show it before it's confirmed?"** → yes, as a draft: the preview, `--draft-preview` videos, `/lm-build-guide --include-drafts`. Say it is a draft every time.

## 4. Not built yet

The spec plans these; say so if someone asks for them, and don't improvise them:

- **Further languages**: English first, then one run per language the writer chose, with a reviewer per language.
- **`/lm-retro`**: at the end of a session, proposes improvements to the glossary, decision records, recommended answers and the kit itself, one at a time, for a person to approve.

## 5. Who does what

| Person | Takes |
|---|---|
| Developer | `/lm-setup`, the environment commands, test IDs, starting `/lm-watch` on each release, product bugs |
| Writer | `/lm-writer-session`, the prose that explains concepts, every confirmation |
| Test reviewer (optional) | reads the generated test code; advice, not a gate |
| The kit | collect, draft, run, generate, watch, guide |
| Readers | the manual, the videos, the guide |
