import type { Segment } from './graph';

export interface Step { text: string; caption?: string; seg: Segment; index: number; kind: Segment['kind'] | 'start' | 'end' }

const b = (s: string) => `<b>${s}</b>`;

/** Human steps: consecutive intra segments in the same building collapse into one. */
export function toSteps(segs: Segment[], names: Map<string, string>): Step[] {
  const name = (c: string) => names.get(c) ? `${c} · ${names.get(c)}` : c;
  const steps: Step[] = [];
  if (!segs.length) return steps;
  steps.push({ text: `Start in ${b(name(segs[0].from))}.`, seg: segs[0], index: 0, kind: 'start' });
  let i = 0;
  while (i < segs.length) {
    const s = segs[i];
    if (s.kind === 'intra') {
      let m = s.m, j = i;
      while (j + 1 < segs.length && segs[j + 1].kind === 'intra' && segs[j + 1].building === s.building) { j++; m += segs[j].m; }
      if (m >= 15) steps.push({ text: `Walk through ${b(s.building!)} (≈ ${Math.round(m / 5) * 5} m).`, seg: s, index: i, kind: 'intra' });
      i = j + 1; continue;
    }
    if (s.kind === 'indoor') {
      const l = s.link!;
      const unv = l.verified ? '' : ' (unverified)';
      const depth = l.kind === 'tunnel' ? `, ${l.z_m} m` : '';
      const verb = l.kind === 'tunnel' ? `Take the ${b(`tunnel to ${s.to}`)}` : l.kind === 'bridge' ? `Cross the ${b(`${l.name.includes('Bridge') || l.name.includes('Walkway') ? l.name : 'bridge'} to ${s.to}`)}` : `Go through the doorway to ${b(s.to)}`;
      steps.push({ text: `${verb} (${l.length_m} m${depth})${unv}.`, caption: l.notes, seg: s, index: i, kind: 'indoor' });
    } else {
      steps.push({ text: `Go outside · ${s.m} m to ${b(s.to)}.`, seg: s, index: i, kind: 'outdoor' });
    }
    i++;
  }
  const last = segs[segs.length - 1];
  steps.push({ text: `Arrive at ${b(name(last.to))}.`, seg: last, index: segs.length - 1, kind: 'end' });
  return steps;
}
