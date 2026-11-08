import { EditorSelection, Prec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';

const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`', '（': '）', '【': '】', '〔': '〕', '［': '］', '｛': '｝', '“': '”', '‘': '’', '《': '》', '〈': '〉', '「': '」', '『': '』' };
const closers = new Set(Object.values(pairs));
export function punctuationTransaction(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  if (state.readOnly || text.length !== 1 || state.selection.ranges.length !== 1) return null;
  const next = state.doc.sliceString(to, to + 1), previous = state.doc.sliceString(Math.max(0, from - 1), from);
  if (from === to && closers.has(text) && next === text) return { selection: EditorSelection.cursor(to + 1), userEvent: 'select.punctuation' };
  const close = pairs[text]; if (!close) return null;
  if (from === to && text === close && /[\p{L}\p{N}_]/u.test(previous)) return null;
  if (from === to && next && !/[\s)\]}）】〕］｝”’》〉」』.,，。;；:：!?！？]/u.test(next)) return null;
  const selected = state.doc.sliceString(from, to);
  return { changes: { from, to, insert: text + selected + close }, selection: EditorSelection.single(from + 1, from + 1 + selected.length), userEvent: 'input.type', annotations: isolateHistory.of('full') };
}
export function deletePunctuation(state: EditorState): TransactionSpec | null {
  const selection = state.selection.main;
  if (state.readOnly || !selection.empty || state.selection.ranges.length !== 1 || selection.head === 0) return null;
  const from = selection.head - 1, open = state.doc.sliceString(from, selection.head), close = state.doc.sliceString(selection.head, selection.head + 1);
  if (!pairs[open] || pairs[open] !== close) return null;
  return { changes: { from, to: selection.head + 1, insert: '' }, selection: EditorSelection.cursor(from), userEvent: 'delete.backward', annotations: isolateHistory.of('full') };
}
export function pairedPunctuation() {
  return [EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing) return false;
    const transaction = punctuationTransaction(view.state, from, to, text); if (!transaction) return false;
    view.dispatch(transaction); return true;
  }), Prec.highest(keymap.of([{ key: 'Backspace', run: view => { if (view.composing) return false; const transaction = deletePunctuation(view.state); if (!transaction) return false; view.dispatch(transaction); return true; } }]))];
}
