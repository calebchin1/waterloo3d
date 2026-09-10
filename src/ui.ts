import type { FeatureCollection, LineString } from 'geojson';
import type { Filters, Kind, Link, LinkProps } from './layers';
import type { Segment } from './graph';
import type { Step } from './steps';

interface Opts {
  links: FeatureCollection<LineString, LinkProps>;
  filters: Filters;
  buildings: { code: string; name: string }[];
  refresh: () => void;
  flyTo: (l: Link) => void;
  setXray: (on: boolean) => void;
  reset: () => void;
  onRoute: (from: string, to: string, preferIndoor: boolean, room: string) => RouteResult | null | 'pending';
  /** Floor-plan availability for the destination building, for the room field. */
  indoorFor: (code: string) => { rooms: number } | null;
  onClearRoute: () => void;
  onStepFocus: (seg: Segment, index: number) => void;
  onWalk: () => void;
  locate: () => Promise<string>; // resolves to building code
}

export interface RouteResult { segs: Segment[]; steps: Step[]; metres: number; minutes: number; indoorShare: number }
export interface UIHandle {
  setRoute(from: string, to: string): void;
  /** Re-render the panel after the route is re-solved over freshly loaded indoor data. */
  setResult(r: RouteResult): void;
  /** Re-check whether the destination building has floor plans. */
  syncRoomField(): void;
  message(text: string): void;
  setSheet(state: 'peek' | 'half' | 'full'): void;
}

