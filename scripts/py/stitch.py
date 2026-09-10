"""Building-wide stair and elevator shafts, and the vertical edges between levels.

    .venv/bin/python scripts/py/stitch.py MC

Shafts are found once for the whole building rather than per level: every
level's stair strokes are rasterised into one shared metric grid and the union
is labelled, so a stairwell keeps the same identity on every floor it reaches.
Per-level clustering cannot do that — it splits a stairwell in two on one floor
and merges it with its neighbour on the next.

Reads and rewrites build/walk/<CODE>.json, adding `shafts` and `vertical`.
"""
import argparse, json, math, os, sys

import numpy as np
from scipy import ndimage as ndi
from skimage.morphology import disk, closing

sys.path.insert(0, os.path.dirname(__file__))
import georef as G
import walkgraph as W
import levels as L

OUT = os.path.join(G.ROOT, 'build', 'walk')
PLANS_JSON = os.path.join(G.ROOT, 'build', 'plans')
GAP_PX = 4             # 0.4 m; joins the two flights of one stairwell. Tried 2 to
                       # stop neighbouring stairwells merging, and floors then stopped
                       # overlapping at all; the renderer clamps oversized flights instead
MIN_SHAFT_M2 = 1.5
RISE_FACTOR = 1.8      # a stair costs more than its plan length
ELEV_WAIT_M = 12.0     # elevator cost as an equivalent walking distance


def strokes(tf, rec_file, kind):
    d = json.load(open(os.path.join(PLANS_JSON, rec_file.replace('.pdf', '.json'))))
    return G.level_tfm(tf, rec_file)(d['classes'].get(kind, []))


def find_shafts(tf, levels, kind):
    per_level = {lv['level']: strokes(tf, lv['file'], kind) for lv in levels}
    allpts = [p for pls in per_level.values() for pl in pls for p in pl]
    if not allpts:
        return [], {}
    fr = W.Frame(np.array(allpts))
    union = fr.blank()
    for pls in per_level.values():
        W.draw(fr, pls, union)
    lab, n = ndi.label(closing(union, disk(GAP_PX)))
    px2 = fr.px * fr.px

    shafts, keep = [], {}
    for i in range(1, n + 1):
        m = lab == i
        if float(m.sum()) * px2 < MIN_SHAFT_M2:
            continue
        ys, xs = np.nonzero(m)
        cen = fr.to_m([[ys.mean(), xs.mean()]])[0]
        bb = fr.to_m([[ys.min(), xs.min()], [ys.max(), xs.max()]])
        sid = f'{kind[0]}{len(shafts)}'
        keep[i] = sid
        shafts.append({'id': sid, 'kind': kind,
                       'c': [round(float(cen[0]), 2), round(float(cen[1]), 2)],
                       'bbox': [round(float(v), 2) for v in (bb[0][0], bb[0][1], bb[1][0], bb[1][1])],
                       'areaM2': round(float(m.sum()) * px2, 1),
                       'levels': []})
    by_id = {s['id']: s for s in shafts}

    # which levels actually reach each shaft, and where on that level
    for lv in levels:
        img = W.draw(fr, per_level[lv['level']])
        if not img.any():
            continue
        nodes = np.array([n['c'] for n in lv['nodes']]) if lv['nodes'] else np.zeros((0, 2))
        for i, sid in keep.items():
            m = img & (lab == i)
            if float(m.sum()) * px2 < MIN_SHAFT_M2 * 0.4:
                continue
            ys, xs = np.nonzero(m)
            cen = fr.to_m([[ys.mean(), xs.mean()]])[0]
            node = None
            if len(nodes):
                node = int(np.hypot(*(nodes - cen).T).argmin())
            by_id[sid]['levels'].append({'level': lv['level'], 'node': node,
                                         'c': [round(float(cen[0]), 2), round(float(cen[1]), 2)],
                                         'areaM2': round(float(m.sum()) * px2, 1)})
    return shafts, keep


def stitch(code, floor_height):
    p = os.path.join(OUT, f'{code}.json')
    doc = json.load(open(p))
    tf = doc['georef']
    levels = doc['levels']

    shafts = []
    for kind in ('stair', 'elevator'):
        sh, _ = find_shafts(tf, levels, kind)
        shafts += sh

    vertical, dead = [], []
    for s in shafts:
        ls = sorted(s['levels'], key=lambda x: x['level'])
        if len(ls) < 2:
            dead.append(s['id'])
            continue
        run = math.hypot(s['bbox'][2] - s['bbox'][0], s['bbox'][3] - s['bbox'][1])
        for a, b in zip(ls, ls[1:]):
            rise = (b['level'] - a['level']) * floor_height
            m = (RISE_FACTOR * run + abs(rise)) if s['kind'] == 'stair' else (abs(rise) + ELEV_WAIT_M)
            vertical.append({'kind': s['kind'], 'shaft': s['id'],
                             'from': {'level': a['level'], 'node': a['node']},
                             'to': {'level': b['level'], 'node': b['node']},
                             'm': round(m, 1), 'riseM': round(rise, 2)})

    for lv in levels:
        lv['stairs'] = [{'id': s['id'], 'c': next(x['c'] for x in s['levels'] if x['level'] == lv['level']),
                         'node': next(x['node'] for x in s['levels'] if x['level'] == lv['level'])}
                        for s in shafts if s['kind'] == 'stair'
                        and any(x['level'] == lv['level'] for x in s['levels'])]
        lv['elevators'] = [{'id': s['id'], 'c': next(x['c'] for x in s['levels'] if x['level'] == lv['level']),
                            'node': next(x['node'] for x in s['levels'] if x['level'] == lv['level'])}
                           for s in shafts if s['kind'] == 'elevator'
                           and any(x['level'] == lv['level'] for x in s['levels'])]

    doc['shafts'] = shafts
    doc['vertical'] = vertical
    doc['floorHeightM'] = floor_height
    doc['singleLevelShafts'] = dead
    json.dump(doc, open(p, 'w'))
    return doc


def floor_height_for(code):
    fc = json.load(open(os.path.join(G.ROOT, 'public', 'data', 'buildings.geojson')))
    for f in fc['features']:
        if f['properties'].get('code') == code:
            return L.floor_height(f['properties'].get('height_m'), f['properties'].get('levels'))
    return 4.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    codes = a.codes or (sorted(f[:-5] for f in os.listdir(OUT) if f.endswith('.json')) if a.all else [])
    for code in codes:
        d = stitch(code, floor_height_for(code))
        v = d['vertical']
        st = [s for s in d['shafts'] if s['kind'] == 'stair']
        el = [s for s in d['shafts'] if s['kind'] == 'elevator']
        print(f"{code:6s} floor {d['floorHeightM']} m  shafts {len(st)} stair / {len(el)} elev  "
              f"vertical {len(v)}  single-level {len(d['singleLevelShafts'])}", flush=True)


if __name__ == '__main__':
    main()
