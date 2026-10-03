# Credits

## People and tools

- Game design, direction, play testing and every decision: the owner of this repository (collecticraft-sudo). Only the owner touched the real controller.
- Code, tests, documentation and the presentation video: built, tested and reviewed by a team of AI agents working with Claude (Anthropic) under the owner's direction. Nobody on the AI side could hold a Joy-Con; see "Honest status" in the README and `docs/GUIDE.md` section 11.
- Art: generated with Higgsfield GPT Image 2.5 (`gpt_image_2_5`), 13 pictures for 5.5 credits. Provenance of every picture: `design/PROVENANCE-jobs.csv` (the Higgsfield job ids) and `public/assets/PROVENANCE.csv` (every shipped file and its source).
- Video: HyperFrames (HeyGen, npm package `hyperframes`) and ffmpeg.
- Forked from [3D Fruit Dojo](https://github.com/collecticraft-sudo/3d-fruit-dojo) by the same owner: the Bluetooth stack, the native bridge, the motion pipeline and the test tools come from there.

## Fonts (SIL Open Font License 1.1)

- **Bebas Neue** by Dharma Type (display text and numerals; the game registers it as `ClayDisplay`). https://fonts.google.com/specimen/Bebas+Neue
- **Barlow** SemiBold and Bold by The Barlow Project Authors, Jeremy Tribby (interface text; registered as `ClayUI`). https://fonts.google.com/specimen/Barlow

The sources and their licence texts are in `design/fonts/src/`; the Latin subsets the game ships (made with `pyftsubset`) and their licence texts are in `public/assets/fonts/`.

## Music and sound (presentation video only)

- Music: "Happy Beats / Business Moves Vol. 10" by Sascha Ende (https://ende.app), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The first 32.6 seconds are used, faded in and out and lowered under the sound effects; details in `video/CREDITS.md`.
- Sound effects: Kenney (https://kenney.nl), CC0 1.0.

The audio files are not in this repository; the finished video is the `clay-rush-presentation.mp4` asset of the [v1.0.0 release](https://github.com/collecticraft-sudo/clay-rush/releases/tag/v1.0.0).

The game itself plays no audio file: every sound is synthesised with the Web Audio API in `public/js/audio/`.

## Research that made the controller work

The Joy-Con 2 Bluetooth protocol was reverse engineered by the community, and this project would not exist without them. The sources, with their licences and how far each one was trusted, are listed in `docs/joycon2-protocol.md` (section 2) and `docs/legacy-fruit-dojo/protocol-audit.md`. Among them: ndeadly (switch2_controller_research), Peterksharma (switch2mac), JoeGeC (joycon2android), TheFrano (joycon2cpp), seitanmen (Joycon2forMac), mascii (Web Bluetooth demo) and the SDL project. Facts (UUIDs, offsets, constants) were reused and no code was copied (one of the projects is GPL-3.0 and several have no licence, so the code here is written from scratch); the owner's real controller then confirmed that it connects and streams.

## Trademarks

Nintendo, Nintendo Switch 2 and Joy-Con are trademarks of Nintendo. This project has no affiliation with Nintendo.
