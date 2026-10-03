#!/usr/bin/env bash
# README hero: docs/img/hero.gif (960x540, 25 fps, about 7 s, one global palette, bayer dither) and docs/img/hero-poster.jpg (1920x1080).
# Source clips (real gameplay, captured by capture-gameplay.mjs; commands in video/README.md):
#   footage/gif-easy.mp4  Classic on Easy, seed 7, --hold-aim, 50 fps, from 4.0 s of the round: one frame in two gives exact 25 fps
#   footage/classic.mp4   Classic on Normal, seed 7, 60 fps (poster frame)
# Size: the backdrop's parallax follows the aim, so most frames change everywhere; 56 colours, bayer scale 5 and a light temporal
# denoise keep the file near 6 MB. Usage: video/tools/make-gif.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/footage/gif-easy.mp4"
OUT="$ROOT/docs/img"
TMP="$HERE/renders/gif"
mkdir -p "$OUT" "$TMP"
# A: Morning Meadow: a pull, SMOKED!, the STREAK X2 banner, then the next clay   (clip 0.20 - 4.60 s)
# B: Golden Hills: a skeet double, the second clay broken in the slow-motion kill cam, DOUBLE!   (clip 20.95 - 23.75 s)
FILTER="[0:v]trim=start=0.20:end=4.60,setpts=PTS-STARTPTS[a];[0:v]trim=start=20.95:end=23.75,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,fps=25,scale=960:540:flags=lanczos,hqdn3d=3:3:30:30"
ffmpeg -y -loglevel error -i "$SRC" -filter_complex "${FILTER},palettegen=max_colors=56:stats_mode=full" "$TMP/palette.png"
ffmpeg -y -loglevel error -i "$SRC" -i "$TMP/palette.png" -filter_complex "${FILTER}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$OUT/hero.gif"
ffprobe -v error -count_frames -show_entries stream=width,height,nb_read_frames,r_frame_rate:format=duration,size -of compact "$OUT/hero.gif"
# poster: the Golden Hills double in the kill cam (DOUBLE!, SMOKED!), full resolution, from the Normal round
ffmpeg -y -loglevel error -ss 26.55 -i "$HERE/footage/classic.mp4" -frames:v 1 -q:v 2 "$OUT/hero-poster.jpg"
ls -la "$OUT"
