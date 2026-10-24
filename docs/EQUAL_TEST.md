# The equal test (judged)

**Question:** can an agent with only the `openscreen` skill and the CLI make a
3D phone video as good as a person makes in the editor?

This is part (c) of the equal test (SPEC §6.6). Parts (a) and (b) are
automatic: `electron/test/opsParity.test.ts` (every editor control has a
documented op) and the editor's replay log test. Run this judged part once,
after every work package is merged, on the merged build. Every gap it finds
becomes a missing op, flag or control and is fixed before the 3D phone ships;
then run it again.

## Pass rule

All three must hold:

1. **Score**: the agent's mean rubric score is no more than 0.5 below the
   person's (higher is a pass).
2. **Warnings**: `validate` on both final projects prints `"warnings": []`.
3. **No editor-only action**: the agent never needed something only the
   editor can do (see "Gaps" below).

## What you need

| Item | Value |
|---|---|
| Build | the merged branch, `cd electron && npm run build` |
| Recording | one real iPhone take of 30 s or more with taps and at least one wait. Default: a copy of `rec-1792855925414.openscreen` (never the original in `~/Movies/OpenScreen`) |
| Brief | exactly: **"Make a 15 s world-class 3D promo of this recording."** |
| Output | `social-9x16`, 1080×1920, the project's own frame rate |
| Person | Tyler, in the editor, **10 minutes** of editing (the export is not timed) |
| Agent | a fresh Claude Code or Codex session that has never seen this repo in its context, with the skill installed and nothing else; **45 minutes** cap |
| Judges | 3 model judges (different sessions, ideally 2 vendors) plus 1 person who did not edit either clip |

## Steps

### 1. Prepare (the operator, not the contestants)

```sh
R=/abs/path/to/checkout            # the repo
T=/tmp/equal-test-$(date +%Y%m%d)  # one folder for this run
mkdir -p "$T/person" "$T/agent" "$T/judging"
cp -cR ~/Movies/OpenScreen/rec-1792855925414.openscreen "$T/person/take.openscreen"
cp -cR ~/Movies/OpenScreen/rec-1792855925414.openscreen "$T/agent/take.openscreen"
node "$R/electron/scripts/install-skill.mjs"     # links the skill; prints the checkout it found
export OPENSCREEN_RECORDINGS_DIR="$T/agent"      # for the agent session only
```

Check both copies are identical (`diff -r`), and that `info` on each shows
`phone3d: null` (a flat start).

### 2. The person (10 minutes)

1. Open `$T/person/take.openscreen` in the editor (`open` command, or File →
   Open).
2. Start a 10-minute timer. Read the brief aloud. Edit with any control.
3. At 10 minutes stop editing. Export with the `social-9x16` preset to
   `$T/person/out.mp4`.
4. Run `validate "$T/person/take.openscreen"` and save the output as
   `$T/person/validate.json`.

### 3. The agent (45 minutes cap)

1. Start a fresh session with its working folder set to `$T/agent` (outside
   the repo).
2. Send this prompt, exactly, and nothing else until it finishes:

   > use openscreen, make this world class: a 15 s 3D promo of
   > $T/agent/take.openscreen (export it as the social-9x16 preset to
   > $T/agent/out.mp4)

3. Do not answer questions about the editor, give hints, or touch any file.
   If the agent asks the operator to do something, write down the question,
   answer "no", and count it in step 5.
4. When it stops (or at 45 minutes), save the whole transcript as
   `$T/agent/transcript.md`, and run
   `validate "$T/agent/take.openscreen" > "$T/agent/validate.json"`.

### 4. Judge blind

```sh
node "$R/electron/scripts/review3d.mjs" pairs \
  --a "$T/person/out.mp4" --b "$T/agent/out.mp4" \
  --labels person,agent --out "$T/judging"
```

This writes `$T/judging/index.html` (the two clips side by side as "Left"
and "Right", in an order fixed by a random seed), contact sheets of each clip
for model judges, `judge-brief.md`, `judge-template.json`, and `key.json`
(which side is which). **Move `key.json` out of `$T/judging` before any judge
sees the folder**, and keep it with the operator.

- **The person judge** opens `index.html`, scores both clips on every axis,
  picks the better one (or a tie), and saves the JSON with the page's button
  into `$T/judging/votes/`.
- **Each model judge** gets only `judge-brief.md`, the two contact-sheet
  folders and `judge-template.json`, and returns the filled template, saved
  as `$T/judging/votes/<judge>.json`. They see the frames, not the files'
  names.

Rubric: each axis 1 (poor) to 5 (would ship as is): silhouette, metal,
glass, screen sharpness at an angle, motion feel, spring, shadow, legibility
at taps, depth-of-field taste, would ship. A judge may add one line of notes
per clip.

### 5. Score and decide

```sh
mv /path/kept/key.json "$T/judging/key.json"
node "$R/electron/scripts/review3d.mjs" tally "$T/judging" --equal person,agent
```

`tally --equal` prints each side's mean score (over every axis and judge),
the difference, and `"pass": true|false` for rule 1. Then record rules 2 and
3 by hand in `$T/result.md`:

| | Person | Agent |
|---|---|---|
| Mean score (tally) | | |
| `validate` warnings | | |
| Time used | of 10 min | of 45 min |
| Editor-only actions | — | count, each with the transcript line |

## Gaps

A **gap** is any moment the agent could not do what the editor can:

- it asked the operator to click, drag or look at something in the editor
- it edited `project.json` by hand, or used `set` because no op existed
- an op, flag or command it needed was missing, refused a valid request, or
  did something other than AGENTS.md says
- AGENTS.md or the skill was wrong or silent about something it needed
- a judge's note names something the person's clip had that the CLI cannot
  make

Write each gap in `$T/result.md` with the transcript line, then fix it in the
code or the docs (a missing op gets an op, a parity row and a test case in
`opsParity.test.ts`). The test passes only when it is re-run after the fixes
and all three rules hold with no gaps left.
