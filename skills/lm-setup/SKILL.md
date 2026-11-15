---
name: lm-setup
description: Set up the Living Manual kit for one product in this workspace, one question at a time.
disable-model-invocation: true
---

Setup turns the installer's answers into the product's section of `living-manual/living-manual.config.json`, which every other `lm-*` stage reads. `living-manual/kit/bin/lm-setup.mjs` does the reading and writing; you hold the **interview**. Run every command from the workspace root.

## 1. Detect

Ask the installer for the product's id (lower-case, e.g. `shop`) unless they gave it. Then run:

```
node living-manual/kit/bin/lm-setup.mjs detect <product>
```

It prints JSON: `context` (glossary, ADR and tracker locations from the Matt Pocock configuration) and `questions`, eight of them, in order.

- `context.ok` is false: tell the installer `context.message` word for word and stop. They run `setup-matt-pocock-skills`, then setup again.
- `otherProducts` is non-empty: say that this run adds or updates only `<product>` and leaves the others as they are.

Done when you hold the detect output and `context.ok` is true.

## 2. Interview

Walk `questions` in order. A question with `ask: false` is answered by its `detected` value: show it in one line ("Repos: shop-web, shop-api, from the config") and move on. Ask each `ask: true` question on its own, one per turn:

- Call `AskUserQuestion` with the question's `question` and its three `options` as given (labels verbatim; the first carries "(Recommended)"). The tool adds the free-text choice itself. Outside Claude Code, number the three options and invite a free answer.
- A picked option's `answer` is the answer. A free-text answer: turn it into the same shape as the options' `answer`, read it back in one line, and ask whether that is right.
- An option whose `answer` is null means "answer in your own words": ask for the words.
- `demoData` has a second part, `confirm`: ask it right after the origin, as its own question, every time, even when the origin was detected. Never answer it for the installer.
- **Secrets** (passwords, tokens, cookie values) never enter the conversation. Ask only for the *name* of the environment variable that holds each one, and remind the installer to set it in their shell.

Merge every answer into one JSON object (the shapes nest: `{ "environment": { … }, "demoData": { … }, … }`). Done when every `ask: true` question, and the `confirm`, has an answer the installer accepted.

**Stop the interview at once** when the installer says the demo data is a copy of customer data, or does not answer yes to the ownership confirmation. Say why: the kit runs only on synthetic data, in a database nothing else uses. Write nothing.

## 3. Write

Save the merged answers to a scratch file and run:

```
node living-manual/kit/bin/lm-setup.mjs write <product> --answers <file>
```

| Exit | Last line | Then |
|---|---|---|
| 0 | `setup OK: wrote product "<product>" to …` | Step 4 |
| 2 | `setup refused the answers:` and one line per problem | Ask again only the questions those lines name, then write again |
| 3 | `setup stopped: …` (data safety) | Tell the installer the line; stop |
| 4 | `setup stopped: … run setup-matt-pocock-skills first …` | Tell the installer the line; stop |

## 4. Agents and environment

```
node living-manual/kit/bin/lm-agents.mjs init
node living-manual/kit/bin/lm-setup.mjs check <product>
```

`init` writes Playwright's planner, generator and healer agents into the kit's Playwright project and applies the kit's patch to them (`agents OK: …`). `check` starts the product, resets and verifies the demo data under the product's run lock, waiting while a run holds it (`setup check PASS`). `setup check FAIL: <step> failed` → tell the installer which command failed; the section is written, the environment is not ready. When the commands answer named a script that does not exist yet, say it must be written, and skip `check`.

## 5. Hand over

Tell the installer, in a few lines: the section was written; the environment variables they must set (every `…Env` value in the answers); the result of `check`; and the next stage, collecting the cases: `/lm-collect`.
