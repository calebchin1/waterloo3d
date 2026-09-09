import type { FeatureCollection, LineString } from 'geojson';
import type { Filters, Kind, Link, LinkProps } from './layers';

interface Opts {
  links: FeatureCollection<LineString, LinkProps>;
  filters: Filters;
  refresh: () => void;
  flyTo: (l: Link) => void;
  setXray: (on: boolean) => void;
  reset: () => void;
}

export function initUI({ links, filters, refresh, flyTo, setXray, reset }: Opts) {
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

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

  const panel = $('#panel');
  $('#panel-toggle').addEventListener('click', () => panel.classList.toggle('collapsed'));

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
}
