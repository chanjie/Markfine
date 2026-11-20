import { findClusterBreak, StateEffect, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { emptyReferences, linkTarget, type ReferenceContext } from './renderer';

/** Resolve a modifier-click in source mode without adding presentation decorations. */
export function sourceLinkTarget(state: EditorState, position: number, context: ReferenceContext = emptyReferences): string | null {
  if (position < 0 || position > state.doc.length) return null;
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, position + 1), 20) ?? syntaxTree(state);
  let link: { from: number; to: number } | undefined;
  for (let node = tree.resolveInner(position, 1); ; ) {
    if (['Image', 'InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) return null;
    if (!link && (node.name === 'Link' || node.name === 'Autolink')) link = node;
    if (!node.parent) break;
    node = node.parent;
  }
  return link ? linkTarget(state.sliceDoc(link.from, link.to), context) : null;
}

type InlineRange = ReturnType<Decoration['range']>;
const closingRun = /^[、。，．；：！？…％,.;:!?%\p{Pe}\p{Pf}]+/u;
const punctuationJoin = Decoration.mark({ class: 'keep-closing-punctuation' });

/** The same inline presentation is used in paragraphs and table cell editors. Source is never rewritten. */
export function inlineDecorations(state: EditorState, tree: Tree, from: number, to: number, context: ReferenceContext = emptyReferences, reveal = true, inTables = false, joins?: InlineRange[]): InlineRange[] {
  const result: InlineRange[] = [];
  const hiddenEnds = new Map<number, number>();
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (to > from) result.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  tree.iterate({ from, to, enter(ref) {
    const node = ref.node, name = node.name;
    if (['FencedCode', 'CodeBlock', 'Image'].includes(name) || name === 'Table' && !inTables) return false;
    const inline: Record<string, string> = { StrongEmphasis: 'live-strong', Emphasis: 'live-emphasis', Strikethrough: 'live-strike', InlineCode: 'live-inline-code' };
    if (inline[name]) mark(node.from, node.to, inline[name]);
    if (['EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(name)) {
      const editing = reveal && state.selection.ranges.some(range => range.empty && range.head >= node.from && range.head <= node.to);
      mark(node.from, node.to, editing ? 'editing-syntax-marker' : 'syntax-marker');
      if (joins && !editing && node.to === node.parent?.to) hiddenEnds.set(node.to, node.from);
    }
    if (name === 'Link' || name === 'Autolink') {
      const href = linkTarget(state.sliceDoc(node.from, node.to), context);
      mark(node.from, node.to, 'live-link', href ? { 'data-link-href': href } : undefined);
      if (name === 'Autolink') return;
      const marks = node.getChildren('LinkMark');
      if (marks.length < 2) return;
      const expanded = reveal && state.selection.ranges.some(range => range.empty ? range.head >= node.from && range.head <= node.to : range.from < node.to && range.to > node.from);
      const className = 'link-syntax' + (expanded ? ' expanded' : '');
      mark(node.from, marks[0].to, className); mark(marks[1].from, node.to, className);
      if (joins && !expanded) hiddenEnds.set(node.to, marks[1].from);
    }
  } });
  // Zero-size syntax can still introduce Unicode break opportunities. Keep the last
  // visible grapheme, hidden closing syntax and following punctuation in one run.
  if (joins && hiddenEnds.size) {
    const hiddenStarts = new Set(hiddenEnds.values());
    for (const [end, closingStart] of hiddenEnds) {
      if (hiddenStarts.has(end) || !closingRun.test(state.sliceDoc(end, Math.min(end + 2, state.doc.length)))) continue;
      let start = closingStart;
      while (hiddenEnds.has(start)) start = hiddenEnds.get(start)!;
      const line = state.doc.lineAt(start);
      if (start <= line.from || end >= line.to) continue;
      const offset = findClusterBreak(line.text, start - line.from, false);
      const run = closingRun.exec(line.text.slice(end - line.from))?.[0];
      if (run && !/\s/u.test(line.text.slice(offset, start - line.from))) joins.push(punctuationJoin.range(line.from + offset, end + run.length));
    }
  }
  return result;
}
export function cellInlinePresentation() {
  const focusEffect = StateEffect.define<null>();
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    joins: DecorationSet = Decoration.none;
    constructor(readonly view: EditorView) { this.refresh(); }
    refresh() {
      const state = this.view.state, focused = this.view.dom.contains(this.view.contentDOM.ownerDocument.activeElement);
      const joins: InlineRange[] = [];
      this.decorations = Decoration.set(inlineDecorations(state, syntaxTree(state), 0, state.doc.length, emptyReferences, focused, false, joins), true);
      this.joins = Decoration.set(joins, true);
    }
    update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.focusChanged || update.startState !== update.state) this.refresh(); }
  }, { decorations: value => value.decorations });
  const changed = (_event: Event, view: EditorView) => {
    queueMicrotask(() => { if (view.dom.isConnected) view.dispatch({ effects: focusEffect.of(null) }); }); return false;
  };
  return [plugin, EditorView.outerDecorations.of(view => view.plugin(plugin)?.joins ?? Decoration.none), EditorView.domEventHandlers({ focus: changed, blur: changed })];
}
