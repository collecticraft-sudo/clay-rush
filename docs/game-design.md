# Clay Rush: Game Design Bible

Version 1.0, 2026-10-01. Owner decisions of 2026-10-01: arcade mix with 3 stages, Time Attack and Zen modes, art by Higgsfield GPT Image 2.5
(cap 15 credits), OFL fonts Bebas Neue and Barlow, hardware recording session AFTER the first playable build. Everything about the real
Joy-Con 2 that was not measured is `UNVERIFIED-ON-HARDWARE`. The numbers below are starting values: every one of them lives in
`public/js/game/config.js` (or `motion/motion-config.js` for aim values) and nowhere else.

## 1. Pitch

You stand at a shooting station in the Italian countryside with an over-and-under shotgun. Call "Pull!", clays fly out of the trap houses,
you swing the Joy-Con, lead the target and pull the trigger. Clays burst into shards and dust, doubles slow the world down, the light goes
from a spring morning to a golden Tuscan afternoon to an alpine dusk. Short rounds (about 3 minutes), easy to start, hard to master.

## 2. Camera and world (2.5D first person)

- Playfield: 1920 x 1080 logical px (same as the previous game, `shared/playfield.js`), letterboxed.
- World: metres. x to the right, y up, z away from the player (depth). The camera is at (0, 1.6, 0) looking along +z, level.
- Projection: `sx = 960 + F * x / z`, `sy = HORIZON_Y - F * (y - 1.6) / z`, with `F = 1663` px (60 degree horizontal field of view) and
  `HORIZON_Y = 670` (62 percent of the height: the horizon in every backdrop is painted there).
- Objects closer than `zNear = 4` m are not drawn and cannot be hit.
- Draw order: far backdrop, launch houses (sorted by z, far first), targets and shards (far first), near backdrop layer, gun, muzzle fx,
  crosshair, HUD, banners.
- Parallax: the backdrop layers shift with the aim by a small amount (far 0.6 percent, near 2.5 percent of the aim offset from the centre)
  and with the recoil kick. Reduce motion turns the parallax and the camera shake off.

## 3. Targets

| Kind | Look (sprite) | World size drawn | Flight | Base points |
|---|---|---|---|---|
| `standard` | orange clay (`clay_std_*`, the frame chosen by the angle of flight: tilt, below, edge) | 0.60 m diameter (arcade size, a real clay is 0.11 m; raised from 0.30 to 0.60 on 2026-10-02 after the owner played: too small) | ballistic with drag | 100 |
| `mini` | the standard sprite at about 0.6 scale | 0.38 m | faster (x1.25) | 150 |
| `battue` | the edge-on frame (`clay_std_edge`), fast (x1.2) and flat (elevation 9 to 15 degrees), dips suddenly at the end (drag x2 after 60 percent of the flight time) | 0.60 m | fast | 150 |
| `rabbit` | the wheel (`clay_rabbit`), rolls and bounces along the ground (y = radius, small hops of 0.2 to 0.6 m) | 0.60 m | ground, 12 to 16 m/s, crosses the field | 150 |
| `gold` | golden clay (`clay_gold_tilt`) with a sparkle | 0.60 m | like standard, at most one per stage, never in Zen | 300 |

Physics (fixed step 1/120 s, deterministic, seeded): `a = g + wind - k |v| v`, `g = (0, -9.81, 0)`, drag `k = 0.012` per metre (a clay at
25 m/s slows to about 18 m/s in 1.5 s). Spin is cosmetic: a seeded angular rate turns the sprite frame and rotation. A target is LOST when
it touches the ground (the ground plane, y = 0 at k = 1, except rabbits), goes beyond `zFar = 90` m (x k, below), comes closer than `zNear = 4` m, leaves the
screen by more than 200 px (after having been on screen), or after 6 s.

World scale (owner decision 2026-10-03): the difficulty changes the DISTANCE (section 7.4). The world is scaled by `k` about the CAMERA
point C = (0, 1.6, 0) (QA F9, 2026-10-03; it was scaled about the origin, which made Easy clays fly 100 to 130 px lower): every position
becomes `C + k (p - C)`, launch jitter, launch speeds, gravity, wind acceleration and rabbit hop heights are multiplied by `k`, the drag
coefficients divided by `k`, `zFar` multiplied by `k`, and the ground plane moves to `y = 1.6 (1 - k)` (house ground points, ground
collisions; rabbits roll one radius above it). Every screen position and path is then identical to Normal (tested within 1 px), while
the clays (their size stays in metres) and the shot pattern (in metres, section 4) look `1/k` times bigger. Easy `k = 0.55` (the trap house at 7.7 m, the nearest point any target reaches: nearly twice zNear), Normal 1,
Hard 1.45; Zen 0.55, the practice round 1.

