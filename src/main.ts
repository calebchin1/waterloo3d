import './style.css';
import type { MapLayerMouseEvent, Popup } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { FeatureCollection, LineString } from 'geojson';
import { buildLayers, type Filters, type Kind, type Link, type LinkProps } from './layers';
import { initUI } from './ui';

const HOME = { center: [-80.5421, 43.4701] as [number, number], zoom: 16.35, pitch: 58, bearing: -18 };

// Fetch the basemap style and strip what we don't want: the Natural Earth raster
// (404s and stalls style loading) and the basemap's own building layers.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const style = await fetch(STYLE_URL).then((r) => r.json());
delete style.sources.ne2_shaded;
style.layers = style.layers.filter((l: any) => l.source !== 'ne2_shaded' && !/building/i.test(l.id));

const map = new maplibregl.Map({
  container: 'map',
  style,
  ...HOME,
  maxPitch: 75,
  attributionControl: false,
});
map.on('error', (e) => console.error('[map]', e.error ?? e));
if (import.meta.env.DEV) (window as any).__map = map;
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay as any);

const filters: Filters = { kinds: new Set<Kind>(['tunnel', 'bridge', 'doorway']), unverified: true, highlight: null };
let links: FeatureCollection<LineString, LinkProps>;
let popup: Popup | null = null;

function refresh() {
  overlay.setProps({ layers: buildLayers(links, filters, showPopup, (l) => { map.getCanvas().style.cursor = l ? 'pointer' : ''; }) });
}

function showPopup(l: Link, coord: [number, number]) {
  popup?.remove();
  const p = l.properties;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  popup = new maplibregl.Popup({ offset: 12 })
    .setLngLat(coord)
    .setHTML(`<div class="pop">
      <div class="kind ${p.kind}">${p.kind}${p.status === 'closed' ? ' · <span class="closed">closed</span>' : ''}${p.verified ? '' : ' · unverified'}</div>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.from)} ↔ ${esc(p.to)} · ${p.length_m} m · ${p.z_m > 0 ? '+' : ''}${p.z_m} m</p>
      <p>${esc(p.notes)}</p>
      <div class="src">Source: ${esc(p.source)}</div>
    </div>`)
    .addTo(map);
  filters.highlight = p.id;
  refresh();
  popup.on('close', () => { filters.highlight = null; refresh(); });
}

function flyTo(l: Link) {
  const c = l.geometry.coordinates;
  const mid = c[Math.floor(c.length / 2)] as [number, number];
  map.flyTo({ center: mid, zoom: 18.2, pitch: 62, bearing: map.getBearing(), duration: 1200 });
  showPopup(l, mid);
}

map.on('load', async () => {
  const [buildings, conn] = await Promise.all([
    fetch('/data/buildings.geojson').then((r) => r.json()) as Promise<FeatureCollection>,
    fetch('/data/connections.geojson').then((r) => r.json()) as Promise<FeatureCollection<LineString, LinkProps>>,
  ]);
  links = conn;

  map.addSource('buildings', { type: 'geojson', data: buildings, promoteId: 'osm_id' });
  map.addLayer({
    id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings',
    paint: {
      'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffb703', ['boolean', ['get', 'campus'], false], '#5c6b85', '#3a4252'],
      'fill-extrusion-height': ['get', 'height_m'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.35,
      'fill-extrusion-vertical-gradient': true,
    },
  });

  // Building code labels at footprint centroids.
  const labels: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildings.features.filter((f) => f.properties?.code).map((f) => {
      const g = f.geometry as any;
      const ring: number[][] = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.reduce((a: number[][], p: any) => (p[0].length > a.length ? p[0] : a), []);
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      return { type: 'Feature', properties: { code: f.properties!.code, name: f.properties!.name }, geometry: { type: 'Point', coordinates: [cx, cy] } };
    }),
  };
  map.addSource('labels', { type: 'geojson', data: labels });
  map.addLayer({
    id: 'building-labels', type: 'symbol', source: 'labels',
    layout: { 'text-field': ['get', 'code'], 'text-size': 13, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': false },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b0e13', 'text-halo-width': 1.4 },
  });

  let hovered: string | number | null = null;
  map.on('mousemove', 'buildings-3d', (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.id ?? null;
    if (id === hovered) return;
    if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: false });
    hovered = id;
    if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: true });
  });
  map.on('mouseleave', 'buildings-3d', () => {
    if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: false });
    hovered = null;
  });

  refresh();
  initUI({
    links,
    filters,
    refresh,
    flyTo,
    setXray: (on) => map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', on ? 0.35 : 0.92),
    reset: () => { popup?.remove(); map.flyTo({ ...HOME, duration: 1200 }); },
  });
});
