// Route state + deck.gl layers for the highlighted route.
import { PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Segment } from './graph';

export const ROUTE_COLOR: [number, number, number] = [255, 214, 10];
const OUTDOOR_COLOR: [number, number, number] = [255, 255, 255];

export function routeLayers(segs: Segment[] | null, activeIndex: number | null): Layer[] {
  if (!segs) return [];
  const data = segs.map((s, i) => ({ s, i }));
  return [
    new PathLayer<{ s: Segment; i: number }>({
      id: 'route-halo',
      data,
      getPath: (d) => d.s.coords,
      getColor: (d) => [...(d.s.kind === 'outdoor' ? OUTDOOR_COLOR : ROUTE_COLOR), 70],
      getWidth: 11,
      widthUnits: 'meters', widthMinPixels: 6, capRounded: true, jointRounded: true,
    }),
    new PathLayer<{ s: Segment; i: number }>({
      id: 'route',
      data,
      getPath: (d) => d.s.coords,
      getColor: (d) => [...(d.s.kind === 'outdoor' ? OUTDOOR_COLOR : ROUTE_COLOR), activeIndex === null || activeIndex === d.i ? 255 : 150],
      getWidth: (d) => (d.s.kind === 'intra' ? 2.5 : activeIndex === d.i ? 6 : 4.5),
      widthUnits: 'meters', widthMinPixels: 3, capRounded: true, jointRounded: true,
      updateTriggers: { getColor: [activeIndex], getWidth: [activeIndex] },
    }),
  ];
}

export function routeBounds(segs: Segment[]): [[number, number], [number, number]] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const seg of segs) for (const [x, y] of seg.coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}
