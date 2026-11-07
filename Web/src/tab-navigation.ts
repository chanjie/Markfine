import { t } from './localization';

export interface TabIdentity { id: string; title: string; path: string }
/** Find the nearest ancestor whose name distinguishes every same-name peer. Keep no middle directories. */
export function tabLabel(item: TabIdentity, peers: readonly TabIdentity[]): string {
  if (!item.path) return t('未命名', 'Untitled') + (peers.filter(peer => !peer.path).length > 1 ? ' · ' + (peers.filter(peer => !peer.path).findIndex(peer => peer.id === item.id) + 1) : '');
  const group = peers.filter(peer => peer.title === item.title && peer.path);
  if (group.length < 2) return item.title;
  const directories = group.map(peer => peer.path.split('/').filter(Boolean).slice(0, -1));
  const names = (depth: number) => directories.map(parts => parts.at(-depth) ?? '/');
  let depth = 1, bestDistinct = 0;
  for (let candidate = 1; candidate <= Math.max(...directories.map(parts => parts.length)) + 1; candidate++) {
    const distinct = new Set(names(candidate)).size;
    if (distinct > bestDistinct) { depth = candidate; bestDistinct = distinct; }
    if (distinct === group.length) { depth = candidate; break; }
  }
  const labels = names(depth), index = group.findIndex(peer => peer.id === item.id);
  // Some path permutations contain fewer distinct ancestor names than files. A stable ordinal is
  // the only extra discriminator in that case; no additional middle path components are exposed.
  const format = (name: string, suffix = '') => (name === '/' ? (suffix ? '/' + suffix + '/' : '/') : name + suffix + '/') + (depth > 1 ? '…/' : '') + item.title;
  const bases = labels.map(name => format(name)), reserved = new Set(bases), used = new Set<string>(), final = new Map<number,string>();
  for (const entry of group.map((peer,index) => ({ peer,index })).sort((a,b) => a.peer.path < b.peer.path ? -1 : a.peer.path > b.peer.path ? 1 : 0)) {
    let label = bases[entry.index];
    if (bases.filter(base => base === label).length > 1) { let serial = 1; do { label = format(labels[entry.index], ' · ' + serial++); } while (reserved.has(label) || used.has(label)); }
    used.add(label); final.set(entry.index,label);
  }
  return final.get(index)!;
}

export type TabCloseScope = 'current' | 'left' | 'right' | 'all';
export function closeTargets(ids: readonly string[], id: string, scope: TabCloseScope): string[] {
  const index = ids.indexOf(id); if (index < 0) return [];
  return scope === 'all' ? [...ids] : scope === 'left' ? ids.slice(0, index) : scope === 'right' ? ids.slice(index + 1) : [id];
}
export function showTabMenu(event: MouseEvent, ids: string[], id: string, close: (scope: TabCloseScope) => void): void {
  event.preventDefault(); document.getElementById('tab-menu')?.remove();
  const menu = document.createElement('div'); menu.id = 'tab-menu'; menu.className = 'table-menu'; menu.setAttribute('role', 'menu');
  const index = ids.indexOf(id);
  const dismiss = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); document.dispatchEvent(new Event('tab-menu-dismissed')); };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node)) dismiss(); };
  const keyboard = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const buttons = [...menu.querySelectorAll('button')]; buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  };
  const choices: [TabCloseScope, string][] = [['current', t('关闭当前', 'Close Tab')]];
  if (index > 0) choices.push(['left', t('关闭左侧全部', 'Close Tabs to the Left')]);
  if (index < ids.length - 1) choices.push(['right', t('关闭右侧全部', 'Close Tabs to the Right')]);
  choices.push(['all', t('关闭所有', 'Close All Tabs')]);
  for (const [scope, text] of choices) { const button = document.createElement('button'); button.dataset.scope = scope; button.setAttribute('role', 'menuitem'); button.textContent = text; button.onclick = () => { dismiss(); close(scope); }; menu.append(button); }
  document.body.append(menu); menu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - menu.offsetWidth - 4)) + 'px'; menu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - menu.offsetHeight - 4)) + 'px';
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true); menu.querySelector('button')?.focus();
}

export function installReadingTabs(strip: HTMLElement, trigger: HTMLElement): void {
  let timer = 0, settleTimer = 0, wasReading = false;
  const settle = () => { clearTimeout(settleTimer); settleTimer = window.setTimeout(() => { for (const animation of strip.getAnimations()) animation.finish(); }, 270); };
  const reveal = () => { clearTimeout(timer); document.body.classList.add('tabs-revealed'); strip.inert = false; settle(); };
  const hide = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (strip.contains(document.activeElement) || document.getElementById('tab-menu')) return; document.body.classList.remove('tabs-revealed'); if (document.body.classList.contains('reading')) strip.inert = true; settle(); }, 450); };
  trigger.addEventListener('pointerenter', reveal); trigger.addEventListener('focus', reveal); strip.addEventListener('pointerenter', reveal); strip.addEventListener('pointerleave', hide); strip.addEventListener('focusout', hide);
  document.addEventListener('tab-menu-dismissed', () => { if (document.body.classList.contains('reading') && !strip.matches(':hover')) hide(); });
  new MutationObserver(() => { const reading = document.body.classList.contains('reading'); if (reading !== wasReading) { wasReading = reading; settle(); } if (!reading) { strip.inert = false; if (document.body.classList.contains('tabs-revealed')) document.body.classList.remove('tabs-revealed'); } else if (!document.body.classList.contains('tabs-revealed')) strip.inert = true; }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function pathTooltip(element: HTMLElement, path: string): void {
  let timer = 0;
  const hide = () => { clearTimeout(timer); document.getElementById('path-tooltip')?.remove(); };
  element.addEventListener('pointerenter', () => { hide(); timer = window.setTimeout(() => { if (!element.isConnected) return; const tip = document.createElement('div'); tip.id = 'path-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = path || t('尚未保存', 'Not yet saved'); document.body.append(tip); const box = element.getBoundingClientRect(); tip.style.left = Math.max(8, Math.min(box.left, innerWidth - tip.offsetWidth - 8)) + 'px'; tip.style.top = box.bottom + 6 + 'px'; }, 500); });
  element.addEventListener('pointerleave', hide); element.addEventListener('pointerdown', hide);
}
