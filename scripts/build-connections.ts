// Builds public/data/connections.geojson — the curated source of truth for
// student-accessible tunnels, bridges and doorway links between UW buildings.
// Geometry comes from OSM ways where they exist (chained by id) or is traced
// between the nearest edges of the two building footprints. Run: npm run build-data
import { readFileSync, writeFileSync } from 'node:fs';
import type { Feature, FeatureCollection, LineString } from 'geojson';

type Kind = 'tunnel' | 'bridge' | 'doorway';
interface Def {
  id: string; from: string; to: string; kind: Kind; z_m: number;
  name?: string; status?: 'open' | 'closed'; osm?: number[]; via?: [number, number][];
  verified: boolean; notes: string;
}

// Ground truth: Imprint, "An introduction to tunnels and bridges on campus".
// verified=true means the link is on that list; false means it is OSM-evidenced only.
const DEFS: Def[] = [
  // ---- tunnels ----
  { id: 'sch-tc', from: 'SCH', to: 'TC', kind: 'tunnel', z_m: -4, osm: [139814054], verified: true, notes: 'Start of the Arts Quad tunnel system; bright orange hallway under SCH.' },
  { id: 'tc-al', from: 'TC', to: 'AL', kind: 'tunnel', z_m: -4, osm: [368682710, 187712344], verified: true, notes: 'Arts Quad tunnel system.' },
  { id: 'al-ml', from: 'AL', to: 'ML', kind: 'tunnel', z_m: -4, osm: [49785862, 187712346], verified: true, notes: 'Arts Quad tunnel system.' },
  { id: 'al-ev1', from: 'AL', to: 'EV1', kind: 'tunnel', z_m: -4, osm: [49785862, 49785860], verified: true, notes: 'Arts Quad tunnel system; EV2/EV3 reached by doorway from EV1.' },
  { id: 'ev1-hh', from: 'EV1', to: 'HH', kind: 'tunnel', z_m: -4, name: 'EV1 to HH Walkway', osm: [49785864, 383816289], verified: true, notes: 'End of the Arts Quad tunnel system; steps up into HH.' },
  { id: 'mc-c2', from: 'MC', to: 'C2', kind: 'tunnel', z_m: -4, osm: [183247348], verified: true, notes: 'Tunnel between MC and C2.' },
  { id: 'rch-e2', from: 'RCH', to: 'E2', kind: 'tunnel', z_m: -4, osm: [51856426], verified: true, notes: 'RCH lecture hall tunnel to E2.' },
  { id: 'rch-dwe', from: 'RCH', to: 'DWE', kind: 'tunnel', z_m: -4, osm: [187714493], verified: true, notes: 'RCH lecture hall tunnel to DWE.' },
  { id: 'esc-eit-t', from: 'ESC', to: 'EIT', kind: 'tunnel', z_m: -4, verified: true, notes: 'ESC and EIT are joined by both a tunnel and a bridge. Traced; not in OSM.' },
  { id: 'phy-e2-t', from: 'PHY', to: 'E2', kind: 'tunnel', z_m: -4, osm: [186942884], verified: false, notes: 'OSM maps an underground footway here in addition to the bridge. Unverified.' },
  { id: 'qnc-b2-t', from: 'QNC', to: 'B2', kind: 'tunnel', z_m: -4, osm: [815045355], verified: false, notes: 'OSM maps an underground footway between QNC and B2. Unverified.' },
  // ---- bridges ----
  { id: 'slc-mc', from: 'SLC', to: 'MC', kind: 'bridge', z_m: 5, osm: [983281506], verified: true, notes: 'Glass-panelled bridge SLC to MC.' },
  { id: 'pac-slc', from: 'PAC', to: 'SLC', kind: 'bridge', z_m: 8, osm: [145079151], verified: true, notes: 'PAC to SLC link (upper level).' },
  { id: 'mc-dc', from: 'MC', to: 'DC', kind: 'bridge', z_m: 5, verified: true, notes: 'Glass-panelled bridge MC to DC. Traced; not in OSM.' },
  { id: 'dc-m3', from: 'DC', to: 'M3', kind: 'bridge', z_m: 5, verified: true, notes: 'Bridge DC to M3. Traced; not in OSM.' },
  { id: 'dc-c2', from: 'DC', to: 'C2', kind: 'bridge', z_m: 5, osm: [137183050], verified: true, notes: 'Bridge DC to C2.' },
  { id: 'dc-e3', from: 'DC', to: 'E3', kind: 'bridge', z_m: 5, verified: true, notes: 'Bridge DC to E3. Traced; not in OSM.' },
  { id: 'e3-e5', from: 'E3', to: 'E5', kind: 'bridge', z_m: 6, name: 'E5 Bridge', osm: [175807556], verified: true, notes: 'Crosses Ring Road and the ION tracks.' },
  { id: 'pse-e6', from: 'PSE', to: 'E6', kind: 'bridge', z_m: 6, name: 'E6 Bridge', osm: [626283189], verified: true, notes: 'PSE (formerly E7) to E6.' },
  { id: 'e2-dwe', from: 'E2', to: 'DWE', kind: 'bridge', z_m: 5, osm: [265314066], verified: true, notes: 'Bridge E2 to DWE.' },
  { id: 'e2-phy', from: 'E2', to: 'PHY', kind: 'bridge', z_m: 5, osm: [182198718], verified: true, notes: 'Bridge E2 to PHY.' },
  { id: 'esc-eit-b', from: 'ESC', to: 'EIT', kind: 'bridge', z_m: 5, verified: true, notes: 'ESC to EIT bridge. Traced; not in OSM.', via: [[-80.54255, 43.47150]] },
  { id: 'mc-qnc', from: 'MC', to: 'QNC', kind: 'bridge', z_m: 5, name: 'MC to QNC Walkway', osm: [182197539], verified: true, notes: 'Covered walkway MC to QNC.' },
  { id: 'e2-e3', from: 'E2', to: 'E3', kind: 'bridge', z_m: 5, name: 'E2 to E3 Walkway', osm: [182286461], verified: true, notes: 'Imprint calls this a doorway; OSM maps a short walkway.' },
  { id: 'c2-esc', from: 'C2', to: 'ESC', kind: 'bridge', z_m: 5, osm: [182087258], verified: false, notes: 'OSM-mapped bridge C2 to ESC. Unverified.' },
  { id: 'ev2-ev3', from: 'EV2', to: 'EV3', kind: 'bridge', z_m: 5, osm: [574196261], verified: true, notes: 'EV2 to EV3 link.' },
  { id: 'ev2-pas', from: 'EV2', to: 'PAS', kind: 'bridge', z_m: 5, osm: [189317460], verified: false, notes: 'OSM-mapped bridge EV2 to PAS. Unverified.' },
  { id: 'stc-nh', from: 'STC', to: 'NH', kind: 'bridge', z_m: 5, osm: [364274039], verified: false, notes: 'OSM-mapped bridge STC to Needles Hall. Unverified.' },
  { id: 'cph-lota', from: 'CPH', to: 'Lot A', kind: 'bridge', z_m: 8, osm: [130347239], status: 'closed', verified: true, notes: 'Pedestrian bridge over University Ave to Parking Lot A. Closed for rebuild; reopening scheduled September 2026.' },
  // ---- doorway links (same level, no structure) ----
  { id: 'ev1-ev2', from: 'EV1', to: 'EV2', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway.' },
  { id: 'eit-phy', from: 'EIT', to: 'PHY', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway.' },
  { id: 'b1-b2', from: 'B1', to: 'B2', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway.' },
  { id: 'b2-stc', from: 'B2', to: 'STC', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway.' },
  { id: 'b1-stc', from: 'B1', to: 'STC', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway.' },
  { id: 'e5-pse', from: 'E5', to: 'PSE', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorway E5 to PSE (E7).' },
  { id: 'e2-cph', from: 'E2', to: 'CPH', kind: 'doorway', z_m: 1, verified: true, notes: 'Interior doorways E2 to CPH.' },
];

// ---------- geometry helpers (local metric projection) ----------
const LAT0 = 43.471;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110574;
const toM = ([lon, lat]: number[]) => [lon * MX, lat * MY];
const toLL = ([x, y]: number[]) => [+(x / MX).toFixed(7), +(y / MY).toFixed(7)];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1]];
const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1]];
const mul = (a: number[], k: number) => [a[0] * k, a[1] * k];
const len = (a: number[]) => Math.hypot(a[0], a[1]);
const unit = (a: number[]) => mul(a, 1 / (len(a) || 1));

function nearestOnSeg(p: number[], a: number[], b: number[]) {
  const ab = sub(b, a);
  const L = ab[0] ** 2 + ab[1] ** 2;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L));
  return add(a, mul(ab, t));
}
function pip(p: number[], ring: number[][]) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
interface Bldg { code: string; rings: number[][][]; centroid: number[] }
function inside(b: Bldg, p: number[]) { return b.rings.some((r) => pip(p, r)); }
function nearestBoundary(b: Bldg, p: number[]) {
  let best = p, bd = Infinity;
  for (const r of b.rings) for (let i = 0; i < r.length - 1; i++) {
    const q = nearestOnSeg(p, r[i], r[i + 1]); const d = len(sub(q, p));
    if (d < bd) { bd = d; best = q; }
  }
  return { q: best, d: bd };
}
// Closest pair of points between two buildings' outlines.
function nearestPair(a: Bldg, b: Bldg) {
  let best: [number[], number[]] = [a.centroid, b.centroid], bd = Infinity;
  const pass = (A: Bldg, B: Bldg, flip: boolean) => {
    for (const r of A.rings) for (const v of r) {
      const { q, d } = nearestBoundary(B, v);
      if (d < bd) { bd = d; best = flip ? [q, v] : [v, q]; }
    }
  };
  pass(a, b, false); pass(b, a, true);
  return best;
}
// Push the end of a path 12 m into its building so the tube visibly enters it.
function enter(b: Bldg, path: number[][], atStart: boolean) {
  const p = atStart ? path[0] : path[path.length - 1];
  if (inside(b, p)) return path;
  const { q } = nearestBoundary(b, p);
  let dir = unit(sub(q, p));
  let deep = add(q, mul(dir, 12));
  if (!inside(b, deep)) { dir = unit(sub(b.centroid, q)); deep = add(q, mul(dir, 12)); }
  const ext = [q, deep];
  return atStart ? [...ext.reverse(), ...path] : [...path, ...ext];
}
// Chain OSM ways end-to-end regardless of their stored direction.
function chain(ways: number[][][]) {
  const same = (a: number[], b: number[]) => len(sub(a, b)) < 0.5;
  let path = ways[0].slice();
  for (const w of ways.slice(1)) {
    const ww = w.slice();
    if (same(path[path.length - 1], ww[0])) path.push(...ww.slice(1));
    else if (same(path[path.length - 1], ww[ww.length - 1])) path.push(...ww.reverse().slice(1));
    else if (same(path[0], ww[ww.length - 1])) path = [...ww.slice(0, -1), ...path];
    else if (same(path[0], ww[0])) path = [...ww.reverse().slice(0, -1), ...path];
    else throw new Error('ways do not chain');
  }
  return path;
}

