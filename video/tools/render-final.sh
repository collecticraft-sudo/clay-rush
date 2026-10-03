#!/usr/bin/env bash
# Renders the Clay Rush presentation video: edit slots + sound, HyperFrames check, render (1080p, 30 fps, libx264 CRF 17),
# two-pass loudness normalisation to -16 LUFS integrated / -1.5 dBTP true peak, poster frame, QA numbers.
# Usage: video/tools/render-final.sh [draft]      ("draft" = 15 fps quick look at 960x540 into video/renders/)
# Needs the clips in video/footage/ (video/README.md lists the capture commands). HyperFrames runs from the npx cache (pinned 0.8.104).
set -euo pipefail
export HYPERFRAMES_SKIP_SKILLS=1 HYPERFRAMES_NO_TELEMETRY=1
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HF="npx --yes hyperframes@0.8.104"
MODE="${1:-final}"
cd "$HERE"
node tools/build-edit.mjs          # footage slots of composition/index.html from composition/edit.json
node tools/build-audio.mjs         # composition/audio/mix.wav: music + gunshots / clay cracks at the captured event frames
mkdir -p renders
cd composition
$HF check
if [ "$MODE" = "draft" ]; then
  $HF render --quality draft --fps 15 --workers 1 --output ../renders/draft-15fps.mp4
  ffmpeg -y -loglevel error -i ../renders/draft-15fps.mp4 -vf scale=960:540 -c:v libx264 -crf 24 -preset fast -c:a aac -b:a 128k ../renders/draft-960x540.mp4
  echo "draft: video/renders/draft-960x540.mp4"; exit 0
fi
RAW=../renders/clay-rush-presentation-raw.mp4
$HF render --quality delivery --crf 17 --fps 30 --workers 1 --output "$RAW"
test -s "$RAW"
cd "$HERE"
RAW=renders/clay-rush-presentation-raw.mp4
# loudness: two-pass linear loudnorm (picture stream copied untouched, audio re-encoded AAC 192 kb/s)
M="$(ffmpeg -hide_banner -i "$RAW" -vn -af loudnorm=I=-16:TP=-2:LRA=11:print_format=json -f null - 2>&1 | sed -n '/{/,/}/p')"
v() { echo "$M" | grep "\"$1\"" | sed 's/[^0-9.-]*\(-\{0,1\}[0-9.]*\).*/\1/'; }
OUT=renders/clay-rush-presentation.mp4
ffmpeg -y -loglevel error -i "$RAW" -map 0:v -map 0:a -c:v copy \
  -af "loudnorm=I=-16:TP=-2:LRA=11:measured_I=$(v input_i):measured_TP=$(v input_tp):measured_LRA=$(v input_lra):measured_thresh=$(v input_thresh):offset=$(v target_offset):linear=true,aresample=48000" \
  -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
test -s "$OUT"
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,pix_fmt:format=duration,size -of compact "$OUT"
ffmpeg -hide_banner -i "$OUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | tail -3
ffmpeg -hide_banner -i "$OUT" -vf "blackdetect=d=0.05:pix_th=0.1" -an -f null - 2>&1 | grep -E "black_start" || echo "blackdetect d=0.05 pix_th=0.1: no black segment"
cp "$OUT" clay-rush-presentation.mp4
# poster: the end card once everything is on screen
ffmpeg -y -loglevel error -ss 31.3 -i clay-rush-presentation.mp4 -frames:v 1 -q:v 2 poster.jpg
echo "final: video/clay-rush-presentation.mp4, video/poster.jpg"
