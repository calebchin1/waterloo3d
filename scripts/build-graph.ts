// Builds public/data/graph.json: a tiny routing graph for the browser.
// Heavy work (10k-node OSM footway network) is collapsed offline into
// building-pair outdoor shortcuts; tunnels/bridges are first-class edges.
// Run: npm run build-graph
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { FeatureCollection, LineString } from 'geojson';
import { toM, toLL, dist, simplify, loadBuildings, nearestBoundary, type Bldg } from './geo';

const BBOX = '43.465,-80.552,43.478,-80.535';
const K_NEAREST = 4;          // outdoor shortcuts per building
const SNAP_M = 60;            // max distance from centroid to footway node
const SIMPLIFY_TOL_M = 1.5;

// ---------- OSM footway network ----------
const QUERY = `[out:json][timeout:90];
(way["highway"~"^(footway|path|pedestrian|steps|cycleway|service|living_street|residential)$"]["indoor"!="yes"]["access"!="private"](${BBOX}););
out geom;`;
// Raw Overpass response is cached (gitignored) so rebuilds don't depend on Overpass uptime.
const CACHE = '.cache/footways.json';
let elements: any[];
if (existsSync(CACHE) && !process.argv.includes('--refresh')) {
  elements = JSON.parse(readFileSync(CACHE, 'utf8')).elements;
} else {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 5000 * attempt));
    res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(QUERY),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'waterloo-tunnels-3d/0.1 (caleb.chin04@gmail.com)' },
    });
  }
  if (!res?.ok) throw new Error(`Overpass ${res?.status}`);
  const text = await res.text();
  mkdirSync('.cache', { recursive: true });
  writeFileSync(CACHE, text);
  elements = JSON.parse(text).elements;
}

// node key -> metric coord; adjacency: key -> [key, weight]
const key = (p: number[]) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const coord = new Map<string, number[]>();
const adj = new Map<string, [string, number][]>();
const link = (a: string, b: string, w: number) => {
  (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]);
  (adj.get(b) ?? adj.set(b, []).get(b)!).push([a, w]);
};
let footwayWays = 0;
for (const e of elements) {
  if (e.type !== 'way' || !e.geometry) continue;
  footwayWays++;
  const mult = e.tags?.highway === 'steps' ? 1.5 : e.tags?.highway === 'residential' || e.tags?.highway === 'service' ? 1.15 : 1;
  const pts = e.geometry.map((p: any) => [p.lon, p.lat]);
  for (let i = 0; i < pts.length; i++) {
    const k = key(pts[i]);
    if (!coord.has(k)) coord.set(k, toM(pts[i]));
    if (i > 0) link(key(pts[i - 1]), k, dist(coord.get(key(pts[i - 1]))!, coord.get(k)!) * mult);
  }
}

