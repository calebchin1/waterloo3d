# UW Tunnels 3D

Every student-accessible indoor link between buildings on the University of
Waterloo main campus (tunnels, bridges, doorway links), drawn at nominal depth /
height over a 3D building map. Restricted steam service tunnels are out of scope.

## Run

```
npm install
npm run dev          # http://localhost:5173
npm run build        # dist/
```

## Data

| File | Source | Regenerate |
|---|---|---|
| `public/data/buildings.geojson` | OpenStreetMap building footprints (bbox 43.465,-80.552 → 43.478,-80.535); height = `height` tag, else `building:levels` × 3.5 m, else 12 m | `npm run fetch-osm` |
| `public/data/osm-indoor.geojson` | OSM ways tagged indoor / tunnel / bridge / negative layer | `npm run fetch-osm` |
| `public/data/connections.geojson` | **Curated source of truth.** Definition table in `scripts/build-connections.ts`; geometry from OSM ways where they exist, else traced between nearest footprint edges | `npm run build-data` |

`npm run build-data` also runs `scripts/check.ts`, which asserts every link from
Imprint's "An introduction to tunnels and bridges on campus" is present.
Links tagged `verified: false` exist in OSM but are not on the Imprint list.

MapLibre is served as a vendored UMD script (`public/vendor/`) because its
inline worker does not survive Vite's dependency pre-bundling. `npm run vendor`
refreshes the copy after upgrading `maplibre-gl`.

## Stack

Vite + TypeScript, MapLibre GL JS (OpenFreeMap Liberty basemap, no API key),
deck.gl PathLayer for the 3D tubes. Static site; no backend.
