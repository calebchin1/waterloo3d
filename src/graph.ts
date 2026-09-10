// Routing core shared by the app and scripts/check-graph.ts.
import type { FeatureCollection, LineString } from 'geojson';
import type { LinkProps } from './layers';
import { MX, MY, metres } from './metric';
import { getIndoor, levelForZ, levelOf, nearestNode, nodeId, parseNodeId, type Indoor } from './indoor';

export interface GNode { b: string; c: number[]; kind: 'B' | 'P' | 'X' }
export interface GEdge { a: string; b: string; kind: 'indoor' | 'outdoor'; link?: string; m: number; g?: number[][] }
export interface GraphData { nodes: Record<string, GNode>; edges: GEdge[]; meta?: Record<string, unknown> }

export type SegKind = 'indoor' | 'intra' | 'outdoor' | 'walk' | 'vertical';
export interface Segment {
  kind: SegKind;
  link?: LinkProps;
  building?: string;      // intra/walk/vertical: building walked through
  level?: number;         // walk: the floor; vertical: the floor departed
  toLevel?: number;       // vertical only
  vertical?: 'stair' | 'elevator';
  from: string; to: string; // building codes at each end
  coords: [number, number, number][];
  m: number;
}
export interface RouteOpts { outdoorPenalty: number }

interface Arc { to: string; w: number; m: number; edge?: GEdge; seg?: Segment }
type Adj = Map<string, Arc[]>;
const INTRA_FACTOR = 1.25;
const STAIR_PENALTY = 1.15;   // stairs cost a little more than their length
const FALLBACK_FACTOR = 2.5;  // clique edges inside a building that has floors

/** Min-heap keyed by number; the old sort-per-pop cost nothing at 196 nodes and
 *  is quadratic once a building contributes thousands of indoor nodes. */
class Heap {
  private a: [number, string][] = [];
  get size() { return this.a.length; }
  push(x: [number, string]) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): [number, string] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

function push(adj: Adj, a: string, b: string, w: number, m: number, edge?: GEdge, seg?: Segment) {
  let l = adj.get(a);
  if (!l) { l = []; adj.set(a, l); }
  l.push({ to: b, w, m, edge, seg });
}

/** Corridor graph, stairs and elevators for one building, spliced into the
 *  campus graph. Replaces the synthetic intra-building clique for that code. */
function addIndoor(adj: Adj, code: string, d: Indoor) {
  for (const l of d.levels) {
    for (const e of l.edges) {
      const a = nodeId(code, l.level, e.a), b = nodeId(code, l.level, e.b);
      const coords = e.path.map(([x, y]) => [x, y, l.elevM] as [number, number, number]);
      push(adj, a, b, e.m, e.m, undefined,
        { kind: 'walk', building: code, level: l.level, from: code, to: code, coords, m: e.m });
      push(adj, b, a, e.m, e.m, undefined,
        { kind: 'walk', building: code, level: l.level, from: code, to: code, coords: [...coords].reverse(), m: e.m });
    }
  }
  for (const v of d.vertical) {
    const [la, ia] = v.a, [lb, ib] = v.b;
    if (ia == null || ib == null) continue;
    const A = levelOf(d, la), B = levelOf(d, lb);
    if (!A || !B) continue;
    const ca = A.nodes[ia], cb = B.nodes[ib];
    if (!ca || !cb) continue;
    const w = v.m * (v.kind === 'stair' ? STAIR_PENALTY : 1);
    const up: [number, number, number][] = [[ca[0], ca[1], A.elevM], [cb[0], cb[1], B.elevM]];
    const mk = (from: number, to: number, coords: [number, number, number][]): Segment =>
      ({ kind: 'vertical', building: code, level: from, toLevel: to, vertical: v.kind,
         from: code, to: code, coords, m: v.m });
    push(adj, nodeId(code, la, ia), nodeId(code, lb, ib), w, v.m, undefined, mk(la, lb, up));
    push(adj, nodeId(code, lb, ib), nodeId(code, la, ia), w, v.m, undefined, mk(lb, la, [...up].reverse()));
  }
}

const MAX_ANCHOR_M = 25;      // a longer stub is a misplaced plan, not a corridor

/** Join a campus node (building centroid, outdoor door, tunnel portal) to the
 *  indoor node it actually lands on — one level only. Anchoring the centroid
 *  to every level looked like a way to reach floors whose ground plan is a
 *  fragment, but it made the centroid a free elevator: DC→MC 4055 went
 *  "1st Floor corridor → 4th Floor corridor" with no stairs in between. */
function anchor(adj: Adj, id: string, n: GNode, d: Indoor, z: number | null) {
  const targets = [levelForZ(d, z ?? 0)];
  for (const lvl of targets) {
    if (!lvl) continue;
    const near = nearestNode(lvl, n.c);
    if (!near || near.m > MAX_ANCHOR_M) continue;
    const iid = nodeId(d.code, lvl.level, near.i);
    const m = Math.max(2, near.m);
    const c = lvl.nodes[near.i];
    const coords: [number, number, number][] = [[n.c[0], n.c[1], lvl.elevM], [c[0], c[1], lvl.elevM]];
    const seg: Segment = { kind: 'walk', building: d.code, level: lvl.level, from: n.b, to: n.b, coords, m };
    push(adj, id, iid, m, m, undefined, seg);
    push(adj, iid, id, m, m, undefined, { ...seg, coords: [...coords].reverse() });
  }
}

