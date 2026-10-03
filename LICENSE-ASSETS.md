# Licences of the art, the video and the third-party files

The MIT licence in [`LICENSE`](LICENSE) covers the source code only. Everything listed here has its own terms.

## 1. Art, logo, name and video: all rights reserved

Copyright (c) 2026 collecticraft-sudo. **All rights reserved.** You may run the game and look at the art in this repository. You may not copy, redistribute, sell, or use it in another project, and you may not train or fine-tune a model on it, without written permission.

This applies to:

- `public/assets/` except the fonts (backdrops in `backgrounds/`, clays, shards, launch houses, effects and icons in `sprites/`, the gun and the logo in `ui/`);
- `design/` except the fonts (the cut sprites in `design/sprites/`; the raw generated pictures are not in the repository, `tools/build-clay-assets.mjs` needs them in `design/raw/` to rebuild `public/assets/`);
- the screenshots in `docs/screens/` and the gameplay GIF in `docs/img/`;
- the presentation video and its poster (published as release assets, not in git) and their sources;
- the name and the logo "Clay Rush".

The art was generated with Higgsfield (GPT Image 2.5) from prompts written for this project and then cut, cleaned and optimised by `design/tools/` and `tools/build-clay-assets.mjs`. The provenance of every picture is in `design/PROVENANCE-jobs.csv` and `public/assets/PROVENANCE.csv`. Check the terms of the generator for any use of AI-generated images that goes beyond running this game.

If you want to build your own game on this code, replace the art: every picture is optional (the game has a complete procedural fallback, start it with `?assets=0` to see it).

## 2. Third-party files and their licences

| What | Where | Author | Licence |
|---|---|---|---|
| Bebas Neue (display font; the game ships a Latin subset and registers it as "ClayDisplay") | `design/fonts/src/ofl_bebasneue_BebasNeue-Regular.ttf`, `public/assets/fonts/range-display.woff2` | Dharma Type | SIL Open Font License 1.1, text in `design/fonts/src/ofl_bebasneue_OFL.txt` and `public/assets/fonts/OFL-bebasneue.txt` |
| Barlow SemiBold and Bold (UI font; Latin subsets registered as "ClayUI") | `design/fonts/src/ofl_barlow_Barlow-SemiBold.ttf`, `design/fonts/src/ofl_barlow_Barlow-Bold.ttf`, `public/assets/fonts/range-ui-600.woff2`, `public/assets/fonts/range-ui-700.woff2` | The Barlow Project Authors (Jeremy Tribby) | SIL Open Font License 1.1, text in `design/fonts/src/ofl_barlow_OFL.txt` and `public/assets/fonts/OFL-barlow.txt` |
| Music of the presentation video (the audio file is not in this repository) | the video | Sascha Ende, https://ende.app | Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/ . Changes made: shortened and faded |
| Sound effects of the presentation video (the audio files are not in this repository) | the video | Kenney, https://kenney.nl | CC0 1.0 (public domain) |

The game itself plays no audio file: every sound is synthesised with the Web Audio API in `public/js/audio/`.

The fonts are modified versions (Latin subsets made with `pyftsubset`). Neither licence declares a Reserved Font Name. They are distributed with their licence texts and are not sold by themselves, as the OFL requires.

## 3. Trademarks

Nintendo, Nintendo Switch, Nintendo Switch 2 and Joy-Con are trademarks of Nintendo. This project is not made, endorsed, sponsored or approved by Nintendo and has no affiliation with it. The controller drawings of the calibration and connect screens are simple generic outlines drawn by the code, not pictures of a Nintendo product. The Bluetooth protocol notes in `docs/` come from public community research; see `docs/joycon2-protocol.md` for the sources.
