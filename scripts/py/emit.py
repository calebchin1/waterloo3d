"""build/walk/<CODE>.json -> public/data/indoor/<CODE>.json for the browser.

    .venv/bin/python scripts/py/emit.py MC

Coordinates are stored as integer decimetres in a local east/north frame with
its origin at `origin` (lon/lat). That is ~10x smaller than repeating six-decimal
lon/lat pairs and still resolves to 0.1 m, and the app only has to add the
origin back. Elevations come from the level index and the building floor height.
"""
import argparse, json, math, os, sys

sys.path.insert(0, os.path.dirname(__file__))
import georef as G
import planshape

WALK = os.path.join(G.ROOT, 'build', 'walk')
PLANS_JSON = os.path.join(G.ROOT, 'build', 'plans')
OUT = os.path.join(G.ROOT, 'public', 'data', 'indoor')

WALL_SIMPLIFY_M = 0.30
EDGE_SIMPLIFY_M = 0.50
MIN_WALL_M = 0.45
WALL_CLIP_M = 8.0      # walls with no point within this of the OSM footprint are dropped


def dm(v):
    return int(round(v * 10))


def flat(pts, ox, oy):
    out = []
    for x, y in pts:
        out.append(dm(x - ox)); out.append(dm(y - oy))
    return out


def simplify(pts, tol):
    import numpy as np
    from walkgraph import simplify as s
    return s(np.asarray(pts, float), tol)


def slab_outline(plan, tfm):
    """Floor plate for a level: the filled envelope of everything drawn on it.

    Without a slab the walls float over the basemap and there is nothing to
    stand on, which is most of what makes a plan read as a flat drawing rather
    than a storey.
    """
    pls = []
    for k in ('wall', 'door', 'room_no', 'space', 'window', 'column', 'stair',
              'elevator', 'fixture', 'other', 'unlayered'):
        pls += plan['classes'].get(k, [])
    if not pls:
        return []
    try:
        poly, _ = planshape.outline(pls)
    except ValueError:
        return []
    rings = [poly.exterior] if poly.geom_type == 'Polygon' else [g.exterior for g in poly.geoms]
    out = []
    for r in rings:
        pts = tfm([list(r.coords)])[0]
        out.append(pts)
    return out


