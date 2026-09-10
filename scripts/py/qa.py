"""QA sheets: plan geometry overlaid on the OSM footprint, per building.

    .venv/bin/python scripts/py/qa.py MC          -> build/qa/MC_georef.png
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import georef as G

ROOT = G.ROOT
COL = {'wall': (20, 20, 20), 'door': (214, 118, 20), 'stair': (0, 132, 235),
       'elevator': (150, 0, 190), 'room_no': (170, 170, 170), 'space': (232, 232, 232)}


def load_tf(code):
    return json.load(open(os.path.join(ROOT, 'data', 'georef', f'{code}.json')))


def apply_tf(tf, pts):
    return G.transform(np.asarray(pts, float), tf['scale'], math.radians(tf['rotationDeg']),
                       tf['mirror'], tf['tx'], tf['ty'])


def sheet(code, plan_file=None, out=None, px=1500):
    tf = load_tf(code)
    fp = G.footprint(code)
    src = plan_file or tf['source']
    d = json.load(open(os.path.join(ROOT, 'build', 'plans', src.replace('.pdf', '.json'))))

    x0, y0, x1, y1 = fp.bounds
    pad = 25
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    s = px / (x1 - x0)
    h = int((y1 - y0) * s)
    im = Image.new('RGB', (px, h), 'white')
    dr = ImageDraw.Draw(im)
    to = lambda p: ((p[0] - x0) * s, h - (p[1] - y0) * s)

    for poly in ([fp] if fp.geom_type == 'Polygon' else fp.geoms):
        dr.polygon([to(p) for p in poly.exterior.coords], fill=(255, 236, 179), outline=(190, 140, 0))

    tfm = G.level_tfm(tf, src)
    for cls in ('space', 'room_no', 'door', 'stair', 'elevator', 'wall'):
        pls = d['classes'].get(cls) or []
        c = COL[cls]
        for q in tfm(pls):
            dr.line([to(p) for p in q], fill=c, width=2 if cls == 'wall' else 1)

    dr.text((10, 10), f"{code}  {src}  iou {tf.get('iou')}  resid {tf.get('residualM')} m  "
                      f"scale {tf.get('scale')}  rot {tf.get('rotationDeg')}  mirror {tf.get('mirror')}",
            fill=(0, 0, 0))
    out = out or os.path.join(ROOT, 'build', 'qa', f'{code}_georef.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out)
    return out


if __name__ == '__main__':
    for code in sys.argv[1:]:
        print(sheet(code))
