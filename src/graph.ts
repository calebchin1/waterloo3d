// Routing core shared by the app and scripts/check-graph.ts.
import type { FeatureCollection, LineString } from 'geojson';
import type { LinkProps } from './layers';

export interface GNode { b: string; c: number[]; kind: 'B' | 'P' | 'X' }
export interface GEdge { a: string; b: string; kind: 'indoor' | 'outdoor'; link?: string; m: number; g?: number[][] }
export interface GraphData { nodes: Record<string, GNode>; edges: GEdge[]; meta?: Record<string, unknown> }

export type SegKind = 'indoor' | 'intra' | 'outdoor';
export interface Segment {
  kind: SegKind;
  link?: LinkProps;
  building?: string;      // intra: building walked through
  from: string; to: string; // building codes at each end
  coords: [number, number, number][];
  m: number;
}
export interface RouteOpts { outdoorPenalty: number }

type Adj = Map<string, { to: string; w: number; m: number; edge?: GEdge }[]>;
const INTRA_FACTOR = 1.25;

const LAT0 = 43.471, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180), MY = 110574;
const metres = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * MX, (a[1] - b[1]) * MY);

/** Adjacency with intra-building edges synthesised; closed links excluded; outdoor cost penalised. */
export function buildAdjacency(g: GraphData, links: FeatureCollection<LineString, LinkProps>, opts: RouteOpts): Adj {
  const linkById = new Map(links.features.map((f) => [f.properties.id, f.properties]));
  const adj: Adj = new Map();
  const push = (a: string, b: string, w: number, m: number, edge?: GEdge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, w, m, edge });
  };
  const nodeIds = Object.keys(g.nodes).filter((id) => {
    if (!id.startsWith('P:')) return true;
    const lp = linkById.get(id.slice(2, id.lastIndexOf(':')));
    return lp && lp.status !== 'closed';
  });
  for (const e of g.edges) {
    if (!nodeIds.includes(e.a) || !nodeIds.includes(e.b)) continue;
    const w = e.kind === 'outdoor' ? e.m * opts.outdoorPenalty : e.m;
    push(e.a, e.b, w, e.m, e); push(e.b, e.a, w, e.m, e);
  }
  const byB = new Map<string, string[]>();
  for (const id of nodeIds) { const b = g.nodes[id].b; if (!byB.has(b)) byB.set(b, []); byB.get(b)!.push(id); }
  for (const ids of byB.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const m = Math.max(5, metres(g.nodes[ids[i]].c, g.nodes[ids[j]].c) * INTRA_FACTOR);
    push(ids[i], ids[j], m, m); push(ids[j], ids[i], m, m);
  }
  return adj;
}

function dijkstra(adj: Adj, src: string, dst: string): { path: string[]; edges: (GEdge | undefined)[]; ms: number[] } | null {
  const d = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, { from: string; edge?: GEdge; m: number }>();
  const heap: [number, string][] = [[0, src]];
  const done = new Set<string>();
  while (heap.length) {
    heap.sort((x, y) => x[0] - y[0]);
    const [dd, u] = heap.shift()!;
    if (done.has(u)) continue; done.add(u);
    if (u === dst) break;
    for (const { to, w, m, edge } of adj.get(u) ?? []) {
      const nd = dd + w;
      if (nd < (d.get(to) ?? Infinity)) { d.set(to, nd); prev.set(to, { from: u, edge, m }); heap.push([nd, to]); }
    }
  }
  if (!d.has(dst)) return null;
  const path = [dst], edges: (GEdge | undefined)[] = [], ms: number[] = [];
  let c = dst;
  while (c !== src) { const p = prev.get(c)!; path.push(p.from); edges.push(p.edge); ms.push(p.m); c = p.from; }
  return { path: path.reverse(), edges: edges.reverse(), ms: ms.reverse() };
}

/** Route between two building codes; returns ordered segments or null. */
export function route(adj: Adj, g: GraphData, links: FeatureCollection<LineString, LinkProps>, from: string, to: string): Segment[] | null {
  const r = dijkstra(adj, `B:${from}`, `B:${to}`);
  if (!r) return null;
  const linkById = new Map(links.features.map((f) => [f.properties.id, f]));
  const segs: Segment[] = [];
  for (let i = 0; i < r.edges.length; i++) {
    const a = r.path[i], b = r.path[i + 1], e = r.edges[i];
    const na = g.nodes[a], nb = g.nodes[b];
    if (!e) {
      segs.push({ kind: 'intra', building: na.b, from: na.b, to: nb.b, m: Math.round(r.ms[i]), coords: [[na.c[0], na.c[1], 1], [nb.c[0], nb.c[1], 1]] });
    } else if (e.kind === 'indoor') {
      const f = linkById.get(e.link!)!;
      let c = f.geometry.coordinates.map(([x, y]) => [x, y, f.properties.z_m] as [number, number, number]);
      if (a.endsWith(':to')) c = c.slice().reverse();
      segs.push({ kind: 'indoor', link: f.properties, from: na.b, to: nb.b, m: e.m, coords: c });
    } else {
      let c = (e.g ?? []).map(([x, y]) => [x, y, 0.3] as [number, number, number]);
      if (e.a !== a) c = c.slice().reverse();
      segs.push({ kind: 'outdoor', from: na.b, to: nb.b, m: e.m, coords: c });
    }
  }
  return segs;
}

export function summarise(segs: Segment[]) {
  const metres = segs.reduce((s, x) => s + x.m, 0);
  const indoor = segs.filter((s) => s.kind !== 'outdoor').reduce((s, x) => s + x.m, 0);
  return { metres, minutes: metres / 1.3 / 60, indoorShare: metres ? indoor / metres : 1 };
}
