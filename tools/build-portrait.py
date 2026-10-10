#!/usr/bin/env python
"""
build-portrait.py — turns a photo into the 1-bit dithered portrait bitmaps used by
the "VISUAL.MAP" panel of the profile banner (tools/generate-banner.mjs).

    python tools/build-portrait.py <photo> [--recut] [--no-hand] [--crop=x0,y0,w]

Pipeline:
  1. rembg cutout (cached in .ref/cutout.png).
  2. Crop to a bust framing. Default keeps the raised peace-sign hand inside the frame
     (face focal at ~48% width, hand margin ~30px); --no-hand gives the symmetric bust
     (head horizontally centered, ~37% frame width, ~35px headroom).
  3. Mask out laptop / stickers (and, with --no-hand, the raised arm).
  4. Feathered silhouette edge.
  5. Bilateral edge-preserving denoise (clean dot screen on jacket, no TV static).
  6. CLAHE local contrast + tailored contrast S-curve with headroom (keeps face tonal gradation).
  7. Floyd-Steinberg error diffusion dither.
  8. Dark theme: lit skin with gradation (67-72%), dense dark jacket/hair with crisp silhouette.
     Light theme: inverted within person mask (dense jacket/hair, open face).
  9. Three logo masks (React atom, </>, Node.js hexagon).
  10. Output assets/visual-map.json and .ref/visual-map-preview.png.

Needs: Pillow, numpy, scipy, scikit-image, rembg.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw
from scipy import ndimage
from skimage import exposure, restoration

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / 'assets' / 'visual-map.json'
CUTOUT = ROOT / '.ref' / 'cutout.png'
PREVIEW = ROOT / '.ref' / 'visual-map-preview.png'

# ---- grid: portrait field is ~372 x 490 px inside the 400x492 frame; ~1.3 px per cell ----
GRID_W, GRID_H = 286, 377

# Crops in source photo coordinates (x0, y0, width); height follows the grid aspect.
# Default (with hand): face (x 915-1150, hair top y~195) is the focal point at ~48% of the frame
# width with ~45px headroom; the raised peace-sign hand (fingertips x~820) sits fully inside with a
# ~30px margin. The frame bottom (source y~776) stops just above the hands on the keyboard / watch.
CROP_WITH_HAND = (800, 135, 486)
# --no-hand: symmetric bust, head horizontally centred (~37% frame width, ~35px headroom)
CROP_NO_HAND = (758, 147, 514)

# Laptop / stickers / keyboard mask: only left of the jacket sleeve (sleeve is x > ~765 at y 650-760)
LAPTOP_MASK = [
    [(400, 560), (735, 590), (765, 700), (785, 800), (790, 960), (400, 960)],
]

ALPHA_T = 0.5
EDGE_SHAVE = 3      # source px eroded off the cutout to drop the brick-coloured fringe
FEATHER = 0.8       # grid-px sigma of the soft silhouette edge

# ---- tone: Bilateral denoise + CLAHE + independent per-theme tone curves (Round 6) ----
BILATERAL_SIGMA_COLOR = 0.09
BILATERAL_SIGMA_SPATIAL = 2.5
CLAHE_CLIP = 0.03
CLAHE_BLEND = 0.60

# Dark theme tone curve: darkest band dotted (~16%), face lifted to mean 78-82%
DARK_FLOOR = 0.15
DARK_SLOPE = 9.0
DARK_MID = 0.37
DARK_MAX = 0.94

# Light theme tone curve: darkest band solid 1.0, bright skin near-white (0.05-0.10)
LIGHT_KNEE = 0.24
LIGHT_SLOPE = 8.5
LIGHT_MID = 0.42
LIGHT_SKIN_FLOOR = 0.05
LIGHT_EDGE = 1             # silhouette contour thickness (cells)
LIGHT_HAND_EDGE = 2        # contour thickness around the raised hand
LIGHT_HAND_DENSITY = 0.27  # even dot density inside the hand
HAND_BOX = (140, 300, 0, 100)   # grid rows y0:y1, cols x0:x1 that contain the hand + forearm
HAND_WARM = 18             # R-B threshold that separates skin from the grey jacket

REMBG_MODEL = 'silueta'   # small (43 MB) u2net derivative

# preview colours: (frame background, dots) per theme
PREVIEW_DARK = ((10, 16, 31), (167, 139, 250))
PREVIEW_LIGHT = ((248, 250, 252), (124, 58, 237))


def cutout(photo: Path, recut: bool) -> Image.Image:
    if CUTOUT.exists() and not recut:
        return Image.open(CUTOUT).convert('RGBA')
    from rembg import new_session, remove
    img = remove(Image.open(photo).convert('RGB'), session=new_session(REMBG_MODEL))
    CUTOUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(CUTOUT)
    return img


def prepare(rgba: Image.Image, with_hand: bool):
    """-> (d_tone, l_tone 0..1 at grid resolution, person-mask weight 0..1, inside bool mask, light contour mask)."""
    if with_hand:
        x0, y0, cw = CROP_WITH_HAND
        ch = round(cw * GRID_H / GRID_W)
        box = (x0, y0, x0 + cw, y0 + ch)

        keep = Image.new('L', rgba.size, 255)
        d = ImageDraw.Draw(keep)
        for poly in LAPTOP_MASK:
            d.polygon(poly, fill=0)
        alpha = ImageChops.multiply(rgba.getchannel('A'), keep)

        canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
        canvas.paste(rgba.crop(box), (0, 0))
        a = Image.new('L', (cw, ch), 0)
        a.paste(alpha.crop(box), (0, 0))
        gray = canvas.convert('L')
    else:
        # Default: clean symmetric bust without hand
        x0, y0, cw = CROP_NO_HAND
        ch = round(cw * GRID_H / GRID_W)
        box = (x0, y0, x0 + cw, y0 + ch)

        crop_raw = rgba.crop(box)

        # Smooth natural left shoulder contour:
        # Curves from jaw down along the neckline to collar, then out to the bottom-left corner
        bg_poly = [
            (0, 0), (150, 0), (150, 270), (175, 330),
            (170, 360), (160, 400), (140, 440), (105, 490), (65, 550), (20, 620), (0, 677),
            (0, 0)
        ]

        alpha_mask = Image.new('L', crop_raw.size, 255)
        d_mask = ImageDraw.Draw(alpha_mask)
        d_mask.polygon(bg_poly, fill=0)
        clean_a = ImageChops.multiply(crop_raw.getchannel('A'), alpha_mask)

        # Fill sleeve polygon inside the shoulder contour with jacket color:
        sleeve_poly = [
            (170, 360), (160, 400), (140, 440), (105, 490), (65, 550), (20, 620), (0, 677),
            (220, 677), (220, 450), (170, 360)
        ]
        canvas = crop_raw.copy()
        d_rgb = ImageDraw.Draw(canvas)
        d_rgb.polygon(sleeve_poly, fill=(28, 28, 30, 255))
        d_clean = ImageDraw.Draw(clean_a)
        d_clean.polygon(sleeve_poly, fill=255)
        canvas.putalpha(clean_a)

        a = clean_a
        gray = canvas.convert('L')

    # Silhouette: largest blob, fill holes, open, shave fringe, feather at grid resolution
    m = np.array(a) > 255 * ALPHA_T
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    m = ndimage.binary_fill_holes(m)
    m = ndimage.binary_opening(m, iterations=2)
    m = ndimage.binary_erosion(m, iterations=EDGE_SHAVE)
    mg = np.array(Image.fromarray((m * 255).astype(np.uint8)).resize((GRID_W, GRID_H), Image.BOX),
                  dtype=np.float32) / 255
    mg = ndimage.gaussian_filter(mg, FEATHER)
    weight = np.clip((mg - 0.2) / 0.6, 0, 1)
    inside = mg > 0.4

    # Tone at grid resolution
    g_grid = np.array(gray.resize((GRID_W, GRID_H), Image.LANCZOS), dtype=np.float32) / 255
    lo, hi = np.percentile(g_grid[inside], (0.2, 99.8))
    lin = np.clip((g_grid - lo) / max(hi - lo, 1e-3), 0, 1)
    lin[~inside] = np.median(lin[inside])

    # Step A: Bilateral edge-preserving denoise (clean dot screen on jacket)
    denoised = restoration.denoise_bilateral(lin, sigma_color=BILATERAL_SIGMA_COLOR, sigma_spatial=BILATERAL_SIGMA_SPATIAL)

    # Step B: CLAHE local contrast + S-curve with headroom
    cl = exposure.equalize_adapthist(denoised, kernel_size=GRID_W // 4, clip_limit=CLAHE_CLIP)
    tone = (1 - CLAHE_BLEND) * denoised + CLAHE_BLEND * cl

    # 1. Dark curve: darkest band dotted (floor ~0.15), face lifted to 78-82% with smooth gradation
    s_curve_dark = DARK_MAX / (1.0 + np.exp(-DARK_SLOPE * (tone - DARK_MID)))
    d_tone = np.maximum(DARK_FLOOR + tone * 0.15, s_curve_dark)
    d_tone = np.clip(d_tone, 0, DARK_MAX)

    # 2. Light curve: darkest band (tone < 0.24) solid 1.0 (hair/jacket), bright skin near-white (~0.05-0.10)
    s_inv = 1.0 / (1.0 + np.exp(LIGHT_SLOPE * (tone - LIGHT_MID)))
    l_tone = np.where(tone < LIGHT_KNEE, 1.0, LIGHT_SKIN_FLOOR + (1.0 - LIGHT_SKIN_FLOOR) * s_inv)
    l_tone = np.clip(l_tone, 0, 1.0)

    # 3. Light-theme silhouette contour (light bitmap only): skin on the near-white background needs a
    #    defined edge. 1-cell band along the person-mask boundary (frame-clipped sides are not outlined:
    #    border_value=1 treats the frame edge as interior); 2 cells around the raised hand.
    edge = inside & ~ndimage.binary_erosion(inside, iterations=LIGHT_EDGE, border_value=1)
    if with_hand:
        rows, cols = np.mgrid[0:GRID_H, 0:GRID_W]
        hy0, hy1, hx0, hx1 = HAND_BOX
        in_box = (rows >= hy0) & (rows < hy1) & (cols >= hx0) & (cols < hx1)
        rgb = np.array(canvas.convert('RGB').resize((GRID_W, GRID_H), Image.BOX), dtype=np.float32)
        warm = (rgb[..., 0] - rgb[..., 2]) > HAND_WARM       # skin is warm, the jacket is grey
        hand = in_box & inside & warm
        hand = ndimage.binary_closing(hand, iterations=2) & in_box & inside
        lab_h, n_h = ndimage.label(hand)                      # keep the main hand blob only
        if n_h > 1:
            hand = lab_h == (1 + int(np.argmax(ndimage.sum(hand, lab_h, range(1, n_h + 1)))))
        hand_zone = ndimage.binary_dilation(hand, iterations=LIGHT_HAND_EDGE) & inside
        edge |= hand_zone & ~ndimage.binary_erosion(hand_zone, iterations=LIGHT_HAND_EDGE, border_value=1) \
            & ~ndimage.binary_erosion(inside, iterations=LIGHT_HAND_EDGE + 1, border_value=1)
        # hand skin: even 20-30% dither so fingers and the V gap read (face skin stays near-white)
        l_tone = np.where(hand, np.maximum(l_tone, LIGHT_HAND_DENSITY), l_tone)

    return d_tone, l_tone, weight, inside, edge


def floyd_steinberg(gray: np.ndarray) -> np.ndarray:
    h, w = gray.shape
    buf = np.pad(gray.astype(np.float64), ((0, 1), (1, 1)))
    out = np.zeros((h, w), dtype=bool)
    for y in range(h):
        xs = range(1, w + 1) if y % 2 == 0 else range(w, 0, -1)
        s = 1 if y % 2 == 0 else -1
        for x in xs:
            old = buf[y, x]
            new = 1.0 if old >= 0.5 else 0.0
            out[y, x - 1] = new == 1.0
            e = old - new
            buf[y, x + s] += e * 7 / 16
            buf[y + 1, x - s] += e * 3 / 16
            buf[y + 1, x] += e * 5 / 16
            buf[y + 1, x + s] += e * 1 / 16
    return out


# ---------------------------------------------------------------- logos
SS = 4  # supersampling for logo masks


def _canvas():
    return Image.new('L', (GRID_W * SS, GRID_H * SS), 0)


def _pts(points, cx, cy):
    return [((cx + x) * SS, (cy + y) * SS) for x, y in points]


def _finish(img) -> np.ndarray:
    small = img.resize((GRID_W, GRID_H), Image.BOX)
    return np.array(small) >= 128


def _ellipse_pts(a, b, rot_deg, cx, cy, n=96):
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x, y = a * math.cos(t), b * math.sin(t)
        pts.append((x * c - y * s, x * s + y * c))
    return _pts(pts, cx, cy)


def logo_react(cx, cy) -> np.ndarray:
    total = _canvas()
    for rot in (0, 60, 120):
        ring = _canvas()
        d = ImageDraw.Draw(ring)
        d.polygon(_ellipse_pts(90, 34, rot, cx, cy), fill=255)
        d.polygon(_ellipse_pts(73, 19, rot, cx, cy), fill=0)
        total = ImageChops.lighter(total, ring)
    d = ImageDraw.Draw(total)
    r = 13
    d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=255)
    return _finish(total)


def logo_code(cx, cy) -> np.ndarray:
    img = _canvas()
    d = ImageDraw.Draw(img)
    left = [(-60, -60), (-37, -60), (-72, 0), (-37, 60), (-60, 60), (-95, 0)]
    d.polygon(_pts(left, cx, cy), fill=255)
    d.polygon(_pts([(-x, y) for x, y in left], cx, cy), fill=255)
    d.polygon(_pts([(7, -66), (28, -66), (-7, 66), (-28, 66)], cx, cy), fill=255)
    return _finish(img)


def logo_hex(cx, cy) -> np.ndarray:
    img = _canvas()
    d = ImageDraw.Draw(img)
    R = 102
    hexa = [(R * math.cos(math.radians(60 * i - 90)), R * math.sin(math.radians(60 * i - 90))) for i in range(6)]
    d.polygon(_pts(hexa, cx, cy), fill=255)
    t = 17
    for poly in (
        [(-38, -46), (-38 + t, -46), (-38 + t, 46), (-38, 46)],
        [(38 - t, -46), (38, -46), (38, 46), (38 - t, 46)],
        [(-38, -46), (-38 + t + 3, -46), (38, 46), (38 - t - 3, 46)],
    ):
        d.polygon(_pts(poly, cx, cy), fill=0)
    return _finish(img)


# ---------------------------------------------------------------- output
def rle(bitmap: np.ndarray):
    rows = []
    for row in bitmap:
        runs, x, w = [], 0, row.size
        while x < w:
            if row[x]:
                s = x
                while x < w and row[x]:
                    x += 1
                runs += [s, x - s]
            else:
                x += 1
        rows.append(runs)
    return rows


def preview(path: Path, dark, light, logos=()):
    tiles = []
    for bm, (bg, fg) in [(dark, PREVIEW_DARK), (light, PREVIEW_LIGHT)] + [(l, PREVIEW_DARK) for l in logos]:
        img = np.empty((GRID_H, GRID_W, 3), dtype=np.uint8)
        img[:] = bg
        img[bm] = fg
        tiles.append(Image.fromarray(img).resize((GRID_W * 2, GRID_H * 2), Image.NEAREST))
    sheet = Image.new('RGB', (sum(t.width for t in tiles) + 8 * (len(tiles) - 1), tiles[0].height), (60, 60, 60))
    x = 0
    for t in tiles:
        sheet.paste(t, (x, 0))
        x += t.width + 8
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        sys.exit(__doc__)
    flags = {a[2:].split('=')[0]: a.split('=')[1] if '=' in a else True for a in sys.argv[1:] if a.startswith('--')}
    with_hand = 'no-hand' not in flags
    if 'crop' in flags:
        global CROP_WITH_HAND, CROP_NO_HAND
        crop = tuple(int(v) for v in flags['crop'].split(','))
        if with_hand:
            CROP_WITH_HAND = crop
        else:
            CROP_NO_HAND = crop

    d_tone, l_tone, weight, inside, edge = prepare(cutout(Path(args[0]), 'recut' in flags), with_hand)
    dark = floyd_steinberg(d_tone * weight) & inside
    light = (floyd_steinberg(l_tone * weight) & inside) | edge

    # Calculate face density metrics:
    # density report (lit fraction inside the person mask): face cheeks/forehead, and the raised hand's palm
    face_box = (slice(80, 160), slice(80, 175)) if with_hand else (slice(75, 160), slice(105, 180))
    palm_box = (slice(230, 275), slice(34, 70))
    def dens(bm, box):
        return bm[box][inside[box]].mean()
    print(f'density (inside mask): face dark={dens(dark, face_box):.1%} light={dens(light, face_box):.1%}'
          + (f'  palm dark={dens(dark, palm_box):.1%} light={dens(light, palm_box):.1%}' if with_hand else ''))

    cx, cy = GRID_W / 2, GRID_H / 2
    logos = [logo_react(cx, cy), logo_code(cx, cy), logo_hex(cx, cy)]
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        'w': GRID_W, 'h': GRID_H,
        'dark': rle(dark), 'light': rle(light),
        'logos': [rle(l) for l in logos],
    }, separators=(',', ':')), encoding='utf-8')
    preview(PREVIEW, dark, light, logos)
    print(f'grid {GRID_W}x{GRID_H} (with_hand={with_hand}): lit dark={int(dark.sum())} light={int(light.sum())}  '
          f'logos={[int(l.sum()) for l in logos]}')
    print(f'wrote {OUT_JSON.relative_to(ROOT)} ({OUT_JSON.stat().st_size} bytes), {PREVIEW.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