// ---------- load ----------
const bfc = JSON.parse(readFileSync('public/data/buildings.geojson', 'utf8')) as FeatureCollection;
const ifc = JSON.parse(readFileSync('public/data/osm-indoor.geojson', 'utf8')) as FeatureCollection<LineString>;
const bld = new Map<string, Bldg>();
for (const f of bfc.features) {
  const code = f.properties?.code as string | null;
  if (!code) continue;
  const g = f.geometry as any;
  const rings: number[][][] = (g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p: any) => p[0])).map((r: number[][]) => r.map(toM));
  const all = rings.flat();
  const centroid = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  const prev = bld.get(code);
  bld.set(code, prev ? { code, rings: [...prev.rings, ...rings], centroid: prev.centroid } : { code, rings, centroid });
}
const ways = new Map<number, number[][]>();
for (const f of ifc.features) ways.set(f.properties!.osm_id, f.geometry.coordinates.map(toM));

// ---------- build ----------
const out: Feature<LineString>[] = [];
for (const d of DEFS) {
  const A = bld.get(d.from), B = bld.get(d.to);
  if (!A) throw new Error(`no building ${d.from}`);
  let path: number[][];
  if (d.osm) {
    path = chain(d.osm.map((id) => { const w = ways.get(id); if (!w) throw new Error(`osm way ${id} missing`); return w; }));
    // orient from A to B
    if (len(sub(path[0], A.centroid)) > len(sub(path[path.length - 1], A.centroid))) path.reverse();
  } else {
    if (!B) throw new Error(`no building ${d.to}`);
    const [pa, pb] = nearestPair(A, B);
    path = d.via ? [pa, ...d.via.map(toM), pb] : [pa, pb];
  }
  path = enter(A, path, true);
  if (B) path = enter(B, path, false);
  const length_m = path.slice(1).reduce((s, p, i) => s + len(sub(p, path[i])), 0);
  out.push({
    type: 'Feature',
    id: d.id,
    properties: {
      id: d.id, from: d.from, to: d.to, kind: d.kind, z_m: d.z_m,
      name: d.name ?? `${d.from} – ${d.to}`,
      status: d.status ?? 'open', verified: d.verified,
      source: d.osm ? d.osm.map((i) => `osm:${i}`).join(',') : 'traced',
      notes: d.notes, length_m: Math.round(length_m),
    },
    geometry: { type: 'LineString', coordinates: path.map(toLL) },
  });
}
writeFileSync('public/data/connections.geojson', JSON.stringify({ type: 'FeatureCollection', features: out }, null, 1));
console.log(`connections=${out.length}`);
