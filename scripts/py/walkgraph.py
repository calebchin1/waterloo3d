"""Per-level walkable network from georeferenced plan geometry.

    .venv/bin/python scripts/py/walkgraph.py MC

Writes build/walk/<CODE>.json — one entry per level with corridor nodes/edges,
room polygons, and stair/elevator shafts, all in local metric coordinates
(the MX/MY campus frame). stitch.py turns those into vertical edges and
emit.py converts to lon/lat for the browser.

Method, per level: rasterise walls into the building mass, subtract them from
the interior to get free space, take the medial axis of the free space as the
walk skeleton, and split it into corridor (wide, spanning) and room stubs.
"""
import argparse, json, math, os, sys
from collections import defaultdict

import numpy as np
from scipy import ndimage as ndi
from skimage.draw import line as skline
from skimage.morphology import skeletonize, dilation, disk, closing
from skimage import measure

sys.path.insert(0, os.path.dirname(__file__))
import georef as G
import planshape

ROOT = G.ROOT
BUILD = os.path.join(ROOT, 'build')
PLANS_JSON = os.path.join(BUILD, 'plans')
OUT = os.path.join(BUILD, 'walk')

PX = 0.10             # metres per pixel
WALL_R = 1            # px of dilation, so hairline walls still block
MIN_CLEAR = 0.25      # m; a door opening is ~0.9 m wide, so clearance ~0.45
CORR_CLEAR = 1.00     # m; a skeleton node this clear of a wall reads as corridor
SPUR_M = 2.0          # m; prune skeleton spurs shorter than this
ENV_R = 8             # px closing radius that seals dashed walls into an envelope
FOOTPRINT_MARGIN_M = 8.0  # plan geometry beyond the OSM footprint by more than this is not floor
MIN_ROOM_M2 = 3.0
SIMPLIFY_M = 0.35


# ---------------------------------------------------------------- rasterising

class Frame:
    """Metric bounding box -> pixel grid, with both directions of conversion."""

    def __init__(self, pts, px=PX, pad=12):
        self.px = px
        self.x0 = float(pts[:, 0].min()) - pad * px
        self.y0 = float(pts[:, 1].min()) - pad * px
        self.w = int((pts[:, 0].max() - self.x0) / px) + pad
        self.h = int((pts[:, 1].max() - self.y0) / px) + pad

    def to_px(self, p):
        return (np.asarray(p, float) - [self.x0, self.y0]) / self.px

    def to_m(self, rc):
        rc = np.asarray(rc, float)
        return np.column_stack([self.x0 + rc[:, 1] * self.px, self.y0 + rc[:, 0] * self.px])

    def blank(self):
        return np.zeros((self.h, self.w), bool)


def draw(frame, polylines, img=None):
    img = frame.blank() if img is None else img
    for pl in polylines:
        q = frame.to_px(pl)
        c = np.clip(q[:, 0].astype(int), 0, frame.w - 1)
        r = np.clip(q[:, 1].astype(int), 0, frame.h - 1)
        for i in range(len(q) - 1):
            rr, cc = skline(r[i], c[i], r[i + 1], c[i + 1])
            img[rr, cc] = True
    return img


# ---------------------------------------------------------------- skeleton -> graph

NEIGH = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
STRUCT8 = np.ones((3, 3), bool)


def _degree(skel):
    pad = np.pad(skel, 1)
    deg = np.zeros(pad.shape, np.uint8)
    for dr, dc in NEIGH:
        deg += np.roll(np.roll(pad, dr, 0), dc, 1)
    return deg[1:-1, 1:-1] * skel


def _order_run(pixels, start):
    """Walk a one-pixel-wide run from the pixel nearest `start`, in order."""
    remaining = set(pixels)
    cur = min(remaining, key=lambda p: (p[0] - start[0]) ** 2 + (p[1] - start[1]) ** 2)
    path = [cur]
    remaining.discard(cur)
    while remaining:
        nxt = None
        for dr, dc in NEIGH:
            q = (cur[0] + dr, cur[1] + dc)
            if q in remaining:
                nxt = q; break
        if nxt is None:
            break
        path.append(nxt); remaining.discard(nxt); cur = nxt
    return path


