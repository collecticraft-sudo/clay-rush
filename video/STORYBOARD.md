# Clay Rush presentation video: what was made

`video/clay-rush-presentation.mp4`: 1920x1080, 30 fps, H.264 (High, CRF 17) + AAC 192 kb/s, 32.6 s, no narration. Music bed plus sound effects synced to the captured game events, short burned-in title cards. Poster: `video/poster.jpg` (the end card).
Modelled on the 28 s cut of 3D Fruit Dojo (same tools: capture script on the manual clock, HyperFrames with the Web Animations API through `kf.js`, Kenney SFX, Ende.app music).

Look: the game's palette (cream #FFF4DC, slate #1B1F24, clay orange #F26B1D, gold #F2C230) and fonts (Bebas Neue display, Barlow interface). Title panels copy the game's own stage-card style (slate panel, orange edge). Wipes: a clay-orange slab with a gold and cream edge slashes across the frame (never a dip to black: blackdetect d=0.05 pix_th=0.1 finds nothing).
Cuts sit on the beat of the music (Vol. 10, 109.96 BPM).

Honesty: every gameplay shot is the real game, captured frame by frame and played by the built-in bot; a "REAL GAMEPLAY · played by the built-in bot" badge is on screen over every gameplay shot, and the end card repeats it. The Joy-Con appears only as a flat drawing labelled "ILLUSTRATION". No claim about real hardware.

| Time (s) | Scene | Picture | On screen |
|---|---|---|---|
| 0.00 - 3.55 | Intro | The menu's Golden Hills backdrop (game art, two layers drifting). A clay sprite flies in; on the beat (1.37) the logo slams in with a flash and clay shards burst out | "Clay pigeon shooting · in your browser" |
| 3.55 - 6.28 | Call "Pull!" | Real footage: Morning Meadow, the first pull, the crosshair glides onto the clay, SMOKED! +175 | Card: "Call "Pull!"" / "Aim like a pistol." / Joy-Con 2 (R) drawing, "ZR is the trigger. Turn to aim." "ILLUSTRATION · JOY-CON 2 (R)" |
| 6.28 - 8.22 | Morning Meadow | Real: pull 4, SMOKED! and the game's STREAK X2 banner | Chip "Three stages · Morning Meadow to Alpine Dusk" |
| 8.22 - 11.47 | Into Golden Hills | Real: last clay of stage 1 in the kill cam, STREAK X4, the game's own "STAGE 2 GOLDEN HILLS" card | |
| 11.47 - 14.20 | Double | Real: a skeet double, the second clay in the game's slow-motion kill cam, DOUBLE! banner | Chip "Doubles · slow-motion kill cam" |
| 14.20 - 16.38 | Into Alpine Dusk | Real: the "STAGE 3 ALPINE DUSK" card while the backdrop crossfades to dusk | |
| 16.38 - 19.10 | Rabbit double | Real: a trap clay and a rabbit rolling on the ground, kill cam, DOUBLE! | Chip "Rabbits · clays that roll along the ground" |
| 19.10 - 22.37 | Easy vs Hard | Real: the same seed and the same first two throws captured on Easy (left) and on Hard (right), centre crop of each | "EASY · the same throw, closer", "HARD · farther: lead the clay", "THE DIFFICULTY IS DISTANCE" |
| 22.37 - 25.10 | Time Attack | Real: Golden Hills, 80 s into a Time Attack round, two doubles in a row, +0.25 s per break | Chip "Time Attack · every break adds time" |
| 25.10 - 28.38 | Results | Real: ROUND COMPLETE, score count-up, the rank S stamp (36/36, 100 %, 10 doubles) | Chip "36 clays a round · ranked S to D" |
| 28.38 - 32.60 | End card | Alpine Dusk backdrop (game art), logo | "A Joy-Con 2 clay shooting game for the browser", github.com/collecticraft-sudo/clay-rush, facts "3 stages · 36 clays per Classic round · Time Attack · Zen · Mouse and simulator too", credit line (two lines) |

Footage used (all 60 fps captures, `video/footage/`, gitignored; times inside the clip):
- `classic.mp4`: one continuous Classic round on Normal, seed 7, 71 s (36/36 broken, score 34,566, rank S). Used at 0.30, 4.55, 18.10, 24.55, 41.50, 46.40, 65.30.
- `easy.mp4`, `hard.mp4`: Classic seed 7 on Easy and on Hard, first 4 s, used from 0.40.
- `timeattack.mp4`: Time Attack, Golden Hills, seed 5, from 80.0 s of the round, used from 0.25.

Sound: 15 gunshots and 15 clay cracks placed on the exact frames of the captured `shot` and `hit` events, a soft trap "thunk" on every launch, wipes, the rank stamp; music under it. Loudness of the final file: -16.0 LUFS integrated, true peak -1.9 dBTP. Every text is at least 28 px at 1080p (the "REAL GAMEPLAY" tag 26 px).

README GIF `docs/img/hero.gif`: 960x540, 25 fps, 7.2 s (180 frames), 5.57 MB, loops. Two real shots of a Classic round on Easy (seed 7, captured at 50 fps with `--hold-aim` and taken one frame in two): Morning Meadow (two pulls: SMOKED!, the STREAK X2 banner, shards), then Golden Hills (a skeet double, the second clay broken in the slow-motion kill cam, DOUBLE!). One global palette of 56 colours, bayer dither. `docs/img/hero-poster.jpg`: a 1920x1080 frame of the Golden Hills double in the kill cam, from `classic.mp4` (Normal).

All footage was re-captured on 2026-10-03 from the fixed build (the gun slides away from the crosshair, the stage label switches with the stage card, the results show the previous best during the count-up and RANK fades in after the stamp); the bot's events are identical to the first capture, frame for frame.
