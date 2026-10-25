---
name: openscreen
description: Edit, polish and export OpenScreen screen recordings from the command line, including the 3D iPhone mockup. Use when asked to "use openscreen", to make a demo or video "world class", to make a 3D phone mockup or promo, or to edit, polish or export a recording (a `.openscreen` bundle).
---

# OpenScreen

You drive OpenScreen through its agent CLI: every command prints one JSON
object. `AGENTS.md` in the checkout is the full reference (every command, op,
time rule, recipe and warning); read its "3D phone" section before the first
3D edit, and look things up there instead of guessing.

## Commands are written out in full

Each shell tool call starts a new shell: a variable set in one call is empty
in the next. So every command in this skill is written with absolute paths:

- `<cli>` stands for `node /abs/…/electron/scripts/openscreen-agent.mjs`,
  exactly as Step 0 prints it after `READY:`.
- `<bundle>` stands for the bundle's absolute path from Step 1.

Write both out in every command, e.g.
`node /Users/me/openscreen/electron/scripts/openscreen-agent.mjs info /Users/me/Movies/OpenScreen/rec-1.openscreen`.
Keep the command in one word-list like this (no `$A`-style variable holding
`node …`): zsh, the macOS shell, runs such a variable as one program name.

## Step 0: find and prepare the CLI