def emit(code):
    import numpy as np
    doc = json.load(open(os.path.join(WALK, f'{code}.json')))
    tf = doc['georef']
    fh = doc.get('floorHeightM', 4.0)

    pts = [n['c'] for lv in doc['levels'] for n in lv['nodes']]
    if not pts:
        raise SystemExit(f'{code}: no nodes')
    ox = min(p[0] for p in pts)
    oy = min(p[1] for p in pts)
    origin = [round(ox / G.MX, 7), round(oy / G.MY, 7)]

    tfm_for = lambda file: G.level_tfm(tf, file)
    fp = G.footprint(code)
    keep = None
    if fp is not None:
        from shapely import contains_xy
        fpbuf = fp.buffer(WALL_CLIP_M)
        keep = lambda pl: bool(contains_xy(fpbuf, pl[:, 0], pl[:, 1]).any())

    corpus = {r['file']: r for r in json.load(open(os.path.join(G.PLANS, '_corpus.json')))['plans']}
    shaft_bbox = {sh['id']: sh['bbox'] for sh in doc.get('shafts', [])}
    levels = []
    for lv in doc['levels']:
        plan = json.load(open(os.path.join(PLANS_JSON, lv['file'].replace('.pdf', '.json'))))
        tfm = tfm_for(lv['file'])
        walls = []
        for pl in tfm(plan['classes'].get('wall') or plan['classes'].get('unlayered') or []):
            if len(pl) < 2:
                continue
            # a polyline entirely outside the building is a title-block or key-map
            # stroke; the audits found them standing on the grass 40-60 m away
            if keep is not None and not keep(pl):
                continue
            q = simplify(pl, WALL_SIMPLIFY_M)
            if float(np.hypot(*np.diff(q, axis=0).T).sum()) < MIN_WALL_M:
                continue
            walls.append(flat(q, ox, oy))

        nodes, kinds = [], []
        for n in lv['nodes']:
            nodes.append(dm(n['c'][0] - ox)); nodes.append(dm(n['c'][1] - oy))
            kinds.append('c' if n['kind'] == 'corridor' else 'p')

        edges = []
        for e in lv['edges']:
            g = simplify(e['g'], EDGE_SIMPLIFY_M) if len(e['g']) > 2 else np.asarray(e['g'], float)
            edges.append([e['a'], e['b'], dm(e['m']), flat(g, ox, oy)])

        slabs = [flat(p, ox, oy) for p in slab_outline(plan, tfm)]

        rooms = []
        for r in lv['rooms']:
            rooms.append({'n': r['no'], 'q': r['conf'], 'a': round(r['areaM2']),
                          'v': r['node'], 'p': flat(r['poly'], ox, oy)})

        levels.append({
            'level': lv['level'], 'label': lv['label'],
            'elevM': round(lv['level'] * fh, 2),
            'nodes': nodes, 'kinds': ''.join(kinds), 'edges': edges,
            'rooms': rooms, 'walls': walls, 'slabs': slabs,
            'tier': corpus.get(lv['file'], {}).get('tier', 'C'),
            'stairGeom': bool(plan['classes'].get('stair')),
            'stairs': [{'id': s['id'], 'v': s['node'], 'c': flat([s['c']], ox, oy),
                        'bbox': flat([shaft_bbox[s['id']][:2], shaft_bbox[s['id']][2:]], ox, oy)}
                       for s in lv['stairs'] if s['id'] in shaft_bbox],
            'elevators': [{'id': s['id'], 'v': s['node'], 'c': flat([s['c']], ox, oy),
                           'bbox': flat([shaft_bbox[s['id']][:2], shaft_bbox[s['id']][2:]], ox, oy)}
                          for s in lv['elevators'] if s['id'] in shaft_bbox],
            'areaM2': lv['areaM2'],
        })

    out = {
        'code': code, 'origin': origin, 'floorHeightM': fh,
        'levels': levels,
        'vertical': [{'kind': v['kind'], 'shaft': v['shaft'],
                      'a': [v['from']['level'], v['from']['node']],
                      'b': [v['to']['level'], v['to']['node']],
                      'm': v['m'], 'rise': v['riseM']} for v in doc.get('vertical', [])],
        'meta': {
            'georef': {k: tf.get(k) for k in ('scale', 'rotationDeg', 'mirror', 'tx', 'ty', 'iou', 'margin', 'residualM', 'method', 'source')},
            'ocr': doc.get('ocr', {}),
            'singleLevelShafts': doc.get('singleLevelShafts', []),
            'built': __import__('datetime').date.today().isoformat(),
        },
    }
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, f'{code}.json')
    json.dump(out, open(p, 'w'), separators=(',', ':'))
    return p, os.path.getsize(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    codes = a.codes or (sorted(f[:-5] for f in os.listdir(WALK) if f.endswith('.json')) if a.all else [])
    sys.path.insert(0, os.path.dirname(__file__))
    for code in codes:
        p, n = emit(code)
        print(f'{code:6s} {n/1024:8.0f} KB  {p}', flush=True)
    write_index()


def write_index():
    """public/data/indoor/_index.json — what the app fetches at startup to know
    which buildings have floors, without downloading any of them."""
    if not os.path.isdir(OUT):
        return
    idx = {}
    for f in sorted(os.listdir(OUT)):
        if not f.endswith('.json') or f.startswith('_'):
            continue
        d = json.load(open(os.path.join(OUT, f)))
        idx[d['code']] = {
            'levels': [l['level'] for l in d['levels']],
            'elev': [l['elevM'] for l in d['levels']],
            'labels': [l['label'] for l in d['levels']],
            'rooms': sum(1 for l in d['levels'] for r in l['rooms'] if r['n']),
            'kb': round(os.path.getsize(os.path.join(OUT, f)) / 1024),
            'georef': d['meta']['georef'].get('method'),
        }
    json.dump(idx, open(os.path.join(OUT, '_index.json'), 'w'), separators=(',', ':'))
    print(f'index: {len(idx)} buildings')


if __name__ == '__main__':
    main()
