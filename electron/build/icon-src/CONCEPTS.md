# OpenScreen app icon: four concepts

Sheet: `/tmp/os-fixture/icon-concepts.png` (columns: current icon, A, B, C, D; rows: 300 px hero, Dock at 128 px on a dark desktop with 64/32/16 px below, the same on a light desktop).
Sources: `electron/build/icon-src/` on branch `feat/app-icon` (worktree `/tmp/os-wt-icon`). Regenerate with `build-concepts.sh`; rebuild the sheet with `compare-sheet.sh`.

## What the research says (adopt / avoid)

- Adopt the macOS grid exactly: 1024 canvas, 824 px body at 100 px inset, continuous-corner squircle, soft drop shadow baked in. I checked this against Apple's own Notes icon: the masks differ only on edge pixels (130 of 65,536 at 256 px). ([HIG App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons))
- Adopt one simple idea made of a few filled, overlapping shapes on a plain background. "Embrace simplicity... minimal number of shapes." (HIG)
- Adopt light from straight above, with specular edges and layered depth. Icon Composer's Liquid Glass uses "a new, vertical light angle [that] shines from above". ([Icon Composer](https://developer.apple.com/icon-composer/), [WWDC25 "Say hello to the new look of app icons"](https://developer.apple.com/videos/play/wwdc2025/220/))
- Adopt bold weights and soft light-to-dark gradients. Avoid thin lines and sharp corners, because they fall apart at 16/32 px. (WWDC25, HIG)
- Adopt separate small-size artwork where the full design turns to mush. B and D each ship a `-small.svg` for 16/32 px, the same way Apple simplifies small icons.
- Avoid a flat frontal photo-real 3D object. Realistic objects fight the material, so Apple prefers "a more flat and frontal view". (WWDC25)
- Avoid copies of Apple hardware (HIG: "Don't use replicas of Apple hardware products"). This is a risk for B: its phone is generic, but the island pill leans toward iPhone.
- Avoid shapes that break the squircle. Tahoe masks every icon to the template, and an icon that does not fit gets shrunk onto a grey tile ("squircle jail"). ([Michael Tsai on Tahoe icons](https://mjtsai.com/blog/2025/06/19/macos-tahoes-new-theming-system/))
- What the best utility icons share: Screen Studio, CleanShot X, Raycast and Things each rely on ONE graphic, one strong colour and depth from light, not outlines. CleanShot's peeled layer and Things' single checkbox read at 16 px because there is only one thing to read.

## Found along the way: the current icon has a baked-in white square

`electron/build/icon.png` is opaque: a white square behind the purple squircle, which fills the canvas edge to edge with no grid margin. On the sheet it shows as a white box in the Dock on both desktops, and it is oversized next to its neighbours. Any of the four concepts fixes both problems.

## Concepts

**A. Aperture + record** (`concept-a-aperture.svg`). A machined graphite lens ring sits on dark glass and holds one glowing orange record dot. This is the most Apple-restrained of the four and matches the app's own look (near-black surfaces, one warm accent, depth from light). It is also the clearest at 16 px: an orange dot on a dark tile is unmistakable, and it reads as "recording" in any culture. Weakness: it says "recorder" but not "iPhone demos", and record dots are a common motif. The warm orange and the lens bezel are what make it ownable.

**B. Phone + zoom** (`concept-b-phone-zoom.svg`, with `-small.svg` for 16/32). A generic phone shows a tap on a button, and a white-rimmed loupe blows that tap up 2.5x. It is the only concept that tells the headline story (mobile demos with auto-zoom on taps) at a glance. Cost: it is the busiest design, it needs separate small artwork (phone and tap only), and the island pill brushes against Apple's rule on hardware replicas. A punch-hole camera would remove that risk.

**C. Open screen** (`concept-c-open-screen.svg`). A screen frame whose dark panel swings open like a door, letting warm light spill onto the floor. It plays on the name and is the most distinctive silhouette in a Dock full of glyph-on-tile icons. It holds up well at 32 px and is acceptable at 16. Risk: it reads first as "door" and only second as "screen", so it could pass for a smart-home or exit app. It also uses the one slight perspective of the four.

**D. Tap ripple** (`concept-d-tap-ripple.svg`, with `-small.svg` for 16/32). An orange touch point sends three fading ripples across dark glass. This is the in-app tap highlight turned into a mark, and it is calm, symmetric and very Apple. At 16 px the full design blurs into a haze, so the small artwork keeps one bold ring. It looks close to A in the Dock (both are orange circles on dark), which makes it the weaker choice if the owner wants a distinct silhouette.

## Recommendation

**A (Aperture + record)** as the primary. It is the strongest at every size, the calmest next to Apple's own icons, and the most "wait, is this Apple's?". Its dark glass with one orange light matches the app's UI one-to-one. If the owner wants the icon to tell the iPhone-demo story, **B** is the runner-up, but I would swap the island pill for a neutral camera dot before shipping it.

## Shipping it

`electron/build/icon-src/make-icns.sh <concept.svg> [out-dir]` renders all 10 iconset entries (16-512 pt at @1x/@2x, so 16-1024 px) with headless Chrome. It checks every PNG's pixel size, uses `<concept>-small.svg` for renders of 32 px and under when that file exists, then runs `iconutil -c icns`. It writes `icon.icns` plus a 1024 px `icon.png`. With no out-dir it writes into `electron/build/` and replaces the shipped icon. I tested it on A into `/tmp/os-icon-render/icns-test`: 10 sizes, and the `.icns` round-trips through `iconutil -c iconset`.

Follow-up (not done): Tahoe renders icons from Icon Composer `.icon` files with live Liquid Glass. The SVG layers here (tile, ring, dot) already split cleanly into Icon Composer groups if OpenScreen later wants the native material. I have not checked whether electron-builder packages `.icon` files.
