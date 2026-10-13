# Creative fonts

Fonts used by the marketing-creative renderer (`server/media/creative`). They
are bundled with the app so text renders identically everywhere, with no
system fonts and no network.

| File                        | Family                                     | Licence                                           |
| --------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `inter-400/600/800.woff`    | Inter (Latin)                              | SIL OFL 1.1 — `LICENSES/inter-OFL.txt`            |
| `inter-ext-400/800.woff`    | Inter (Latin Extended: ₹ and other glyphs) | SIL OFL 1.1                                       |
| `montserrat-700/800.woff`   | Montserrat                                 | SIL OFL 1.1 — `LICENSES/montserrat-OFL.txt`       |
| `playfair-display-700.woff` | Playfair Display                           | SIL OFL 1.1 — `LICENSES/playfair-display-OFL.txt` |
| `bebas-neue-400.woff`       | Bebas Neue                                 | SIL OFL 1.1 — `LICENSES/bebas-neue-OFL.txt`       |

The files are the Fontsource static WOFF builds.

`metrics.json` holds every glyph's advance width, used to measure and wrap
text exactly. After adding or changing a font, regenerate it:

```bash
pip install fonttools
python scripts/font-metrics.py
```