Launch houses (positions in world metres, each drawn with its sprite at the matching scale and anchored on the ground):

| Id | Sprite | Position (x, y, z) | Used for |
|---|---|---|---|
| `trap` | `house_trap` | (0, 0.4, 14) | going-away targets (trap style): launched away from the player, angle -35 to +35 degrees left-right, elevation 18 to 30 degrees (retuned from 8 to 20 for the fairness rule), 20 to 26 m/s |
| `skeetL` | `house_skeet` | (-22, 3.0, 32) | crossers from the left to the right, slightly towards the player (azimuth 95 to 112, elevation 14 to 24 degrees, 19 to 24 m/s) |
| `skeetR` | `house_skeet` (mirrored) | (22, 1.2, 34) | crossers from the right to the left (elevation 16 to 26 degrees) |
| `tower` | `house_tower` | (-14, 6.0, 46) | high incoming/dropping targets (stage 3), elevation 6 to 16 degrees, 16 to 20 m/s |
| `rabbitL` | none (the clay comes out of the near grass on the left) | (-26, 0.15, 24) | rabbits |

Launch parameters are seeded per target (`rng.stream('launch')`): speed, azimuth, elevation, spin, small jitter of the launch point.
Every target of a launch has a trajectory that stays at least 1.2 s inside the shootable view (checked at spawn by simulating it in the
scaled world of the round; if it fails the generator retries up to 8 times with new draws of the same stream, then clamps to a safe set
of parameters per house). This is the fairness rule. The positions above are Normal (k = 1); the snapshot gives the scaled ones.

## 4. The shot

- The gun is an over-and-under: **2 shells per pull** (Classic). Firing an empty gun gives a dry click and no shot.
- **Hit test in screen space at the instant of the shot** (hit-scan in Easy and Normal): for every airborne target project its centre and
  its radius. Hit if `distance(aimPoint, targetCentre) <= patternRadiusPx(z) + targetRadiusPx(z)`.
- Shot pattern: radius in metres `r(z) = r0 + spread * z`, `r0 = 0.10`, `spread = 0.018` (at 20 m 0.46 m, at 40 m 0.82 m); in px that is
  about 34 to 38 px, nearly constant on screen, which keeps aiming readable. Difficulty multiplies `r` (section 7.4). `z` is the real depth
  of the scaled world, so on Easy (closer) the pattern is bigger on screen and on Hard (farther) smaller, like the clays.
- Centre hit ("SMOKED!"): `distance <= 0.35 * patternRadiusPx`. Bonus +50, a bigger burst, the kill cam may trigger (section 8).
- Hard difficulty adds pellet travel time: the shot is resolved after `z / 750 m/s` of WORLD time (about 25 to 100 ms at k 1.45; 420 m/s
  at first, 650 m/s, then 750 m/s on 2026-10-03 after QA F6), using the target position at that later time, so the player must lead a
  little. Measured with bots (Classic Hard, 12 seeds, one shot per clay): aiming straight at the clay breaks 68 percent, leading by the
  pellet time 100 percent (1000 m/s gave 95 percent straight: no challenge). Easy and Normal resolve instantly (the 33 Hz controller
  already adds latency). No lead indicator.
- The distance bonus (section 5) uses the Normal-world depth `z / k`, so the same throw scores the same at every difficulty.
- Several targets can be broken by one shot (the pattern covers both): each one scores, plus "ONE SHOT, TWO BIRDS" +200.
- The aim point used for the hit test is the **trigger-compensated** aim (section 6.3), never the extrapolated cursor.

## 5. Scoring

| Event | Points |
|---|---|
| Hit | base points of the kind (100 / 150 / 300) |
| Centre hit (SMOKED!) | +50 |
| First barrel (the target broken with the first shell of the pull) | +25 |
| Distance bonus | `+4 per metre beyond 25 m` (rounded down) |
| Double (both targets of a double broken) | +100 and the banner "DOUBLE!" |
| Two with one shot | +200 |
| Stage clear (every target of the stage broken) | +500 "PERFECT STAGE" |

