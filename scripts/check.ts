// Asserts every ground-truth link from the Imprint article is present exactly once.
import { readFileSync } from 'node:fs';
const REQUIRED = [
  'SCH-TC', 'TC-AL', 'AL-ML', 'AL-EV1', 'EV1-HH', 'MC-C2', 'RCH-E2', 'RCH-DWE', 'ESC-EIT',
  'SLC-MC', 'MC-DC', 'DC-M3', 'DC-C2', 'DC-E3', 'E3-E5', 'PSE-E6', 'E2-DWE', 'E2-PHY', 'MC-QNC', 'CPH-Lot A',
  'EV1-EV2', 'EV2-EV3', 'EIT-PHY', 'B1-B2', 'B2-STC', 'E3-E2', 'E5-PSE', 'E2-CPH',
];
const fc = JSON.parse(readFileSync('public/data/connections.geojson', 'utf8'));
const keys = new Map<string, number>();
for (const f of fc.features) {
  const k = `${f.properties.from}-${f.properties.to}`;
  keys.set(k, (keys.get(k) ?? 0) + 1);
  keys.set(`${f.properties.to}-${f.properties.from}`, (keys.get(`${f.properties.to}-${f.properties.from}`) ?? 0) + 1);
  if (f.geometry.coordinates.length < 2) throw new Error(`${k}: degenerate geometry`);
}
const missing = REQUIRED.filter((k) => !keys.has(k));
if (missing.length) { console.error('MISSING:', missing); process.exit(1); }
const dup = REQUIRED.filter((k) => (keys.get(k) ?? 0) > 2);
console.log(`ok: ${fc.features.length} connections; ${REQUIRED.length} required links present${dup.length ? '; duplicated: ' + dup.join(',') : ''}`);
