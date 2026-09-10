"""Fit a plan -> world affine per building, by maximising mask overlap with the
OSM footprint.

    .venv/bin/python scripts/py/georef.py MC
    .venv/bin/python scripts/py/georef.py --all

Writes data/georef/<CODE>.json:
  { code, scale, rotationDeg, mirror, tx, ty, iou, residualM, method, source }

`scale` is metres per plan unit; the transform maps a plan point (x, y) to local
metric campus coordinates (the same MX/MY frame scripts/geo.ts uses):

    [X]   [ s·cos  -s·sin ] [ m·x ]   [tx]
    [Y] = [ s·sin   s·cos ] [   y ] + [ty]

with m = -1 when `mirror` is set. Buildings whose iou lands under ACCEPT are
written with method "needs-review" and are expected to be fixed by hand in
tools/georef.html.
"""
import argparse, json, math, os, sys
import numpy as np
from scipy.optimize import minimize
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
import planshape

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PLANS = os.path.join(ROOT, 'floorplans')
BUILD = os.path.join(ROOT, 'build', 'plans')
OUT = os.path.join(ROOT, 'data', 'georef')

LAT0 = 43.471
MX = 111320 * math.cos(math.radians(LAT0))
MY = 110574
GRID_M = 0.5          # metres per pixel for the overlap score
ACCEPT = 0.62         # iou at or above this is taken as solved
MARGIN = 0.04         # required lead over the next distinct orientation
MAX_RESID = 6.0       # metres, mean plan-boundary to footprint-edge distance


def dominant_angle(segments, min_len=0.0):
    """Length-weighted circular mean of segment directions, modulo 90 degrees.

    Rectilinear buildings have a single dominant grid; comparing the plan's grid
    with the footprint's gives a far better rotation seed than a coarse sweep.
    """
    acc = 0j
    for a, b in segments:
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L <= min_len:
            continue
        acc += L * np.exp(4j * math.atan2(dy, dx))
    if acc == 0:
        return 0.0
    return math.degrees(np.angle(acc)) / 4.0


def plan_segments(pls, top_frac=0.25):
    segs = []
    for pl in pls:
        a = np.asarray(pl, float)
        for i in range(len(a) - 1):
            segs.append((a[i], a[i + 1]))
    segs.sort(key=lambda s: -math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]))
    return segs[:max(20, int(len(segs) * top_frac))]


def poly_segments(poly):
    segs = []
    for g in ([poly] if poly.geom_type == 'Polygon' else poly.geoms):
        c = list(g.exterior.coords)
        segs += [(np.array(c[i]), np.array(c[i + 1])) for i in range(len(c) - 1)]
    return segs


def footprint(code):
    fc = json.load(open(os.path.join(ROOT, 'public', 'data', 'buildings.geojson')))
    polys = []
    for f in fc['features']:
        if f['properties'].get('code') != code:
            continue
        g = f['geometry']
        rings = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
        for r in rings:
            p = Polygon([(c[0] * MX, c[1] * MY) for c in r])
            if p.is_valid and p.area > 1:
                polys.append(p)
    if not polys:
        return None
    return unary_union(polys)


def mask_of(poly, bounds, res=GRID_M):
    """Rasterise a shapely polygon over fixed bounds."""
    x0, y0, x1, y1 = bounds
    w = max(1, int((x1 - x0) / res)); h = max(1, int((y1 - y0) / res))
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y0 + (np.arange(h) + 0.5) * res
    from shapely import contains_xy
    gx, gy = np.meshgrid(xs, ys)
    return contains_xy(poly, gx, gy)