def skeleton_graph(skel):
    """Thinned mask -> (node pixels, chains of pixels between nodes).

    Junction and endpoint pixels are clustered into nodes, and the degree-2 runs
    between them become chains. Splitting on junctions and labelling is far more
    robust than walking the skeleton pixel by pixel: `skeletonize` leaves
    diagonal adjacencies that make a naive walk abandon most of its chains.
    """
    if not skel.any():
        return [], []
    deg = _degree(skel)
    junc = skel & (deg != 2)
    if not junc.any():                       # a pure loop: cut it anywhere
        first = tuple(np.argwhere(skel)[0])
        junc = np.zeros_like(skel); junc[first] = True

    jl, jn = ndi.label(junc, structure=STRUCT8)
    node_px, node_of = [], {}
    for i in range(1, jn + 1):
        px = np.argwhere(jl == i)
        rep = tuple(px[len(px) // 2])
        node_px.append(rep)
        for p in px:
            node_of[tuple(p)] = i - 1

    runs = skel & ~junc
    rl, rn = ndi.label(runs, structure=STRUCT8)
    chains = []
    for i in range(1, rn + 1):
        px = [tuple(p) for p in np.argwhere(rl == i)]
        touching = {}
        for p in px:
            for dr, dc in NEIGH:
                q = (p[0] + dr, p[1] + dc)
                n = node_of.get(q)
                if n is not None:
                    touching.setdefault(n, q)
        if len(touching) < 2:
            # dead end: still a chain, so prune() can judge it by length
            if len(touching) == 1:
                n, anchor_px = next(iter(touching.items()))
                chains.append([node_px[n]] + _order_run(px, anchor_px))
            continue
        ends = list(touching.items())[:2]
        (na, pa), (nb, _) = ends
        ordered = _order_run(px, pa)
        chains.append([node_px[na]] + ordered + [node_px[nb]])

    # junction clusters that touch each other directly, with no run between
    for a, pa in enumerate(node_px):
        for dr, dc in NEIGH:
            q = (pa[0] + dr, pa[1] + dc)
            b = node_of.get(q)
            if b is not None and b > a:
                chains.append([pa, node_px[b]])
    return node_px, chains


def prune(nodes, chains, clear_px, spur_px):
    """Drop short dead-end chains, then keep only chains whose ends are nodes."""
    node_set = set(nodes)
    chains = [c for c in chains if c[0] in node_set and c[-1] in node_set and c[0] != c[-1]]
    changed = True
    while changed:
        changed = False
        deg = defaultdict(int)
        for ch in chains:
            deg[ch[0]] += 1; deg[ch[-1]] += 1
        keep = []
        for ch in chains:
            ends_dead = (deg[ch[0]] == 1) or (deg[ch[-1]] == 1)
            both_dead = (deg[ch[0]] == 1) and (deg[ch[-1]] == 1)
            if ends_dead and not both_dead and len(ch) < spur_px:
                changed = True
                continue
            keep.append(ch)
        chains = keep
    used = {p for ch in chains for p in (ch[0], ch[-1])}
    return [n for n in nodes if n in used], chains


def polyline_m(frame, path, tol=SIMPLIFY_M):
    pts = frame.to_m(np.array(path))
    return simplify(pts, tol)


def simplify(pts, tol):
    if len(pts) <= 2:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = float(np.hypot(*ab))
    if L < 1e-9:
        d = np.hypot(*(pts - a).T)
    else:
        t = np.clip(((pts - a) @ ab) / (L * L), 0, 1)
        d = np.hypot(*(pts - (a + t[:, None] * ab)).T)
    i = int(d.argmax())
    if d[i] <= tol:
        return np.array([a, b])
    return np.vstack([simplify(pts[:i + 1], tol)[:-1], simplify(pts[i:], tol)])


# ---------------------------------------------------------------- one level

def level_graph(code, rec, tf):
    path = os.path.join(PLANS_JSON, rec['file'].replace('.pdf', '.json'))
    d = json.load(open(path))
    cls = d['classes']
    tfm = G.level_tfm(tf, rec['file'])

    walls = tfm(cls.get('wall') or cls.get('unlayered') or [])
    if not walls:
        return None
    fr = Frame(np.vstack(walls))
    wall_img = draw(fr, walls)
    door_img = draw(fr, tfm(cls.get('door', [])))
    # Some plans draw a threshold line across every doorway on the wall layer.
    # Left in, it seals each room and cuts the corridor at every fire door, and
    # the "largest walkable component" collapses to a fragment (DC 2nd floor:
    # 402 m² of 2 412). Door strokes mark openings, so they punch through walls.
    solid = dilation(wall_img, disk(WALL_R)) & ~dilation(door_img, disk(WALL_R + 1))

    # The floor envelope comes from *all* the drawn geometry, not just walls:
    # upper floors often draw corridor walls dashed, which leaks a wall-only
    # fill, whereas room numbers and fixtures blanket wherever the floor exists.
    env_src = []
    for k in ('wall', 'door', 'room_no', 'space', 'window', 'column', 'stair', 'elevator'):
        env_src += tfm(cls.get(k, []))
    if not env_src:
        env_src = tfm(cls.get('unlayered', []))
    mass = ndi.binary_fill_holes(closing(draw(fr, env_src), disk(ENV_R)))
    # Nothing outside the OSM footprint (+ margin) is floor: without this the
    # skeleton loops through the sheet gutter, title block and key map.
    fp = G.footprint(code)
    if fp is not None:
        from shapely import contains_xy
        buf = fp.buffer(FOOTPRINT_MARGIN_M)
        ys, xs = np.mgrid[0:fr.h, 0:fr.w]
        pts = fr.to_m(np.column_stack([ys.ravel(), xs.ravel()]))
        inside = contains_xy(buf, pts[:, 0], pts[:, 1]).reshape(fr.h, fr.w)
        mass &= inside
    lab, n = ndi.label(mass)
    if n:
        sizes = ndi.sum(mass, lab, range(1, n + 1))
        mass = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 0.05 * sizes.max()])

    # --- walk network: doors left OPEN, so the skeleton runs through them ---
    free = mass & ~solid
    clear = ndi.distance_transform_edt(free) * fr.px
    walkable = free & (clear >= MIN_CLEAR)
    lab, n = ndi.label(walkable)
    if not n:
        return None
    sizes = ndi.sum(walkable, lab, range(1, n + 1))
    main = lab == (1 + int(np.argmax(sizes)))

    skel = skeletonize(main)
    nodes, chains = skeleton_graph(skel)
    nodes, chains = prune(nodes, chains, clear, int(SPUR_M / fr.px))

    idx = {p: i for i, p in enumerate(nodes)}
    raw_nodes = [{'c': [round(float(v), 2) for v in fr.to_m([p])[0]],
                  'clear': round(float(clear[p]), 2),
                  'kind': 'corridor' if clear[p] >= CORR_CLEAR else 'passage',
                  'px': (int(p[0]), int(p[1]))}
                 for p in nodes]
    raw_edges = []
    for ch in chains:
        a, b = idx.get(ch[0]), idx.get(ch[-1])
        if a is None or b is None or a == b:
            continue
        pl = polyline_m(fr, ch)
        m = float(np.hypot(*np.diff(pl, axis=0).T).sum())
        if m < 0.2:
            continue
        cl = float(np.median([clear[p] for p in ch]))
        raw_edges.append({'a': a, 'b': b, 'm': round(m, 2), 'clear': round(cl, 2),
                          'g': [[round(float(x), 2), round(float(y), 2)] for x, y in pl]})

    # Keep one connected component. Nodes that no surviving chain touches would
    # otherwise stay in the file and become dead ends: the router anchors a
    # portal to the *nearest* node, and an isolated one makes the route fail.
    gnodes, gedges = largest_component(raw_nodes, raw_edges)

    # --- rooms: doors SEALED, so each enclosed space separates out ---
    node_px = np.array([n['px'] for n in gnodes]) if gnodes else np.zeros((0, 2), int)
    rooms = find_rooms(fr, mass, dilation(wall_img | door_img, disk(WALL_R)), node_px)

    # Stair and elevator shafts are found building-wide in stitch.py, because a
    # per-level clustering splits and merges differently on every floor.
    return {
        'level': rec['level'], 'label': rec['label'], 'file': rec['file'],
        'frame': {'x0': round(fr.x0, 3), 'y0': round(fr.y0, 3), 'px': fr.px, 'w': fr.w, 'h': fr.h},
        'nodes': [{k: v for k, v in n.items() if k != 'px'} for n in gnodes],
        'edges': gedges, 'rooms': rooms,
        'stairs': [], 'elevators': [],
        'areaM2': round(float(main.sum()) * fr.px * fr.px, 1),
        'massM2': round(float(mass.sum()) * fr.px * fr.px, 1),
    }


