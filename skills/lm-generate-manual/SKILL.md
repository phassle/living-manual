---
name: lm-generate-manual
description: Build a product's Living Manual (Markdown pages, then the site and the preview) from its step records, prose files and page plan.
---

The manual is made in two steps, both run from the workspace root. `<product>` is the product's id in `living-manual/living-manual.config.json`, e.g. `shop`.

## 1. Pages

```
node living-manual/kit/bin/lm-manual.mjs <product>
```

It reads, from the product folder `living-manual/products/<product>/`:

- `page-plan.json`: every page, in reading order, with its type (`how`, `why` or `reference`) and its `slug`, which is the page's URL. The writer decides the type; the writer session writes this file. Never change a published slug; add the old one to the entry's `formerly` instead.
- the step records: a how page per scenario that ran and passed, from `build/runs/<ID>/`, or, on a machine without runs (the writer's), from the facts pack (`facts/step-records/`, `facts/screenshots/<ID>/`).
- `prose/<feature>.md`: the writer's text. Each `## Heading` is a section that a why page, a reference page or a `@manual` scenario's how page names.

It writes `<slug>.md` per page, `assets/`, and `manual.json` to `publish.to`. Its last line is `manual: … how page(s) written to …; N page(s) from prose`. Exit 1 lists each problem above that line (a missing section, an unknown scenario, a failed run): fix the plan or the prose and run it again.

## 2. Site and preview

```
node living-manual/kit/bin/lm-publish.mjs <product>
```

It builds `publish.site` (only pages that `isPublishable` allows, in `living-manual/kit/bin/lib/publishable.mjs`; a broken scenario keeps its last published page, line `<ID>: broken (…); its last published page is kept`) and `publish.preview` (every page, with drafts marked) through the adapter named in `publish.adapter`. Open `index.html` in either folder from disk; no server is needed.

Done when both lines `site: N page(s)` and `preview: N page(s), D draft(s)` are printed. Tell the writer the preview path and how many pages are still drafts.

## Rules

- Never run `lm-confirm.mjs … confirm` or set a prose file's `status: confirmed` yourself. Only the writer confirms, through the writer session (spec: Confirmation). `node living-manual/kit/bin/lm-confirm.mjs <product> status` shows each scenario as draft, confirmed or broken.
- A page you cannot build from a step record or a prose section does not get written by hand. Report what is missing instead.