def plan_points(code):
    """Filled floor mass of the building's lowest full floor, in plan units.

    Built from *all* the drawn geometry, not walls alone: a wall-only fill
    fragments wherever a plan draws a corridor wall dashed, and a fragmented
    mass makes the area-derived scale seed several times too large — which was
    the single biggest source of bad fits.
    """
    corpus = json.load(open(os.path.join(PLANS, '_corpus.json')))['plans']
    cand = [r for r in corpus if r['code'] == code and r['level'] is not None]
    if not cand:
        raise SystemExit(f'{code}: no plans')
    # Reference floor: the one with the most wall geometry (a fragmentary ground
    # floor fitted E3 at IoU 0.12), ground floor preferred when it is close.
    def wall_len(r):
        p = os.path.join(BUILD, r['file'].replace('.pdf', '.json'))
        if not os.path.exists(p):
            return 0.0
        d = json.load(open(p))
        pls = d['classes'].get('wall') or d['classes'].get('unlayered') or []
        return float(sum(np.hypot(*np.diff(np.array(pl, float), axis=0).T).sum() for pl in pls if len(pl) > 1))
    lens = {r['file']: wall_len(r) for r in cand}
    top = max(lens.values() or [0])
    cand.sort(key=lambda r: (not (r['level'] == 0.0 and lens[r['file']] >= 0.7 * top), -lens[r['file']]))
    for rec in cand:
        p = os.path.join(BUILD, rec['file'].replace('.pdf', '.json'))
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        # Structural classes only: title blocks, key maps and sheet borders sit
        # in `other`/`title`/`site`, and with them in the mass the fit locks onto
        # the border rectangle instead of the building (AL, C2).
        pls = []
        for k in ('wall', 'door', 'window', 'column', 'stair', 'elevator', 'room_no', 'space'):
            pls += d['classes'].get(k, [])
        if not pls:
            pls = d['classes'].get('unlayered', [])
        if not pls:
            continue
        img, (ox, oy, r) = planshape.rasterise(pls)
        m = planshape.mass(img)
        ys, xs = np.nonzero(m)
        if len(xs) < 200:
            continue
        pts = np.column_stack([ox + xs * r, oy + ys * r])
        return rec, pts, float(m.sum()) * r * r
    raise SystemExit(f'{code}: no usable plan geometry')


def other_footprints(code):
    """Every campus footprint except this building's, as one geometry."""
    fc = json.load(open(os.path.join(ROOT, 'public', 'data', 'buildings.geojson')))
    polys = []
    for f in fc['features']:
        if f['properties'].get('code') == code:
            continue
        g = f['geometry']
        rings = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
        for r in rings:
            q = Polygon([(c[0] * MX, c[1] * MY) for c in r])
            if q.is_valid and q.area > 1:
                polys.append(q)
    return unary_union(polys) if polys else None


def site_points(rec, step=7):
    """Neighbouring buildings and roads drawn around the plan, if it has them."""
    d = json.load(open(os.path.join(BUILD, rec['file'].replace('.pdf', '.json'))))
    pls = d['classes'].get('site') or []
    pts = [p for pl in pls for p in pl[::step]]
    return np.array(pts, float) if len(pts) > 60 else None


def site_score(pts, others, s, th, mirror, tx, ty):
    """Fraction of drawn site geometry that lands on a real neighbouring building."""
    if pts is None or others is None:
        return None
    from shapely import contains_xy
    q = transform(pts, s, th, mirror, tx, ty)
    return float(np.count_nonzero(contains_xy(others, q[:, 0], q[:, 1]))) / len(q)


def plan_wall_polylines(rec):
    d = json.load(open(os.path.join(BUILD, rec['file'].replace('.pdf', '.json'))))
    return d['classes'].get('wall') or d['classes'].get('unlayered') or []


def level_tfm(tf, file):
    """Polylines of one plan file -> world metric, honouring the per-floor
    shift from floorshift.py when the building has one. Every consumer
    (walkgraph, stitch, emit, qa) goes through here so a floor can never be
    placed two different ways."""
    lv = (tf.get('levels') or {}).get(file)
    def f(pls):
        out = []
        for pl in pls:
            a = np.array(pl, float)
            if lv and lv.get('trusted', True) and (lv['rotDeg'] or lv['dx'] or lv['dy']):
                th = math.radians(lv['rotDeg'])
                px, py = lv['pivot']
                c, sn = math.cos(th), math.sin(th)
                x = a[:, 0] - px; y = a[:, 1] - py
                a = np.column_stack([px + c * x - sn * y + lv['dx'], py + sn * x + c * y + lv['dy']])
            out.append(transform(a, tf['scale'], math.radians(tf['rotationDeg']), tf['mirror'], tf['tx'], tf['ty']))
        return out
    return f