Streak multiplier on everything above, from consecutive broken targets: x1 (0 to 2), x2 (3 to 5), x3 (6 to 9), x4 (10 and more). A LOST
target resets the streak to 0; a missed shot alone does not. The HUD shows the multiplier and a ring that fills to the next step.

End of round: score, targets broken / presented, accuracy (hits / shells fired), best streak, rank, best score per mode and difficulty
(saved locally, versioned storage). Rank by the percentage of targets broken: S >= 95, A >= 85, B >= 70, C >= 50, D below.

## 6. Controls

### 6.1 Mapping (right unit; the left unit mirrors: ZL fire, L recentre, minus pause)

| Action | Joy-Con 2 R | Mouse | Keyboard |
|---|---|---|---|
| Aim | relative gyro pointer | the cursor | arrows (menus only) |
| Fire / call "Pull!" | **ZR** (setting: ZR or R; A also calls "Pull!") | left click | F or Enter |
| Recentre the aim | R (or ZR when R is the trigger) | double click | C |
| Pause | plus | middle click | P or Escape |
| Menu move / confirm / back | stick / A / B | point and click / right click | arrows / Enter / Escape |

Menus never react to the pointer of a real Joy-Con (no accidental activation): stick, A and B only. The mouse may click menu items.

### 6.2 Aim (motion pipeline, reused)

Relative pointer in the controller plane, dead zone 5 deg/s, acceleration curve, idle soft auto-centre, 33 Hz interpolation, extrapolation
at most 35 ms. Three presets in settings (`aimCurve`), raised on 2026-10-02 after the owner played with the mouse ("not sensitive enough"; not yet tried on a real Joy-Con): **Precise** 6 px/deg slow to 17 px/deg fast, **Balanced** 8 to 24 (default), **Fast** 11 to 32; the vertical gain is capped at about 0.8x
the fast gain (13 / 19 / 25). Values in `MOTION_CONFIG.shooter`. `sensitivity` (0.5 to 3.0) multiplies the whole curve. All UNVERIFIED-ON-HARDWARE for shooting until the
recording session (section 11).

### 6.3 Trigger compensation (the most important feel parameter)

Pressing ZR jerks the wrist. The shot uses the aim position at `pressTime - triggerCompMs` taken from the pointer history
(`motion.recent()`), where `pressTime` is the timestamp of the first input report that shows the button down. Default `triggerCompMs = 40`,
range 0 to 100 in steps of 10 (setting "Trigger steadiness"). With the mouse and the simulator the compensation is 0. The value 40 is a
guess (UNVERIFIED-ON-HARDWARE); the recording session measures the real jerk and sets it.

### 6.4 Recoil and rumble

On every shot: the gun sprite kicks (8 px up, 3 degrees, back in 140 ms), the camera shakes (amplitude 6 px, 120 ms; off with reduce
motion), the crosshair blooms. Rumble preset 5 through the bridge (`vibrate(5)`), setting "Rumble" on by default for a real Joy-Con,
UNVERIFIED-ON-HARDWARE.

### 6.5 Aim assist (off by default)

Setting "Aim assist": Off / Light. Light enlarges the pattern by 15 percent and pulls the compensated aim point 25 percent of the way
towards a target whose centre is within 1.6 pattern radii. Results are marked "assist" in the best scores.

## 7. Modes and stages

### 7.1 Classic (the main mode, "Tour of the Range")

Three stages played in order, one continuous score. A "pull" is one launch (a single or a double); the player calls it.

| Stage | Backdrop | Pulls | Content | Wind |
|---|---|---|---|---|
| 1 Morning Meadow | `meadow` (spring, blue sky) | 10 | singles from `trap`, 18 to 22 m/s, 1 mini in the last 3 | none |
| 2 Golden Hills | `hills` (late afternoon) | 8 | 4 singles (skeet crossers L/R), 4 doubles (L+R together, or trap pair 0.4 s apart), 1 gold | steady 1.5 m/s, random side |
| 3 Alpine Dusk | `alpine` (dusk) | 8 | 2 singles from `tower`, 3 doubles mixed, 2 rabbit + clay, 1 battue double | 2.5 m/s with gusts (+-1 m/s, period 3 s) |

