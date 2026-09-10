"""Room numbers, recovered from the stroked glyph geometry on B-SP-ROOM_NO.

    .venv/bin/python scripts/py/ocr.py MC

The plans have no text layer at all: AutoCAD plotted SHX fonts, so every room
number is a bundle of short line strokes. They do sit on their own layer, so we
cluster those strokes into label groups, render each group alone at a generous
resolution, and read it with Tesseract. Recognition happens in *plan* space,
where the text is upright; only the resulting centroid is pushed through the
georeference to find which room it belongs to.

Writes the numbers back into build/walk/<CODE>.json.
"""
import argparse, json, math, os, re, sys

import numpy as np
import pytesseract
from PIL import Image
from scipy import ndimage as ndi
from skimage.draw import line as skline
from skimage.morphology import dilation, disk, closing

sys.path.insert(0, os.path.dirname(__file__))
import georef as G

OUT = os.path.join(G.ROOT, 'build', 'walk')
PLANS_JSON = os.path.join(G.ROOT, 'build', 'plans')

PPU = 6.0              # pixels per plan unit when rendering a label
GROUP_R = 12           # px closing radius that binds the digits of one label
MIN_INK = 60           # px; below this a group is a tick mark, not a number
PAD = 8
CFG = '--psm 7 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-'
CLEAN = re.compile(r'[^0-9A-Z.\-]')


def render(strokes, x0, y0, w, h):
    img = np.zeros((h, w), bool)
    for pl in strokes:
        a = np.asarray(pl, float)
        c = np.clip(((a[:, 0] - x0) * PPU).astype(int), 0, w - 1)
        r = np.clip(((a[:, 1] - y0) * PPU).astype(int), 0, h - 1)
        for i in range(len(a) - 1):
            rr, cc = skline(r[i], c[i], r[i + 1], c[i + 1])
            img[rr, cc] = True
    return img


def label_groups(strokes):
    """-> [(text_image, centroid in plan units)] for each cluster of glyph strokes."""
    pts = np.array([p for pl in strokes for p in pl], float)
    x0, y0 = pts.min(0) - 2
    x1, y1 = pts.max(0) + 2
    w = int((x1 - x0) * PPU) + 1
    h = int((y1 - y0) * PPU) + 1
    if w * h > 200_000_000:
        return []
    img = render(strokes, x0, y0, w, h)
    lab, n = ndi.label(closing(img, disk(GROUP_R)))
    out = []
    for i in range(1, n + 1):
        m = lab == i
        ink = img & m
        if ink.sum() < MIN_INK:
            continue
        ys, xs = np.nonzero(m)
        crop = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        if crop.shape[0] < 12 or crop.shape[1] < 12:
            continue
        crop = dilation(crop, disk(1))
        pad = np.zeros((crop.shape[0] + 2 * PAD, crop.shape[1] + 2 * PAD), bool)
        pad[PAD:PAD + crop.shape[0], PAD:PAD + crop.shape[1]] = crop
        pil = Image.fromarray(np.where(pad[::-1], 0, 255).astype(np.uint8))
        cen = (x0 + xs.mean() / PPU, y0 + ys.mean() / PPU)
        out.append((pil, cen))
    return out


def read(pil):
    d = pytesseract.image_to_data(pil, config=CFG, output_type=pytesseract.Output.DICT)
    best, conf = '', -1.0
    for t, c in zip(d['text'], d['conf']):
        t = CLEAN.sub('', (t or '').upper())
        c = float(c)
        if t and c > conf:
            best, conf = t, c
    return best, max(conf, 0.0) / 100.0


def point_in_poly(p, ring):
    x, y = p
    inside = False
    n = len(ring)
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[(i - 1) % n]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
    return inside


def plausible(text, level):
    """Room numbers on these plans read <floor><3 digits>, with optional suffix."""
    if not text or len(text) < 2:
        return False
    m = re.match(r'^([0-9]{3,4})([A-Z]{0,2})$', text)
    if not m:
        return False
    if level is None or level < 0:
        return True
    want = str(int(level) + 1)
    return m.group(1).startswith(want) or len(m.group(1)) == 3


def run(code):
    p = os.path.join(OUT, f'{code}.json')
    doc = json.load(open(p))
    tf = doc['georef']
    total = named = 0
    for lv in doc['levels']:
        d = json.load(open(os.path.join(PLANS_JSON, lv['file'].replace('.pdf', '.json'))))
        strokes = d['classes'].get('room_no') or []
        if not strokes or not lv['rooms']:
            continue
        groups = label_groups(strokes)
        cents, texts, confs = [], [], []
        for pil, cen in groups:
            t, c = read(pil)
            if not plausible(t, lv['level']):
                continue
            cents.append(cen); texts.append(t); confs.append(c)
        if not cents:
            continue
        # Same per-floor placement as walkgraph/emit; using the bare building
        # transform here put every label on a shifted floor off its room.
        met = G.level_tfm(tf, lv['file'])([cents])[0]
        for room in lv['rooms']:
            total += 1
            ring = room['poly']
            hits = [(texts[i], confs[i]) for i in range(len(met)) if point_in_poly(met[i], ring)]
            if not hits:
                continue
            hits.sort(key=lambda h: -h[1])
            room['no'], room['conf'] = hits[0][0], round(hits[0][1], 2)
            named += 1
        print(f"  {code:5s} lvl {str(lv['level']):5s} labels {len(cents):4d}  "
              f"rooms {len(lv['rooms']):4d} named {sum(1 for r in lv['rooms'] if r['no']):4d}", flush=True)
    doc['ocr'] = {'rooms': total, 'named': named,
                  'coverage': round(named / total, 3) if total else 0.0}
    json.dump(doc, open(p, 'w'))
    return doc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    codes = a.codes or (sorted(f[:-5] for f in os.listdir(OUT) if f.endswith('.json')) if a.all else [])
    for code in codes:
        d = run(code)
        print(f"{code:6s} rooms {d['ocr']['rooms']} named {d['ocr']['named']} "
              f"({d['ocr']['coverage']:.0%})", flush=True)


if __name__ == '__main__':
    main()
