import type { Feature, FeatureCollection, LineString } from 'geojson';
import { PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

export type Kind = 'tunnel' | 'bridge' | 'doorway';
export interface LinkProps {
  id: string; from: string; to: string; kind: Kind; z_m: number; name: string;
  status: 'open' | 'closed'; verified: boolean; source: string; notes: string; length_m: number;
}
export type Link = Feature<LineString, LinkProps>;

export const COLORS: Record<Kind, [number, number, number]> = {
  tunnel: [255, 140, 26],
  bridge: [45, 212, 255],
  doorway: [163, 173, 189],
};
const CLOSED: [number, number, number] = [255, 77, 109];

export interface Filters { kinds: Set<Kind>; unverified: boolean; highlight: string | null }

export function visible(links: FeatureCollection<LineString, LinkProps>, f: Filters): Link[] {
  return links.features.filter((l) => f.kinds.has(l.properties.kind) && (f.unverified || l.properties.verified));
}

/** deck.gl layers: a 3D tube per link, plus a faint ground shadow under tunnels/bridges for depth cue. */
export function buildLayers(
  links: FeatureCollection<LineString, LinkProps>,
  f: Filters,
  onClick: (l: Link, coord: [number, number]) => void,
  onHover: (l: Link | null) => void,
  dim = 1,
): Layer[] {
  const data = visible(links, f);
  const color = (l: Link, alpha = 255): [number, number, number, number] => {
    const base = l.properties.status === 'closed' ? CLOSED : COLORS[l.properties.kind];
    const dimmed = (f.highlight && f.highlight !== l.properties.id ? 0.35 : 1) * dim;
    return [base[0], base[1], base[2], Math.round(alpha * dimmed)];
  };
  const width = (l: Link) => (l.properties.kind === 'doorway' ? 1.6 : 3.2) * (f.highlight === l.properties.id ? 1.6 : 1);
  return [
    new PathLayer<Link>({
      id: 'link-shadow',
      data: data.filter((l) => l.properties.kind !== 'doorway'),
      getPath: (l) => l.geometry.coordinates.map(([x, y]) => [x, y, 0.2] as [number, number, number]),
      getColor: (l) => color(l, 70),
      getWidth: (l) => width(l) * 1.4,
      widthUnits: 'meters', widthMinPixels: 1, capRounded: true, jointRounded: true,
      updateTriggers: { getColor: [f.highlight, dim], getWidth: [f.highlight] },
    }),
    new PathLayer<Link>({
      id: 'links',
      data,
      getPath: (l) => l.geometry.coordinates.map(([x, y]) => [x, y, l.properties.z_m] as [number, number, number]),
      getColor: (l) => color(l),
      getWidth: width,
      widthUnits: 'meters', widthMinPixels: 2.5, capRounded: true, jointRounded: true,
      pickable: true,
      onClick: (info) => { if (info.object) onClick(info.object, info.coordinate as [number, number]); },
      onHover: (info) => onHover(info.object ?? null),
      updateTriggers: { getColor: [f.highlight, dim], getWidth: [f.highlight] },
    }),
  ];
}

// ---------------------------------------------------------------- indoor
//
// The plans are drawn as real storeys, not as a floor plan pasted on the map:
// a floor slab you stand on, walls extruded to ceiling height with the door
// openings left as gaps, room floors tinted inside them, and stairs modelled as
// actual steps climbing to the next slab.

import { SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { MX, MY } from './metric';
import type { Indoor, IndoorLevel, Room, Shaft } from './indoor';

type P3 = [number, number, number];

const SLAB: [number, number, number] = [30, 36, 48];
const ROOM: [number, number, number] = [56, 68, 90];
const WALL: [number, number, number] = [214, 222, 233];
const STAIR: [number, number, number] = [0, 214, 143];
const ELEV: [number, number, number] = [120, 190, 255];

const WALL_THICK_M = 0.16;
const WALL_MAX_M = 3.1;
const SLAB_THICK_M = 0.25;
const STEP_COUNT = 14;
const STAIR_RUN_MAX_M = 9;     // a flight, not a whole stairwell block
const STAIR_WIDE_MAX_M = 4.5;

export interface IndoorView { code: string; level: number }

/** Wall polylines -> one thin quad per segment, ready to extrude. A quad is
 *  cheaper and more predictable than trying to extrude an open path. */
function wallQuads(walls: [number, number][][], z: number): { poly: P3[] }[] {
  const out: { poly: P3[] }[] = [];
  const half = WALL_THICK_M / 2;
  for (const w of walls) {
    for (let i = 0; i < w.length - 1; i++) {
      const [x1, y1] = w[i], [x2, y2] = w[i + 1];
      const dx = (x2 - x1) * MX, dy = (y2 - y1) * MY;
      const len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      const nx = (-dy / len) * half, ny = (dx / len) * half;
      const ox = nx / MX, oy = ny / MY;
      out.push({ poly: [
        [x1 + ox, y1 + oy, z], [x2 + ox, y2 + oy, z],
        [x2 - ox, y2 - oy, z], [x1 - ox, y1 - oy, z],
      ] });
    }
  }
  return out;
}

/** A stair shaft as a flight of steps rising to the next slab. The plans give
 *  the shaft footprint but not the tread order, so the flight runs along the
 *  footprint's long axis — right in aggregate, not per-tread. */
function stairSteps(s: Shaft, z: number, rise: number): { poly: P3[]; h: number }[] {
  const [[ax, ay], [bx, by]] = s.bbox;
  const w = Math.abs(bx - ax) * MX, h = Math.abs(by - ay) * MY;
  const along = w >= h;
  const out: { poly: P3[]; h: number }[] = [];
  // Two nearby stairwells sometimes merge into one shaft, and drawing that
  // whole footprint as a flight puts a green ramp across half the floor. Clamp
  // to a plausible flight around the shaft centre instead.
  const runCap = (along ? STAIR_RUN_MAX_M : STAIR_WIDE_MAX_M) / 2 / MX;
  const wideCap = (along ? STAIR_WIDE_MAX_M : STAIR_RUN_MAX_M) / 2 / MY;
  const x0 = Math.max(Math.min(ax, bx), s.c[0] - runCap);
  const x1 = Math.min(Math.max(ax, bx), s.c[0] + runCap);
  const y0 = Math.max(Math.min(ay, by), s.c[1] - wideCap);
  const y1 = Math.min(Math.max(ay, by), s.c[1] + wideCap);
  if (x1 <= x0 || y1 <= y0) return out;
  for (let i = 0; i < STEP_COUNT; i++) {
    const t0 = i / STEP_COUNT, t1 = (i + 1) / STEP_COUNT;
    const p: P3[] = along
      ? [[x0 + (x1 - x0) * t0, y0, z], [x0 + (x1 - x0) * t1, y0, z],
         [x0 + (x1 - x0) * t1, y1, z], [x0 + (x1 - x0) * t0, y1, z]]
      : [[x0, y0 + (y1 - y0) * t0, z], [x1, y0 + (y1 - y0) * t0, z],
         [x1, y0 + (y1 - y0) * t1, z], [x0, y0 + (y1 - y0) * t1, z]];
    out.push({ poly: p, h: Math.max(0.15, (rise * (i + 1)) / STEP_COUNT) });
  }
  return out;
}

// Wall quads are expensive to rebuild and there are thousands per floor, so they
// are cached per level and per z shift (the shift only changes while walking).
const memo = new Map<string, { poly: P3[] }[]>();
function wallsFor(code: string, l: IndoorLevel, z: number) {
  const key = `${code}:${l.level}:${z.toFixed(1)}`;
  let g = memo.get(key);
  if (!g) {
    if (memo.size > 40) memo.clear();
    g = wallQuads(l.walls, z);
    memo.set(key, g);
  }
  return g;
}

/** Storeys around the one being viewed. Only the active building draws, so a
 *  half-megabyte building file never becomes 62 of them on screen. */
export function buildIndoorLayers(d: Indoor, view: IndoorView, span = 1, zShift = 0): Layer[] {
  const wallH = Math.min(WALL_MAX_M, Math.max(2.4, d.floorHeightM - 0.4));
  const levels = d.levels.filter((l) => Math.abs(l.level - view.level) <= span);
  const out: Layer[] = [];
  for (const l of levels) {
    const active = l.level === view.level;
    const fade = active ? 1 : 0.2;
    const z = l.elevM + zShift;
    const a = (v: number) => Math.round(v * fade);
    const id = `${d.code}-${l.level}`;

    if (l.slabs.length) {
      out.push(new SolidPolygonLayer<[number, number][]>({
        id: `in-slab-${id}`,
        data: l.slabs,
        // The slab top sits a few centimetres proud of the storey height: level
        // with it, the basemap ground plane z-fights through the floor when the
        // scene is shifted down for a walk.
        getPolygon: (p: [number, number][]) => p.map(([x, y]) => [x, y, z - SLAB_THICK_M] as P3),
        getFillColor: [SLAB[0], SLAB[1], SLAB[2], a(250)],
        extruded: true, getElevation: SLAB_THICK_M + 0.04, material: false,
      }));
    }
    out.push(new SolidPolygonLayer<Room>({
      id: `in-rooms-${id}`,
      data: l.rooms,
      getPolygon: (r) => r.poly.map(([x, y]) => [x, y, z + 0.02] as P3),
      getFillColor: (r) => [ROOM[0], ROOM[1], ROOM[2], a(r.no ? 190 : 130)],
      extruded: false, material: false, pickable: active,
    }));
    out.push(new SolidPolygonLayer<{ poly: P3[] }>({
      id: `in-walls-${id}`,
      data: wallsFor(d.code, l, z),
      getPolygon: (w) => w.poly,
      getFillColor: [WALL[0], WALL[1], WALL[2], a(active ? 235 : 120)],
      extruded: true, getElevation: wallH, material: true,
    }));

    if (!active) continue;

    const rise = d.floorHeightM;
    const shafts: { s: Shaft; kind: 'stair' | 'elevator' }[] = [
      ...l.stairs.map((s) => ({ s, kind: 'stair' as const })),
      ...l.elevators.map((s) => ({ s, kind: 'elevator' as const })),
    ];
    const steps = shafts.filter((x) => x.kind === 'stair').flatMap((x) => stairSteps(x.s, z, rise));
    if (steps.length) {
      out.push(new SolidPolygonLayer<{ poly: P3[]; h: number }>({
        id: `in-steps-${id}`,
        data: steps,
        getPolygon: (s) => s.poly,
        getFillColor: [STAIR[0], STAIR[1], STAIR[2], 210],
        getElevation: (s) => s.h,
        extruded: true, material: true,
      }));
    }
    const lifts = shafts.filter((x) => x.kind === 'elevator');
    if (lifts.length) {
      out.push(new SolidPolygonLayer<{ s: Shaft; kind: string }>({
        id: `in-lifts-${id}`,
        data: lifts,
        getPolygon: ({ s }) => {
          const [[ax, ay], [bx, by]] = s.bbox;
          return [[ax, ay, z], [bx, ay, z], [bx, by, z], [ax, by, z]] as P3[];
        },
        getFillColor: [ELEV[0], ELEV[1], ELEV[2], 190],
        getElevation: rise, extruded: true, material: true,
      }));
    }

    out.push(new PathLayer<IndoorLevel['edges'][number]>({
      id: `in-spine-${id}`,
      data: l.edges,
      getPath: (e) => e.path.map(([x, y]) => [x, y, z + 0.06] as P3),
      getColor: [255, 214, 10, 70],
      getWidth: 0.3, widthUnits: 'meters', widthMinPixels: 1,
    }));
    out.push(new TextLayer<Room>({
      id: `in-labels-${id}`,
      data: l.rooms.filter((r) => r.no),
      getPosition: (r) => {
        const n = r.poly.length || 1;
        return [r.poly.reduce((s, p) => s + p[0], 0) / n,
                r.poly.reduce((s, p) => s + p[1], 0) / n, z + 1.7] as P3;
      },
      getText: (r) => r.no ?? '',
      getSize: 11, sizeUnits: 'pixels', sizeMinPixels: 8, sizeMaxPixels: 15,
      getColor: [240, 245, 252, 235],
      outlineWidth: 2, outlineColor: [10, 14, 20, 200], fontSettings: { sdf: true },
      characterSet: 'auto', billboard: true,
    }));
  }
  return out;
}
