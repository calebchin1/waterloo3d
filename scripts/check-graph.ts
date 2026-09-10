// Assertions on public/data/graph.json using the same routing core the app uses.
import { readFileSync, statSync } from 'node:fs';
import { buildAdjacency, route, type GraphData } from '../src/graph';
import type { FeatureCollection, LineString } from 'geojson';
import type { LinkProps } from '../src/layers';

const graph = JSON.parse(readFileSync('public/data/graph.json', 'utf8')) as GraphData;
const links = JSON.parse(readFileSync('public/data/connections.geojson', 'utf8')) as FeatureCollection<LineString, LinkProps>;
const kb = statSync('public/data/graph.json').size / 1024;
const fail = (m: string) => { console.error('FAIL', m); process.exitCode = 1; };
if (kb > 80) fail(`graph.json is ${kb.toFixed(0)} KB (> 80)`);
for (const e of graph.edges) {
  if (e.kind === 'outdoor' && e.m > 700) fail(`outdoor edge ${e.a}-${e.b} is ${e.m} m`);
  if (e.g && e.g.length > 60) fail(`polyline ${e.a}-${e.b} has ${e.g.length} pts`);
}
const codes = [...new Set(Object.values(graph.nodes).map((n) => n.b))].filter((c) => graph.nodes[`X:${c}`]);
const adjIndoor = buildAdjacency(graph, links, { outdoorPenalty: 1.6 });
let unreachable = 0;
for (const a of codes) for (const b of codes) if (a !== b && !route(adjIndoor, graph, links, a, b)) { unreachable++; if (unreachable < 5) fail(`${a} -> ${b} unreachable`); }
const linksOf = (segs: ReturnType<typeof route>) => (segs ?? []).filter((s) => s.kind === 'indoor').map((s) => s.link!.id);
const schHH = linksOf(route(adjIndoor, graph, links, 'SCH', 'HH'));
if (!['sch-tc', 'tc-al', 'al-ev1', 'ev1-hh'].every((l) => schHH.includes(l))) fail(`SCH->HH used ${schHH.join(',')}`);
const mcE5segs = route(adjIndoor, graph, links, 'MC', 'E5');
const mcE5 = linksOf(mcE5segs);
if (mcE5segs?.some((s) => s.kind === 'outdoor') || !['dc-e3', 'e3-e5'].every((l) => mcE5.includes(l))) fail(`MC->E5 used ${mcE5.join(',')}`);
const closed = links.features.filter((l) => l.properties.status === 'closed').map((l) => l.properties.id);
for (const c of closed) if (adjIndoor.has(`P:${c}:from`)) fail(`closed link ${c} in graph`);
const adjShort = buildAdjacency(graph, links, { outdoorPenalty: 1 });
const s1 = linksOf(route(adjIndoor, graph, links, 'SCH', 'HH')), s2 = linksOf(route(adjShort, graph, links, 'SCH', 'HH'));
console.log(`ok: ${kb.toFixed(1)} KB, ${codes.length} routable buildings, ${unreachable} unreachable pairs; SCH->HH indoor=[${s1}] shortest=[${s2}]`);