You are usually in another project's folder, so nothing here assumes the
checkout is the current folder. The checkout is two folders above this
file's real path (`<checkout>/skills/openscreen/SKILL.md`). Before you run
the block, put the path you read this file from into its first line (Claude
Code shows it as the skill's base directory; add `/SKILL.md`). Leave it `''`
when you do not know it: the block then tries the installed skill for each
tool, one line each, then the current folder's git checkout.

Run the block as one call (it works in zsh and bash, from any folder):

```sh
SKILL_MD=''   # the path you read this SKILL.md from; '' if you do not know it
OS=''
[ -n "$SKILL_MD" ] && [ -e "$SKILL_MD" ] && OS="$(cd "$(dirname "$(realpath "$SKILL_MD")")/../.." && pwd)"
[ -z "$OS" ] && [ -e ~/.claude/skills/openscreen/SKILL.md ] && OS="$(cd "$(dirname "$(realpath ~/.claude/skills/openscreen/SKILL.md)")/../.." && pwd)"
[ -z "$OS" ] && [ -e ~/.codex/skills/openscreen/SKILL.md ] && OS="$(cd "$(dirname "$(realpath ~/.codex/skills/openscreen/SKILL.md)")/../.." && pwd)"
[ -z "$OS" ] && G="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -e "$G/electron/scripts/openscreen-agent.mjs" ] && OS="$G"
CLI="$OS/electron/scripts/openscreen-agent.mjs"
ready() { [ -n "$OS" ] && node "$CLI" ops | grep -q '"phone3d"' && node "$CLI" ops | grep -q '"direct"' && node "$CLI" help | grep -q '"frames"'; }
[ -z "$OS" ] || ready || { echo "building $OS/electron/dist (once)"; npm --prefix "$OS/electron" run build > "${TMPDIR:-/tmp}/openscreen-skill-build.log" 2>&1; }
ready && echo "READY: node $CLI" || { echo "NOT READY (checkout: ${OS:-not found})"; [ -n "$OS" ] && tail -5 "${TMPDIR:-/tmp}/openscreen-skill-build.log" 2>/dev/null; }
```

Done when it prints `READY: node /abs/…/openscreen-agent.mjs`: that line is
`<cli>`. Then read `AGENTS.md` in that checkout (the folder above
`electron/`).

- `NOT READY (checkout: not found)`: no path, no installed skill, and the
  current folder is not a checkout. Ask the user where their OpenScreen
  checkout is, put `<checkout>/skills/openscreen/SKILL.md` in the first line,
  and run the block again.
- `NOT READY (checkout: /abs/…)` with build output: the build failed. Stop
  and report that output.

A person installs the skill once, so "use openscreen" works from any
project. One command links it for both tools:
`node <checkout>/electron/scripts/install-skill.mjs`. It makes these two
links, one per tool (by hand, each line on its own):

```sh
ln -s <checkout>/skills/openscreen ~/.claude/skills/openscreen
ln -s <checkout>/skills/openscreen ~/.codex/skills/openscreen
```

## Step 1: pick the recording

"This" means, in order: a bundle path the user pasted (from **File → Copy
Path for Agent**), else a `.openscreen` path earlier in the conversation, else
the newest recording: `<cli> latest` prints it as `bundle`. That absolute
path is `<bundle>` from now on (`latest` would change if a new take is
recorded mid-edit). Say which bundle you picked, by name and full path,
before the first edit.

## Step 2: the loop

Run these in order. Each step is done when its check holds.

1. `<cli> info <bundle>` — note `source.kind`, `outputDuration`, the taps,
   waits, `export` (`preset`, `fps`, `canvas`) and `phone3d`. 3D steps (5, 6,
   9) need `source.kind: "iosDevice"`; skip them for other recordings.
2. `<cli> review <bundle>` — **open every `review/sheet-*.png`** and write,
   in one line each: what the recording shows, and its best moments as
   source-second ranges. Review covers the whole source recording; after a
   trim, only the ranges in `info.clips` are in the video.
3. Cut to the best moments: one
   `<cli> apply <bundle> '[{"op":"trim","start":S,"end":E},{"op":"cut","ranges":[{"start":…,"end":…}]}]'`
   in **source seconds**, keeping the ranges from step 2 and cutting the
   rest. Aim for the target's ideal length: the social presets'
   (`social-9x16`) is 15–30 s, and `polish` shortens waits further, so keep
   roughly 20–40 s of source. Done when `outputDuration` is at most about
   1.5× the target. Skip only when the user asked for the whole recording.
4. `<cli> polish <bundle> --style clean` (add `--title` / `--subtitle` when
   you know the product) — cuts dead air and speeds up waits. Done when
   `outputDuration` is inside the target length (else cut more, step 3).
   Times change: re-run `info` and work in **output seconds** from here on.
5. `<cli> direct <bundle> --style hero` — `bold` for promos (rests a few
   degrees off front), `subtle` for tutorials. Read each `shots[].reason`
   and the `note`. Auto 3D is restrained on purpose: at most one big move
   (`spin-in`, `turn-to-back`, `hero-layback`) per 30 s (per 20 s with
   `--style bold`), never two big moves within 6 s, at most 3
   `turn-to-back`s; the phone holds a calm pose the rest of the time. On a
   take over 90 s the `note` recommends a trim to the best 15–45 s: do
   step 3 again rather than adding shots. When you add or keep shots by
   hand, keep the same limits (no warning checks the counts) and count
   **shots, not rows**: one shot writes 2 to 4 rows in
   `info.transitions`, all with its `recipe`, each starting at the `end` of
   the row before; a new shot begins where the `recipe` changes or a gap
   opens (`direct`'s `shots` also lists one entry per planned shot). To
   remove a shot, remove every one of its rows by `id` in one `apply`
   (one row alone leaves half a shot).
   **Placing a shot yourself** (only when the video is short and has no
   shot after the intro): pick a gap between taps of at least the shot's
   length (2.4 s for `hero-layback`), convert the taps to output seconds
   with `info.clips`, and keep the same restraint (one big move per 30 s,
   6 s apart). **Zooms count too** (`info.zooms` lists when each plays): a zoom (Zoom to taps, auto-focus or a
   manual zoom) pushes the 3D camera in toward the screen, so while one
   plays the phone must stay within 35° of front. A tap zoom starts just
   before its tap, so end the shot's lean (the first 1.4 s of a
   `hero-layback`) before the next tap, and never put `spin-in` or
   `turn-to-back` over a zoom. Check with `apply --dry-run`: done when
   `warnings: []`; a `zoom-angle` or `tap-angle` warning names the moment:
   move the shot earlier, shorten it (`duration`), or apply its `fix`.
   The rest pose after Auto 3D is the End of the intro **and of every
   planned shot that returns to rest**. To rest a few degrees off front for
   the whole video: use `--style bold` (rests at -8°/5°), or edit the End
   of the intro's last move (each intro writes the move and a settle, so
   `{"op":"setPose","index":1,"end":"to","turn":-8,"tilt":5}`)
   and read its note in `changes`: when later moves still hold the old
   pose, it ends with `For one rest pose, apply: [...]`. Apply that list as
   it is, or the phone goes back to front after the first planned shot.
   Re-running `direct` resets the rest (it sets the base itself). Do this
   **before** adding shots by hand (a shot returns to the pose it starts
   from). A `target:"base"` edit shows nowhere once the first move has its
   own Start (Auto 3D's spin-in does); its output note says so.
6. `<cli> frames <bundle> --moves --sheet --draft` — **open `sheet.png`**
   and judge it against the checklist below. Each file's `facing` must be
   near 1 at every tap time and during every zoom. On a long video,
   `--from S --to E` limits the stills to output seconds S..E; when the
   moves need more than 200 stills, `--moves` samples them evenly and says
   so in its output.
7. Fix what you saw with one `<cli> apply <bundle> '[…]'` per round:
   `setPose`, `editTransition`, `shot`, `removeTransition`, a `phone3d`
   setting, or a warning's `fix` list as it is. Read each note in `changes`.
   Go back to 6 until the sheet passes.
8. `<cli> validate <bundle>` — done when `problems` is `[]` and `warnings`
   is `[]`, or every remaining warning is one you can explain in a sentence
   to the user. Apply each `fix` that exists.
9. `<cli> frames <bundle> --moves --sheet` — full quality (motion blur,
   anti-aliasing): **open `sheet.png`** once more.
10. Export: `<cli> export <bundle> --out /abs/out.mp4`, or
    `--preset social-9x16,… --out /abs/folder` for socials. The frame rate is
    `info.export.fps` (a layout preset sets its own). For the 4K hero file
    on a layout preset, first
    `<cli> apply <bundle> '[{"op":"exportSettings","preset":"uhd4k"}]'` and
    check `info.export.canvas`. Check the output's `probe` (`duration`,
    `width`, `height`, `fps`).