def largest_component(raw_nodes, raw_edges):
    adj = {}
    for e in raw_edges:
        adj.setdefault(e['a'], []).append(e['b'])
        adj.setdefault(e['b'], []).append(e['a'])
    seen, best = set(), []
    for start in adj:
        if start in seen:
            continue
        comp, stack = [], [start]
        seen.add(start)
        while stack:
            u = stack.pop(); comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v); stack.append(v)
        if len(comp) > len(best):
            best = comp
    keep = sorted(best)
    remap = {old: i for i, old in enumerate(keep)}
    nodes = [{'i': i, **{k: v for k, v in raw_nodes[old].items() if k != 'px'},
              'px': raw_nodes[old]['px']} for i, old in enumerate(keep)]
    edges = [{**e, 'a': remap[e['a']], 'b': remap[e['b']]}
             for e in raw_edges if e['a'] in remap and e['b'] in remap]
    return nodes, edges


def nearest_node(node_px, fr, pt_m):
    """Index of the walk node closest to a metric point, or None."""
    if not len(node_px):
        return None
    q = fr.to_px([pt_m])[0]          # (x, y) in px
    d = np.hypot(node_px[:, 1] - q[0], node_px[:, 0] - q[1])
    return int(d.argmin())


def find_rooms(fr, mass, sealed, node_px):
    """Enclosed spaces once door openings are sealed. The largest component is
    the circulation network; everything else is a room."""
    sp = mass & ~sealed
    lab, n = ndi.label(sp)
    if not n:
        return []
    px2 = fr.px * fr.px
    sizes = ndi.sum(sp, lab, range(1, n + 1)) * px2
    corridor_label = 1 + int(np.argmax(sizes))
    out = []
    for i in range(1, n + 1):
        if i == corridor_label or sizes[i - 1] < MIN_ROOM_M2:
            continue
        m = lab == i
        cs = measure.find_contours(m.astype(float), 0.5)
        if not cs:
            continue
        poly = simplify(fr.to_m(np.array(max(cs, key=len))), 0.4)
        ys, xs = np.nonzero(m)
        cen = fr.to_m([[ys.mean(), xs.mean()]])[0]
        # a node actually inside this space beats the nearest node overall
        node = None
        if len(node_px):
            inside = [k for k, p in enumerate(node_px) if m[p[0], p[1]]]
            node = inside[0] if inside else nearest_node(node_px, fr, cen)
        out.append({'id': f'r{len(out)}', 'no': None, 'conf': 0.0,
                    'areaM2': round(float(sizes[i - 1]), 1),
                    'c': [round(float(cen[0]), 2), round(float(cen[1]), 2)],
                    'node': node,
                    'poly': [[round(float(x), 2), round(float(y), 2)] for x, y in poly]})
    return out


