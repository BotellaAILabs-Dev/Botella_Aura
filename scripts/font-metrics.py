"""
Regenerate assets/fonts/metrics.json — the advance width of every character in
each bundled creative font (lib/creative/text-fit.ts measures text with it, so
headlines are wrapped and sized exactly rather than guessed).

Run after adding or changing a font in assets/fonts:
    pip install fonttools
    python scripts/font-metrics.py
"""
import glob
import json
import os

from fontTools.ttLib import TTFont

out = {}
for path in sorted(glob.glob(os.path.join('assets', 'fonts', '*.woff'))):
    font = TTFont(path)
    cmap = font.getBestCmap()
    hmtx = font['hmtx'].metrics
    advances = {str(cp): hmtx[name][0] for cp, name in cmap.items() if name in hmtx}
    out[os.path.basename(path)] = {
        'unitsPerEm': font['head'].unitsPerEm,
        'advances': advances,
    }

with open(os.path.join('assets', 'fonts', 'metrics.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, separators=(',', ':'))
print('wrote', len(out), 'fonts')