/** Adjacency with indoor floors spliced in where available, the intra-building
 *  clique synthesised where not, closed links excluded, outdoor cost penalised. */
export function buildAdjacency(g: GraphData, links: FeatureCollection<LineString, LinkProps>, opts: RouteOpts): Adj {
  const linkById = new Map(links.features.map((f) => [f.properties.id, f.properties]));
  const adj: Adj = new Map();
  const nodeIds = Object.keys(g.nodes).filter((id) => {
    if (!id.startsWith('P:')) return true;
    const lp = linkById.get(id.slice(2, id.lastIndexOf(':')));
    return lp && lp.status !== 'closed';
  });
  for (const e of g.edges) {
    if (!nodeIds.includes(e.a) || !nodeIds.includes(e.b)) continue;
    const w = e.kind === 'outdoor' ? e.m * opts.outdoorPenalty : e.m;
    push(adj, e.a, e.b, w, e.m, e); push(adj, e.b, e.a, w, e.m, e);
  }

  const byB = new Map<string, string[]>();
  for (const id of nodeIds) { const b = g.nodes[id].b; if (!byB.has(b)) byB.set(b, []); byB.get(b)!.push(id); }

  for (const [code, ids] of byB) {
    const d = getIndoor(code);
    if (d) {
      addIndoor(adj, code, d);
      for (const id of ids) {
        const n = g.nodes[id];
        const lp = id.startsWith('P:') ? linkById.get(id.slice(2, id.lastIndexOf(':'))) : undefined;
        anchor(adj, id, n, d, lp ? lp.z_m : null);
      }
    }
    // The clique stays even when floors exist, weighted so the real corridors
    // win whenever they connect. A flattened (Tier C) floor can leave a portal
    // anchored to a fragment 100 m from anything; without this a route through
    // that building would fail outright instead of falling back to the old
    // building-to-building hop.
    const k = d ? FALLBACK_FACTOR : 1;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const m = Math.max(5, metres(g.nodes[ids[i]].c, g.nodes[ids[j]].c) * INTRA_FACTOR);
      push(adj, ids[i], ids[j], m * k, m); push(adj, ids[j], ids[i], m * k, m);
    }
  }
  return adj;
}

interface Hop { from: string; edge?: GEdge; seg?: Segment; m: number }

function dijkstra(adj: Adj, src: string, dst: string): { path: string[]; hops: Hop[] } | null {
  const d = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, Hop>();
  const heap = new Heap();
  heap.push([0, src]);
  const done = new Set<string>();
  while (heap.size) {
    const [dd, u] = heap.pop();
    if (done.has(u)) continue; done.add(u);
    if (u === dst) break;
    if (dd > (d.get(u) ?? Infinity)) continue;
    for (const { to, w, m, edge, seg } of adj.get(u) ?? []) {
      const nd = dd + w;
      if (nd < (d.get(to) ?? Infinity)) { d.set(to, nd); prev.set(to, { from: u, edge, seg, m }); heap.push([nd, to]); }
    }
  }
  if (!d.has(dst)) return null;
  const path = [dst], hops: Hop[] = [];
  let c = dst;
  while (c !== src) { const p = prev.get(c)!; path.push(p.from); hops.push(p); c = p.from; }
  return { path: path.reverse(), hops: hops.reverse() };
}

/** Route between two building codes (or an `I:` room node); ordered segments or null. */
export function route(adj: Adj, g: GraphData, links: FeatureCollection<LineString, LinkProps>, from: string, to: string): Segment[] | null {
  const src = from.startsWith('I:') ? from : `B:${from}`;
  const dst = to.startsWith('I:') ? to : `B:${to}`;
  const r = dijkstra(adj, src, dst);
  if (!r) return null;
  const linkById = new Map(links.features.map((f) => [f.properties.id, f]));
  const code = (id: string) => g.nodes[id]?.b ?? parseNodeId(id)?.code ?? '';
  const segs: Segment[] = [];
  for (let i = 0; i < r.hops.length; i++) {
    const a = r.path[i], b = r.path[i + 1], { edge: e, seg, m } = r.hops[i];
    if (seg) { segs.push({ ...seg, m: Math.round(seg.m) }); continue; }
    const na = g.nodes[a], nb = g.nodes[b];
    if (!e) {
      segs.push({ kind: 'intra', building: code(a), from: code(a), to: code(b), m: Math.round(m),
                  coords: [[na.c[0], na.c[1], 1], [nb.c[0], nb.c[1], 1]] });
    } else if (e.kind === 'indoor') {
      const f = linkById.get(e.link!)!;
      let c = f.geometry.coordinates.map(([x, y]) => [x, y, f.properties.z_m] as [number, number, number]);
      if (a.endsWith(':to')) c = c.slice().reverse();
      segs.push({ kind: 'indoor', link: f.properties, from: code(a), to: code(b), m: e.m, coords: c });
    } else {
      let c = (e.g ?? []).map(([x, y]) => [x, y, 0.3] as [number, number, number]);
      if (e.a !== a) c = c.slice().reverse();
      segs.push({ kind: 'outdoor', from: code(a), to: code(b), m: e.m, coords: c });
    }
  }
  return segs;
}

export function summarise(segs: Segment[]) {
  const m = segs.reduce((s, x) => s + x.m, 0);
  const indoor = segs.filter((s) => s.kind !== 'outdoor').reduce((s, x) => s + x.m, 0);
  return { metres: m, minutes: m / 1.3 / 60, indoorShare: m ? indoor / m : 1 };
}

export { MX, MY };
