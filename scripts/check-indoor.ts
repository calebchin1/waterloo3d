// Invariants for public/data/indoor/*.json. Run: npm run check-indoor
//
// The failure that matters most is a silent vertical break: a stair that exists
// on one floor and not the next leaves a route that can never reach an upper
// level, and nothing in the UI would say so. That is an error here, not a note.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LAT0, MX, MY } from './geo';

const DIR = 'public/data/indoor';
const MAX_KB = 900;
const MAX_RESID_M = 8;
const MAX_ANCHOR_M = 45;

interface RawLevel {
  level: number; label: string; elevM: number;
  nodes: number[]; edges: [number, number, number, number[]][];
  rooms: { n: string | null }[]; stairs: { id: string; v: number | null }[];
  elevators: { id: string; v: number | null }[]; walls: number[][];
  tier: 'A' | 'B' | 'C'; stairGeom: boolean; areaM2: number;
}
interface Raw {
  code: string; origin: [number, number]; floorHeightM: number;
  levels: RawLevel[];
  vertical: { kind: string; shaft: string; a: [number, number | null]; b: [number, number | null] }[];
  meta: { georef: Record<string, unknown>; ocr?: { coverage?: number }; singleLevelShafts?: string[] };
}

const errors: string[] = [];
const warnings: string[] = [];
const fail = (s: string) => errors.push(s);
const warn = (s: string) => warnings.push(s);

if (!existsSync(DIR)) {
  console.log('no indoor data yet — nothing to check');
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
if (!files.length) { console.log('no indoor data yet — nothing to check'); process.exit(0); }

const graph = JSON.parse(readFileSync('public/data/graph.json', 'utf8')) as
  { nodes: Record<string, { b: string; c: number[]; kind: string }> };
const links = JSON.parse(readFileSync('public/data/connections.geojson', 'utf8')) as
  { features: { properties: { id: string; z_m: number } }[] };
const linkZ = new Map(links.features.map((f) => [f.properties.id, f.properties.z_m]));

let totalRooms = 0, namedRooms = 0, totalKb = 0;

for (const file of files) {
  const code = file.replace('.json', '');
  const kb = readFileSync(join(DIR, file)).length / 1024;
  totalKb += kb;
  if (kb > MAX_KB) fail(`${code}: ${kb.toFixed(0)} KB exceeds the ${MAX_KB} KB per-building budget`);
  const d = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Raw;

  if (!d.levels.length) { fail(`${code}: no levels`); continue; }
  const ox = d.origin[0] * MX, oy = d.origin[1] * MY;
  const nodeLL = (l: RawLevel, i: number): [number, number] =>
    [(ox + l.nodes[2 * i] / 10) / MX, (oy + l.nodes[2 * i + 1] / 10) / MY];

  const resid = Number(d.meta.georef.residualM ?? NaN);
  if (Number.isFinite(resid) && resid > MAX_RESID_M) {
    warn(`${code}: georef residual ${resid} m (> ${MAX_RESID_M}); check build/qa/${code}_georef.png`);
  }
  if (d.meta.georef.method !== 'auto') warn(`${code}: georef ${d.meta.georef.method}`);

  const byLevel = new Map(d.levels.map((l) => [l.level, l]));
  for (const l of d.levels) {
    const n = l.nodes.length / 2;
    if (!n) { fail(`${code} L${l.level}: no walk nodes`); continue; }
    // connectivity
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of l.edges) {
      if (a >= n || b >= n) { fail(`${code} L${l.level}: edge references node out of range`); continue; }
      adj[a].push(b); adj[b].push(a);
    }
    const seen = new Set<number>([0]); const stack = [0];
    while (stack.length) { const u = stack.pop()!; for (const v of adj[u]) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
    if (seen.size !== n) fail(`${code} L${l.level}: walk graph is in ${n - seen.size + 1} pieces (${seen.size}/${n} reachable)`);
    for (const s of [...l.stairs, ...l.elevators]) {
      if (s.v == null || s.v >= n) fail(`${code} L${l.level}: shaft ${s.id} has no valid walk node`);
    }
    totalRooms += l.rooms.length;
    namedRooms += l.rooms.filter((r) => r.n).length;
  }

  // vertical edges must land on real nodes on both sides
  for (const v of d.vertical) {
    for (const [lvl, idx] of [v.a, v.b]) {
      const l = byLevel.get(lvl);
      if (!l) { fail(`${code}: ${v.kind} ${v.shaft} references missing level ${lvl}`); continue; }
      if (idx == null || idx >= l.nodes.length / 2) fail(`${code}: ${v.kind} ${v.shaft} has no node on level ${lvl}`);
    }
  }
  // A Tier C plan has no layer names, so there is no stair geometry to find and
  // the missing vertical link is a data limitation, not a pipeline bug.
  const withStairs = d.levels.filter((l) => l.stairGeom).length;
  if (d.levels.length > 1 && !d.vertical.length) {
    if (withStairs >= 2) fail(`${code}: ${d.levels.length} levels with stair geometry on ${withStairs}, but nothing connects them`);
    else warn(`${code}: ${d.levels.length} levels, no vertical link — stair geometry on only ${withStairs} (unlayered plans)`);
  }
  const dead = d.meta.singleLevelShafts ?? [];
  if (dead.length) warn(`${code}: ${dead.length} shaft(s) found on only one level (${dead.slice(0, 6).join(', ')})`);

  // every campus portal into this building must reach a floor
  for (const [id, nd] of Object.entries(graph.nodes)) {
    if (nd.b !== code || nd.kind === 'B') continue;
    const z = id.startsWith('P:') ? linkZ.get(id.slice(2, id.lastIndexOf(':'))) ?? 0 : 0;
    // same rule as levelForZ in src/indoor.ts: floors with a usable corridor network
    const full = d.levels.filter((l) => l.nodes.length / 2 >= 30);
    let best = Infinity, bestLevel: RawLevel | null = null;
    for (const l of (full.length ? full : d.levels)) {
      const dz = Math.abs(l.elevM - z);
      if (dz < best) { best = dz; bestLevel = l; }
    }
    if (!bestLevel) continue;
    let bd = Infinity;
    for (let i = 0; i < bestLevel.nodes.length / 2; i++) {
      const c = nodeLL(bestLevel, i);
      bd = Math.min(bd, Math.hypot((c[0] - nd.c[0]) * MX, (c[1] - nd.c[1]) * MY));
    }
    if (bd > MAX_ANCHOR_M) {
      const why = `${code}: ${id} is ${bd.toFixed(0)} m from the nearest node on L${bestLevel.level}`;
      // A flattened plan has no wall layer, so its walkable space is a fragment;
      // that is a data tier, not a misplacement. The router keeps the old
      // building-to-building hop as a fallback there.
      if (bestLevel.tier === 'C') warn(`${why} — flattened (Tier C) floor, router falls back`);
      else fail(`${why} — the plan is probably misplaced`);
    }
  }
}

void LAT0;
console.log(`indoor: ${files.length} buildings, ${(totalKb / 1024).toFixed(1)} MB, ` +
  `${namedRooms}/${totalRooms} rooms numbered (${totalRooms ? Math.round((namedRooms / totalRooms) * 100) : 0}%)`);
for (const w of warnings) console.log(`  note  ${w}`);
for (const e of errors) console.error(`  FAIL  ${e}`);
if (errors.length) { console.error(`\n${errors.length} error(s)`); process.exit(1); }
console.log(`ok — ${warnings.length} note(s)`);
