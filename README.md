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

## Indoor floor plans

`floorplans/` holds 223 Plant Operations floor-plan PDFs covering 62 building
codes — every plan a normal WatIAM account can reach. The other 263 entries in
`floorplans/_manifest.json` are unavailable: 246 sit under `/restricted/` and
need Plant Operations staff group membership (residences and all roof plans),
and 17 are listed on the index page but return 404. `floorplans/_missing.json`
records exactly which.

The plans are vector CAD (AutoCAD → `pdfplot`) with **no text layer at all** —
room numbers are stroked glyph geometry, so they come back through OCR. 123 of
the 223 carry their AutoCAD layer names as PDF optional content groups
(`B-BP-WALL`, `B-BP-DOOR`, `B-BP-STAIR`, `B-SP-ROOM_NO`), which is what makes
walls, doors and stairs separable; `floorplans/_corpus.json` tiers every plan
A (layered, with room numbers), B (layered, without) or C (flattened).

### Pipeline

Python, in `scripts/py/`, because the walk network comes out of a raster medial
axis and that is not a fight worth having in TypeScript. Needs Tesseract
(`brew install tesseract`).

```
npm run indoor:setup      # .venv + scripts/py/requirements.txt
npm run indoor:corpus     # floorplans/_corpus.json — tier, layers, level per plan
npm run indoor:extract    # build/plans/*.json — classified polylines in plan units
npm run indoor:georef     # data/georef/<CODE>.json — plan -> world affine
npm run indoor:floorshift -- --all   # per-floor shift inside each building (see below)
npm run indoor:build -- --core   # walkgraph -> stitch -> ocr -> emit, tunnel network
npm run indoor:qa MC      # build/qa/MC_georef.png — plan over its OSM footprint
npm run check-indoor
```

| Stage | What it does |
|---|---|
| `corpus.py` | One pass over every PDF: tier, layer names, `/Rotate`, per-class counts, level |
| `extract.py` | Content streams → polylines classified `wall`/`door`/`stair`/`room_no`/… |
| `georef.py` | Fits scale, rotation, mirror and offset by maximising mask overlap with the OSM footprint; rotation is seeded from the two rectilinear grids rather than a blind sweep |
| `floorshift.py` | Registers every floor to the building's reference floor in plan units (cross-correlation, four 90° candidates). MC and SLC share one origin across floors; E2 and DC do not, and without this no stairwell overlapped between their floors |
| `walkgraph.py` | Rasterises walls, takes the medial axis of the free space, prunes spurs, keeps one connected component; rooms come from the same space with doors *sealed* |
| `stitch.py` | Stair and elevator shafts found once building-wide, so a stairwell keeps its identity on every floor, then vertical edges between adjacent levels |
| `ocr.py` | Clusters `B-SP-ROOM_NO` strokes into labels, renders each alone, Tesseract |
| `emit.py` | `public/data/indoor/<CODE>.json` + `_index.json`, coordinates as integer decimetres off a local origin |

Two known limits, both recorded per building by `check-indoor`: a flattened
(Tier C) floor has no wall layer, so every stroke blocks free space and the
walkable area collapses to a fragment — the router keeps the old
building-to-building hop as a weighted fallback there rather than failing; and
a floor shift with correlation under 0.45 is stored but not applied.

**Georeferencing is the weak joint.** A near-square building scores almost the
same 180° out, so `method` is `needs-review` whenever the winning placement
leads the next distinct one by less than 0.04 IoU. Check `build/qa/<CODE>_georef.png`
before trusting a building. `siteScore` (how much of the drawn site context lands
on a real neighbour) is reported as a hint; it was tried as an automatic
tiebreaker and picked a verified-wrong mirror for MC, so it does not decide.

Ten buildings have no OSM footprint under their code — ARC, DMS, PHR, IHB, RA2,
RAC, AVR, CLV, REV, TJB — mostly because they are off the main-campus bbox
(Cambridge, Stratford, Kitchener, north campus). They cannot be placed until
`fetch-osm.ts` covers those areas.

## Directions & walkthrough

`?from=SCH&to=HH` deep-links a route. Routing runs in the browser over
`public/data/graph.json` (~70 KB): building nodes, portal nodes at each end of
every tunnel/bridge/doorway link, and outdoor "shortcut" edges between each
building and its 4 nearest neighbours. The shortcuts are precomputed by
`npm run build-graph` from the full OSM footway network (1,767 ways, cached
in `.cache/footways.json`; pass `--refresh` to re-fetch). "Prefer indoor"
multiplies outdoor cost by 1.6. Times are metres ÷ 1.3 m/s, nothing more.

"Walk it" plays a first-person camera along the route (1.6 m/s, 1×/2×/4×).
Underground segments tint the edges orange. The camera now rises with the floor
it is on — `map.setCenterElevation` plus `setCenterClampedToGround(false)` — so
stairs read as stairs.

Where a building has floor plans (`public/data/indoor/<CODE>.json`, fetched only
for buildings on the current route), the router walks its real corridors and
stairs instead of the synthetic same-building clique in `src/graph.ts`, and the
destination can be a room number rather than a building. Buildings without plans
still fall back to the clique, so nothing regresses.

`/mobile-test.html` shows the app in a 390×844 frame for layout checks.

## Stack

Vite + TypeScript, MapLibre GL JS (OpenFreeMap Liberty basemap, no API key),
deck.gl PathLayer for the 3D tubes. Static site; no backend.
