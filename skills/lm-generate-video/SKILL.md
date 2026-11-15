---
name: lm-generate-video
description: Make the narrated video of a Living Manual scenario from its step record.
disable-model-invocation: true
---

`living-manual/kit/bin/lm-video.mjs` does the work; you run it, read its last lines and look at the film. Run every command from the workspace root. One scenario per run.

## 1. Preconditions

- The scenario has a passing step record: `living-manual/products/<product>/build/runs/<ID>/step-record.json` with `run.status` `passed`. If not, run it first: `node living-manual/kit/bin/lm-run.mjs <product> --grep <ID>`.
- An ElevenLabs key is reachable for clips not yet cached: `ELEVENLABS_API_KEY`, or `ELEVENLABS_KEY_FILE` naming a file that holds it (the product's `video.keyEnv` / `video.keyFileEnv` rename them). Pass the variable through; the key itself never enters the conversation, a file or a commit.
- `ffmpeg` and `ffprobe` (default `/opt/homebrew/bin/`; override with `FFMPEG` / `FFPROBE`).

Done when the step record has passed and the key variable is set (or the narration is unchanged, so every clip is cached).

## 2. Make the video

```
node living-manual/kit/bin/lm-video.mjs <product> --id <ID>
```

It narrates, voices (cached by hash), records a slowed run under the run lock (it waits, printing `lock: waiting …`, while another run holds the lock), checks sync, writes captions and mixes. About one minute plus the scenario's own reset.

| Exit | Last lines | Then |
|---|---|---|
| 0 | `mix: …/build/videos/<ID>.mp4 …` and `audio: N of N sentences heard …` | Step 3 |
| 0 | `<ID>: unchanged since … video kept` | Nothing changed; the film on disk is current. Pass `--force` only when asked to remake it |
| 1 | `video refused: …` or `no step record …` | Tell the user the line; it names the run to do first |
| 1 | `FAIL T1.12 …` with `OVERLAP` rows | A sentence was still playing when the next action started. Report the rows; the run's pacing is in `src/index.ts` (`Narrator`) |
| 1 | `FAIL T1.12 … lasted longer than their clip` with `STALLED` rows | The run stalled (the machine slept). Run the command again; nothing is voiced twice |
| 2 | `lm-video: set ELEVENLABS_API_KEY …` | Ask the user to set the variable in their shell |

A single stage reruns with `--stage narrate|voice|record|check|captions|mix`, each from the files the earlier stages left in `build/videos/<ID>/`.

**Draft preview.** Only a scenario the writer has confirmed gets a video. When the user wants to show an unconfirmed scenario anyway, add `--draft-preview`. The run must still have passed. Everything then goes to `build/preview-videos/` instead of `build/videos/`, and the title card and every caption say "Draft preview · not confirmed by the writer". Never call a draft preview the scenario's video, and never confirm a scenario to get one: only the writer confirms.

## 3. Look at it

Open the three stills in `build/videos/<ID>/stills/` (title card, a sentence mid-film with the pointer and ring on its element, the result) and read `build/videos/<ID>/narration.json`'s `text` lines. Done when the stills show the pointer on the element the caption names and every sentence reads as plain instruction a user would follow.

Outputs: `build/videos/<ID>.mp4` (H.264 + AAC, the window size plus a caption band), `<ID>.vtt` (WebVTT), `<ID>/sync-check.txt` (T1.12 verdict first, one row per sentence), `<ID>/timeline.json`.