Targets presented: 10 + 12 + 14 = 36. Between stages a 2.5 s stage card ("STAGE 2: GOLDEN HILLS", wind arrow, best so far) and a crossfade.

Pull cycle: `ready` (HUD says "Press ZR: PULL!") -> the player fires -> "PULL!" cue -> seeded delay 0.15 to 0.55 s -> launch -> `flight`
(2 shells) -> when every target of the pull is broken or lost -> 0.7 s `settle` -> next `ready`. In `ready` the gun is loaded with a
two-shell insert animation (0.4 s). Auto-pull: if the player does not call within 6 s, the HUD pulses; the setting "Auto pull" (off) calls
it after 1.2 s.

### 7.2 Time Attack

90 seconds, any stage (chosen in the menu; default Golden Hills). Targets launch automatically, one wave at a time (owner decision
2026-10-03: never more clays in the air than shells in the gun). A wave is a single or a double (doubles from 15 percent of the waves at
the start to 60 percent at 90 s). Each wave refills the gun to 2 shells instantly; the next wave starts only when every target of the
previous one is broken or lost, after a gap that shrinks from 1.4 s to 0.5 s over the first 90 s. There is no other reload: two misses
leave the gun empty until the next wave (dry click). Every broken target adds time: +1.5 s for the first 20 breaks, then +0.75 s up to break 40, then +0.25 s
(max 120 s on the clock). The round ends ("TIME!") after 180 s of real round time at the latest, and the clock is honest: it never shows
more than the time really left (`min(clock, 180 - elapsed)`), so the round always ends at 0:00. Score, streak and doubles as in Classic
(Zen counts doubles in its statistics too).

Rank by score thresholds, re-derived on 2026-10-03 from simulated players (QA F1): S 175,000, A 85,000, B 33,000, C 17,000, else D. The
measured scores (bot that hits each shot with a fixed probability; 3 stages x 4 seeds per row; min / median / max):

| Hit rate | Easy | Normal | Hard | Rank |
|---|---|---|---|---|
| 40 % | 7.6k / 13.0k / 16.7k | 7.2k / 12.5k / 16.7k | 7.2k / 12.3k / 16.6k | D |
| 60 % | 16.9k / 24.8k / 30.7k | 17.9k / 23.6k / 27.8k | 17.9k / 22.6k / 27.4k | C |
| 75 % | 39k / 52k / 71k | 37k / 51k / 72k | 37k / 51k / 76k | B |
| 90 % | 111k / 136k / 160k | 111k / 133k / 158k | 97k / 138k / 156k | A |
| 100 % | 196k / 234k / 256k | 196k / 239k / 259k | 189k / 228k / 244k | S |

The difficulties score within 5 percent of each other (the distance bonus uses the Normal-world depth), so one table serves all three.
The scores grow so fast with the hit rate because a good player keeps the clock up (up to the 180 s cap) and the x4 streak.

### 7.3 Zen (practice)

No score, no timer, unlimited shells, instant reload, slow targets (x0.8 speed), pattern x1.3, choose the stage. Shows small statistics
(hits, accuracy in the last 20 shots). Leave with pause -> "End session".

### 7.4 Difficulty (menu choice before Classic and Time Attack)

The difficulty mainly changes the distance (owner decision 2026-10-03): Easy shows the same throws closer, Hard farther (world scale k,
section 3), in Classic and Time Attack; accentuated on 2026-10-03 (was 0.7 / 1.25) because the owner could not feel it. Zen plays at the
Easy distance. Hard keeps the Normal speed and a slightly wider pattern (x1.1, the clays are smaller) so that the smaller clays and the
lead are the whole challenge. The renderer may add a cosmetic backdrop zoom from `snapshot.worldScale`.

| | Easy | Normal | Hard |
|---|---|---|---|
| Distance (world scale k) | x0.55 (clearly closer, clays about 1.8x bigger) | x1 | x1.45 (clearly farther, clays about 0.7x) |
| Target speed | x0.9 | x1 | x1 |
| Pattern radius | x1.15 | x1 | x1.1 |
| Shot | instant | instant | pellet travel 750 m/s |
| Wind | x0.5 | x1 | x1.2 |

