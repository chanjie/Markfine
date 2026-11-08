export interface MenuAction { label: string; run: () => void; disabled?: boolean; destructive?: boolean }
let dismissCurrent: (() => void) | undefined;
export function dismissContextMenu(): void { dismissCurrent?.(); }
export function isContextGesture(event: MouseEvent): boolean { return event.button === 2 || event.button === 0 && event.ctrlKey; }
/** Stop WebKit/CodeMirror's right-click word selection before opening a menu. */
export function preserveContextSelection(): void {
  document.addEventListener('mousedown', event => {
    if (isContextGesture(event) && event.target instanceof Element && event.target.closest('#editor,#reader,.outline-row,.tab')) event.preventDefault();
  }, true);
}
export function contextMenu(x: number, y: number, actions: MenuAction[], className = ''): void {
  dismissContextMenu();
  const menu = document.createElement('div'), events = new AbortController(), previous = document.activeElement;
  menu.className = 'table-menu context-menu ' + className; menu.setAttribute('role', 'menu');
  const dismiss = () => { const focused = menu.contains(document.activeElement); events.abort(); menu.remove(); if (focused && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); if (dismissCurrent === dismiss) dismissCurrent = undefined; };
  dismissCurrent = dismiss;
  for (const action of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
    button.setAttribute('role', 'menuitem'); button.disabled = !!action.disabled;
    if (action.destructive) button.className = 'destructive';
    button.onclick = () => { dismiss(); action.run(); }; menu.append(button);
  }
  document.body.append(menu);
  menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 6)) + 'px';
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) dismiss(); }, { capture: true, signal: events.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    }
  }, { capture: true, signal: events.signal });
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}
