import { StateField, type EditorState } from '@codemirror/state';
import { referenceIndex } from './reference-context';
import type { SyntaxNode } from '@lezer/common';
import { t } from './localization';

export interface OutlineHeading { from: number; to: number; level: number; title: string; children: OutlineHeading[] }
export function headingTitle(state: EditorState, node: SyntaxNode): string {
  return state.sliceDoc(node.from, node.to).replace(/^ {0,3}#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/\n[ \t]*[=-]+[ \t]*$/, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim() || t('未命名标题', 'Untitled heading');
}
function headings(state: EditorState): OutlineHeading[] {
  const result: OutlineHeading[] = [], stack: OutlineHeading[] = [];
  state.field(referenceIndex).tree.iterate({ enter(node) {
    const match = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    if (!match) return;
    const item: OutlineHeading = { from: node.from, to: node.to, level: Number(match[1]), title: headingTitle(state, node.node), children: [] };
    while (stack.length && stack.at(-1)!.level >= item.level) stack.pop();
    (stack.at(-1)?.children ?? result).push(item); stack.push(item);
  } });
  return result;
}
export const documentOutline = StateField.define<OutlineHeading[]>({
  create: headings,
  update: (value, transaction) => transaction.docChanged || transaction.startState.field(referenceIndex).tree !== transaction.state.field(referenceIndex).tree ? headings(transaction.state) : value
});
