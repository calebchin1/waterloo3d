import type { Segment } from './graph';

export interface Step { text: string; caption?: string; seg: Segment; index: number; kind: Segment['kind'] | 'start' | 'end' }

const b = (s: string) => `<b>${s}</b>`;

/** "1st Floor", "Basement", "Level 4" — matches how the plans are labelled. */
export function levelName(level: number): string {
  if (level === 0) return '1st Floor';
  if (level === -1) return 'Basement';
  if (level < 0) return `Level ${level}`;
  if (!Number.isInteger(level)) return `Mezzanine (level ${level})`;
  const n = level + 1;
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix} Floor`;
}

/** Human steps: consecutive intra or same-floor walk segments collapse into one. */
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
    if (s.kind === 'walk') {
      let m = s.m, j = i;
      while (j + 1 < segs.length && segs[j + 1].kind === 'walk'
             && segs[j + 1].building === s.building && segs[j + 1].level === s.level) { j++; m += segs[j].m; }
      if (m >= 8) {
        steps.push({ text: `Follow the corridor on ${b(`${s.building} ${levelName(s.level!)}`)} (≈ ${Math.round(m / 5) * 5} m).`,
                     seg: s, index: i, kind: 'walk' });
      }
      i = j + 1; continue;
    }
    if (s.kind === 'vertical') {
      const up = (s.toLevel ?? 0) > (s.level ?? 0);
      const how = s.vertical === 'elevator' ? 'Take the elevator' : `Take the stairs ${up ? 'up' : 'down'}`;
      steps.push({ text: `${how} to ${b(`${s.building} ${levelName(s.toLevel!)}`)}.`, seg: s, index: i, kind: 'vertical' });
      i++; continue;
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