// Keep only the largest connected component so doors never snap to stray fragments.
{
  const seen = new Set<string>(); let best: string[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp: string[] = []; const stack = [start]; seen.add(start);
    while (stack.length) { const u = stack.pop()!; comp.push(u); for (const [v] of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
    if (comp.length > best.length) best = comp;
  }
  const keep = new Set(best);
  for (const k of [...coord.keys()]) if (!keep.has(k)) { coord.delete(k); adj.delete(k); }
}

// ---------- buildings & door nodes ----------
const bfc = JSON.parse(readFileSync('public/data/buildings.geojson', 'utf8')) as FeatureCollection;
const bld = loadBuildings(bfc);
const nodes = [...coord.entries()];
function nearestNode(p: number[], maxD: number) {
  let best: string | null = null, bd = maxD;
  for (const [k, c] of nodes) { const d = dist(c, p); if (d < bd) { bd = d; best = k; } }
  return best;
}
const door = new Map<string, string>(); // code -> footway node key
for (const b of bld.values()) {
  let k = nearestNode(b.centroid, SNAP_M);
  if (!k) {
    // fall back: nearest footway node to any footprint vertex within 40 m
    let bd = 40;
    for (const r of b.rings) for (const v of r) { const n = nearestNode(v, bd); if (n) { k = n; bd = dist(coord.get(n)!, v); } }
  }
  if (k) door.set(b.code, k);
  else console.warn(`no footway node near ${b.code}`);
}

// ---------- Dijkstra over footways ----------
function dijkstra(src: string) {
  const d = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, string>();
  const heap: [number, string][] = [[0, src]];
  const push = (x: [number, string]) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const done = new Set<string>();
  while (heap.length) {
    const [dd, u] = pop();
    if (done.has(u)) continue; done.add(u);
    if (dd > 1200) break;
    for (const [v, w] of adj.get(u) ?? []) {
      const nd = dd + w;
      if (nd < (d.get(v) ?? Infinity)) { d.set(v, nd); prev.set(v, u); push([nd, v]); }
    }
  }
  return { d, prev };
}
function pathTo(prev: Map<string, string>, src: string, dst: string) {
  const out = [dst]; let c = dst;
  while (c !== src) { c = prev.get(c)!; if (!c) return null; out.push(c); }
  return out.reverse().map((k) => coord.get(k)!);
}

// ---------- assemble graph ----------
interface GNode { b: string; c: number[]; kind: 'B' | 'P' | 'X' }
interface GEdge { a: string; b: string; kind: 'indoor' | 'outdoor'; link?: string; m: number; g?: number[][] }
const gnodes: Record<string, GNode> = {};
const gedges: GEdge[] = [];
for (const b of bld.values()) gnodes[`B:${b.code}`] = { b: b.code, c: toLL(b.centroid).map((v) => +v.toFixed(6)), kind: 'B' };
for (const [code, k] of door) gnodes[`X:${code}`] = { b: code, c: toLL(coord.get(k)!).map((v) => +v.toFixed(6)), kind: 'X' };

const cfc = JSON.parse(readFileSync('public/data/connections.geojson', 'utf8')) as FeatureCollection<LineString>;
for (const f of cfc.features) {
  const p = f.properties!;
  const c = f.geometry.coordinates;
  const A = `P:${p.id}:from`, B = `P:${p.id}:to`;
  gnodes[A] = { b: p.from, c: c[0], kind: 'P' };
  gnodes[B] = { b: p.to, c: c[c.length - 1], kind: 'P' };
  gedges.push({ a: A, b: B, kind: 'indoor', link: p.id, m: p.length_m });
}

const seen = new Set<string>();
const doorCodes = [...door.keys()];
for (const code of doorCodes) {
  const src = door.get(code)!;
  const { d, prev } = dijkstra(src);
  const near = doorCodes
    .filter((o) => o !== code && d.has(door.get(o)!))
    .map((o) => [o, d.get(door.get(o)!)!] as [string, number])
    .sort((x, y) => x[1] - y[1])
    .slice(0, K_NEAREST);
  for (const [o, m] of near) {
    const id = [code, o].sort().join('|');
    if (seen.has(id)) continue; seen.add(id);
    const path = pathTo(prev, src, door.get(o)!);
    if (!path) continue;
    gedges.push({ a: `X:${code}`, b: `X:${o}`, kind: 'outdoor', m: Math.round(m), g: simplify(path, SIMPLIFY_TOL_M).map((p) => toLL(p).map((v) => +v.toFixed(6))) });
  }
}

const out = { nodes: gnodes, edges: gedges, meta: { built: new Date().toISOString().slice(0, 10), footwayWays, footwayNodes: coord.size, k: K_NEAREST } };
writeFileSync('public/data/graph.json', JSON.stringify(out));
const outdoor = gedges.filter((e) => e.kind === 'outdoor');
console.log(`graph: ${Object.keys(gnodes).length} nodes, ${gedges.length} edges (${outdoor.length} outdoor, ${gedges.length - outdoor.length} indoor), ${(JSON.stringify(out).length / 1024).toFixed(1)} KB, from ${footwayWays} footway ways / ${coord.size} nodes`);