def shafts(fr, polylines, kind, gap_px=6, min_m2=1.5):
    """Cluster stair/elevator strokes into shafts."""
    if not polylines:
        return []
    img = draw(fr, polylines)
    lab, n = ndi.label(ndi.binary_closing(img, disk(gap_px)))
    out = []
    px2 = fr.px * fr.px
    for i in range(1, n + 1):
        m = lab == i
        a = float(m.sum()) * px2
        if a < min_m2:
            continue
        ys, xs = np.nonzero(m)
        cen = fr.to_m([[ys.mean(), xs.mean()]])[0]
        bb = fr.to_m([[ys.min(), xs.min()], [ys.max(), xs.max()]])
        out.append({'id': f'{kind[0]}{len(out)}', 'kind': kind,
                    'c': [round(float(cen[0]), 2), round(float(cen[1]), 2)],
                    'bbox': [round(float(v), 2) for v in (bb[0][0], bb[0][1], bb[1][0], bb[1][1])],
                    'areaM2': round(a, 1)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    corpus = json.load(open(os.path.join(G.PLANS, '_corpus.json')))['plans']
    codes = sorted({r['code'] for r in corpus}) if a.all else a.codes
    os.makedirs(OUT, exist_ok=True)
    for code in codes:
        gp = os.path.join(ROOT, 'data', 'georef', f'{code}.json')
        if not os.path.exists(gp):
            print(f'{code:6s} SKIP no georef'); continue
        tf = json.load(open(gp))
        if 'scale' not in tf:
            print(f'{code:6s} SKIP {tf.get("method")}'); continue
        recs = sorted([r for r in corpus if r['code'] == code and r['level'] is not None],
                      key=lambda r: r['level'])
        levels = []
        for rec in recs:
            try:
                lv = level_graph(code, rec, tf)
            except Exception as e:
                print(f"  {rec['file']}: {type(e).__name__}: {e}"); continue
            if lv:
                levels.append(lv)
                print(f"  {code:5s} lvl {str(rec['level']):5s} nodes {len(lv['nodes']):4d} "
                      f"edges {len(lv['edges']):4d} rooms {len(lv['rooms']):4d} "
                      f"area {lv['areaM2']:.0f} m2", flush=True)
        if levels:
            json.dump({'code': code, 'georef': tf, 'levels': levels},
                      open(os.path.join(OUT, f'{code}.json'), 'w'))


if __name__ == '__main__':
    main()
