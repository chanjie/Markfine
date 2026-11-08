import { EditorState, StateEffect, StateField, type Text } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { composition, composingEffect } from './preview';
import { editorPreferences, sourceMode } from './editor-preferences';
import { highlightCode } from './code-highlighting';

interface Endings { breaks: { at: number; separator: string }[]; preferred: string; key: string }
const endingKey = (breaks: Endings['breaks']) => breaks.map(entry => entry.separator === '\r\n' ? 'c' : entry.separator === '\r' ? 'r' : 'n').join('');
const restoreEndings = StateEffect.define<Endings>({ map: (value, changes) => ({ ...value, breaks: value.breaks.map(entry => ({ ...entry, at: changes.mapPos(entry.at, 1) })) }) });
export const lineEndings = StateField.define<Endings>({
  create: () => ({ breaks: [], preferred: '\n', key: '' }),
  update(value, transaction) {
    const restored = transaction.effects.find(effect => effect.is(restoreEndings));
    if (restored) return restored.value;
    if (!transaction.docChanged || transaction.newDoc.eq(transaction.startState.doc)) return value;
    const removed: { from: number; to: number }[] = [], inserted: Endings['breaks'] = [];
    transaction.changes.iterChanges((from, to, newFrom, _newTo, text) => {
      removed.push({ from, to });
      for (let line = 1, at = newFrom; line < text.lines; line++) { at += text.line(line).length; inserted.push({ at, separator: value.preferred }); at++; }
    });
    const kept = value.breaks.filter(entry => !removed.some(range => entry.at >= range.from && entry.at < range.to))
      .map(entry => ({ ...entry, at: transaction.changes.mapPos(entry.at, 1) }));
    const breaks = [...kept, ...inserted].sort((a, b) => a.at - b.at);
    return { breaks, preferred: value.preferred, key: endingKey(breaks) };
  }
});
export function preserveLineEndings(source: string) {
  const breaks: Endings['breaks'] = []; let removed = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) { breaks.push({ at: match.index! - removed, separator: match[0] }); removed += match[0].length - 1; }
  return [lineEndings.init(() => ({ breaks, preferred: breaks[0]?.separator ?? '\n', key: endingKey(breaks) })),
    invertedEffects.of(transaction => transaction.docChanged ? [restoreEndings.of(transaction.startState.field(lineEndings))] : [])];
}
export function serializeText(text: Text, endings: Endings): string {
  let result = '', from = 0;
  for (const entry of endings.breaks) { result += text.sliceString(from, entry.at) + entry.separator; from = entry.at + 1; }
  return result + text.sliceString(from);
}
export function textParagraphRange(state: EditorState): { from: number; to: number } {
  let first = state.doc.lineAt(state.selection.main.head).number, last = first;
  if (state.doc.line(first).text.trim()) {
    while (first > 1 && state.doc.line(first - 1).text.trim()) first--;
    while (last < state.doc.lines && state.doc.line(last + 1).text.trim()) last++;
  }
  return { from: state.doc.line(first).from, to: state.doc.line(last).to };
}
export function textSnapshot(source: string) {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { html: '<pre><code>' + escaped + '</code></pre>', resources: [], imageBindings: [] };
}
/** Read source offsets, not Selection.toString(): CSS block lines have no newline text nodes. */
export function selectedRawText(source: Text, content: HTMLElement, selection: Range): string | null {
  const position = (node: Node, offset: number): number | null => {
    if (node === content) {
      if (offset < 0 || offset > content.childNodes.length) return null;
      if (offset === content.childNodes.length) return source.length;
      const child = content.childNodes[offset];
      const number = child instanceof HTMLElement ? Number(child.dataset.sourceLine) + 1 : NaN;
      return Number.isInteger(number) && number > 0 && number <= source.lines ? source.line(number).from : null;
    }
    const element = node instanceof Element ? node : node.parentElement;
    const line = element?.closest<HTMLElement>('.text-preview-line');
    if (!line || line.parentElement !== content) return null;
    const number = Number(line.dataset.sourceLine) + 1;
    if (!Number.isInteger(number) || number < 1 || number > source.lines) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(line);
    try { prefix.setEnd(node, offset); } catch { return null; }
    const original = source.line(number);
    return original.from + Math.min(original.length, prefix.toString().length);
  };
  const from = position(selection.startContainer, selection.startOffset), to = position(selection.endContainer, selection.endOffset);
  return from === null || to === null || to < from ? null : source.sliceString(from, to);
}
export function renderText(source: string, language: string): DocumentFragment {
  const fragment = document.createDocumentFragment(), ranges = highlightCode(source, language).ranges;
  let from = 0, rangeIndex = 0;
  for (const [index, text] of source.split('\n').entries()) {
    const line = document.createElement('span'); line.className = 'text-preview-line'; line.dataset.sourceLine = String(index); line.dataset.line = String(index + 1);
    const to = from + text.length; let position = from;
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= from) rangeIndex++;
    for (let i = rangeIndex; i < ranges.length && ranges[i].from < to; i++) {
      const start = Math.max(from, ranges[i].from), end = Math.min(to, ranges[i].to);
      if (start > position) line.append(document.createTextNode(source.slice(position, start)));
      if (end > start) { const span = document.createElement('span'); span.className = ranges[i].className; span.textContent = source.slice(start, end); line.append(span); position = end; }
    }
    line.append(document.createTextNode(source.slice(position, to))); fragment.append(line); from = to + 1;
  }
  return fragment;
}
export function textPresentation(language: string) {
  const styles = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(readonly view: EditorView) { this.decorations = this.build(); }
    update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.transactions.some(transaction => transaction.effects.length)) this.decorations = this.build(); }
    build() {
      const state = this.view.state, result: ReturnType<Decoration['range']>[] = [];
      for (const range of highlightCode(state.doc.toString(), language).ranges) result.push(Decoration.mark({ class: range.className }).range(range.from, range.to));
      if (state.field(editorPreferences).lineNumbers) for (const range of this.view.visibleRanges) {
        for (let number = state.doc.lineAt(range.from).number; number <= state.doc.lineAt(range.to).number; number++) {
          const line = state.doc.line(number); result.push(Decoration.line({ class: 'source-line-number', attributes: { 'data-line': String(number) } }).range(line.from));
        }
      }
      return Decoration.set(result, true);
    }
  }, { decorations: plugin => plugin.decorations });
  return [composition, sourceMode, editorPreferences, styles, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
    compositionend: (_event, view) => { queueMicrotask(() => { if (!view.composing) view.dispatch({ effects: composingEffect.of(false) }); }); return false; }
  })];
}
