// Shared planar geometry helpers (local metric projection around campus).
import type { FeatureCollection } from 'geojson';

export const LAT0 = 43.471;
export const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
export const MY = 110574;
export const toM = ([lon, lat]: number[]) => [lon * MX, lat * MY];
export const toLL = ([x, y]: number[]) => [+(x / MX).toFixed(7), +(y / MY).toFixed(7)];
export const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1]];
export const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: number[], k: number) => [a[0] * k, a[1] * k];
export const len = (a: number[]) => Math.hypot(a[0], a[1]);
export const unit = (a: number[]) => mul(a, 1 / (len(a) || 1));
export const dist = (a: number[], b: number[]) => len(sub(a, b));

export function nearestOnSeg(p: number[], a: number[], b: number[]) {
  const ab = sub(b, a);
  const L = ab[0] ** 2 + ab[1] ** 2;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L));
  return add(a, mul(ab, t));
}
export function pip(p: number[], ring: number[][]) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
export interface Bldg { code: string; name: string; rings: number[][][]; centroid: number[] }
export function inside(b: Bldg, p: number[]) { return b.rings.some((r) => pip(p, r)); }
export function nearestBoundary(b: Bldg, p: number[]) {
  let best = p, bd = Infinity;
  for (const r of b.rings) for (let i = 0; i < r.length - 1; i++) {
    const q = nearestOnSeg(p, r[i], r[i + 1]); const d = len(sub(q, p));
    if (d < bd) { bd = d; best = q; }
  }
  return { q: best, d: bd };
}
/** Closest pair of points between two buildings' outlines. */
export function nearestPair(a: Bldg, b: Bldg) {
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
/** Push the end of a path 12 m into its building so the tube visibly enters it. */
export function enter(b: Bldg, path: number[][], atStart: boolean) {
  const p = atStart ? path[0] : path[path.length - 1];
  if (inside(b, p)) return path;
  const { q } = nearestBoundary(b, p);
  let dir = unit(sub(q, p));
  let deep = add(q, mul(dir, 12));
  if (!inside(b, deep)) { dir = unit(sub(b.centroid, q)); deep = add(q, mul(dir, 12)); }
  const ext = [q, deep];
  return atStart ? [...ext.reverse(), ...path] : [...path, ...ext];
}
/** Chain OSM ways end-to-end regardless of their stored direction. */
export function chain(ways: number[][][]) {
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
/** Douglas-Peucker simplification in metric space. */
export function simplify(pts: number[][], tol: number): number[][] {
  if (pts.length <= 2) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(pts[i], nearestOnSeg(pts[i], pts[0], pts[pts.length - 1]));
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}
/** Load coded campus buildings from buildings.geojson into metric space. */
export function loadBuildings(fc: FeatureCollection): Map<string, Bldg> {
  const bld = new Map<string, Bldg>();
  for (const f of fc.features) {
    const code = f.properties?.code as string | null;
    if (!code) continue;
    const g = f.geometry as any;
    const rings: number[][][] = (g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p: any) => p[0])).map((r: number[][]) => r.map(toM));
    const all = rings.flat();
    const centroid = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
    const prev = bld.get(code);
    bld.set(code, prev ? { ...prev, rings: [...prev.rings, ...rings] } : { code, name: f.properties?.name ?? code, rings, centroid });
  }
  return bld;
}
