"""PDF floor plan -> classified polylines in plan units.

    .venv/bin/python scripts/py/extract.py 017MC_01FLR.pdf
    .venv/bin/python scripts/py/extract.py --code MC
    .venv/bin/python scripts/py/extract.py --all

Writes build/plans/<file>.json:
  { file, code, level, tier, rotation, bbox, classes: { wall: [polyline...], ... } }

Points are page-space (rotation applied) with y flipped so +y is up, which is
what every downstream metric step assumes. Curves are flattened to chords.
"""
import argparse, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from corpus import classify
import pymupdf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PLANS = os.path.join(ROOT, 'floorplans')
OUT = os.path.join(ROOT, 'build', 'plans')

CURVE_STEPS = 6
JOIN_TOL = 1e-6          # plan units; CAD output is exact so this can be tight


def _bezier(p0, p1, p2, p3, n=CURVE_STEPS):
    pts = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        pts.append((
            u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        ))
    return pts


def _items_to_polylines(items):
    """A drawing's item list -> list of polylines, chaining contiguous segments."""
    out, cur = [], []

    def flush():
        nonlocal cur
        if len(cur) >= 2:
            out.append(cur)
        cur = []

    def add(pts):
        nonlocal cur
        if cur and abs(cur[-1][0] - pts[0][0]) < JOIN_TOL and abs(cur[-1][1] - pts[0][1]) < JOIN_TOL:
            cur.extend(pts[1:])
        else:
            flush()
            cur = list(pts)

    for it in items:
        op = it[0]
        if op == 'l':
            add([(it[1].x, it[1].y), (it[2].x, it[2].y)])
        elif op == 'c':
            add([(it[1].x, it[1].y)] + _bezier(it[1], it[2], it[3], it[4]))
        elif op == 're':
            r = it[1]
            flush()
            out.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])
        elif op == 'qu':
            q = it[1]
            flush()
            out.append([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)])
    flush()
    return out


def extract(rec):
    path = os.path.join(PLANS, rec['file'])
    doc = pymupdf.open(path)
    page = doc[0]
    mat = page.rotation_matrix               # unrotated user space -> displayed page space
    h = page.rect.height
    classes = defaultdict(list)
    for d in page.get_drawings():
        cls = classify(d.get('layer') or '')
        for pl in _items_to_polylines(d['items']):
            pts = []
            for x, y in pl:
                p = pymupdf.Point(x, y) * mat
                pts.append([round(p.x, 3), round(h - p.y, 3)])   # flip so +y is up
            classes[cls].append(pts)
    doc.close()

    pts_all = [p for pls in classes.values() for pl in pls for p in pl]
    xs = [p[0] for p in pts_all]
    ys = [p[1] for p in pts_all]
    bbox = [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 0, 0]
    return {
        'file': rec['file'], 'code': rec['code'], 'level': rec['level'], 'tier': rec['tier'],
        'rotation': rec['rotation'], 'bbox': [round(v, 3) for v in bbox],
        'counts': {k: len(v) for k, v in sorted(classes.items())},
        'classes': {k: v for k, v in classes.items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='*')
    ap.add_argument('--code')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()

    corpus = json.load(open(os.path.join(PLANS, '_corpus.json')))['plans']
    if a.all:
        sel = corpus
    elif a.code:
        sel = [r for r in corpus if r['code'] == a.code]
    else:
        want = set(a.files)
        sel = [r for r in corpus if r['file'] in want]
    if not sel:
        sys.exit('no matching plans')

    os.makedirs(OUT, exist_ok=True)
    for rec in sel:
        d = extract(rec)
        p = os.path.join(OUT, rec['file'].replace('.pdf', '.json'))
        json.dump(d, open(p, 'w'))
        kb = os.path.getsize(p) / 1024
        print(f"{rec['file']:28s} lvl {str(rec['level']):5s} {kb:7.0f} KB  " +
              ' '.join(f'{k}={v}' for k, v in d['counts'].items() if k in
                       ('wall', 'door', 'stair', 'elevator', 'room_no', 'space', 'unlayered')), flush=True)


if __name__ == '__main__':
    main()
