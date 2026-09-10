"""One pass over every downloaded floor plan -> floorplans/_corpus.json.

Everything downstream reads this instead of re-probing PDFs. Records the tier
(A = layered with room numbers, B = layered without, C = flattened), the layer
names, page geometry, per-class segment counts and the resolved level.

Run: .venv/bin/python scripts/py/corpus.py
"""
import json, os, re, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(__file__))
import levels as L
import pymupdf

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
PLANS = os.path.join(ROOT, 'floorplans')

# AutoCAD layer name -> semantic class. Checked in order; first hit wins.
CLASS_RULES = [
    ('room_no',  re.compile(r'ROOM_NO|RM\$TXT|ROOM ?NUM', re.I)),
    ('elevator', re.compile(r'ELEV|ELEVATOR|\bELV\b', re.I)),
    ('stair',    re.compile(r'STAIR|\bSTR\b|ESCAL', re.I)),
    ('door',     re.compile(r'DOOR|\bDW\b|\bDT\d', re.I)),
    ('window',   re.compile(r'WINDOW|\bWIN\b', re.I)),
    ('column',   re.compile(r'COLUMN|\bCOL\b', re.I)),
    ('wall',     re.compile(r'WALL|\bWL\d?\b|\bWL-|\bW[23]\b', re.I)),
    ('corridor', re.compile(r'CORRIDOR', re.I)),
    ('space',    re.compile(r'SPACE|B-SP-SOLID', re.I)),
    ('title',    re.compile(r'TITLE|SCALE|NORTH|LEGEND|KEY', re.I)),
    ('site',     re.compile(r'SIDEWALK|DRIVE|MAINBUILDING|PARKING|B-SP-', re.I)),
    ('fixture',  re.compile(r'FIXTURE|PLUMB|\bWC\b|FURN|MECH|METAL|CASE', re.I)),
]


def classify(layer):
    if not layer:
        return 'unlayered'
    for name, rx in CLASS_RULES:
        if rx.search(layer):
            return name
    return 'other'


def probe(path, label):
    doc = pymupdf.open(path)
    page = doc[0]
    ocgs = {v['name'] for v in doc.get_ocgs().values()}
    drawings = page.get_drawings()
    per_class, per_layer, seen_layers = Counter(), Counter(), set()
    for d in drawings:
        lay = d.get('layer') or ''
        if lay:
            seen_layers.add(lay)
        n = len(d['items'])
        per_class[classify(lay)] += n
        per_layer[lay or '(none)'] += n
    file = os.path.basename(path)
    lv, ft = L.resolve(label, file)
    layered = bool(ocgs)
    tier = 'A' if layered and per_class.get('room_no') else 'B' if layered else 'C'
    r = page.mediabox
    out = {
        'file': file,
        'label': label,
        'level': lv,
        'level_from_file': ft,
        'tier': tier,
        'rotation': page.rotation,
        'mediabox': [r.x0, r.y0, r.x1, r.y1],
        'drawings': len(drawings),
        'layers': sorted(ocgs | seen_layers),
        'per_class': dict(per_class),
        'per_layer': dict(per_layer.most_common(40)),
    }
    doc.close()
    return out


def building_code(entry):
    """'MC - Mathematics & Computer' -> 'MC'; keeps wing suffixes out."""
    b = entry['building'].split(' - ')[0].split(' and ')[0].strip()
    b = b.replace('IHB-', 'IHB').strip()
    return b


def main():
    man = json.load(open(os.path.join(PLANS, '_manifest.json')))
    have = {f for f in os.listdir(PLANS) if f.endswith('.pdf')}
    out, by_building = [], {}
    for e in man:
        if e['file'] not in have:
            continue
        rec = probe(os.path.join(PLANS, e['file']), e['label'])
        rec['code'] = building_code(e)
        rec['building'] = e['building']
        out.append(rec)
        by_building.setdefault(rec['code'], []).append(rec['file'])
        print(f"  {rec['code']:6s} {rec['file']:28s} tier {rec['tier']}  level {rec['level']}", flush=True)
    out.sort(key=lambda r: (r['code'], r['level'] if r['level'] is not None else 99))
    doc = {
        'built': __import__('datetime').date.today().isoformat(),
        'files': len(out),
        'buildings': len(by_building),
        'tiers': dict(Counter(r['tier'] for r in out)),
        'plans': out,
    }
    p = os.path.join(PLANS, '_corpus.json')
    json.dump(doc, open(p, 'w'), indent=1)
    print(f"\n{len(out)} plans, {len(by_building)} buildings, tiers {doc['tiers']} -> {p}")


if __name__ == '__main__':
    main()