export function initUI(o: Opts): UIHandle {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const { links, filters, refresh, flyTo, setXray, reset } = o;

  // ---- tabs ----
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
  }));

  // ---- bottom sheet (mobile) ----
  const panel = $('#panel');
  const states = ['peek', 'half', 'full'] as const;
  let sheet: (typeof states)[number] = 'half';
  const setSheet = (s: (typeof states)[number]) => { sheet = s; panel.dataset.sheet = s; };
  setSheet('half');
  let dragY: number | null = null;
  const grip = $('#grip');
  grip.addEventListener('pointerdown', (e) => { dragY = e.clientY; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointerup', (e) => {
    if (dragY === null) return;
    const dy = e.clientY - dragY; dragY = null;
    const i = states.indexOf(sheet);
    if (dy < -30) setSheet(states[Math.min(2, i + 1)]);
    else if (dy > 30) setSheet(states[Math.max(0, i - 1)]);
    else setSheet(sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'peek');
  });
  $('#panel-toggle').addEventListener('click', () => panel.classList.toggle('collapsed'));

  // ---- browse tab ----
  for (const kind of ['tunnel', 'bridge', 'doorway'] as Kind[]) {
    $<HTMLElement>(`#n-${kind}`).textContent = String(links.features.filter((l) => l.properties.kind === kind).length);
  }
  document.querySelectorAll<HTMLInputElement>('input[data-kind]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const k = cb.dataset.kind as Kind;
      cb.checked ? filters.kinds.add(k) : filters.kinds.delete(k);
      refresh(); renderList();
    }),
  );
  $<HTMLInputElement>('#xray').addEventListener('change', (e) => setXray((e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('#unverified').addEventListener('change', (e) => { filters.unverified = (e.target as HTMLInputElement).checked; refresh(); renderList(); });
  $('#reset').addEventListener('click', reset);

  const search = $<HTMLInputElement>('#search');
  const results = $<HTMLUListElement>('#results');
  const order: Record<Kind, number> = { tunnel: 0, bridge: 1, doorway: 2 };
  function renderList() {
    const q = search.value.trim().toLowerCase();
    const items = links.features
      .filter((l) => filters.kinds.has(l.properties.kind) && (filters.unverified || l.properties.verified))
      .filter((l) => !q || [l.properties.from, l.properties.to, l.properties.name, l.properties.notes].some((s) => s.toLowerCase().includes(q)))
      .sort((a, b) => order[a.properties.kind] - order[b.properties.kind] || a.properties.from.localeCompare(b.properties.from));
    results.replaceChildren(
      ...items.map((l) => {
        const li = document.createElement('li');
        const p = l.properties;
        li.className = [p.status === 'closed' ? 'closed' : '', p.verified ? '' : 'unverified'].join(' ').trim();
        li.innerHTML = `<i class="sw ${p.kind}"></i><span class="name">${p.from} ↔ ${p.to}</span><span class="meta">${p.length_m} m</span>`;
        li.addEventListener('click', () => { results.querySelectorAll('.active').forEach((n) => n.classList.remove('active')); li.classList.add('active'); flyTo(l); });
        return li;
      }),
    );
    if (!items.length) results.innerHTML = '<li style="color:var(--muted);cursor:default">No matches</li>';
  }
  search.addEventListener('input', renderList);
  renderList();

  // ---- route tab ----
  const from = $<HTMLSelectElement>('#from'), to = $<HTMLSelectElement>('#to');
  const sorted = [...o.buildings].sort((a, b) => a.code.localeCompare(b.code));
  for (const sel of [from, to]) for (const b of sorted) {
    const opt = document.createElement('option'); opt.value = b.code; opt.textContent = `${b.code} — ${b.name}`; sel.append(opt);
  }
  const result = $('#result'), msg = $('#route-msg'), stepsEl = $<HTMLOListElement>('#steps');
  const message = (text: string) => { msg.textContent = text; msg.hidden = !text; };
  const render = (r: RouteResult) => {
    message('');
    $('#r-min').textContent = String(Math.max(1, Math.round(r.minutes)));
    $('#r-m').textContent = String(r.metres);
    $('#r-indoor').textContent = `${Math.round(r.indoorShare * 100)}%`;
    stepsEl.replaceChildren(...r.steps.map((s) => {
      const li = document.createElement('li');
      li.className = s.kind;
      li.innerHTML = `<span class="t">${s.text}</span>${s.caption ? `<span class="cap">${s.caption}</span>` : ''}`;
      li.addEventListener('click', () => { stepsEl.querySelectorAll('.active').forEach((n) => n.classList.remove('active')); li.classList.add('active'); o.onStepFocus(s.seg, s.index); });
      return li;
    }));
    result.hidden = false;
  };
  const roomWrap = $('#room-wrap'), roomInput = $<HTMLInputElement>('#room');
  const syncRoomField = () => {
    const info = to.value ? o.indoorFor(to.value) : null;
    roomWrap.hidden = !info;
    if (info) {
      $('#room-code').textContent = to.value;
      $('#room-hint').textContent = `· ${info.rooms} numbered`;
    } else roomInput.value = '';
  };
  to.addEventListener('change', syncRoomField);

  const run = () => {
    if (!from.value || !to.value) return message('Pick a start and an end.');
    const room = roomWrap.hidden ? '' : roomInput.value.trim().toUpperCase();
    if (from.value === to.value && !room) return message('Start and end are the same building.');
    const r = o.onRoute(from.value, to.value, $<HTMLInputElement>('#indoor').checked, room);
    if (r === 'pending') { message('Loading floor plans…'); return; }
    if (!r) { result.hidden = true; return message('No route found.'); }
    render(r);
    const url = new URL(location.href); url.searchParams.set('from', from.value); url.searchParams.set('to', to.value); history.replaceState(null, '', url);
    setSheet('half');
  };
  $('#route-form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  $('#swap').addEventListener('click', () => { [from.value, to.value] = [to.value, from.value]; if (from.value && to.value) run(); });
  $<HTMLInputElement>('#indoor').addEventListener('change', () => { if (!result.hidden) run(); });
  $('#clear').addEventListener('click', () => { result.hidden = true; from.value = ''; to.value = ''; o.onClearRoute(); const url = new URL(location.href); url.searchParams.delete('from'); url.searchParams.delete('to'); history.replaceState(null, '', url); });
  $('#share').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); message('Link copied.'); setTimeout(() => message(''), 1500); } catch { message(location.href); } });
  $('#walk').addEventListener('click', () => o.onWalk());
  $('#locate').addEventListener('click', async () => {
    message('Locating…');
    try { from.value = await o.locate(); message(''); if (to.value) run(); }
    catch (e) { message((e as Error).message); }
  });

  return {
    setRoute(f, t) { from.value = f; to.value = t; syncRoomField(); run(); },
    syncRoomField,
    setResult: render,
    message,
    setSheet,
  };
}
