# OpenScreen app icon

## Round 2: camera shutter (shipped: B, Ember iris)

The owner asked for an icon built around a camera shutter, "a lot better than" a generic clipart shutter (a black ring with six white curved blades). This round replaces the shipped icon with concept B below.

Sheet: `shutter-icon-concepts.png` on branch `pr-assets/shutter-icon` (columns: the icon on main before this round, then A to D; row 1 is each 1024 px master at true size; rows 2 and 3 put it in a Dock at 128 px with 32 and 16 px beside it, on a dark and a light desktop). Rebuild it with `shutter-sheet.sh <out.png> <old icon.icns> shutter-*.svg`. Every size on that sheet is rendered on its own, the same way `make-icns.sh` builds the iconset, so the small sizes are the pixels that ship.

Sources: `build-shutter.py` writes every `shutter-*.svg`, the `-small.svg` artwork for 16 and 32 px, and the layers of `OpenScreen.icon`. Edit the script, not the SVGs.

### What the research added this round

- Apple's own Tahoe camera and photo icons (Photos, Screenshot, Photo Booth, Image Capture, QuickTime, pulled from this Mac's `/System/Applications`) all use one large frontal glyph that fills about 70 to 80% of the body, with soft top-down gradients and no outlines. Photos is the closest relative: overlapping petals whose overlaps carry the depth. The irises here follow that.
- Icon Composer: "a new, vertical light angle shines from above". Every blade is lit by which way it faces: blades facing up are lighter, blades facing down darker. ([Icon Composer](https://developer.apple.com/icon-composer/))
- WWDC25 "Say hello to the new look of app icons": avoid thin lines, use "softer light-to-dark gradients", keep a "more flat and frontal view", and build the icon as a background plus a few foreground layers so the system can add glass, shadows and the dark, tinted and clear looks. ([WWDC25 session 220](https://developer.apple.com/videos/play/wwdc2025/220/))
- Iris construction (Bjango's camera-iris walkthrough): each blade is a rotated copy cut by the next one. Too many blades turn to clutter, so 6 to 8 is the useful range. ([Bjango](https://bjango.com/articles/speedruncamerairis/))

### How the irises are built

Each blade's inner edge is an arc of a large circle that just touches the opening. Blade i shows only the part of the disc outside its own circle and inside the next blade's circle, so every blade is overlapped by its neighbour and the last tucks under the first, like a real diaphragm. The depth comes from light, not outlines: a gradient across each blade, a soft shadow cast by the blade on top of it, a 2.5 px specular on each exposed edge, shade toward the rim where the blades run under the ring, and an inner shadow at the opening. The 16 and 32 px artwork drops to 6 blades, opens the hole wider, and removes the speculars and the lens sheen, which only turn to noise at that size.

### Concepts

**A. Graphite iris** (`shutter-a-graphite-iris.svg`). Seven graphite blades in a machined ring open onto warm orange light. It is the calmest of the four and the most "lens". Weakness: the orange is only the centre, so at 16 and 32 px on a dark Dock it shrinks to a small orange dot on a dark tile and loses the shutter.

**B. Ember iris** (`shutter-b-ember-iris.svg`). The same iris with orange blades around a dark coated lens: a faint warm ring and a soft sheen from above. Orange is the hero and covers most of the body, so the icon reads as an orange shutter at every size. At 16 px it is still an orange ring around a dark centre.

**C. Play iris** (`shutter-c-play-iris.svg`). Six blades: three close to a triangle and three stop short to trim its corners, so the opening is a glowing Play button. It tells the "recorder" story best, but the uneven blades are busier, and Play glyphs are common.

**D. Orange tile** (`shutter-d-orange-tile.svg`). A graphite iris set into an orange tile, opening onto warm white light. It is the most legible on a dark Dock and follows Apple's advice to use coloured backgrounds in the default look. It reads more "camera app" than "screen recorder", and it gives up the dark graphite body that matches the app's own look.

### Recommendation: B

B is the reference turned into an icon Apple could ship: one graphic, real overlapping blades lit from above, and the single orange accent on deep graphite, the same palette as the app. It is the only concept where orange carries the shape (the blades) rather than just a dot or a background, so it stays a recognisable shutter from 1024 px down to 16. On a light Dock its graphite tile stands out. On a dark Dock the orange ring carries it. D is the runner-up if a coloured tile is wanted.

### Shipped

`make-icns.sh shutter-b-ember-iris.svg` regenerated `electron/build/icon.icns` (10 sizes, 16 to 1024 px, with the `-small` artwork at 32 px and under) and `electron/build/icon.png`. `package.json` sets no icon, and electron-builder takes `build/icon.icns` by default. The 1.3.0 build in `electron/release/` carries a byte-identical copy of main's `build/icon.icns`, which proves that default is the one used.

### Tahoe looks: `OpenScreen.icon` (built, not wired in)

`OpenScreen.icon` is an Icon Composer document with B split into three layers (ring, blades, lens) on a graphite gradient. Apple's `ictool` renders it in all six Tahoe looks (Default, Dark, Clear Light, Clear Dark, Tinted Light, Tinted Dark): see `shutter-icon-tahoe-looks.png` on the assets branch. `actool` from Xcode 26 compiles it without warnings.

I left it out of the build on purpose. electron-builder 26 accepts it (`"mac": {"icon": "build/OpenScreen.icon"}`), but then it makes the `.icns` from the `.icon` with `actool`. That replaces the hand-tuned 16 and 32 px artwork, and every release build would need Xcode 26. To opt in later, move `OpenScreen.icon` to `electron/build/`, set `mac.icon`, and check the small sizes in the generated `.icns`.

## Round 1: four concepts

Sheet: `/tmp/os-fixture/icon-concepts.png` (columns: current icon, A, B, C, D; rows: 300 px hero, Dock at 128 px on a dark desktop with 64/32/16 px below, the same on a light desktop).
Sources: `electron/build/icon-src/` on branch `feat/app-icon` (worktree `/tmp/os-wt-icon`). Regenerate with `build-concepts.sh`; rebuild the sheet with `compare-sheet.sh`.

### What the research says (adopt / avoid)

- Adopt the macOS grid exactly: 1024 canvas, 824 px body at 100 px inset, continuous-corner squircle, soft drop shadow baked in. I checked this against Apple's own Notes icon: the masks differ only on edge pixels (130 of 65,536 at 256 px). ([HIG App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons))
- Adopt one simple idea made of a few filled, overlapping shapes on a plain background. "Embrace simplicity... minimal number of shapes." (HIG)
- Adopt light from straight above, with specular edges and layered depth. Icon Composer's Liquid Glass uses "a new, vertical light angle [that] shines from above". ([Icon Composer](https://developer.apple.com/icon-composer/), [WWDC25 "Say hello to the new look of app icons"](https://developer.apple.com/videos/play/wwdc2025/220/))
- Adopt bold weights and soft light-to-dark gradients. Avoid thin lines and sharp corners, because they fall apart at 16/32 px. (WWDC25, HIG)
- Adopt separate small-size artwork where the full design turns to mush. B and D each ship a `-small.svg` for 16/32 px, the same way Apple simplifies small icons.
- Avoid a flat frontal photo-real 3D object. Realistic objects fight the material, so Apple prefers "a more flat and frontal view". (WWDC25)
- Avoid copies of Apple hardware (HIG: "Don't use replicas of Apple hardware products"). This is a risk for B: its phone is generic, but the island pill leans toward iPhone.
- Avoid shapes that break the squircle. Tahoe masks every icon to the template, and an icon that does not fit gets shrunk onto a grey tile ("squircle jail"). ([Michael Tsai on Tahoe icons](https://mjtsai.com/blog/2025/06/19/macos-tahoes-new-theming-system/))
- What the best Mac utility icons share: each relies on ONE graphic, one strong colour and depth from light, not outlines. A single checkbox or a single peeled layer reads at 16 px because there is only one thing to read.

### Found along the way: the current icon has a baked-in white square

`electron/build/icon.png` is opaque: a white square behind the purple squircle, which fills the canvas edge to edge with no grid margin. On the sheet it shows as a white box in the Dock on both desktops, and it is oversized next to its neighbours. Any of the four concepts fixes both problems.

### Concepts

**A. Aperture + record** (`concept-a-aperture.svg`). A machined graphite lens ring sits on dark glass and holds one glowing orange record dot. This is the most Apple-restrained of the four and matches the app's own look (near-black surfaces, one warm accent, depth from light). It is also the clearest at 16 px: an orange dot on a dark tile is unmistakable, and it reads as "recording" in any culture. Weakness: it says "recorder" but not "iPhone demos", and record dots are a common motif. The warm orange and the lens bezel are what make it ownable.

**B. Phone + zoom** (`concept-b-phone-zoom.svg`, with `-small.svg` for 16/32). A generic phone shows a tap on a button, and a white-rimmed loupe blows that tap up 2.5x. It is the only concept that tells the headline story (mobile demos with auto-zoom on taps) at a glance. Cost: it is the busiest design, it needs separate small artwork (phone and tap only), and the island pill brushes against Apple's rule on hardware replicas. A punch-hole camera would remove that risk.

**C. Open screen** (`concept-c-open-screen.svg`). A screen frame whose dark panel swings open like a door, letting warm light spill onto the floor. It plays on the name and is the most distinctive silhouette in a Dock full of glyph-on-tile icons. It holds up well at 32 px and is acceptable at 16. Risk: it reads first as "door" and only second as "screen", so it could pass for a smart-home or exit app. It also uses the one slight perspective of the four.

**D. Tap ripple** (`concept-d-tap-ripple.svg`, with `-small.svg` for 16/32). An orange touch point sends three fading ripples across dark glass. This is the in-app tap highlight turned into a mark, and it is calm, symmetric and very Apple. At 16 px the full design blurs into a haze, so the small artwork keeps one bold ring. It looks close to A in the Dock (both are orange circles on dark), which makes it the weaker choice if the owner wants a distinct silhouette.

### Recommendation

**A (Aperture + record)** as the primary. It is the strongest at every size, the calmest next to Apple's own icons, and the most "wait, is this Apple's?". Its dark glass with one orange light matches the app's UI one-to-one. If the owner wants the icon to tell the iPhone-demo story, **B** is the runner-up, but I would swap the island pill for a neutral camera dot before shipping it.

### Shipping it

`electron/build/icon-src/make-icns.sh <concept.svg> [out-dir]` renders all 10 iconset entries (16-512 pt at @1x/@2x, so 16-1024 px) with headless Chrome. It checks every PNG's pixel size, uses `<concept>-small.svg` for renders of 32 px and under when that file exists, then runs `iconutil -c icns`. It writes `icon.icns` plus a 1024 px `icon.png`. With no out-dir it writes into `electron/build/` and replaces the shipped icon. I tested it on A into `/tmp/os-icon-render/icns-test`: 10 sizes, and the `.icns` round-trips through `iconutil -c iconset`.

Follow-up (not done): Tahoe renders icons from Icon Composer `.icon` files with live Liquid Glass. The SVG layers here (tile, ring, dot) already split cleanly into Icon Composer groups if OpenScreen later wants the native material. I have not checked whether electron-builder packages `.icon` files.
