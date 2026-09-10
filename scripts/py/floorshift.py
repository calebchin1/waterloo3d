"""Per-floor registration inside a building, in plan units.

    .venv/bin/python scripts/py/floorshift.py E2 MC
    .venv/bin/python scripts/py/floorshift.py --all

georef.py fits the ground floor to the OSM footprint and every other floor was
assumed to share its origin. MC and SLC do; E2 does not — its 2nd and 3rd floor
drawings sit 13-36 m apart from each other, so no stairwell ever overlapped
between floors. This step aligns each floor's filled mass to the reference
floor's mass by cross-correlation (four 90° candidates), and records the
(dx, dy, rot) per file in data/georef/<CODE>.json under "levels". Every
consumer goes through georef.level_tfm(), which applies the floor shift first
and the building transform second.
"""
import argparse, json, os, sys

import numpy as np
from scipy.signal import fftconvolve

sys.path.insert(0, os.path.dirname(__file__))
import georef as G
import planshape

RES = 2.0            # plan units per pixel for the correlation
MIN_IN_FOOTPRINT = 0.5
MIN_SCORE = 0.60     # E2's correct shifts scored 0.65-0.80; PAS/PHY/TC at 0.47-0.55 stacked floors at the wrong size
ALL_CLASSES = ('wall', 'door', 'room_no', 'space', 'window', 'column', 'stair',
               'elevator', 'fixture', 'other', 'unlayered')


def mass_of(file):
    d = json.load(open(os.path.join(G.BUILD, file.replace('.pdf', '.json'))))
    pls = [pl for k in ALL_CLASSES for pl in d['classes'].get(k, [])]
    if not pls:
        return None, None
    img, (ox, oy, r) = planshape.rasterise(pls, res=RES)
    return planshape.mass(img), (ox, oy)


def _rot_index(r, c, h, w, k):
    """Where pixel (r, c) of an (h, w) array lands after np.rot90(a, k)."""
    for _ in range(k % 4):
        r, c, h, w = w - 1 - c, r, w, h
    return r, c


def register(ref, ref_o, tgt, tgt_o):
    """-> {rotDeg, pivot, dx, dy, score}: p' = R(rot)·(p - pivot) + pivot + (dx, dy)
    moves a target-floor plan point onto the reference floor.

    The rigid transform is *solved from correspondences* — three target points
    pushed through the exact raster rotation and correlation offset — rather
    than derived by hand. A hand-derived pivot got the rotation sign wrong and
    sent E2's second floor off the map entirely.
    """
    best = None
    rf = ref.astype(np.float32)
    for k in range(4):
        t = np.rot90(tgt, k).astype(np.float32)
        corr = fftconvolve(rf, t[::-1, ::-1], mode='full')
        iy, ix = np.unravel_index(int(corr.argmax()), corr.shape)
        score = corr[iy, ix] / max(1.0, float(np.sqrt(rf.sum() * t.sum())))
        if best is None or score > best[0]:
            best = (float(score), k, ix - (t.shape[1] - 1), iy - (t.shape[0] - 1))
    score, k, px, py = best
    h, w = tgt.shape

    def push(p):
        r = (p[1] - tgt_o[1]) / RES; c = (p[0] - tgt_o[0]) / RES
        r2, c2 = _rot_index(r, c, h, w, k)
        return np.array([ref_o[0] + (px + c2) * RES, ref_o[1] + (py + r2) * RES])

    p0 = np.array([tgt_o[0], tgt_o[1]])
    q0 = push(p0)
    ex = push(p0 + [100.0, 0.0]) - q0          # image of the +x direction
    rot = float(np.degrees(np.arctan2(ex[1], ex[0])))
    return {'rotDeg': round(rot % 360, 3), 'pivot': [round(float(p0[0]), 2), round(float(p0[1]), 2)],
            'dx': round(float(q0[0] - p0[0]), 2), 'dy': round(float(q0[1] - p0[1]), 2),
            'score': round(score, 3)}


def run(code):
    p = os.path.join(G.OUT, f'{code}.json')
    tf = json.load(open(p))
    if 'scale' not in tf:
        return None
    corpus = [r for r in json.load(open(os.path.join(G.PLANS, '_corpus.json')))['plans']
              if r['code'] == code and r['level'] is not None]
    ref_file = tf['source']
    fp = G.footprint(code)
    fpbuf = fp.buffer(6.0) if fp is not None else None
    ref, ref_o = mass_of(ref_file)
    if ref is None:
        return None
    levels = {}
    for r in corpus:
        if r['file'] == ref_file:
            levels[r['file']] = {'rotDeg': 0.0, 'pivot': [0, 0], 'dx': 0.0, 'dy': 0.0, 'score': 1.0}
            continue
        tgt, tgt_o = mass_of(r['file'])
        if tgt is None:
            continue
        s = register(ref, ref_o, tgt, tgt_o)
        s['trusted'] = s['score'] >= MIN_SCORE
        # A shift that lands the floor's walls outside the building is wrong no
        # matter how well the sheets correlate (E5 5th/6th floors, rot 180 at 0.62).
        if s['trusted'] and fp is not None:
            probe = dict(tf, levels={r['file']: dict(s, trusted=True)})
            d = json.load(open(os.path.join(G.BUILD, r['file'].replace('.pdf', '.json'))))
            walls = d['classes'].get('wall') or d['classes'].get('unlayered') or []
            pts = np.vstack(G.level_tfm(probe, r['file'])(walls)) if walls else None
            if pts is not None and len(pts):
                from shapely import contains_xy
                frac = float(np.count_nonzero(contains_xy(fpbuf, pts[::5, 0], pts[::5, 1]))) / len(pts[::5])
                s['inFootprint'] = round(frac, 3)
                if frac < MIN_IN_FOOTPRINT:
                    s['trusted'] = False
        levels[r['file']] = s
    tf['levels'] = levels
    json.dump(tf, open(p, 'w'), indent=1)
    return levels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    codes = a.codes or (sorted(f[:-5] for f in os.listdir(G.OUT) if f.endswith('.json')) if a.all else [])
    for code in codes:
        lv = run(code)
        if not lv:
            print(f'{code:6s} skip'); continue
        moved = [(f, s) for f, s in lv.items() if abs(s['dx']) > 3 or abs(s['dy']) > 3 or s['rotDeg']]
        print(f"{code:6s} {len(lv)} floors, {len(moved)} shifted:", flush=True)
        for f, s in moved:
            print(f"   {f:24s} rot {s['rotDeg']:>5} dx {s['dx']:>8} dy {s['dy']:>8} score {s['score']}"
                  + ('  UNTRUSTED' if s.get('trusted') is False else ''))


if __name__ == '__main__':
    main()
