export interface MenuAction { label: string; run: () => void; disabled?: boolean; destructive?: boolean }
let dismissCurrent: (() => void) | undefined;
let menuSequence = 0;
export function dismissContextMenu(): void { dismissCurrent?.(); }
export function isContextGesture(event: MouseEvent): boolean { return event.button === 2 || event.button === 0 && event.ctrlKey; }
/** Stop WebKit/CodeMirror's right-click word selection before opening a menu. */
export function preserveContextSelection(actions?: () => MenuAction[]): void {
  document.addEventListener('mousedown', event => {
    if (isContextGesture(event) && event.target instanceof Element && event.target.closest('#editor,#reader,.outline-row,.tab')) event.preventDefault();
  }, true);
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented || !actions || !(event.target instanceof Element) || !event.target.closest('#editor') || event.target.closest('.live-table,.image-frame')) return;
    // WebKit's native context menu selects the word under the pointer even when
    // mousedown was cancelled. Use the same controlled menu as other editor objects.
    event.preventDefault(); contextMenu(event.clientX, event.clientY, actions(), 'editor-context-menu');
  });
}
export function contextMenu(x: number, y: number, actions: MenuAction[], className = '', keepFocus = false): void {
  dismissContextMenu();
  const menu = document.createElement('div'), events = new AbortController(), previous = document.activeElement;
  menu.className = 'table-menu context-menu ' + className; menu.setAttribute('role', 'menu');
  const originalControls = previous?.getAttribute('aria-controls'), originalActive = previous?.getAttribute('aria-activedescendant');
  const dismiss = () => {
    const focused = menu.contains(document.activeElement); events.abort(); menu.remove();
    if (keepFocus && previous instanceof HTMLElement) for (const [name, value] of [['aria-controls', originalControls], ['aria-activedescendant', originalActive]] as const) {
      if (value === null || value === undefined) previous.removeAttribute(name); else previous.setAttribute(name, value);
    }
    if (focused && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    if (dismissCurrent === dismiss) dismissCurrent = undefined;
  };
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
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  let active = 0;
  const highlight = () => {
    buttons.forEach((button, index) => button.classList.toggle('selected', index === active));
    if (previous instanceof HTMLElement && buttons[active]) previous.setAttribute('aria-activedescendant', buttons[active].id);
  };
  if (keepFocus) {
    // Focus outside a contenteditable clears WebKit's visible DOM selection even
    // when the CM selection is unchanged. Use active-descendant menu navigation.
    menu.id = 'context-menu-' + ++menuSequence;
    buttons.forEach((button, index) => { button.id = menu.id + '-' + index; });
    previous?.setAttribute('aria-controls', menu.id); highlight();
    menu.addEventListener('mousedown', event => event.preventDefault(), { signal: events.signal });
  }
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) dismiss(); }, { capture: true, signal: events.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const index = keepFocus ? active : buttons.indexOf(document.activeElement as HTMLButtonElement);
      active = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      if (keepFocus) highlight(); else buttons[active]?.focus({ preventScroll: true });
    } else if (keepFocus && event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); buttons[active]?.click();
    } else if (keepFocus && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      dismiss(); // Ordinary typing returns to the original input instead of editing behind a stale menu.
    }
  }, { capture: true, signal: events.signal });
  if (!keepFocus) buttons[0]?.focus({ preventScroll: true });
}
