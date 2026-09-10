"""Plan polylines -> the building's filled outline, in plan units.

Rasterises the wall class, seals door gaps with a morphological closing, fills
interior voids and keeps the largest connected mass. Small detached blocks
(annexes reached by a link corridor, title-block fragments) are dropped, which
is what makes the outline comparable to an OSM footprint.
"""
import numpy as np
from skimage.draw import line as skline
from skimage.morphology import closing, disk
from skimage import measure
from scipy import ndimage as ndi
from shapely.geometry import Polygon
from shapely.ops import unary_union

RES = 1.0          # plan units per pixel
CLOSE_R = 4        # ~ a door opening
KEEP_FRAC = 0.06   # extra components kept if at least this fraction of the main mass


def rasterise(polylines, res=RES, pad=3):
    pts = np.array([p for pl in polylines for p in pl], dtype=float)
    x0, y0 = pts.min(0)
    x1, y1 = pts.max(0)
    w = int((x1 - x0) / res) + 2 * pad
    h = int((y1 - y0) / res) + 2 * pad
    img = np.zeros((h, w), bool)
    for pl in polylines:
        a = np.array(pl, dtype=float)
        c = ((a[:, 0] - x0) / res + pad).astype(int)
        r = ((a[:, 1] - y0) / res + pad).astype(int)
        for i in range(len(a) - 1):
            rr, cc = skline(r[i], c[i], r[i + 1], c[i + 1])
            img[rr, cc] = True
    return img, (x0 - pad * res, y0 - pad * res, res)


def mass(img, close_r=CLOSE_R, keep_frac=KEEP_FRAC):
    """Filled building mass as a boolean image: main component plus large siblings."""
    filled = ndi.binary_fill_holes(closing(img, disk(close_r)))
    lab, n = ndi.label(filled)
    if n == 0:
        return filled
    sizes = ndi.sum(filled, lab, range(1, n + 1))
    top = sizes.max()
    keep = {i + 1 for i, s in enumerate(sizes) if s >= keep_frac * top}
    return np.isin(lab, list(keep))


def outline(polylines, res=RES):
    """-> (shapely polygon in plan units, filled-area in plan units^2)."""
    img, (ox, oy, r) = rasterise(polylines, res)
    m = mass(img)
    polys = []
    for c in measure.find_contours(m.astype(float), 0.5):
        if len(c) < 8:
            continue
        ring = [(ox + x * r, oy + y * r) for y, x in c]
        p = Polygon(ring)
        if p.is_valid and p.area > 0:
            polys.append(p)
    if not polys:
        raise ValueError('no outline')
    poly = unary_union(polys)
    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly.simplify(res * 1.5), float(m.sum()) * r * r
