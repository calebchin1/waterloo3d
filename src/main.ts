import './style.css';
import type { MapLayerMouseEvent, Popup } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { FeatureCollection, LineString } from 'geojson';
import { buildLayers, type Filters, type Kind, type Link, type LinkProps } from './layers';
import { initUI } from './ui';
import { buildAdjacency, route, summarise, type GraphData, type Segment } from './graph';
import { toSteps, type Step } from './steps';
import { routeLayers, routeBounds } from './route';
import { createPlayer, type Player } from './pov';

const HOME = { center: [-80.5421, 43.4701] as [number, number], zoom: 16.35, pitch: 58, bearing: -18 };
const isMobile = () => matchMedia('(max-width: 720px)').matches;

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
  maxPitch: 80,
  attributionControl: false,
});
map.on('error', (e) => console.error('[map]', e.error ?? e));
if (import.meta.env.DEV) (window as any).__map = map;
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: !isMobile() }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay as any);

const filters: Filters = { kinds: new Set<Kind>(['tunnel', 'bridge', 'doorway']), unverified: true, highlight: null };
let links: FeatureCollection<LineString, LinkProps>;
let graph: GraphData;
let popup: Popup | null = null;
let currentRoute: Segment[] | null = null;
let currentSteps: Step[] = [];
let activeSeg: number | null = null;
let player: Player | null = null;
let xray = true;

