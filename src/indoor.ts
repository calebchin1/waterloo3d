// Indoor floor plans: fetch, decode and route inside a building.
//
// public/data/indoor/<CODE>.json stores coordinates as integer decimetres in a
// local east/north frame anchored at `origin`, which is roughly ten times
// smaller than repeating lon/lat pairs. Everything here decodes back to lon/lat
// on demand and caches the result per building.
import { LAT0, MX, MY } from './metric';

export type NodeKind = 'corridor' | 'passage';
export type VerticalKind = 'stair' | 'elevator';

interface RawRoom { n: string | null; q: number; a: number; v: number | null; p: number[] }
interface RawShaft { id: string; v: number | null; c: number[]; bbox: number[] }
interface RawLevel {
  level: number; label: string; elevM: number;
  nodes: number[]; kinds: string; edges: [number, number, number, number[]][];
  rooms: RawRoom[]; walls: number[][]; slabs: number[][];
  stairs: RawShaft[]; elevators: RawShaft[]; areaM2: number;
  tier?: 'A' | 'B' | 'C'; stairGeom?: boolean;
}
interface RawIndoor {
  code: string; origin: [number, number]; floorHeightM: number;
  levels: RawLevel[];
  vertical: { kind: VerticalKind; shaft: string; a: [number, number | null]; b: [number, number | null]; m: number; rise: number }[];
  meta: Record<string, unknown>;
}

export interface Room { no: string | null; conf: number; areaM2: number; node: number | null; poly: [number, number][] }
export interface Shaft { id: string; node: number | null; c: [number, number]; bbox: [[number, number], [number, number]] }
export interface IndoorLevel {
  level: number; label: string; elevM: number; areaM2: number;
  nodes: [number, number][]; kinds: NodeKind[];
  edges: { a: number; b: number; m: number; path: [number, number][] }[];
  rooms: Room[]; walls: [number, number][][]; slabs: [number, number][][];
  stairs: Shaft[]; elevators: Shaft[];
}
export interface Indoor {
  code: string; floorHeightM: number;
  levels: IndoorLevel[];
  vertical: { kind: VerticalKind; shaft: string; a: [number, number | null]; b: [number, number | null]; m: number; rise: number }[];
  meta: Record<string, unknown>;
}

/** Node id inside the routing graph. Never contains a colon in the link slot, so
 *  the existing `P:<linkId>:from` parsing in graph.ts is unaffected. */
export const nodeId = (code: string, level: number, i: number) => `I:${code}:${level}:${i}`;
export const parseNodeId = (id: string) => {
  const p = id.split(':');
  return p[0] === 'I' ? { code: p[1], level: Number(p[2]), i: Number(p[3]) } : null;
};

const cache = new Map<string, Promise<Indoor | null>>();

function decodePairs(flat: number[], ox: number, oy: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push([(ox + flat[i] / 10) / MX, (oy + flat[i + 1] / 10) / MY]);
  }
  return out;
}

function decode(raw: RawIndoor): Indoor {
  const ox = raw.origin[0] * MX, oy = raw.origin[1] * MY;
  const pairs = (f: number[]) => decodePairs(f, ox, oy);
  const shaft = (s: RawShaft): Shaft => {
    const bb = pairs(s.bbox ?? []);
    return { id: s.id, node: s.v, c: pairs(s.c)[0], bbox: [bb[0] ?? pairs(s.c)[0], bb[1] ?? pairs(s.c)[0]] };
  };
  return {
    code: raw.code,
    floorHeightM: raw.floorHeightM,
    vertical: raw.vertical,
    meta: raw.meta,
    levels: raw.levels.map((l) => ({
      level: l.level, label: l.label, elevM: l.elevM, areaM2: l.areaM2,
      nodes: pairs(l.nodes),
      kinds: [...l.kinds].map((c) => (c === 'c' ? 'corridor' : 'passage') as NodeKind),
      edges: l.edges.map(([a, b, m, g]) => ({ a, b, m: m / 10, path: pairs(g) })),
      rooms: l.rooms.map((r) => ({ no: r.n, conf: r.q, areaM2: r.a, node: r.v, poly: pairs(r.p) })),
      walls: l.walls.map(pairs),
      slabs: (l.slabs ?? []).map(pairs),
      stairs: l.stairs.map(shaft),
      elevators: l.elevators.map(shaft),
    })),
  };
}

/** Fetch a building's indoor data; resolves to null when there is none. */
export function loadIndoor(code: string): Promise<Indoor | null> {
  let p = cache.get(code);
  if (!p) {
    p = fetch(`/data/indoor/${code}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<RawIndoor>) : null))
      .then((raw) => (raw ? decode(raw) : null))
      .catch(() => null);
    cache.set(code, p);
  }
  return p;
}

/** Synchronously readable once loadIndoor has resolved. */
const ready = new Map<string, Indoor>();
export function markReady(d: Indoor) { ready.set(d.code, d); }
export function getIndoor(code: string): Indoor | undefined { return ready.get(code); }
export function hasIndoor(code: string): boolean { return ready.has(code); }

export function levelOf(d: Indoor, level: number): IndoorLevel | undefined {
  return d.levels.find((l) => l.level === level);
}

/** Level whose elevation best matches a link's z_m — how a tunnel or bridge
 *  portal finds the floor it actually arrives on. */
export function levelForZ(d: Indoor, z: number): IndoorLevel | undefined {
  // A mezzanine or a stub floor can sit closest in elevation while having a
  // few dozen square metres of corridor; a portal anchored there is 100 m from
  // anything. Only full-sized floors are candidates unless nothing else exists.
  const maxArea = Math.max(...d.levels.map((l) => l.areaM2));
  const full = d.levels.filter((l) => l.areaM2 >= 0.25 * maxArea);
  let best: IndoorLevel | undefined, bd = Infinity;
  for (const l of (full.length ? full : d.levels)) {
    const dd = Math.abs(l.elevM - z);
    if (dd < bd) { bd = dd; best = l; }
  }
  return best;
}

const metres = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * MX, (a[1] - b[1]) * MY);

/** Nearest walk node on a level to a lon/lat, with its distance in metres. */
export function nearestNode(l: IndoorLevel, c: number[]): { i: number; m: number } | null {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < l.nodes.length; i++) {
    const d = metres(l.nodes[i], c);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi < 0 ? null : { i: bi, m: bd };
}

/** Every room with a number, for search. */
export function rooms(d: Indoor): { no: string; level: number; node: number | null; c: [number, number] }[] {
  const out: { no: string; level: number; node: number | null; c: [number, number] }[] = [];
  for (const l of d.levels) {
    for (const r of l.rooms) {
      if (!r.no) continue;
      const c = r.poly.length
        ? ([r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length,
            r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length] as [number, number])
        : ([0, 0] as [number, number]);
      out.push({ no: r.no, level: l.level, node: r.node, c });
    }
  }
  return out;
}

export { LAT0, MX, MY };
