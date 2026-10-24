---
name: openscreen
description: Edit, polish and export OpenScreen screen recordings from the command line, including the 3D iPhone mockup. Use when asked to "use openscreen", to make a demo or video "world class", to make a 3D phone mockup or promo, or to edit, polish or export a recording (a `.openscreen` bundle).
---

# OpenScreen

You drive OpenScreen through its agent CLI: every command prints one JSON
object. `AGENTS.md` in the checkout is the full reference (every command, op,
time rule, recipe and warning); read its "3D phone" section before the first
3D edit, and look things up there instead of guessing.

## Step 0: find and prepare the CLI

This skill is a symlink and you are usually in another project's folder, so
find the checkout from this file's real path. Use the line for the home this
skill was loaded from:

```sh
OS="$(cd "$(dirname "$(realpath ~/.claude/skills/openscreen/SKILL.md)")/../.." && pwd)"
OS="$(cd "$(dirname "$(realpath ~/.codex/skills/openscreen/SKILL.md)")/../.." && pwd)"
A="node $OS/electron/scripts/openscreen-agent.mjs"
$A ops | grep -q '"phone3d"' && $A ops | grep -q '"direct"' && $A help | grep -q '"frames"' && echo READY
```

Done when it prints `READY`. If not, `dist/` is missing or old: run
`npm --prefix "$OS/electron" run build` once and check again. If it still
does not print `READY`, stop and report the output. Then read `$OS/AGENTS.md`.

## Step 1: pick the recording

"This" means, in order: a bundle path the user pasted (from **File → Copy
Path for Agent**), else a `.openscreen` path earlier in the conversation, else
`latest`. Say which bundle you picked, by name and full path, before the first
edit. Set `B` to it.

## Step 2: the loop

Run these in order. Each step is done when its check holds.

1. `$A info $B` — note `source.kind`, `outputDuration`, the taps, waits and
   `phone3d`. 3D steps (4, 5, 8) need `source.kind: "iosDevice"`; skip them
   for other recordings.
2. `$A review $B` — **open every `review/sheet-*.png`** and say in one line
   what the recording shows and where its best moments are (source seconds).
3. `$A polish $B --style clean` (add `--title` / `--subtitle` when you know
   the product) — cuts dead air and speeds up waits. Times change: re-run
   `info` and work in **output seconds** from here on.
4. `$A direct $B --style hero` — `bold` for promos, `subtle` for tutorials.
   Read each `shots[].reason`.
5. `$A frames $B --moves --sheet --draft` — **open `sheet.png`** and judge it
   against the checklist below. Each file's `facing` must be near 1 at every
   tap time.
6. Fix what you saw with one `$A apply $B '[…]'` per round: `setPose`,
   `editTransition`, `shot`, `removeTransition`, a `phone3d` setting, or a
   warning's `fix` list as it is. Go back to 5 until the sheet passes.
7. `$A validate $B` — done when `problems` is `[]` and `warnings` is `[]`,
   or every remaining warning is one you can explain in a sentence to the
   user. Apply each `fix` that exists.
8. `$A frames $B --moves --sheet` — full quality (motion blur,
   anti-aliasing): **open `sheet.png`** once more.
9. Export: `$A export $B --out /abs/out.mp4`, or `--preset social-9x16,…
   --out /abs/folder` for socials. For the 4K hero file on a layout preset,
   first `$A apply $B '[{"op":"exportSettings","preset":"uhd4k"}]'` and check
   `info.export.canvas`.
10. `$A review /abs/out.mp4` — **open its sheets**. Done when what viewers
    see passes the checklist; otherwise go back to 6.

Report: the bundle, the shots and their reasons, the fixes you made, the
final warnings (0), and the output path.

## World-class checklist

- The screen faces front at every tap (facing near 1), readable.
- One idea per move; nothing moves while something happens on screen.
- Moves sit in waits or at scene changes.
- The intro is under 1.8 s; at most about a third of the runtime moves.
- Springs for settles and landings, cinematic for big turns.
- Motion blur on for the export; 0 warnings.
- 4K only for the hero file.

## Recipes and easing

| Recipe | Use it for |
|---|---|
| `spin-in` | the intro, before the first tap |
| `settle` | a gentle intro, or any intro under 2 s |
| `hero-layback` | a wait of 2.4 s or more; with `"return":"stay"` as the outro |
| `turn-to-back` | a long wait (4.5 s or more) or a scene change; bold promos |
| `float` | calm tutorials (idle drift, no moves) |

`info.shotRecipes` has each one's length and summary. Easing: `spring` for
anything that lands (180/18 = one soft overshoot; `fitDuration:true` fits the
length), `cinematic` for turns of 90° or more, `smooth` for small moves,
`linear` almost never.

## Rules

- Edit only with `apply` ops, `polish` and `direct`; `project.json` changes
  only through them.
- Times are output seconds after cuts. In one edits list, put
  `trim`/`cut`/`speed` first and write later times against the cut timeline.
- App Store layouts stay flat by design; use a social preset for 3D.
- An export renders 10-15× slower than real time: judge with `frames`, and
  export once at the end.
- `undo $B` swaps back the last `apply`, `polish` or `direct` (one level).
