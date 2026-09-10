// Local planar projection around campus. The same constants exist in
// scripts/geo.ts for the Node side; these are the browser's copy, and graph.ts,
// pov.ts and main.ts import from here rather than redeclaring them.
export const LAT0 = 43.471;
export const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
export const MY = 110574;
export const toM = ([x, y]: number[]) => [x * MX, y * MY];
export const toLL = ([x, y]: number[]) => [x / MX, y / MY];
export const metres = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * MX, (a[1] - b[1]) * MY);
