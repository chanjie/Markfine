import type { EditorState } from '@codemirror/state';
import { referenceIndex } from './reference-context';
import { t } from './localization';

export function formatContext(state: EditorState): string {
  const position = state.selection.main.head;
  const labels: Record<string, string> = {
    StrongEmphasis: '加粗  ⌘B', Emphasis: '斜体  ⌘I', InlineCode: '行内代码  ⌥⌘K', Strikethrough: '删除线  ⌃⇧`',
    Link: '链接  ⌘K', Image: '图片引用  ⌃⌘I', Table: '表格  ⌥⌘T', FencedCode: '代码块  ⌥⌘C', CodeBlock: '代码块  ⌥⌘C',
    Blockquote: '引用  ⌥⌘Q', BulletList: '无序列表  ⌥⌘U', OrderedList: '有序列表  ⌥⌘O', Task: '任务列表  ⌥⌘X'
  };
  const found: string[] = [];
  const english: Record<string, string> = { StrongEmphasis: 'Bold  ⌘B', Emphasis: 'Italic  ⌘I', InlineCode: 'Inline code  ⌥⌘K', Strikethrough: 'Strikethrough  ⌃⇧`', Link: 'Link  ⌘K', Image: 'Image  ⌃⌘I', Table: 'Table  ⌥⌘T', FencedCode: 'Code block  ⌥⌘C', CodeBlock: 'Code block  ⌥⌘C', Blockquote: 'Quote  ⌥⌘Q', BulletList: 'Unordered list  ⌥⌘U', OrderedList: 'Ordered list  ⌥⌘O', Task: 'Task list  ⌥⌘X' };
  for (let node = state.field(referenceIndex).tree.resolveInner(position, -1); node; node = node.parent!) {
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    const label = heading ? `${t('标题', 'Heading')} ${heading[1]}  ⌘${heading[1]}` : labels[node.name] && t(labels[node.name], english[node.name]);
    if (label && !found.includes(label)) found.push(label);
  }
  return found.slice(0, 2).join('   ·   ');
}