11. `<cli> review /abs/out.mp4` — **open its sheets**. Done when what
    viewers see passes the checklist; otherwise go back to 7.

Report: the bundle, the moments you kept, the shots and their reasons, the
fixes you made, the final warnings (0), and the output path.

## World-class checklist

- Only the best moments, inside the target length (social: 15–30 s).
- The screen faces front at every tap (facing near 1), readable.
- Zooms play with the phone near front (within 35°): a zoom pushes the
  camera in, so it is never the moment for a big turn.
- Restraint: at most one big move per 30 s (per 20 s with `--style bold`),
  counted by shot, never two within 6 s; the phone holds a calm pose (float is fine) the rest of the time.
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
| `hero-layback` | a wait of 2.4 s or more; with `"return":"stay"` as the outro; its lean ends before the next zoom |
| `turn-to-back` | a long wait (4.5 s or more) or a scene change, never over a zoom; bold promos, at most 3 per video |
| `float` | calm tutorials (idle drift, no moves) |

`info.shotRecipes` has each one's length and summary. Easing: `spring` for
anything that lands (180/18 = one soft overshoot; `fitDuration:true` fits the
length), `cinematic` for turns of 90° or more, `smooth` for small moves,
`linear` almost never.

## Rules

- Edit only with `apply` ops, `polish` and `direct`; `project.json` changes
  only through them.
- `trim`, `cut` and `speed` take source seconds; every other time is output
  seconds after cuts. In one edits list, put `trim`/`cut`/`speed` first.
- App Store layouts stay flat by design; use a social preset for 3D.
- Zooms play in 3D as a camera push-in (same timing and easing as flat);
  there is no separate 3D zoom control: the Zoom tab and zoom ops drive it.
- An export renders 10-15× slower than real time: judge with `frames`, and
  export once at the end.
- `<cli> undo <bundle>` swaps back the last `apply`, `polish` or `direct`
  (one level).
