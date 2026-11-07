import { newID } from './protocol';
import { t, formatTimestamp } from './localization';
import { fileIcon, fileKind } from './file-icons';
export interface WorkspaceEntry { id: string; name: string; directory: boolean; markdown: boolean; modified?: number }
export class WorkspaceBrowser {
  generation = ''; root?: WorkspaceEntry;
  private children = new Map<string, WorkspaceEntry[]>();
  private expanded = new Set<string>();
  private pending = new Map<string, string>();
  private showAll = false;
  private timeZone: 'local' | 'UTC' = 'local';
  private hoverTimer = 0;
  private hovering = false;
  private metadataRequests = new Set<string>();
  constructor(private post: (kind: string, fields: Record<string, unknown>) => void, private open: (entry: WorkspaceEntry, generation: string, pin: boolean) => void,
              private preference: (value: boolean) => void, private changed: () => void) {
    document.getElementById('show-all-files')!.onchange = event => this.preference((event.target as HTMLInputElement).checked);
    document.getElementById('refresh-files')!.onclick = () => this.refresh();
    const panel = document.getElementById('files-panel')!;
    panel.addEventListener('pointerenter', () => { this.hovering = true; clearTimeout(this.hoverTimer); panel.classList.add('show-modified'); this.refreshDates(); });
    panel.addEventListener('pointerleave', () => { this.hovering = false; clearTimeout(this.hoverTimer); this.hoverTimer = window.setTimeout(() => panel.classList.remove('show-modified'), 3000); });
    panel.addEventListener('focusin', () => { clearTimeout(this.hoverTimer); panel.classList.add('show-modified'); this.refreshDates(); });
    panel.addEventListener('focusout', () => { if (!this.hovering && !panel.contains(document.activeElement)) this.hoverTimer = window.setTimeout(() => panel.classList.remove('show-modified'), 3000); });
  }
  receive(message: Record<string, unknown>): boolean {
    if (message.kind === 'workspace') {
      const value = message.workspace as { generation: string; root: WorkspaceEntry };
      this.generation = value.generation; this.root = value.root; this.children.clear(); this.pending.clear(); this.metadataRequests.clear(); this.expanded = new Set([value.root.id]);
      document.getElementById('files-panel')!.hidden = false; this.load(value.root.id); this.render(); this.changed(); return true;
    }
    if (message.kind === 'workspaceMetadata') {
      if (message.generation !== this.generation || !this.metadataRequests.delete(String(message.requestID))) return true;
      const dates = message.dates as Record<string, number>;
      for (const entries of this.children.values()) for (const entry of entries) if (Object.hasOwn(dates, entry.id)) entry.modified = dates[entry.id];
      for (const row of document.querySelectorAll<HTMLElement>('#file-tree [data-entry-id]')) {
        const time = row.querySelector('time'); if (time && Object.hasOwn(dates, row.dataset.entryId!)) this.setTime(time, dates[row.dataset.entryId!]);
      }
      return true;
    }
    if (message.kind !== 'workspaceChildren') return false;
    const id = String(message.folderID);
    if (message.generation !== this.generation || this.pending.get(id) !== message.requestID) return true;
    this.pending.delete(id); this.children.set(id, message.entries as WorkspaceEntry[]); this.render();
    if (message.error) document.getElementById('files-message')!.textContent = String(message.error);
    return true;
  }
  setPreferences(showAll: boolean, timeZone: 'local' | 'UTC' = this.timeZone): void {
    this.timeZone = timeZone;
    const change = this.showAll !== showAll; this.showAll = showAll;
    (document.getElementById('show-all-files') as HTMLInputElement).checked = showAll;
    if (change) this.refresh(); else this.render();
  }
  private load(id: string): void {
    const requestID = newID(); this.pending.set(id, requestID);
    this.post('workspaceChildren', { folderID: id, generation: this.generation, showAll: this.showAll, requestID });
  }
  refresh(): void {
    this.children.clear(); this.pending.clear(); this.metadataRequests.clear(); if (this.root) { this.load(this.root.id); for (const id of this.expanded) if (id !== this.root.id) this.load(id); } this.render();
  }
  private refreshDates(): void {
    if (!this.root || this.metadataRequests.size) return;
    const ids = [...document.querySelectorAll<HTMLElement>('#file-tree [data-entry-id]')].map(row => row.dataset.entryId!);
    for (let start = 0; start < ids.length; start += 4096) { const requestID = newID(); this.metadataRequests.add(requestID); this.post('workspaceMetadata', { entryIDs: ids.slice(start, start + 4096), generation: this.generation, requestID }); }
  }
  private setTime(time: HTMLTimeElement, modified?: number): void {
    if (typeof modified === 'number' && Number.isFinite(modified) && Math.abs(modified) < 8.64e15) { time.dateTime = new Date(modified).toISOString(); time.textContent = formatTimestamp(modified, this.timeZone); time.title = t('最近修改：', 'Modified: ') + time.textContent; }
    else { time.removeAttribute('datetime'); time.textContent = '—'; }
  }
  render(): void {
    const tree = document.getElementById('file-tree')!; tree.replaceChildren(); if (!this.root) return;
    document.getElementById('workspace-name')!.textContent = this.root.name;
    document.getElementById('files-message')!.textContent = '';
    const append = (items: WorkspaceEntry[], parent: HTMLElement, depth: number) => {
      for (const entry of items) {
        const row = document.createElement('div'); row.setAttribute('role', 'treeitem'); row.dataset.entryId = entry.id;
        const button = document.createElement('button'); button.className = 'file-tree-row'; button.style.paddingLeft = `${12 + depth * 14}px`; button.title = entry.name;
        const disclosure = document.createElement('span'); disclosure.className = 'file-disclosure'; disclosure.textContent = entry.directory ? (this.expanded.has(entry.id) ? '⌄' : '›') : ''; disclosure.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span'); title.className = 'file-label'; const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name;
        const time = document.createElement('time'); time.className = 'file-modified';
        this.setTime(time, entry.modified);
        title.append(name, time); button.append(disclosure, fileIcon(fileKind(entry.name, entry.directory)), title); row.append(button); parent.append(row);
        button.onclick = event => {
          if (entry.directory) { if (this.expanded.has(entry.id)) this.expanded.delete(entry.id); else { this.expanded.add(entry.id); if (!this.children.has(entry.id)) this.load(entry.id); } this.render(); }
          else if (event.detail < 2) this.open(entry, this.generation, false);
        };
        button.ondblclick = event => { if (!entry.directory) { event.preventDefault(); this.open(entry, this.generation, true); } };
        if (entry.directory) {
          row.setAttribute('aria-expanded', String(this.expanded.has(entry.id)));
          if (this.expanded.has(entry.id)) { const group = document.createElement('div'); group.setAttribute('role', 'group'); row.append(group); append(this.children.get(entry.id) ?? [], group, depth + 1); }
        }
      }
    };
    const list = this.children.get(this.root.id); if (list) append(list, tree, 0);
    if (list?.length === 0) document.getElementById('files-message')!.textContent = t('没有可显示的文件', 'No matching files');
  }
}
