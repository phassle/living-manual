# Living Manual kit

> **Proof of concept.** A personal experiment, not a product: no company supports or maintains it. Use it as a template, make your own copy, and adapt it.

A skill pack that writes and keeps a product's user manual, a narrated video per task and an in-product guide, from doc scenarios that run against the product. The pack is the **single source of truth** for the kit: a workspace holds an installed copy, and every change to the kit is made here and installed again.

The pack knows no product. Everything about a product lives in the workspace: its section of `living-manual/living-manual.config.json` (written by `/lm-setup`) and its folder `living-manual/products/<product>/`.

**Installing with an agent?** Read [Install into your own repository](#install-into-your-own-repository) and follow it top to bottom. Each step ends with how you know it is done.

**Lost, or not sure what comes next?** Type `/lm-ask` in the workspace. It looks at where a product stands and says the next step and who takes it.

## How it works: who does what

The product's code and the writer's knowledge go in; a manual, a narrated video per task and an in-product guide come out. The kit does the legwork, the writer makes every decision, and nothing is published until the writer has confirmed it. AI never approves its own work.

![Who does what: a developer runs setup; the kit collects, drafts and runs; the writer decides and confirms; only confirmed scenarios pass to generate, watch and guide; readers use the manual, videos and guide](docs/who-does-what.svg)

Paths are relative to the product folder `living-manual/products/<product>/`.

| Step | Who | What happens | Document produced |
|---|---|---|---|
| 1 Setup | Developer, once per product | Answers eight questions (product, sources, a database the kit owns); the kit detects the rest | The product's section of `living-manual/living-manual.config.json` |
| 2 Collect | Kit | Reads the code, existing manuals and the running product; lists every task a user can perform | Case inventory: `facts/cases.md`, `facts/cases.json` |
| 3 Draft | Kit; the writer may hand in a manual, plain text, Gherkin or a click recording | Writes each task as an intent-level scenario in plain English, and a prose file for concepts and business rules | Doc scenarios `scenarios/<feature>.feature` (Gherkin), prose `prose/<feature>.md` |
| 4 Run | Kit, on demo data under the run lock | Turns each scenario into a Playwright test, runs it and records what the product actually did | Test code `tests/<feature>.spec.ts`; step records and screenshots in `facts/`; the facts pack `facts/pack.md` (matches, mismatches, unknown terms) |
| 5 Writer session | The writer decides; AI asks one question at a time with a recommended answer | Page type, reader, task boundaries, words, and who is right when text and product disagree; ends when the writer confirms | Decision records `decisions/NNNN-<slug>.md`, the documentation glossary `GLOSSARY.md`, and a confirmation (who, when, fingerprint) on each scenario |
| 6 Generate | Kit, confirmed scenarios only | Builds the manual (how, why and reference pages, with search) and one narrated video per task | The site `build/site/`, videos `build/videos/<ID>.mp4` with captions. Drafts go to `build/preview/` and `build/preview-videos/` only |
| 7 Watch | Developers start it on each release candidate; the kit runs it | Reruns every scenario. A changed label flows into the manual; a changed flow is marked broken and goes back to the writer | Change report; issues in the workspace's tracker (broken scenario, missing case, missing test IDs, product bug) |
| 8 Guide | Kit builds it; users use it | A help button in the product picks a tested task from the user's question and highlights each element to use. It never clicks for the user | Guide script and guide index; unanswered questions filed as one batched issue |

A test reviewer (QA) may review the generated test code. That review is advice, not a publishing gate.

The documents fall in three groups:

- **Working papers**, kept in the product folder and never shown to readers: configuration, case inventory, scenarios and prose, test code, step records, facts pack, decision records, glossary.
- **Published outputs**, built only from confirmed scenarios: the manual site, the videos, the guide.
- **Feedback** to people, as issues: broken scenarios, missing cases and test IDs, product bugs found in mismatches, guide questions with no tested answer.

The writer stops taking screenshots and writing click-by-click steps; they answer the session's questions, write the prose that explains concepts, and return only when a flow changes. Developers run setup once, add test IDs where the kit asks for them, start a watch run per release candidate and fix the bugs the issues report.

## Install into your own repository

The **workspace** is the repository you install into. Run every workspace command from its root. The product's code sits in top-level folders of the workspace (each with a `.git`, `package.json`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `build.gradle` or a `.sln`/`.csproj`); setup offers those folders as the product's repos.

### What the workspace must have

Check each row before step 1. A missing row stops a later step; the last column says which.

| Need | How to check | Missing → |
|---|---|---|
| Node 20 or later | `node -v` | install fails |
| Claude Code in the workspace | `claude --version` | the stage skills cannot run |
| Agent configuration: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md` | `ls docs/agents/` | setup stops (exit 4). See [Agent configuration](#agent-configuration) |
| The product runs locally with demo data, from four commands: start, reset, verify, stop | run them | setup's check fails. See [Environment commands](#environment-commands) |
| A database **only the kit uses**, holding **synthetic** demo data, no personal data | ask the person who owns it | setup stops (exit 3). A copy of customer data is never allowed |
| A test user, with any secret in an environment variable | the variable is set in the shell | runs cannot sign in |
| Videos only: `ffmpeg` and `ffprobe`, and an ElevenLabs key in `ELEVENLABS_API_KEY` (or a file named by `ELEVENLABS_KEY_FILE`) | `ffmpeg -version` | `/lm-generate-video` stops. The default path is `/opt/homebrew/bin/`; set `FFMPEG` and `FFPROBE` elsewhere |
| Guide questions only: `ANTHROPIC_API_KEY` set, or the `claude` CLI signed in | `claude -p "hi"` | the guide's question box gets no answers |

Never paste a key or password into a file, a commit or the conversation. Name the environment variable that holds it.

### Steps

1. **Get your own copy of the pack.** This repository is a template: on GitHub choose **Use this template → Create a new repository** (or fork it), then clone *your* copy next to the workspace: `git clone <your copy's URL> living-manual-kit`. Your copy is where the kit's own improvements land (`/lm-retro` writes product-neutral ones there); offer the ones useful to everyone back to the template as a pull request. Done when `living-manual-kit/install.mjs` exists and `git remote -v` names your copy.
2. **Install.** From the pack: `node install.mjs <workspace>`. It copies `kit/` to `<workspace>/living-manual/kit/` and each `skills/lm-<stage>/` to `<workspace>/.claude/skills/lm-<stage>/`; the workspace's configuration, product folders and other skills stay as they are. Done on `install OK: …`.
3. **Dependencies.** In `<workspace>/living-manual/kit/`: `npm ci`, then `npx playwright install chromium`. Run `npm ci` again after every reinstall: an updated `package.json` is not installed by itself. Done when both exit 0 and `npm test` there reports `fail 0`.
4. **Ignore build output.** Add these lines to the workspace's `.gitignore`: `/living-manual/**/node_modules/`, `/living-manual/products/*/build/`, `/living-manual/kit/.playwright-mcp/`, `/living-manual/kit/test-results/`. Everything else under `living-manual/` is versioned, including the facts and their screenshots. Done when `git status` lists none of those folders.
5. **Setup.** Ask the person to type `/lm-setup` in Claude Code in the workspace (the stage skills are user-invoked; if you cannot invoke one, read its `.claude/skills/lm-<stage>/SKILL.md` and follow it). Setup asks eight questions one at a time: the repos, the sources to start from, the environment commands, where the demo data comes from and whether the kit owns the database, how the test user signs in, the first area to document, the writer (and an optional test reviewer), and where to build the manual. The **person** answers the data questions; never answer them for them. Done on `setup OK` followed by `setup check PASS`.
6. **Add what setup does not ask.** Edit the product's section in `living-manual/living-manual.config.json` by hand; see [Sections setup does not write](#sections-setup-does-not-write). Done when `node living-manual/kit/bin/lm-setup.mjs check <product>` still passes.
7. **Hand over.** Tell the person the environment variables they must set (every `…Env` value in the section), that the next stage is `/lm-collect`, and that `/lm-ask` tells them where they stand at any point. Then the stages follow in the order of the table below.

`node install.mjs <workspace> --check` (from the pack) compares the installed copy with the pack and changes nothing: `install check OK` means byte for byte equal, outside `node_modules`.

### Agent configuration

Setup reads three files to find the workspace's glossary, decision records and issue tracker. If the workspace has the `setup-matt-pocock-skills` skill, run it; otherwise write the files by hand. Setup reads only backticked paths:

- `docs/agents/issue-tracker.md`: starts with `# Issue tracker: <kind>` and names the issue folder in backticks, e.g. `` `.scratch/<feature>/issues/` ``. The kit files its issues there.
- `docs/agents/domain.md`: names the glossary in backticks (`` `GLOSSARY.md` `` or `` `GLOSSARY-MAP.md` ``) and the decision-record folder (a path ending `adr/`). The kit reads both and never writes them.
- `docs/agents/triage-labels.md`: the labels the tracker uses. The kit adds `needs-triage` and its own `living-manual` label to every issue.

Done when `node living-manual/kit/bin/lm-setup.mjs detect <product>` prints `"ok": true` under `context`.

### Environment commands

The kit never starts or seeds the product itself; it calls four commands named in the config, from the workspace root. Write them as a script in the product folder (setup's option `node living-manual/products/<product>/env/env.mjs start|reset|verify|stop`), as npm scripts or as make targets.

| Command | Must | Exit |
|---|---|---|
| `start` | bring the product up at the base URL, on the kit's database | 0 when the product answers |
| `reset` | put the kit's database back to exactly the demo data | 0 when done |
| `verify` | check that the database the product uses is the kit's and holds only demo data | 0 only then; anything else stops every run |
| `stop` | shut down what `start` started | 0 |

Every run calls `verify` first and runs nothing when it fails; `reset` runs before every scenario. Two runs on unchanged code must give identical screenshots, so the demo data must not depend on today's date.

### Sections setup does not write

Add these to the product's section by hand. Keys ending in `Env` hold the **name** of an environment variable, never its value.

```json
"environment": {
  "viewport": { "width": 1440, "height": 900 },
  "clock": { "time": "2026-01-05T09:00:00+01:00", "timezone": "Europe/Berlin" },
  "productVersion": { "css": ".app-version", "pattern": "^v?(\\S+)" }
},
"video": {
  "voice": { "id": "<licensed ElevenLabs stock voice id>", "name": "<voice name>", "model": "eleven_multilingual_v2" },
  "keyEnv": "ELEVENLABS_API_KEY",
  "keyFileEnv": "ELEVENLABS_KEY_FILE"
},
"guide": {
  "port": 4100,
  "role": "<the role the demo user has>",
  "routeKeys": { "<query key that names a screen>": "value" },
  "match": { "model": "claude-haiku-5-5", "keyEnv": "ANTHROPIC_API_KEY" },
  "session": { "cookie": "<session cookie>", "header": "<token header>", "validate": "<URL that validates a session token>" }
},
"publish": { "searchExample": "<a task readers search for>" },
"idPrefixes": { "<area>": "<scenario ID prefix, e.g. ORD>" }
```

- `clock` fixes the browser's date in every run; `productVersion` tells a run where the product shows its version.
- `video` is needed only for `/lm-generate-video`.
- `idPrefixes` is optional: by default an area's scenario IDs take the area's letters ("Work orders" → `WORKORDERS-01`).
- `guide` is needed only for `/lm-build-guide`. `match` and `session` turn on the question endpoint; it accepts only signed-in users.

## Stages

One user-invoked skill per stage, in the order a product meets them:

| Skill | Stage |
|---|---|
| `/lm-ask` | not a stage: where a product stands, the next step and who takes it, and which skill fits a situation |
| `/lm-setup` | eight questions; writes the product's config section, initialises the Playwright agents, checks the environment |
| `/lm-collect` | the case inventory: every case a user can perform |
| `/lm-draft` | intent-level doc scenarios for the first area, and their test code |
| `/lm-run` | runs the scenarios under the run lock; step records, screenshots, facts pack, issues |
| `/lm-writer-session` | the writer's decisions and confirmations |
| `/lm-generate-manual` | the manual pages, the site and the preview |
| `/lm-generate-video` | a narrated video per scenario |
| `/lm-watch` | after a product change: rerun, heal locators and waits, regenerate, report |
| `/lm-build-guide` | the in-product guide: index, script, question endpoint |

Each skill says what it needs, what it runs and when it is done. Every command-line tool in `living-manual/kit/bin/` has its usage at the top of the file.

## What is in the pack

- `kit/`: the kit's own Playwright TypeScript project (`src/`, `playwright.config.ts`), its command-line tools (`bin/lm-*.mjs`), the publish adapter `adapters/static-site/`, the guide script `guide/`, and its tests (`npm test` in `kit/`).
- `kit/agents/kit.patch`: the kit's changes to Playwright's planner, generator and healer agents. Playwright rewrites the agents on every upgrade; `node bin/lm-agents.mjs init` in the kit writes them and applies the patch again. When the patch no longer fits, merge by hand and run `make-patch`.
- `skills/`: the stage skills above.
- `install.mjs`: the installer.
- `bin/check-generic.mjs`: the genericity check.
- `docs/who-does-what.svg`: the diagram above.

## Change the kit

1. Edit here, in the pack.
2. `npm test`: the pack's tests, then the kit's. Done when both report `fail 0`.
3. `node bin/check-generic.mjs --workspace <workspace>` against every workspace the kit is installed in. It hunts the product words that workspace's configuration and product folders name (ids, names, repos, areas, people, databases, ports, cookies, scenario ID prefixes, and each product folder's `private-terms.txt`). Done on `generic OK`. A hit means a product fact sits in the pack: move it to the config or the product folder.
4. `node install.mjs <workspace>` for each workspace, then `--check`.
