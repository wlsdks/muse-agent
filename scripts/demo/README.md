# The README terminal demo

`docs/images/muse-continue.gif` is generated, not hand-drawn, and every line in it is real output
from the CLI in this repo.

1. `record-setup.sh` builds a throwaway `HOME` with one fictional note and one task, so no personal
   data can appear and the run reproduces from scratch.
2. The real commands run against it and their output is captured verbatim into `transcript.txt`.
3. `build-frames.mjs` turns that transcript into per-frame HTML (typing reveal, blinking cursor).
4. Each frame is rasterized headless at 2x and encoded with a diff palette:

```bash
bash scripts/demo/record-setup.sh
node scripts/demo/build-frames.mjs
# rasterize frames/*.html at --window-size=993,392 --force-device-scale-factor=2, then:
ffmpeg -framerate 8 -pattern_type glob -i 'png/f*.png' -vf scale=900:-1,palettegen=stats_mode=diff pal.png
ffmpeg -framerate 8 -pattern_type glob -i 'png/f*.png' -i pal.png \
  -lavfi '[0:v]scale=900:-1[x];[x][1:v]paletteuse=diff_mode=rectangle' -loop 0 muse-continue.gif
```

Regenerate it whenever the `muse continue` output format changes — a demo that shows output the CLI
no longer prints is worse than no demo.