def transform(pts, s, th, mirror, tx, ty):
    x = pts[:, 0] * (-1 if mirror else 1)
    y = pts[:, 1]
    c, sn = math.cos(th), math.sin(th)
    return np.column_stack([s * (c * x - sn * y) + tx, s * (sn * x + c * y) + ty])


def score(pts, fp_mask, bounds, s, th, mirror, tx, ty, res=GRID_M):
    q = transform(pts, s, th, mirror, tx, ty)
    x0, y0, x1, y1 = bounds
    cx = ((q[:, 0] - x0) / res).astype(int)
    cy = ((q[:, 1] - y0) / res).astype(int)
    ok = (cx >= 0) & (cy >= 0) & (cx < fp_mask.shape[1]) & (cy < fp_mask.shape[0])
    pm = np.zeros_like(fp_mask)
    pm[cy[ok], cx[ok]] = True
    inter = np.count_nonzero(pm & fp_mask)
    union = np.count_nonzero(pm | fp_mask)
    return inter / union if union else 0.0


def fit(code):
    fp = footprint(code)
    if fp is None:
        return {'code': code, 'method': 'no-footprint'}
    rec, pts, plan_area = plan_points(code)

    fx0, fy0, fx1, fy1 = fp.bounds
    pad = 40.0
    bounds = (fx0 - pad, fy0 - pad, fx1 + pad, fy1 + pad)
    fp_mask = mask_of(fp, bounds)

    s0 = math.sqrt(fp.area / plan_area)
    pc = pts.mean(0)
    fc = np.array(fp.centroid.coords[0])

    # Rotation seed from the two rectilinear grids, not a blind sweep.
    fp_ang = dominant_angle(poly_segments(fp))
    plan_ang = dominant_angle(plan_segments(plan_wall_polylines(rec)))
    # No mirrored candidates: a floor plan is never drawn reflected relative to
    # the world, and every mirror=True fit audited (AL, E3, E6) put the title
    # text backwards on the map. Near-symmetric outlines had been scoring the
    # reflection a hair higher.
    seeds = []
    for mirror in (False,):
        base = fp_ang - plan_ang
        for k in range(4):
            seeds.append((mirror, base + 90 * k))

    fw, fh = fx1 - fx0, fy1 - fy0
    coarse = []
    for mirror, deg in seeds:
        bestc = None
        # Scale seeds: from the area ratio, and from how the rotated plan's own
        # extent compares with the footprint's. The extent seeds survive a mass
        # that is missing pieces, which the area seed does not.
        q0 = transform(pts, 1.0, math.radians(deg), mirror, 0, 0)
        pw = max(q0[:, 0].max() - q0[:, 0].min(), 1e-6)
        ph = max(q0[:, 1].max() - q0[:, 1].min(), 1e-6)
        bases = sorted({round(v, 6) for v in (s0, fw / pw, fh / ph, math.sqrt((fw / pw) * (fh / ph)))})
        for dd in (-2.0, 0.0, 2.0):
            th = math.radians(deg + dd)
            for base in bases:
              for ks in (0.9, 1.0, 1.1):
                s = base * ks
                q = transform(pts, s, th, mirror, 0, 0)
                t = fc - q.mean(0)
                v = score(pts, fp_mask, bounds, s, th, mirror, t[0], t[1])
                if bestc is None or v > bestc[0]:
                    bestc = (v, s, th, mirror, t[0], t[1])
        coarse.append(bestc)
    coarse.sort(key=lambda c: -c[0])

    refined = []
    for v, s, th, mirror, tx, ty in coarse[:4]:
        r = minimize(lambda p: -score(pts, fp_mask, bounds, p[0], p[1], mirror, p[2], p[3]),
                     [s, th, tx, ty], method='Nelder-Mead',
                     options={'xatol': 1e-4, 'fatol': 1e-5, 'maxiter': 900})
        refined.append((max(v, -r.fun), *(r.x if -r.fun > v else (s, th, tx, ty)), mirror))
    refined.sort(key=lambda c: -c[0])
    v, s, th, tx, ty, mirror = refined[0]

    # How far clear of the next *distinct* placement? Seeds often converge on the
    # same optimum, so only a different mirror or a rotation more than 20 degrees
    # away counts as a rival. Near-symmetric outlines settle 180 degrees out, and
    # that is exactly what a human needs to check.
    def far(c):
        d = abs((math.degrees(c[2] - th) + 180) % 360 - 180)
        return c[5] != mirror or d > 20
    rivals = [c for c in refined[1:] if far(c)]
    margin = round(v - max(c[0] for c in rivals), 4) if rivals else 1.0

    # Diagnostic only: how much of the drawn site context lands on a real
    # neighbouring building under this placement. Tried as a tiebreaker for the
    # near-symmetric cases and it picked a verified-wrong mirror for MC, so it is
    # reported for the reviewer rather than trusted to decide.
    sp = site_points(rec)
    others = other_footprints(code) if sp is not None else None
    ss = site_score(sp, others, s, th, mirror, tx, ty)
    site = round(ss, 3) if ss is not None else None

    # residual: mean distance from the transformed plan *boundary* to the footprint edge
    from scipy import ndimage as ndi
    from shapely.geometry import Point
    q = transform(pts, s, th, mirror, tx, ty)
    hull = np.zeros((int((bounds[3] - bounds[1]) / GRID_M) + 1,
                     int((bounds[2] - bounds[0]) / GRID_M) + 1), bool)
    cx = ((q[:, 0] - bounds[0]) / GRID_M).astype(int)
    cy = ((q[:, 1] - bounds[1]) / GRID_M).astype(int)
    ok = (cx >= 0) & (cy >= 0) & (cx < hull.shape[1]) & (cy < hull.shape[0])
    hull[cy[ok], cx[ok]] = True
    hull = ndi.binary_fill_holes(hull)
    edge_px = hull & ~ndi.binary_erosion(hull)
    ey, ex = np.nonzero(edge_px)
    ep = np.column_stack([bounds[0] + ex * GRID_M, bounds[1] + ey * GRID_M])
    if len(ep) > 1200:
        ep = ep[np.random.default_rng(0).choice(len(ep), 1200, replace=False)]
    edge = fp.exterior
    resid = float(np.mean([edge.distance(Point(*p)) for p in ep])) if len(ep) else float('nan')

    return {
        'code': code, 'source': rec['file'], 'level': rec['level'],
        'scale': round(s, 6), 'rotationDeg': round(math.degrees(th) % 360, 3),
        'mirror': bool(mirror), 'tx': round(tx, 3), 'ty': round(ty, 3),
        'iou': round(v, 4), 'margin': margin, 'siteScore': site, 'residualM': round(resid, 2),
        'method': 'auto' if (v >= ACCEPT and margin >= MARGIN and resid <= MAX_RESID) else 'needs-review',
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    corpus = json.load(open(os.path.join(PLANS, '_corpus.json')))['plans']
    codes = sorted({r['code'] for r in corpus}) if a.all else a.codes
    os.makedirs(OUT, exist_ok=True)
    for code in codes:
        try:
            d = fit(code)
        except SystemExit as e:
            print(f'{code:6s} SKIP {e}'); continue
        json.dump(d, open(os.path.join(OUT, f'{code}.json'), 'w'), indent=1)
        print(f"{code:6s} iou {d.get('iou','-'):>6} margin {d.get('margin','-'):>7} resid {d.get('residualM','-'):>6} m  "
              f"scale {d.get('scale','-')} rot {d.get('rotationDeg','-')} mirror {d.get('mirror','-')}  {d['method']}", flush=True)


if __name__ == '__main__':
    main()
