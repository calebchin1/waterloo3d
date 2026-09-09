// Overpass -> public/data/buildings.geojson + public/data/osm-indoor.geojson
// Run: npm run fetch-osm. Outputs are committed; the app never hits Overpass at runtime.
import { writeFileSync } from 'node:fs';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';

const BBOX = '43.465,-80.552,43.478,-80.535';
const QUERY = `[out:json][timeout:90];
(
  way["building"](${BBOX});
  relation["building"](${BBOX});
  way["highway"]["indoor"="yes"](${BBOX});
  way["highway"]["tunnel"](${BBOX});
  way["highway"]["bridge"](${BBOX});
  way["highway"]["layer"~"^-"](${BBOX});
);
out geom;`;

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  body: 'data=' + encodeURIComponent(QUERY),
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'waterloo-tunnels-3d/0.1 (caleb.chin04@gmail.com)' },
});
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const { elements } = (await res.json()) as { elements: any[] };

// OSM lacks short_name on a few campus buildings; alias by name.
const CODE_BY_NAME: Record<string, string> = {
  'Tatham Centre for Co-operative Education and Career Action': 'TC',
  'William G. Davis Computer Research Centre': 'DC',
  'Davis Centre': 'DC',
  'Mathematics 3': 'M3',
  'Pearl Sullivan Engineering Building': 'E7',
  'Mike & Ophelia Lazaridis Quantum Nano Centre': 'QNC',
};
const buildings: Feature<Polygon | import('geojson').MultiPolygon>[] = [];
const indoor: Feature<LineString>[] = [];

// Assemble closed rings from unordered outer-member ways of a multipolygon.
function assembleRings(ways: number[][][]): number[][][] {
  const pool = ways.map((w) => w.slice());
  const rings: number[][][] = [];
  const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
  while (pool.length) {
    const ring = pool.shift()!;
    let grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const tail = ring[ring.length - 1];
        if (same(w[0], tail)) ring.push(...w.slice(1));
        else if (same(w[w.length - 1], tail)) ring.push(...w.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

for (const e of elements) {
  const t = e.tags ?? {};
  if (e.type === 'relation' && t.building) {
    const outers = (e.members ?? [])
      .filter((m: any) => m.type === 'way' && m.role !== 'inner' && m.geometry)
      .map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]));
    const rings = assembleRings(outers);
    if (!rings.length) continue;
    const levels = parseFloat(t['building:levels']);
    const height = parseFloat(t.height);
    const height_m = Number.isFinite(height) ? height : Number.isFinite(levels) ? levels * 3.5 : 12;
    buildings.push({
      type: 'Feature',
      id: e.id,
      properties: {
        osm_id: e.id,
        name: t.name ?? null,
        code: t.ref ?? t.short_name ?? CODE_BY_NAME[t.name] ?? null,
        alt_code: t.old_ref ?? null,
        height_m,
        levels: Number.isFinite(levels) ? levels : null,
        campus: !!(t.operator?.includes('Waterloo') || t.ref || t.short_name),
      },
      geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) } as any,
    } as any);
    continue;
  }
  if (e.type !== 'way' || !e.geometry) continue;
  const coords = e.geometry.map((p: any) => [p.lon, p.lat]);
  if (t.building) {
    if (coords.length < 4) continue;
    const levels = parseFloat(t['building:levels']);
    const height = parseFloat(t.height);
    const height_m = Number.isFinite(height) ? height : Number.isFinite(levels) ? levels * 3.5 : 12;
    buildings.push({
      type: 'Feature',
      id: e.id,
      properties: {
        osm_id: e.id,
        name: t.name ?? null,
        code: t.ref ?? t.short_name ?? CODE_BY_NAME[t.name] ?? null,
        alt_code: t.old_ref ?? null,
        height_m,
        levels: Number.isFinite(levels) ? levels : null,
        campus: !!(t.operator?.includes('Waterloo') || t.ref || t.short_name || /University of Waterloo/i.test(t.name ?? '')),
      },
      geometry: { type: 'Polygon', coordinates: [coords] },
    });
  } else {
    indoor.push({
      type: 'Feature',
      id: e.id,
      properties: {
        osm_id: e.id,
        name: t.name ?? null,
        highway: t.highway,
        tunnel: t.tunnel ?? null,
        bridge: t.bridge ?? null,
        layer: t.layer ?? null,
        level: t.level ?? null,
        covered: t.covered ?? null,
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
}

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
writeFileSync('public/data/buildings.geojson', JSON.stringify(fc(buildings)));
writeFileSync('public/data/osm-indoor.geojson', JSON.stringify(fc(indoor), null, 1));
console.log(`buildings=${buildings.length} indoor=${indoor.length}`);
