# Presentation video and README GIF: how to rebuild

What is here (in git): `tools/` (capture, edit, audio, render and GIF scripts), `composition/` (the HyperFrames source: `index.html`,
`compositions/*.html`, `edit.json`, `kf.js`, the game's art and fonts in `assets/`), `STORYBOARD.md` (what was made), `CREDITS.md`
(music, sound effects, licences), `poster.jpg`.
Not in git (`video/.gitignore` and the root `.gitignore`): `footage/` (the captured clips), `renders/` (intermediate files),
`composition/footage/`, `composition/audio/` and the finished `clay-rush-presentation.mp4` (uploaded as an asset of the v1.0.0 release).

Needs: macOS, Node 22+, Google Chrome, ffmpeg (with libx264). HyperFrames runs through `npx --yes hyperframes@0.8.104` (pinned; it is
in the local npx cache with its own headless Chrome in `~/.cache/hyperframes`). The music and Kenney sounds are read from the bundled
assets of the `brag` skill (`~/.claude/skills/brag/assets/`, or set `CLAY_VIDEO_ASSETS` to a folder with `sfx/` and `music/`), see `CREDITS.md`.

## 1. Capture the gameplay (real game, played by the bot)

`tools/capture-gameplay.mjs` starts the game server (port 8380) and one headless Chrome at 1920x1080 through `test-support/e2e/env.js`,
opens the game with `?input=mouse&skipsafety=1&clock=manual&mute=1`, and plays with a scripted bot through `window.__clay`: it glides the
crosshair onto each clay with a smooth spring (`__clay.aim` every frame), calls "Pull!" and fires with `__clay.press('fire')`. Each frame
advances the game exactly 1000/fps ms, paints it and grabs it with `Page.captureScreenshot`. Next to each clip it writes
`<name>.events.json` (every shot, hit, double, kill cam... with its time in the clip). Same arguments, same footage.
`--plan` plays without pictures and prints the event timeline (that is how the windows below were chosen).

```bash
T=video/tools/capture-gameplay.mjs
node $T --mode classic --seed 7 --from 0 --seconds 71 --name classic                      # full Classic round, Normal (about 6 min)
node $T --mode classic --difficulty easy --seed 7 --from 0 --seconds 4 --name easy        # Easy vs Hard: the same throws
node $T --mode classic --difficulty hard --seed 7 --from 0 --seconds 4 --name hard
node $T --mode timeattack --stage hills --seed 5 --from 80 --seconds 3.2 --name timeattack
node $T --mode classic --difficulty easy --seed 7 --fps 50 --hold-aim --from 4.0 --seconds 26 --name gif-easy   # GIF source
node $T --plan --mode classic --seed 7 --seconds 200                                      # example: event timeline only
```

Look at the frames before using them (no stutter, nothing odd): for example
`ffmpeg -ss 24.6 -t 2.6 -i video/footage/classic.mp4 -vf "fps=6,scale=480:-1,tile=4x4" -frames:v 1 sheet.jpg`.

## 2. Edit, sound and render the video

The edit lives in `composition/edit.json` (which part of which clip plays when, plus the extra sound cues). Then:

```bash
video/tools/render-final.sh          # or: video/tools/render-final.sh draft   (15 fps quick look in video/renders/)
```

It runs `tools/build-edit.mjs` (writes the footage slots of `composition/index.html`, copies the clips into `composition/footage/`),
`tools/build-audio.mjs` (music bed + a gunshot on every `shot` frame and a clay crack on every `hit` frame -> `composition/audio/mix.wav`),
`hyperframes check`, `hyperframes render` (1920x1080, 30 fps, H.264 CRF 17), a two-pass loudness normalisation to -16 LUFS integrated,
true peak about -2 dBTP (AAC 192 kb/s), the QA numbers (streams, loudness, black frames), then copies the result to
`video/clay-rush-presentation.mp4` and writes `video/poster.jpg`. A render takes about one minute.

Preview with HyperFrames Studio: `cd video/composition && npx --yes hyperframes@0.8.104 preview`.

## 3. README GIF and poster

```bash
video/tools/make-gif.sh              # docs/img/hero.gif (960x540, 25 fps, ~7 s, under 6 MB) and docs/img/hero-poster.jpg (1920x1080)
```

Then check the GIF frame by frame, for example
`ffmpeg -i docs/img/hero.gif -vf "select='between(n\,14\,37)',scale=320:-1,tile=6x4" -frames:v 1 gif-sheet.png`.
