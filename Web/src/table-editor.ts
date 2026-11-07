import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { defaultKeymap, isolateHistory, cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown } from '@codemirror/commands';
import { EditorView, WidgetType, keymap } from '@codemirror/view';
import { editorMarkdown } from './editor-language';
import { cellInlinePresentation } from './inline-presentation';
import { t } from './localization';

export interface TableCell { from: number; to: number; text: string }
export interface TableRow { cells: TableCell[]; header: boolean }
function containerPrefix(line: string): string { return /^(?:[ \t]*>[ \t]?)+[ \t]*/.exec(line)?.[0] ?? /^[ \t]+/.exec(line)?.[0] ?? ''; }
/** Split only unescaped pipes; retain exact UTF-16 source spans and original padding. */
export function tableRows(source: string, base: number): TableRow[] {
  const rows: TableRow[] = []; let offset = base;
  for (const [index, line] of source.split('\n').entries()) {
    if (index === 1) { offset += line.length + 1; continue; }
    const prefix = containerPrefix(line), cuts = [prefix.length - 1];
    for (let i = prefix.length; i < line.length; i++) if (line[i] === '|') {
      let slash = i - 1; while (slash >= 0 && line[slash] === '\\') slash--;
      if ((i - 1 - slash) % 2 === 0) cuts.push(i);
    }
    cuts.push(line.length);
    const cells: TableCell[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i] + 1, end = cuts[i + 1], raw = line.slice(start, end);
      if ((i === 0 || i === cuts.length - 2) && !raw.trim() && cuts.length > 2) continue;
      const left = raw.length - raw.trimStart().length, text = raw.trim();
      cells.push({ from: offset + start + left, to: offset + start + left + text.length, text });
    }
    rows.push({ cells, header: index === 0 }); offset += line.length + 1;
  }
  return rows;
}
export type TableAction = 'rowBefore' | 'rowAfter' | 'columnBefore' | 'columnAfter' | 'deleteRow' | 'deleteColumn' | 'deleteTable';
/** Structural changes are one parent-document transaction and one undo step, including bulk insertion. */
export function tableTransaction(source: string, from: number, row: number, column: number, action: TableAction, count = 1): TransactionSpec | null {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) return null;
  const parsed = tableRows(source, 0); if (!parsed.length || !parsed[0].cells.length) return null;
  const width = Math.max(...parsed.map(row => row.cells.length));
  const rows = parsed.map(row => Array.from({ length: width }, (_, index) => row.cells[index]?.text ?? ''));
  const delimiter = source.split('\n')[1] ?? '';
  let alignment = delimiter.slice(containerPrefix(delimiter).length).split('|').map(cell => cell.trim()).filter(cell => /^:?-+:?$/.test(cell));
  alignment = Array.from({ length: width }, (_, index) => alignment[index] ?? '---');
  row = Math.max(0, Math.min(rows.length - 1, row)); column = Math.max(0, Math.min(width - 1, column));
  let targetRow = row, targetColumn = column;
  if (action === 'deleteTable' || action === 'deleteColumn' && width === 1 || action === 'deleteRow' && rows.length === 1) {
    return { changes: { from, to: from + source.length, insert: '' }, selection: EditorSelection.cursor(from), userEvent: 'input.table' };
  }
  if (action === 'rowBefore' || action === 'rowAfter') {
    targetRow = row + (action === 'rowAfter' ? 1 : 0); rows.splice(targetRow, 0, ...Array.from({ length: count }, () => Array(width).fill('') as string[]));
  } else if (action === 'columnBefore' || action === 'columnAfter') {
    targetColumn = column + (action === 'columnAfter' ? 1 : 0);
    for (const cells of rows) cells.splice(targetColumn, 0, ...Array<string>(count).fill(''));
    alignment.splice(targetColumn, 0, ...Array<string>(count).fill('---'));
  } else if (action === 'deleteRow') { rows.splice(row, 1); targetRow = Math.min(row, rows.length - 1); }
  else if (action === 'deleteColumn') { for (const cells of rows) cells.splice(column, 1); alignment.splice(column, 1); targetColumn = Math.min(column, width - 2); }
  if (rows.length * rows[0].length > 10_000) return null;
  const format = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  const sourceLines = source.split('\n'), firstPrefix = containerPrefix(sourceLines[0]), continuation = containerPrefix(sourceLines[1] ?? '');
  const insert = [firstPrefix + format(rows[0]), continuation + format(alignment), ...rows.slice(1).map(row => continuation + format(row))].join('\n');
  const target = tableRows(insert, from)[targetRow]?.cells[targetColumn]?.from ?? from;
  return { changes: { from, to: from + source.length, insert }, selection: EditorSelection.cursor(target), userEvent: 'input.table' };
}
const controllers = new WeakMap<HTMLElement, TableController>();
export function tableHasFocus(view: EditorView): boolean { return !!view.dom.querySelector('.table-cell-editor.cm-focused'); }
export function tableComposing(view: EditorView): boolean {
  return [...view.dom.querySelectorAll<HTMLElement>('.live-table')].some(element => controllers.get(element)?.composing);
}
export function tableCaretRect(view: EditorView): { top: number; bottom: number } | null {
  for (const element of view.dom.querySelectorAll<HTMLElement>('.live-table')) {
    const controller = controllers.get(element);
    const child = controller?.views.find(child => child.dom.contains(document.activeElement));
    if (child) return child.coordsAtPos(child.state.selection.main.head);
  }
  return null;
}
export function focusTableSelection(view: EditorView): boolean {
  for (const element of view.dom.querySelectorAll<HTMLElement>('.live-table')) if (controllers.get(element)?.focusSelection()) return true;
  return false;
}
export function navigateTable(view: EditorView, direction: 'left' | 'right' | 'up' | 'down'): boolean {
  if (view.composing || !view.state.selection.main.empty) return false;
  const tables = [...view.dom.querySelectorAll<HTMLElement>('.live-table')].map(element => controllers.get(element)!).filter(Boolean);
  if (!tables.length) return false;
  const before = view.state.selection.main.head, point = view.coordsAtPos(before);
  const move = { left: cursorCharLeft, right: cursorCharRight, up: cursorLineUp, down: cursorLineDown }[direction];
  if (!move(view)) return false;
  const after = view.state.selection.main.head, forward = direction === 'right' || direction === 'down';
  const table = tables.find(table => after >= table.start && after <= table.end || forward && before <= table.start && after >= table.end || !forward && before >= table.end && after <= table.start);
  if (table) table.enter(forward, point?.left, direction === 'up' || direction === 'down');
  return true;
}
class TableController {
  rows: TableRow[] = []; views: EditorView[] = []; syncing = false;
  private source = ''; private from = 0; private menu?: HTMLElement; private menuEvents?: AbortController; private dialog?: HTMLDialogElement;
  constructor(readonly parent: EditorView, readonly element: HTMLElement, source: string, from: number) {
    element.addEventListener('focusin', () => element.classList.add('table-active'));
    element.addEventListener('focusout', () => queueMicrotask(() => {
      const head = this.parent.state.selection.main.head;
      element.classList.toggle('table-active', element.contains(document.activeElement) || this.parent.contentDOM === document.activeElement && head >= this.from && head <= this.from + this.source.length);
    }));
    element.addEventListener('contextmenu', event => this.contextMenu(event));
    this.sync(source, from);
  }
  get composing(): boolean { return this.views.some(view => view.composing); }
  get start(): number { return this.from; }
  get end(): number { return this.from + this.source.length; }
  sync(source: string, from: number) {
    this.source = source; this.from = from;
    const head = this.parent.state.selection.main.head;
    this.element.classList.toggle('table-active', head >= from && head <= from + source.length);
    const rows = tableRows(source, from), cells = rows.flatMap(row => row.cells);
    const structure = rows.map(row => row.cells.length).join(',') + t('zh', 'en');
    if (this.element.dataset.structure !== structure) {
      this.views.forEach(view => view.destroy()); this.views = []; this.element.replaceChildren(); this.element.dataset.structure = structure;
      const remove = document.createElement('button'); remove.className = 'table-delete'; remove.type = 'button'; remove.textContent = '×';
      remove.title = t('删除表格（可撤销）', 'Delete table (undoable)'); remove.setAttribute('aria-label', remove.title);
      remove.onmousedown = event => event.preventDefault(); remove.onclick = () => this.apply('deleteTable', 0, 0);
      const scroll = document.createElement('div'); scroll.className = 'table-scroll';
      const table = document.createElement('table'); scroll.append(table); this.element.append(remove, scroll);
      for (const row of rows) {
        const tr = document.createElement('tr'); table.append(tr);
        for (const cell of row.cells) {
          const td = document.createElement(row.header ? 'th' : 'td'); td.dataset.row = String(rows.indexOf(row)); td.dataset.column = String(row.cells.indexOf(cell)); tr.append(td);
          const index = this.views.length;
          const view = new EditorView({ parent: td, state: EditorState.create({ doc: cell.text, extensions: [editorMarkdown(), cellInlinePresentation(), EditorView.lineWrapping,
            EditorView.editorAttributes.of({ class: 'table-cell-editor' }), EditorView.contentAttributes.of({ 'aria-label': row.header ? t('表头单元格', 'Table header cell') : t('表格单元格', 'Table cell') }),
            EditorState.transactionFilter.of(transaction => transaction.docChanged && (this.parent.state.readOnly || /[\r\n]/.test(transaction.newDoc.toString())) ? [] : transaction),
             keymap.of([{ key: 'Tab', run: () => this.move(index, 1) }, { key: 'Shift-Tab', run: () => this.move(index, -1) },
               ...(['left', 'right', 'up', 'down'] as const).map(direction => ({ key: 'Arrow' + direction[0].toUpperCase() + direction.slice(1), run: (view: EditorView) => this.arrow(view, index, direction) })),
              { key: 'Enter', run: () => this.move(index, row.cells.length) }, { key: 'Escape', run: () => { this.parent.focus(); return true; } },
              ...defaultKeymap]),
            EditorView.updateListener.of(update => {
              if (this.syncing || (!update.docChanged && !update.selectionSet && !update.focusChanged)) return;
              if (update.focusChanged && !update.view.hasFocus) return;
              const cell = this.rows.flatMap(row => row.cells)[index]; if (!cell) return;
              const spec: TransactionSpec = { selection: EditorSelection.single(cell.from + update.state.selection.main.anchor, cell.from + update.state.selection.main.head) };
              if (update.docChanged) { spec.changes = { from: cell.from, to: cell.to, insert: update.state.doc.toString().replace(/(?<!\\)\|/g, '\\|') }; spec.userEvent = 'input.type'; }
              // A child update cannot dispatch into its parent synchronously during the parent's DOM update.
              queueMicrotask(() => { if (this.element.isConnected && !this.parent.state.readOnly) this.parent.dispatch(spec); });
            }), EditorView.domEventHandlers({ paste: event => {
              event.preventDefault(); this.parent.dom.dispatchEvent(new CustomEvent('table-paste', { bubbles: true })); return true;
            } })
          ] }) });
          this.views.push(view);
        }
      }
    }
    this.rows = rows; this.syncing = true;
    try {
      this.views.forEach((view, index) => {
        const text = cells[index].text;
        const effects = view.state.doc.toString() === text ? {} : { changes: { from: 0, to: view.state.doc.length, insert: text } };
        if ('changes' in effects) view.dispatch({ ...effects, annotations: Transaction.addToHistory.of(false) });
        view.contentDOM.contentEditable = String(!this.parent.state.readOnly);
      });
    } finally { this.syncing = false; }
  }
  focusSelection(): boolean {
    const position = this.parent.state.selection.main.head, cells = this.rows.flatMap(row => row.cells);
    const index = cells.findIndex(cell => position >= cell.from && position <= cell.to);
    if (index < 0) return false;
    this.syncing = true;
    try { this.views[index].dispatch({ selection: EditorSelection.cursor(position - cells[index].from) }); this.views[index].focus(); }
    finally { this.syncing = false; }
    return true;
  }
  move(index: number, direction: number): boolean {
    const next = this.views[index + direction];
    if (next) { next.focus(); next.dispatch({ selection: EditorSelection.cursor(0) }); }
    else { const cells = this.rows.flatMap(row => row.cells); this.parent.dispatch({ selection: EditorSelection.cursor(direction > 0 ? Math.min(this.parent.state.doc.length, cells.at(-1)!.to + 2) : Math.max(0, cells[0].from - 2)), scrollIntoView: true }); this.parent.focus(); }
    return true;
  }
  enter(forward: boolean, x?: number, vertical = false): void {
    const row = forward ? 0 : this.rows.length - 1;
    let column = forward ? 0 : this.rows[row].cells.length - 1;
    if (vertical && x !== undefined) {
      const cells = [...this.element.querySelectorAll('tr')][row]?.children;
      if (cells?.length) {
        let distance = Infinity;
        for (let i = 0; i < cells.length; i++) { const rect = cells[i].getBoundingClientRect(), delta = Math.abs((rect.left + rect.right) / 2 - x); if (delta < distance) { distance = delta; column = i; } }
      }
    }
    this.focusCell(this.rows.slice(0, row).reduce((sum, row) => sum + row.cells.length, 0) + column, forward ? 0 : Infinity);
  }
  private focusCell(index: number, position: number): boolean {
    const child = this.views[index], cell = this.rows.flatMap(row => row.cells)[index]; if (!child || !cell) return false;
    position = Math.min(child.state.doc.length, position); this.parent.dispatch({ selection: EditorSelection.cursor(cell.from + position) });
    this.syncing = true; try { child.dispatch({ selection: EditorSelection.cursor(position) }); child.focus(); } finally { this.syncing = false; }
    return true;
  }
  private arrow(view: EditorView, index: number, direction: 'left' | 'right' | 'up' | 'down'): boolean {
    if (view.composing || !view.state.selection.main.empty) return false;
    const head = view.state.selection.main.head;
    if (direction === 'left' && head !== 0 || direction === 'right' && head !== view.state.doc.length) return false;
    if (direction === 'up' || direction === 'down') {
      const caret = view.coordsAtPos(head), edge = view.coordsAtPos(direction === 'up' ? 0 : view.state.doc.length);
      if (caret && edge && Math.abs(caret.top - edge.top) > 2) return false;
    }
    const width = this.rows[0]?.cells.length ?? 1, offset = direction === 'left' ? -1 : direction === 'right' ? 1 : direction === 'up' ? -width : width;
    if (this.focusCell(index + offset, direction === 'left' ? Infinity : direction === 'right' ? 0 : head)) return true;
    const position = direction === 'up' || direction === 'left' ? Math.max(0, this.from - 1) : Math.min(this.parent.state.doc.length, this.end + 1);
    this.parent.dispatch({ selection: EditorSelection.cursor(position), scrollIntoView: true }); this.parent.focus(); return true;
  }
  private apply(action: TableAction, row: number, column: number, count = 1): void {
    if (this.parent.state.readOnly || this.composing) return;
    const spec = tableTransaction(this.source, this.from, row, column, action, count); if (!spec) return;
    this.dismissMenu(); this.parent.dispatch({ ...spec, annotations: isolateHistory.of('full') });
    if (action === 'deleteTable') this.parent.focus(); else queueMicrotask(() => { if (!focusTableSelection(this.parent)) this.parent.focus(); });
  }
  private dismissMenu(): void { this.menuEvents?.abort(); this.menu?.remove(); this.menu = undefined; }
  private contextMenu(event: MouseEvent): void {
    if (this.parent.state.readOnly || this.composing) return;
    const cell = (event.target as Element).closest<HTMLElement>('td,th'); if (!cell) return;
    event.preventDefault(); this.dismissMenu();
    const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
    const menu = document.createElement('div'); menu.className = 'table-menu'; menu.setAttribute('role', 'menu'); this.menu = menu;
    const choices: [string, string, TableAction, boolean?][] = [
      ['在上方插入一行', 'Insert row above', 'rowBefore'], ['在下方插入一行', 'Insert row below', 'rowAfter'],
      ['在上方插入多行…', 'Insert rows above…', 'rowBefore', true], ['在下方插入多行…', 'Insert rows below…', 'rowAfter', true],
      ['在左侧插入一列', 'Insert column left', 'columnBefore'], ['在右侧插入一列', 'Insert column right', 'columnAfter'],
      ['在左侧插入多列…', 'Insert columns left…', 'columnBefore', true], ['在右侧插入多列…', 'Insert columns right…', 'columnAfter', true],
      ['删除当前行', 'Delete row', 'deleteRow'], ['删除当前列', 'Delete column', 'deleteColumn'], ['删除表格', 'Delete table', 'deleteTable']
    ];
    for (const [zh, en, action, multiple] of choices) {
      const button = document.createElement('button'); button.textContent = t(zh, en); button.setAttribute('role', 'menuitem'); button.dataset.action = action;
      if (action.startsWith('delete')) button.className = 'destructive';
      button.onclick = () => multiple ? this.askCount(action, row, column) : this.apply(action, row, column); menu.append(button);
    }
    document.body.append(menu);
    menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
    this.menuEvents = new AbortController();
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) this.dismissMenu(); }, { capture: true, signal: this.menuEvents.signal });
    menu.onkeydown = event => {
      if (event.key === 'Escape') { this.dismissMenu(); this.parent.focus(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
    };
    menu.querySelector('button')?.focus();
  }
  private askCount(action: TableAction, row: number, column: number): void {
    this.dismissMenu(); this.dialog?.remove();
    const dialog = document.createElement('dialog'); this.dialog = dialog; dialog.className = 'table-count-dialog';
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.textContent = action.startsWith('row') ? t('插入多行', 'Insert rows') : t('插入多列', 'Insert columns');
    const label = document.createElement('label'); label.textContent = t('数量（1–100）', 'Count (1–100)');
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '1'; input.value = '2'; input.required = true; label.append(input);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('取消', 'Cancel');
    const close = () => { dialog.close(); dialog.remove(); this.dialog = undefined; };
    cancel.onclick = close;
    const submit = document.createElement('button'); submit.className = 'primary'; submit.textContent = t('插入', 'Insert'); submit.type = 'submit';
    form.onsubmit = event => { event.preventDefault(); if (!input.checkValidity()) { input.reportValidity(); return; } const count = Number(input.value); close(); this.apply(action, row, column, count); };
    dialog.oncancel = event => { event.preventDefault(); close(); };
    const actions = document.createElement('div'); actions.className = 'dialog-actions'; actions.append(cancel, submit);
    form.append(title, label, actions); dialog.append(form); document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  }
  destroy() { this.dismissMenu(); this.dialog?.remove(); this.views.forEach(view => view.destroy()); }
}
export class TableWidget extends WidgetType {
  private readonly locale = t('zh', 'en');
  constructor(readonly source: string, readonly from: number, readonly muted: boolean) { super(); }
  eq(other: TableWidget) { return this.source === other.source && this.from === other.from && this.muted === other.muted && this.locale === other.locale; }
  toDOM(view: EditorView) {
    const element = document.createElement('section'); element.className = 'live-table' + (this.muted ? ' unfocused-block' : '');
    element.dataset.line = String(view.state.doc.lineAt(this.from).number); element.classList.add('source-line-number');
    controllers.set(element, new TableController(view, element, this.source, this.from)); return element;
  }
  updateDOM(element: HTMLElement) {
    element.classList.toggle('unfocused-block', this.muted);
    const controller = controllers.get(element); controller?.sync(this.source, this.from);
    if (controller) element.dataset.line = String(controller.parent.state.doc.lineAt(this.from).number);
    return true;
  }
  ignoreEvent() { return true; }
  destroy(element: HTMLElement) { controllers.get(element)?.destroy(); controllers.delete(element); }
}
