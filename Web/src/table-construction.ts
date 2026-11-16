import { EditorSelection, type EditorState, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, type EditorView } from '@codemirror/view';
import { tableRows, tableContainerPrefix } from './table-editor';
import { finishTableConstruction, tableConstruction } from './markdown-input-state';

export interface SourceTableLine { from: number; to: number; className: string; attributes: Record<string, string> }

/** Format the authoritative source text in place; never replace the native insertion node. */
export function sourceTablePresentation(state: EditorState, table: { from: number; to: number }, visible: { from: number; to: number }) {
  const marks: Range<Decoration>[] = [], lines: SourceTableLine[] = [];
  const first = state.doc.lineAt(table.from), last = state.doc.lineAt(Math.max(table.from, table.to - 1));
  // A table may start after a list/quote marker on its first physical line.
  // The surrounding container is not an additional header cell.
  const columns = Math.max(1, tableRows(state.sliceDoc(table.from, first.to), table.from)[0]?.cells.length ?? 1);
  const alignments = state.doc.line(Math.min(first.number + 1, state.doc.lines)).text.slice(tableContainerPrefix(first.text).length)
    .split('|').map(value => value.trim()).filter(value => /^:?-+:?$/.test(value));
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (to > from) marks.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const begin = Math.max(first.number, state.doc.lineAt(Math.min(visible.from, state.doc.length)).number);
  const end = Math.min(last.number, state.doc.lineAt(Math.min(visible.to, state.doc.length)).number);
  for (let number = begin; number <= end; number++) {
    const line = state.doc.line(number), index = number - first.number;
    const from = number === first.number ? table.from : line.from, text = state.sliceDoc(from, line.to);
    const cells = tableRows(text, from)[0]?.cells ?? [];
    const prefixEnd = from + tableContainerPrefix(text).length;
    let cursor = line.from;
    for (const [column, cell] of cells.entries()) {
      let from = cell.from, to = cell.to;
      while (from > prefixEnd && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
      while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to++;
      const pipe = to < line.to && state.sliceDoc(to, to + 1) === '|';
      mark(cursor, from, 'table-source-marker table-source-prefix');
      const alignment = alignments[column] ?? '---';
      const align = alignment.startsWith(':') && alignment.endsWith(':') ? 'center' : alignment.endsWith(':') ? 'right' : 'left';
      mark(from, to + (pipe ? 1 : 0), 'table-source-cell', { style: 'text-align:' + align });
      if (pipe) mark(to, to + 1, 'table-source-marker');
      cursor = to + (pipe ? 1 : 0);
    }
    mark(cursor, line.to, 'table-source-marker table-source-prefix');
    lines.push({ from: line.from, to: line.to,
      className: 'table-source-row' + (index === 0 ? ' table-source-header' : '') +
        (index === 1 ? ' table-source-delimiter' : '') + (number === last.number ? ' table-source-last' : ''),
      attributes: { style: '--table-columns:' + columns, 'data-source-table-line': String(first.number),
        'data-source-table-row': String(index), 'data-source-cells': JSON.stringify(cells.map(cell => [cell.from, cell.to])) } });
  }
  return { marks, lines };
}

function sourceRow(view: EditorView, target: EventTarget | null) {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const row = element?.closest<HTMLElement>('.table-source-row[data-source-cells]');
  return row && view.contentDOM.contains(row) ? row : null;
}

export function sourceTablePosition(view: EditorView, target: EventTarget | null, point: { x: number; y: number }): number | null {
  const row = sourceRow(view, target); if (!row) return null;
  let cells: [number, number][];
  try { cells = JSON.parse(row.dataset.sourceCells!); } catch { return null; }
  if (!Array.isArray(cells) || !cells.length || cells.some(cell => !Array.isArray(cell) || cell.length !== 2 ||
    !cell.every(value => Number.isSafeInteger(value) && value >= 0 && value <= view.state.doc.length) || cell[0] > cell[1])) return null;
  const box = row.getBoundingClientRect(), columns = Number(row.style.getPropertyValue('--table-columns'));
  if (box.width <= 0 || !Number.isSafeInteger(columns) || columns < 1) return null;
  const column = Math.max(0, Math.min(cells.length - 1, Math.floor((point.x - box.left) / (box.width / columns))));
  const [from, to] = cells[column], position = view.posAtCoords(point, false);
  return position !== null && position >= from && position <= to ? position :
    point.x > box.left + (column + .5) * box.width / columns ? to : from;
}

export function sourceTableTab(view: EditorView, backward = false): boolean {
  if (view.composing || view.state.readOnly || !view.state.selection.main.empty || !view.state.field(tableConstruction, false)) return false;
  const head = view.state.selection.main.head; let node = syntaxTree(view.state).resolveInner(head, -1);
  while (node.parent && node.name !== 'Table') node = node.parent;
  if (node.name !== 'Table') return false;
  const rows = tableRows(view.state.sliceDoc(node.from, node.to), node.from), cells = rows.flatMap(row => row.cells);
  const first = view.state.doc.lineAt(node.from).number, line = view.state.doc.lineAt(head).number;
  let next;
  if (line === first + 1) next = backward ? rows[0]?.cells.at(-1) : rows[1]?.cells[0];
  else {
    const onLine = cells.map((cell, index) => ({ cell, index })).filter(value => view.state.doc.lineAt(value.cell.from).number === line);
    const current = onLine.find(value => head >= value.cell.from && head <= value.cell.to) ??
      onLine.reduce<typeof onLine[number] | undefined>((best, value) => !best || Math.abs(value.cell.from - head) < Math.abs(best.cell.from - head) ? value : best, undefined);
    if (!current) return false;
    next = cells[current.index + (backward ? -1 : 1)];
  }
  view.dispatch({ selection: EditorSelection.cursor(next?.from ?? (backward ? Math.max(0, node.from - 1) : Math.min(view.state.doc.length, node.to + 1))),
    effects: next ? [] : finishTableConstruction.of(null), scrollIntoView: true });
  view.focus(); return true;
}

/** An explicit context-menu request may hand the already formatted table to its normal cell views. */
export function sourceTableContextMenu(view: EditorView, event: MouseEvent): boolean {
  if (view.composing || view.state.readOnly) return false;
  const row = sourceRow(view, event.target), position = sourceTablePosition(view, event.target, { x: event.clientX, y: event.clientY });
  if (!row || position === null) return false;
  const tableLine = Number(row.dataset.sourceTableLine), sourceIndex = Number(row.dataset.sourceTableRow);
  const ranges: [number, number][] = JSON.parse(row.dataset.sourceCells!);
  const column = Math.max(0, ranges.findIndex(cell => position >= cell[0] && position <= cell[1]));
  event.preventDefault(); event.stopPropagation();
  view.dispatch({ selection: EditorSelection.cursor(position), effects: finishTableConstruction.of(null) });
  queueMicrotask(() => {
    if (!view.dom.isConnected || view.composing || view.state.readOnly) return;
    const table = [...view.dom.querySelectorAll<HTMLElement>('.live-table')].find(element => Number(element.dataset.line) === tableLine);
    const cell = table?.querySelector<HTMLElement>('[data-row="' + Math.max(0, sourceIndex - (sourceIndex > 0 ? 1 : 0)) + '"][data-column="' + column + '"]');
    cell?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: event.clientX, clientY: event.clientY }));
  });
  return true;
}
