// First-person flythrough along a route: camera glides at eye height, heading along the path.
import type { Segment } from './graph';

const LAT0 = 43.471, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180), MY = 110574;
const toM = ([x, y]: number[]) => [x * MX, y * MY];
const toLL = ([x, y]: number[]) => [x / MX, y / MY];

export interface Frame { lngLat: [number, number]; bearing: number; z: number; segIndex: number; t: number }

/** Densify to ~1 m spacing; each frame knows its bearing, elevation and segment. */
export function buildFrames(segs: Segment[]): Frame[] {
  const frames: Frame[] = [];
  segs.forEach((seg, si) => {
    const pts = seg.coords.map((c) => [...toM(c), c[2]]);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      const n = Math.max(1, Math.round(L));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        frames.push({ lngLat: toLL([a[0] + dx * t, a[1] + dy * t]) as [number, number], bearing, z: a[2] + (b[2] - a[2]) * t, segIndex: si, t: 0 });
      }
    }
  });
  // smooth bearings over a 6 m window so corners don't snap
  const out = frames.map((f, i) => {
    let sx = 0, sy = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(frames.length - 1, i + 3); j++) { const r = (frames[j].bearing * Math.PI) / 180; sx += Math.sin(r); sy += Math.cos(r); }
    return { ...f, bearing: ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360, t: frames.length > 1 ? i / (frames.length - 1) : 0 };
  });
  return out;
}

export interface Player {
  play(): void; pause(): void; seek(t: number): void; setSpeed(x: number): void; stop(): void;
  readonly playing: boolean; readonly frame: number; readonly frames: Frame[];
}

export function createPlayer(
  map: import('maplibre-gl').Map,
  segs: Segment[],
  onFrame: (f: Frame, i: number) => void,
  onEnd: () => void,
): Player {
  const frames = buildFrames(segs);
  let i = 0, playing = false, speed = 1, raf = 0, last = 0;
  const METRES_PER_SEC = 1.6;
  const apply = () => {
    const f = frames[Math.min(Math.floor(i), frames.length - 1)];
    // Camera sits ~7 m behind the walker so the tube ahead is visible.
    const back = toM(f.lngLat);
    const r = (f.bearing * Math.PI) / 180;
    const cam = toLL([back[0] - Math.sin(r) * 7, back[1] - Math.cos(r) * 7]) as [number, number];
    map.jumpTo({ center: cam, bearing: f.bearing, pitch: 74, zoom: 19.6 });
    onFrame(f, i);
  };
  const tick = (now: number) => {
    if (!playing) return;
    const dt = last ? (now - last) / 1000 : 0; last = now;
    i += dt * METRES_PER_SEC * speed;
    if (i >= frames.length - 1) { i = frames.length - 1; apply(); playing = false; onEnd(); return; }
    apply();
    raf = requestAnimationFrame(tick);
  };
  return {
    get playing() { return playing; },
    get frame() { return Math.floor(i); },
    get frames() { return frames; },
    play() { if (playing) return; playing = true; last = 0; raf = requestAnimationFrame(tick); },
    pause() { playing = false; cancelAnimationFrame(raf); },
    seek(t) { i = Math.max(0, Math.min(frames.length - 1, t * (frames.length - 1))); apply(); },
    setSpeed(x) { speed = x; },
    stop() { playing = false; cancelAnimationFrame(raf); },
  };
}
