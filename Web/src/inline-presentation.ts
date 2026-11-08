import { StateField, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
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

/** The same inline presentation is used in paragraphs and table cell editors. Source is never rewritten. */
export function inlineDecorations(state: EditorState, tree: Tree, from: number, to: number, context: ReferenceContext = emptyReferences): ReturnType<Decoration['range']>[] {
  const result: ReturnType<Decoration['range']>[] = [];
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (to > from) result.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  tree.iterate({ from, to, enter(ref) {
    const node = ref.node, name = node.name;
    if (['FencedCode', 'CodeBlock', 'Image', 'Table'].includes(name)) return false;
    const inline: Record<string, string> = { StrongEmphasis: 'live-strong', Emphasis: 'live-emphasis', Strikethrough: 'live-strike', InlineCode: 'live-inline-code' };
    if (inline[name]) mark(node.from, node.to, inline[name]);
    if (['EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(name)) mark(node.from, node.to, 'syntax-marker');
    if (name === 'Link' || name === 'Autolink') {
      const href = linkTarget(state.sliceDoc(node.from, node.to), context);
      mark(node.from, node.to, 'live-link', href ? { 'data-link-href': href } : undefined);
      if (name === 'Autolink') return;
      const marks = node.getChildren('LinkMark');
      if (marks.length < 2) return;
      const expanded = state.selection.ranges.some(range => range.empty ? range.head > node.from && range.head < node.to : range.from < node.to && range.to > node.from);
      const className = 'link-syntax' + (expanded ? ' expanded' : '');
      mark(node.from, marks[0].to, className); mark(marks[1].from, node.to, className);
    }
  } });
  return result;
}
export function cellInlinePresentation() {
  const field = StateField.define<DecorationSet>({
    create: state => Decoration.set(inlineDecorations(state, syntaxTree(state), 0, state.doc.length), true),
    update: (value, transaction) => transaction.docChanged || transaction.selection ? Decoration.set(inlineDecorations(transaction.state, syntaxTree(transaction.state), 0, transaction.state.doc.length), true) : value,
    provide: field => EditorView.decorations.from(field)
  });
  return field;
}