## 8. Juice (the owner wants spectacular effects; each has a reduce-flashing and a reduce-motion twin)

- Shot: muzzle flash sprite at the barrel tip (2 frames, 60 ms), additive glow, smoke puff drifting with the wind, a shell casing ejected
  in an arc (only when the gun opens after the pull, as in a real over-and-under), recoil kick, camera shake, crosshair bloom, the
  "BOOM" sound with a low thump and a tail.
- Break: 6 to 10 shards (sprites `shard_*`, seeded velocities, gravity, spin, fade at 1.2 s), a dust burst (`fx_dust_burst`, scaled by
  depth), an orange powder ring, hit-stop 40 ms (world freeze, not the UI; skipped while another clay still flies, 2026-10-03), a points popup that rises and fades ("+175"), "SMOKED!" on
  centre hits.
- Kill cam: on a centre hit that ends a double or a stage, or a gold, slow motion `timeScale 0.25` for 0.45 s with a 1.12 zoom on the hit
  point and a letterbox vignette. Off with reduce motion (replaced by a still flash frame of 80 ms).
- Banners: "DOUBLE!", "STREAK x3", "PERFECT STAGE", "NEW BEST!"; stamped rank on the results screen (scale 2.2 -> 1 with a thud).
- Miss feedback: a faint pellet cloud where the shot went (12 dots that fade in 250 ms) so the player sees behind/ahead.
- Transitions: crossfade 400 ms between screens; stage card slides.
- Audio (WebAudio synth, no files): shot boom (noise burst + 60 Hz thump + reverb tail), dry click, clay crack (filtered noise + ping),
  shell insert click, "Pull!" cue (a two-tone whistle, no voice), trap thrower clunk, wind ambience (filtered noise, stage-dependent),
  birdsong chirps in stage 1 and 2 (synthesised, sparse), crickets in stage 3, UI tick and confirm.

## 9. Screens (UI, English)

Safety ("Before you play": clear space, wrist strap, do not point at people), Boot, Title / main menu (logo, Classic, Time Attack, Zen,
Best scores, Settings, Controller), Connect (native bridge first, simulator and mouse), Calibration (hold still, point at the screen
centre, test shot at a practice clay), Difficulty choice, Stage choice (Time Attack and Zen), Countdown, Playing (HUD), Stage card, Pause
(Resume, Recentre, Settings, Quit), Results, Best scores, Settings, Aim tuning (live crosshair, shows deg/s and the trigger jerk of the last
shot). Bottom hint line on every screen with the key glyphs of the active controller.

HUD: top-left score with the streak multiplier ring; top-centre stage name and pull counter ("PULL 4/10") or the Time Attack clock;
top-right wind sock with speed; bottom-left two shell icons (full / empty) with the reload animation; target counter as small clay icons
(broken = orange, lost = grey); low-battery toast.

## 10. Art

Style "Golden-hour countryside": clean stylised flat-vector game art with soft painterly gradients, thin dark outlines (#1B1F24) only on
gameplay objects, no outlines on scenery. The generated files are listed in `design/PROVENANCE-jobs.csv` with their Higgsfield job ids.
Every image is optional: a procedural painter draws a matching fallback (sky gradient, hills, clay ellipse with rim, gun silhouette).
Fonts: `ClayDisplay` (Bebas Neue, display, numerals) and `ClayUI` (Barlow 600 and 700). Minimum text 28 px, minimum target 84 px.

Readability rules: the sky band where targets fly has no detail in the centre; clays have a dark rim and keep the highest saturation on
screen; the crosshair is a white ring with a dark outline and a centre dot, the colour can be changed in settings (white, yellow, green,
magenta) for colour-blind players.

## 11. Hardware session (after the first playable build, about 20 minutes)

Record with `tools/record-imu.mjs` (steps in `tools/shooting-steps.json`): aim at 5 fixed points and hold 2 s each; track a slow moving
dot; 20 snap shots with ZR; 20 trigger pulls while holding still (the trigger jerk); a sequence of 50 shots; lower and raise the arm.
From it: the jerk amplitude and timing (sets `triggerCompMs`), the hold-still stability (target: under 10 px over 10 s), the 90 percent
rule (the fired position within a few px of the aimed one after compensation). Until then every feel value is a guess.
