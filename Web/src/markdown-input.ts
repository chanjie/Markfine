import { EditorSelection, countColumn, type EditorState, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { formatTransaction } from './commands';
import { pendingListLine, tableConstruction } from './markdown-input-state';
export { pendingListLine } from './markdown-input-state';

export function markdownInput(_composing: (state: EditorState) => boolean) {
  // Display intent must not add characters to manually typed Markdown. Explicit
  // format commands own their template separators in formatTransaction.
  return [pendingListLine, tableConstruction];
}

export function listIndentTransaction(state: EditorState, outdent: boolean): TransactionSpec | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  let item = syntaxTree(state).resolveInner(selection.head, -1);
  while (item.parent && item.name !== 'ListItem') {
    if (/^(FencedCode|CodeBlock|Table|HTMLBlock|CommentBlock)$/.test(item.name)) return null;
    item = item.parent;
  }
  if (item.name !== 'ListItem') return null;
  const first = state.doc.lineAt(item.from), last = state.doc.lineAt(Math.max(item.from, item.to - 1));
  const prefix = (text: string) => {
    const quote = /^(?:[ \t]*>[ \t]?)+/.exec(text)?.[0].length ?? 0;
    return { quote, spaces: /^[ \t]*/.exec(text.slice(quote))![0] };
  };
  const base = prefix(first.text), width = countColumn(base.spaces, 4);
  let delta = 2;
  if (outdent) {
    let outer = item.parent?.parent;
    while (outer && outer.name !== 'ListItem') outer = outer.parent;
    const outerWidth = outer ? countColumn(prefix(state.doc.lineAt(outer.from).text).spaces, 4) : Math.max(0, width - 2);
    delta = Math.max(0, width - outerWidth);
  } else {
    const previous = item.prevSibling, marker = previous?.name === 'ListItem' ? previous.getChild('ListMark') : null;
    if (marker) {
      const line = state.doc.lineAt(marker.from), start = prefix(line.text).quote;
      const gap = /^[ \t]*/.exec(state.sliceDoc(marker.to, line.to))![0];
      delta = Math.max(1, countColumn(state.sliceDoc(line.from + start, marker.to) + gap, 4) - width);
    }
  }
  const changes = Array.from({ length: last.number - first.number + 1 }, (_, index) => {
    const line = state.doc.line(first.number + index), part = prefix(line.text), at = line.from + part.quote;
    return outdent ? { from: at, to: at + part.spaces.length, insert: ' '.repeat(Math.max(0, countColumn(part.spaces, 4) - delta)) } : { from: at, to: at, insert: ' '.repeat(delta) };
  });
  const set = state.changes(changes);
  return { changes: set, selection: state.selection.map(set, 1), userEvent: 'input.indent', annotations: isolateHistory.of('full'), scrollIntoView: true };
}

/** Consume Tab inside editable text; never let the browser move focus into another widget. */
export function markdownTab(view: EditorView, outdent = false): boolean {
  if (view.composing || view.state.readOnly) return false;
  const state = view.state;
  const spec = listIndentTransaction(state, outdent) ?? (outdent || !state.selection.main.empty ? formatTransaction(state, outdent ? 'outdent' : 'indent') : {
    ...state.changeByRange(range => ({ changes: { from: range.from, to: range.to, insert: '  ' }, range: EditorSelection.cursor(range.from + 2) })),
    userEvent: 'input.indent', annotations: isolateHistory.of('full'), scrollIntoView: true
  });
  if (spec) view.dispatch(spec);
  return true;
}
