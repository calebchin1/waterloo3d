// Route state + deck.gl layers for the highlighted route.
import { PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Segment } from './graph';

export const ROUTE_COLOR: [number, number, number] = [255, 214, 10];
const OUTDOOR_COLOR: [number, number, number] = [255, 255, 255];

export function routeLayers(segs: Segment[] | null, activeIndex: number | null, pov = false, zShift = 0): Layer[] {
  if (!segs) return [];
  const data = segs.map((s, i) => ({ s, i }));
  // Walking inside the route means the camera sits *in* the tube; at 11 m the
  // halo simply fills the screen, so it thins right down in POV.
  const halo = pov ? 2.6 : 11;
  const core = pov ? 0.5 : 1;
  return [
    new PathLayer<{ s: Segment; i: number }>({
      id: 'route-halo',
      data,
      getPath: (d) => d.s.coords.map(([x, y, z]) => [x, y, z + zShift] as [number, number, number]),
      getColor: (d) => [...(d.s.kind === 'outdoor' ? OUTDOOR_COLOR : ROUTE_COLOR), pov ? 40 : 70],
      getWidth: halo,
      widthUnits: 'meters', widthMinPixels: pov ? 2 : 6, capRounded: true, jointRounded: true,
      updateTriggers: { getPath: [zShift] },
    }),
    new PathLayer<{ s: Segment; i: number }>({
      id: 'route',
      data,
      getPath: (d) => d.s.coords.map(([x, y, z]) => [x, y, z + zShift] as [number, number, number]),
      getColor: (d) => [...(d.s.kind === 'outdoor' ? OUTDOOR_COLOR : ROUTE_COLOR), activeIndex === null || activeIndex === d.i ? 255 : 150],
      getWidth: (d) => core * (d.s.kind === 'intra' ? 2.5 : activeIndex === d.i ? 6 : 4.5),
      widthUnits: 'meters', widthMinPixels: pov ? 1.5 : 3, capRounded: true, jointRounded: true,
      updateTriggers: { getColor: [activeIndex, pov], getWidth: [activeIndex, pov], getPath: [zShift] },
    }),
  ];
}

export function routeBounds(segs: Segment[]): [[number, number], [number, number]] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const seg of segs) for (const [x, y] of seg.coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}
