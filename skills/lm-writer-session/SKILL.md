---
name: lm-writer-session
description: Run the Living Manual writer session, the interview in which the writer makes every documentation decision for a product's manual and then confirms its scenarios.
disable-model-invocation: true
---

The writer session is grill-with-docs for documentation. You **interview**; the writer **decides**; `lm-writer-session.mjs` does the bookkeeping. It picks each question from the facts pack, writes each answer down the moment it is given (decision record, documentation glossary, page plan, scenario correction, bug issue, queue for the next run) and confirms the scenarios when the writer confirms. It reads files only, so the session needs no running product: never start the environment for it.

Run every command from the workspace root. `S` below is `node living-manual/kit/bin/lm-writer-session.mjs <product>`, where `<product>` is the product's id in `living-manual/living-manual.config.json` (e.g. `shop`).

## 1. Start

```
S start --writer <writer's name>
```

It builds the preview from the facts pack, queues the facts the pack lacks, and ends with `session: N question(s) to ask, K answered by decision records, …`. Tell the writer, in two or three plain sentences: how many questions there are, that the preview is open, and which earlier decisions it skipped (the `skipped … answered by decisions/NNNN-…` lines). Open the preview for them: `open <the preview: open … path>`. Show each `correction (…)` line: it is a change made to the writer's own scenario text.

Done when the writer has heard the count and has the preview open.

## 2. Ask, one question at a time

Loop until `next` says `question: null`:

1. `S next --json` gives `question` (`key`, `type`, `text`, three `options`, the first recommended) and `show` (`previewPage`, `screenshots`, `corrections`).
2. When the question is about a page you have not shown yet, open its `previewPage` (`open <path>`) and say which screenshots belong to it. Show Gherkin only when the writer asks to see the scenario: then run `S show <ID>` and paste it.
3. Ask with **AskUserQuestion**: one question; the three options in the given order, the first label ending in ` (Recommended)`; the writer can always type their own answer. Put the question in plain words: the writer is not a developer. Keep the facts in the option labels; you may shorten a label, never change what it means.
4. Record the answer: `S answer <key> --choice <1|2|3>`, or `S answer <key> --text "<the writer's own words>"` for free text. Tell the writer in one line what was written (the CLI prints it: `decision: …`, `glossary: …`, `scenario corrected: …`, `bug issue: …`, `queued for the next run: …`).

While the writer talks, **challenge their words**: when they use a word for something in the product that the glossaries may name differently, run `S term "<word>"`. If it prints `question … added`, that term question comes next.

Done when `next` returns `question: null`.

## 3. Summary and confirmation

```
S summary
```

Show the summary as it is printed. Point at the "Skipped" section: each line names the decision record that answered a question, so the writer can say when one no longer holds (then mark that record `superseded by NNNN`, and the question returns next session). Then ask with AskUserQuestion whether they confirm: (1) "Yes, I confirm (Recommended)", (2) "No, change something first", (3) "Not now: keep everything a draft".

Only on (1), and only with the name the writer gave:

```
S confirm --by <writer's name>
```

Done when `confirm` has printed one `<ID>: confirmed by …` line per scenario it confirmed, and you have told the writer which stayed draft or broken and why. On (2), take their change as a free-text answer or a `term` check, then show the summary again.

## Rules

- **The writer decides.** Confirm only after the writer chose "Yes, I confirm" in this session. Never answer a question for the writer, never choose an option they did not choose, and never run `lm-confirm.mjs` yourself.
- **Facts come from the pack.** When the writer asks something the pack cannot answer, say so, and record their answer as free text: on a mismatch or boundaries question the CLI queues it in `facts/queue.json` for the next run. Carry on with the next question.
- The codebase glossary belongs to the developers: terms go to the product folder's `GLOSSARY.md` through `answer`, and nowhere else.
- A rehearsal (a session with scripted answers, to test the session) runs on a throwaway copy of the product folder, never the real one, and its confirmation is labelled a rehearsal.
