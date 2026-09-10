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
