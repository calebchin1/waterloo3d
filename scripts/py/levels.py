"""Floor label / filename -> signed level index, and per-building floor heights.

Level 0 is the ground floor ("1st Floor"). Basements are negative. Mezzanines
sit half a level above their host floor. Mirrored as a table in src/indoor.ts,
so any change here must be reflected there.
"""
import re

ORDINAL = {
    '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4, '6th': 5,
    '7th': 6, '8th': 7, '9th': 8, '10th': 9, '11th': 10, '12th': 11, '13th': 12,
}

# Sub-buildings that share a plan-ops code (residence complexes, annexes).
WING = re.compile(r'^(central complex|community centre|commons|village \d+ ?- ?\w+|beck hall|\w+ hall)\s+', re.I)


def level_from_label(label: str):
    """-> (level, name) or (None, name) when the label carries no floor."""
    s = label.strip()
    wing = ''
    m = WING.match(s)
    if m and not s.lower().startswith(('lower', 'mid')):
        wing = m.group(1).strip()
        s = s[m.end():]
    low = s.lower()

    if 'midlevel basement' in low:
        return -1.5, label
    if 'basement' in low:
        return -1.0, label
    if low in ('concourse', 'lower level'):
        return -1.0, label
    if low == 'link':
        return 0.0, label
    if low == 'mezzanine':
        return 0.5, label
    if 'penthouse' in low:
        return 90.0, label          # resolved to top+1 once the building is known
    m = re.match(r'(\d+(?:st|nd|rd|th))\s+floor(\s+mezzanine)?', low)
    if m:
        lv = ORDINAL.get(m.group(1))
        if lv is None:
            return None, label
        return lv + (0.5 if m.group(2) else 0.0), label
    return None, label


TOKEN = re.compile(r'_(?:(\d{2})FLR|(B1)FLR|(MB)FLR|(LL)FLR|0M_MEZ|0B_CON)(_MEZ)?\.pdf$', re.I)


def level_from_file(name: str):
    m = TOKEN.search(name)
    if not m:
        return None
    if m.group(1) is not None:
        lv = int(m.group(1))
        lv = 0.0 if lv <= 1 else float(lv - 1)
    elif m.group(2):
        lv = -1.0
    elif m.group(3):
        lv = -1.5
    elif m.group(4):
        lv = -1.0
    elif '0M_MEZ' in name.upper():
        lv = 0.5
    else:
        lv = -1.0                    # 0B_CON, concourse
    if m.group(5):
        lv += 0.5
    return lv


def resolve(label: str, filename: str):
    """Label wins; filename token is the fallback and the cross-check."""
    lv, _ = level_from_label(label)
    ft = level_from_file(filename)
    if lv is None:
        lv = ft
    return lv, ft


def floor_height(height_m, levels):
    """Metres per storey for a building, from its OSM height/levels."""
    if height_m and levels and levels > 0:
        h = height_m / levels
        if 3.0 <= h <= 5.5:
            return round(h, 2)
    return 4.0


def elevation(level, fh):
    """Level index -> floor elevation in metres above ground."""
    return round(level * fh, 2)
