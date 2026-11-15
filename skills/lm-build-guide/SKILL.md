---
name: lm-build-guide
description: Build the Living Manual guide (index and script) for one product and show it answering questions and highlighting in the local product.
disable-model-invocation: true
---

The guide is one script the product loads with one line: a help button, a panel with a question box and the tested tasks, and a highlight that marks each recorded action in the real product while the user does the clicking. It is built from the step records (the facts pack's, overlaid by `build/runs/`). Run every command from the workspace root.

## 1. Build

```
node living-manual/kit/bin/lm-build-guide.mjs <product>
```

It writes `build/guide/guide-index.json` and `build/guide/lm-guide.js` and prints one line per scenario, then the line that loads the guide.

- Only confirmed scenarios whose run passed go in. A line `<ID>: draft (…), left out` means the writer has not confirmed the scenario, `<ID>: broken (…), left out` that its confirmation lapsed; say so to the user. Add `--include-drafts` only for a demonstration, and say the index then holds drafts.
- `guide: 0 scenario(s)`: no step record, or none confirmed. Run `lm-run` first, or confirm scenarios.

Done when the index lists the scenarios you expected.

## 2. Show it in the local product

```
node living-manual/kit/bin/lm-guide-serve.mjs <product> [--include-drafts]
```

It serves the product at `http://localhost:<guide.port><base path>` with the loading line added to its pages (decision 0002 in the product folder). The product's own port is unchanged. Give the user that address; it runs until stopped.

It also serves the question endpoint (`POST /lm-guide/match`, decision 0004) when the config has `guide.match` and `guide.session`. Its first line says which model client answers:

- `through the Anthropic SDK`: the variable `guide.match.keyEnv` is set in this shell. Never print or copy the key.
- `through the claude CLI`: no key; questions go to the local `claude` with the user's own login. Each takes a few seconds.

Build the manual first (`lm-manual`, `lm-publish`): the no-answer message links the closest page, served at `/lm-manual/` from `build/site`, or from `build/preview` with `--include-drafts` (say the link then points at drafts). Questions with no tested answer collect in `build/guide/unanswered.jsonl`; `node living-manual/kit/bin/lm-issues.mjs <product> after-run` files them as one issue.

## 3. Test

The guide tests drive the live product, so they hold the run lock:

```
node living-manual/kit/bin/lm-lock.mjs <product> -- sh -c 'cd living-manual/kit && npx playwright test --project=<product>-guide'
```

`LM_GUIDE_EVIDENCE=<dir>` saves a screenshot of every highlight step and, for the question tests, `t2.1-questions.json` (each question and the scenario it selected). The question tests call the model, so they need a key or a signed-in `claude`. The tests live in `living-manual/products/<product>/guide-tests/` and import `living-manual/kit/src/guide-test.ts`.

## Reference

- Product config `guide`: `port`, `role` (stands in for the signed-in user's role), `routeKeys` (query keys that name a screen: `"value"` or `"presence"`), `match` (`model`, `keyEnv`, optional `cli`), `session` (`cookie`, `header`, `validate`, `forward`).
- The endpoint takes exactly `{ question, screen, role }` (400 for anything else) and refuses a request without a signed-in session (401).
- In a real product the product adds the printed line to its own HTML and fills in the user's role; the proxy is for the demonstration.
