import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { editorMarkdownLanguage } from './editor-language';

/** Source units, never visual wrapped lines. Paragraph deletion refuses code/table structures. */
export function deletionTransaction(state: EditorState, kind: 'deleteLine' | 'deleteParagraph'): TransactionSpec | null {
  if (state.readOnly || !state.doc.length) return null;
  const tree = kind === 'deleteParagraph' ? editorMarkdownLanguage.parser.parse(state.doc.toString()) : null;
  const ranges: { from: number; to: number }[] = [];
  for (const selection of state.selection.ranges) {
    const end = selection.to > selection.from && state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to;
    let first = state.doc.lineAt(selection.from), last = state.doc.lineAt(end);
    if (tree) {
      let protectedBlock = false;
      tree.iterate({ from: selection.from, to: Math.max(selection.from + 1, end), enter(node) { if (/^(Table|FencedCode|CodeBlock)$/.test(node.name)) { protectedBlock = true; return false; } } });
      if (protectedBlock) return null;
      const block = (position: number) => {
        let node = tree.resolveInner(position, 1);
        while (node.parent && !/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|CommentBlock|HTMLBlock|Table|FencedCode|CodeBlock)$/.test(node.name)) node = node.parent;
        return node;
      };
      const startNode = block(selection.from), endNode = block(end);
      if ([startNode, endNode].some(node => /^(Table|FencedCode|CodeBlock)$/.test(node.name))) return null;
      if (startNode.name !== 'Document') first = state.doc.lineAt(startNode.from);
      if (endNode.name !== 'Document') last = state.doc.lineAt(Math.max(endNode.from, endNode.to - 1));
    }
    let from = first.from, to = last.to;
    if (last.number < state.doc.lines) to++;
    else if (first.number > 1) from--;
    if (to > from) ranges.push({ from, to });
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged: typeof ranges = [];
  for (const range of ranges) { const previous = merged.at(-1); if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to); else merged.push({ ...range }); }
  if (!merged.length) return null;
  return { changes: merged.map(range => ({ ...range, insert: '' })), selection: EditorSelection.cursor(merged[0].from), userEvent: 'delete.line', scrollIntoView: true };
}