function refresh() {
  const dim = currentRoute ? 0.25 : 1;
  overlay.setProps({
    layers: [
      ...buildLayers(links, filters, showPopup, (l) => { map.getCanvas().style.cursor = l ? 'pointer' : ''; }, dim),
      ...routeLayers(currentRoute, activeSeg),
    ],
  });
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

/** Padding that keeps the route clear of the panel / sheet. */
function fitPadding() {
  return isMobile() ? { top: 60, left: 20, right: 20, bottom: Math.round(innerHeight * 0.45) + 20 } : { top: 40, left: 400, right: 60, bottom: 40 };
}

const setBuildingOpacity = (v: number) => map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', v);

map.on('load', async () => {
  const [buildings, conn, g] = await Promise.all([
    fetch('/data/buildings.geojson').then((r) => r.json()) as Promise<FeatureCollection>,
    fetch('/data/connections.geojson').then((r) => r.json()) as Promise<FeatureCollection<LineString, LinkProps>>,
    fetch('/data/graph.json').then((r) => r.json()) as Promise<GraphData>,
  ]);
  links = conn; graph = g;
  const names = new Map<string, string>();
  for (const f of buildings.features) if (f.properties?.code) names.set(f.properties.code, f.properties.name ?? f.properties.code);
  const routable = Object.values(graph.nodes).filter((n) => n.kind === 'X').map((n) => ({ code: n.b, name: names.get(n.b) ?? n.b }));

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

  const labels: FeatureCollection = {
    type: 'FeatureCollection',
    features: buildings.features.filter((f) => f.properties?.code).map((f) => {
      const geo = f.geometry as any;
      const ring: number[][] = geo.type === 'Polygon' ? geo.coordinates[0] : geo.coordinates.reduce((a: number[][], p: any) => (p[0].length > a.length ? p[0] : a), []);
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

  // ---- POV walkthrough ----
  const pov = document.getElementById('pov')!;
  const povStep = document.getElementById('pov-step')!;
  const povPlay = document.getElementById('pov-play') as HTMLButtonElement;
  const povSeek = document.getElementById('pov-seek') as HTMLInputElement;
  const povSpeed = document.getElementById('pov-speed') as HTMLButtonElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stopWalk() {
    player?.stop(); player = null;
    pov.hidden = true; document.body.classList.remove('pov-active', 'underground');
    setBuildingOpacity(xray ? 0.35 : 0.92);
    if (currentRoute) map.fitBounds(routeBounds(currentRoute), { padding: fitPadding(), pitch: 58, bearing: -18, duration: 900 });
  }
  function startWalk() {
    if (!currentRoute) return;
    player?.stop();
    pov.hidden = false; document.body.classList.add('pov-active');
    setBuildingOpacity(0.22);
    ui.setSheet('peek');
    let lastSeg = -1;
    player = createPlayer(map, currentRoute, (f, i) => {
      povSeek.value = String(Math.round(f.t * 1000));
      document.body.classList.toggle('underground', f.z < -0.5);
      if (f.segIndex !== lastSeg) {
        lastSeg = f.segIndex;
        const step = [...currentSteps].reverse().find((s) => s.index <= f.segIndex && s.kind !== 'start' && s.kind !== 'end') ?? currentSteps[0];
        povStep.innerHTML = step.text;
        activeSeg = f.segIndex; refresh();
      }
      void i;
    }, () => { povPlay.textContent = '▶'; povStep.innerHTML = currentSteps[currentSteps.length - 1].text; });
    player.seek(0);
    if (reducedMotion) { povPlay.textContent = '▶'; } else { player.play(); povPlay.textContent = '⏸'; }
  }
  povPlay.addEventListener('click', () => {
    if (!player) return;
    if (reducedMotion) { player.seek(Math.min(1, (player.frame + 15) / (player.frames.length - 1))); return; }
    if (player.playing) { player.pause(); povPlay.textContent = '▶'; } else { player.play(); povPlay.textContent = '⏸'; }
  });
  povSeek.addEventListener('input', () => { player?.pause(); povPlay.textContent = '▶'; player?.seek(Number(povSeek.value) / 1000); });
  let speed = 1;
  povSpeed.addEventListener('click', () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; player?.setSpeed(speed); povSpeed.textContent = `${speed}×`; });
  document.getElementById('pov-exit')!.addEventListener('click', stopWalk);

  // ---- UI ----
  const ui = initUI({
    links,
    filters,
    buildings: routable,
    refresh,
    flyTo,
    setXray: (on) => { xray = on; setBuildingOpacity(on ? 0.35 : 0.92); },
    reset: () => { popup?.remove(); map.flyTo({ ...HOME, duration: 1200 }); },
    onRoute: (from, to, preferIndoor) => {
      const adj = buildAdjacency(graph, links, { outdoorPenalty: preferIndoor ? 1.6 : 1 });
      const segs = route(adj, graph, links, from, to);
      if (!segs) return null;
      if (player) stopWalk();
      currentRoute = segs; activeSeg = null; popup?.remove();
      currentSteps = toSteps(segs, names);
      refresh();
      map.fitBounds(routeBounds(segs), { padding: fitPadding(), pitch: 58, bearing: -18, duration: 1000, maxZoom: 18.5 });
      return { segs, steps: currentSteps, ...summarise(segs) };
    },
    onClearRoute: () => { if (player) stopWalk(); currentRoute = null; activeSeg = null; refresh(); },
    onStepFocus: (seg, index) => {
      activeSeg = index; refresh();
      const c = seg.coords[Math.floor(seg.coords.length / 2)];
      map.easeTo({ center: [c[0], c[1]], zoom: 18.6, pitch: 62, duration: 800, padding: isMobile() ? { top: 0, bottom: Math.round(innerHeight * 0.4), left: 0, right: 0 } : { top: 0, bottom: 0, left: 360, right: 0 } });
    },
    onWalk: startWalk,
    locate: () => new Promise<string>((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation not available.'));
      navigator.geolocation.getCurrentPosition((pos) => {
        const { longitude: x, latitude: y } = pos.coords;
        const MX = 111320 * Math.cos((43.471 * Math.PI) / 180), MY = 110574;
        let best: string | null = null, bd = 250;
        for (const n of Object.values(graph.nodes)) if (n.kind === 'X') { const d = Math.hypot((n.c[0] - x) * MX, (n.c[1] - y) * MY); if (d < bd) { bd = d; best = n.b; } }
        best ? resolve(best) : reject(new Error('You are more than 250 m from any campus building.'));
      }, () => reject(new Error('Location permission denied.')), { enableHighAccuracy: true, timeout: 8000 });
    }),
  });

  // Deep link: ?from=SCH&to=HH
  const q = new URLSearchParams(location.search);
  const f = q.get('from')?.toUpperCase(), t = q.get('to')?.toUpperCase();
  if (f && t && graph.nodes[`X:${f}`] && graph.nodes[`X:${t}`]) ui.setRoute(f, t);
});
