# Credits and licences of the presentation video and the README GIF

The credit lines burned into the end card of `clay-rush-presentation.mp4`:

> Music: "Happy Beats / Business Moves Vol. 10" by Sascha Ende (ende.app), CC BY 4.0 · SFX: Kenney, CC0
> Gameplay: the real game, played by the built-in bot

## Music (attribution required)

- Track: "Happy Beats / Business Moves Vol. 10" (1:00), file `happy-beats-business-moves-vol-10-by-ende-dot-app.mp3`, from the bundled tracks of the `brag` skill (`~/.claude/skills/brag/assets/music/`). Not stored in this repository.
- Author: Sascha Ende, https://ende.app
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/ . Commercial use is allowed with credit. Credit: "Sascha Ende (ende.app), CC BY 4.0".
- Changes made (CC BY asks to say so): only the first 32.6 seconds of the track are used; 0.25 s fade-in, 1.6 s fade-out; the level is lowered (gain 0.5) and mixed with sound effects; the whole mix passes a peak limiter and a loudness normalisation to -16 LUFS.
- Licence status: the owner confirmed the CC BY 4.0 licence of this track (Vol. 10) on the author's page at ende.app for the previous project (3D Fruit Dojo), which used the same track with the same credit.

## Sound effects (CC0, credited anyway)

Kenney (https://kenney.nl), licence CC0 1.0 (public domain). Files used, from the bundled Kenney packs of the `brag` skill (`~/.claude/skills/brag/assets/sfx/`; the same packs as `3d-fruit-dojo/video/audio/sfx/`):

- casino/card-slide-1, card-slide-3 (wipes)
- impact/impactPunch_heavy_000, impactMetal_heavy_000, impactWood_heavy_001: layered, pitched down and given a short echo to make the shotgun "boom"
- impact/impactPlate_light_000, impactPlate_light_002, impactPlate_light_004 with impactGlass_light_001, 002, 003 (pitched up): the three clay "cracks"
- impact/impactWood_light_002 (pitched down): the trap machine throwing a clay
- impact/impactPunch_heavy_001 with impactPlate_medium_001: the rank stamp

How the sounds are layered and where they are placed: `video/tools/build-audio.mjs`. Every gunshot and every crack sits on the exact frame of a `shot` or `hit` event of the captured game (`video/footage/<clip>.events.json`). The game itself plays no audio file (its sounds are synthesised in `public/js/audio/`); the footage was captured muted.

## Pictures

- Gameplay: every gameplay picture in the video and in `docs/img/hero.gif` / `docs/img/hero-poster.jpg` is the real Clay Rush build, captured frame by frame in headless Chrome under the manual clock and played by a scripted bot through the game's test API `window.__clay` (`video/tools/capture-gameplay.mjs`). The bot moves the crosshair with a smooth spring and fires with the same fire intent as the mouse button. Nobody played with a real Joy-Con in any shot. The footage is not retimed: the slow motion in the doubles is the game's own kill cam. The only treatment is a slow 2.5 % push-in on each shot and, for the Easy / Hard comparison, a centre crop of each half.
- Title cards, chips, wipes: drawn in HTML/CSS for the video (HyperFrames composition in `video/composition/`). The Joy-Con 2 on the "Call Pull!" card is a flat drawing, labelled "ILLUSTRATION" on screen; it is not a photo or footage.
- Art: the logo, the Golden Hills and Alpine Dusk backdrops and the clay shard sprites are the game's own art (`public/assets/`, provenance in `public/assets/PROVENANCE.csv`, generated with Higgsfield GPT Image 2.5).

## Numbers on screen

- "3 stages", "36 clays per Classic round", "Time Attack: every break adds time", "ranked S to D": the game's rules (README, `public/js/game/config.js`).
- The scores, ranks and statistics on screen are whatever the game showed while the bot played (36/36 on Normal, rank S). Nothing on screen is about how a real Joy-Con feels or about its latency.

## Fonts and tools

- Bebas Neue (Dharma Type) and Barlow SemiBold / Bold (The Barlow Project Authors), SIL Open Font License 1.1: the game's own fonts, full versions copied from `design/fonts/src/` into `video/composition/assets/fonts/` with their licence texts.
- Video built with HyperFrames (HeyGen, npm package `hyperframes` 0.8.104, run from the local npx cache) and its bundled headless Chrome, ffmpeg 8.1. Captured, edited and checked by a Claude (Anthropic) agent.
