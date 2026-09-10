// First-person flythrough along a route: the camera walks at eye height,
// following the path and rising with it through stairs and onto upper floors.
import type { Segment } from './graph';
import { MX, MY } from './metric';

const toM = ([x, y]: number[]) => [x * MX, y * MY];
const toLL = ([x, y]: number[]) => [x / MX, y / MY];

export interface Frame { lngLat: [number, number]; bearing: number; z: number; segIndex: number; t: number; pitch: number }

/** Densify to ~1 m spacing; each frame knows its bearing, elevation and segment. */
export function buildFrames(segs: Segment[]): Frame[] {
  const frames: Omit<Frame, 't' | 'pitch'>[] = [];
  segs.forEach((seg, si) => {
    const pts = seg.coords.map((c) => [...toM(c), c[2]]);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      const bearing = L < 1e-6 ? (frames.length ? frames[frames.length - 1].bearing : 0)
                               : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      // A stair is a vertical hop with almost no plan length; give it enough
      // frames that the camera visibly climbs instead of teleporting.
      const rise = Math.abs(b[2] - a[2]);
      const n = Math.max(1, Math.round(Math.max(L, rise * 1.5)));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        frames.push({
          lngLat: toLL([a[0] + dx * t, a[1] + dy * t]) as [number, number],
          bearing, z: a[2] + (b[2] - a[2]) * t, segIndex: si,
        });
      }
    }
  });
  // smooth bearings over a 6 m window so corners don't snap
  return frames.map((f, i) => {
    let sx = 0, sy = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(frames.length - 1, i + 3); j++) {
      const r = (frames[j].bearing * Math.PI) / 180; sx += Math.sin(r); sy += Math.cos(r);
    }
    const climb = i + 1 < frames.length ? frames[i + 1].z - f.z : 0;
    return {
      ...f,
      bearing: ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360,
      pitch: Math.max(64, Math.min(88, 77 - climb * 40)),
      t: frames.length > 1 ? i / (frames.length - 1) : 0,
    };
  });
}

export interface Player {
  play(): void; pause(): void; seek(t: number): void; setSpeed(x: number): void; stop(): void;
  readonly playing: boolean; readonly frame: number; readonly frames: Frame[];
}

const EYE_M = 1.6;
const BACK_M = 5;
const ZOOM = 20.6;

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
    const here = toM(f.lngLat);
    const r = (f.bearing * Math.PI) / 180;
    const cam = toLL([here[0] - Math.sin(r) * BACK_M, here[1] - Math.cos(r) * BACK_M]) as [number, number];
    // The camera deliberately stays at ground level. Raising it with MapLibre's
    // centre elevation moves the basemap camera but not deck.gl's overlay camera,
    // so the indoor geometry ends up drawn a storey overhead; main.ts slides the
    // scene down to the walker instead.
    map.jumpTo({ center: cam, bearing: f.bearing, pitch: f.pitch, zoom: ZOOM });
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
