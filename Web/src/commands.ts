import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

export function formatTransaction(state: EditorState, action: string): TransactionSpec | null {
  const selection = state.selection.main;
  const { from, to } = selection;
  const selected = state.sliceDoc(from, to);
  const edit = (insert: string, anchor = from + insert.length, head = anchor): TransactionSpec => ({
    changes: { from, to, insert }, selection: EditorSelection.single(anchor, head), userEvent: 'input.format', scrollIntoView: true
  });
  const wrappers: Record<string, string> = { bold: '**', italic: '*', inlineCode: '`', strike: '~~' };
  if (wrappers[action]) {
    const mark = wrappers[action];
    if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= mark.length * 2) return edit(selected.slice(mark.length, -mark.length), from, to - mark.length * 2);
    if (from >= mark.length && state.sliceDoc(from - mark.length, from) === mark && state.sliceDoc(to, to + mark.length) === mark) {
      return { changes: [{ from: from - mark.length, to: from, insert: '' }, { from: to, to: to + mark.length, insert: '' }],
        selection: EditorSelection.single(from - mark.length, to - mark.length), userEvent: 'input.format', scrollIntoView: true };
    }
    return edit(mark + selected + mark, from + mark.length, to + mark.length);
  }
  if (action === 'link' || action === 'image') {
    const label = selected || (action === 'image' ? '图片' : '链接文字'), target = action === 'image' ? 'image.png' : 'https://';
    const prefix = `${action === 'image' ? '!' : ''}[${label}](`;
    return edit(prefix + target + ')', from + prefix.length, from + prefix.length + target.length);
  }
  if (action === 'codeBlock') {
    const insert = '```\n' + selected + '\n```';
    return edit(insert, from + 4, from + 4 + selected.length);
  }
  if (action === 'table') return edit('\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n');
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
  const lines = state.sliceDoc(first.from, last.to).split('\n');
  const heading = /^heading([0-6])$/.exec(action);
  let changed: string[];
  if (heading) {
    const level = Number(heading[1]);
    changed = lines.map(line => (level ? '#'.repeat(level) + ' ' : '') + line.replace(/^ {0,3}#{1,6}\s+/, ''));
  } else if (['quote', 'unordered', 'ordered', 'task'].includes(action)) {
    const pattern = action === 'quote' ? /^> ?/ : action === 'unordered' ? /^[-+*] / : action === 'ordered' ? /^\d+\. / : /^[-+*] \[[ xX]\] /;
    const remove = lines.every(line => pattern.test(line));
    changed = lines.map((line, index) => remove ? line.replace(pattern, '') :
      (action === 'quote' ? '> ' : action === 'unordered' ? '- ' : action === 'ordered' ? `${index + 1}. ` : '- [ ] ') + line);
  } else if (action === 'indent') changed = lines.map(line => '  ' + line);
  else if (action === 'outdent') changed = lines.map(line => line.replace(/^(?: {1,2}|\t)/, ''));
  else return null;
  const insert = changed.join('\n');
  return { changes: { from: first.from, to: last.to, insert }, selection: EditorSelection.single(first.from, first.from + insert.length), userEvent: 'input.format', scrollIntoView: true };
}

export function findMatch(text: string, query: string, start: number, backwards = false): { from: number; to: number } | null {
  if (!query) return null;
  const pattern = literalPattern(query);
  if (!backwards) {
    pattern.lastIndex = Math.max(0, start);
    let match = pattern.exec(text);
    if (!match) { pattern.lastIndex = 0; match = pattern.exec(text); }
    return match ? { from: match.index, to: match.index + match[0].length } : null;
  }
  let previous: RegExpExecArray | null = null, last: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) { last = match; if (match.index < start) previous = match; }
  const match = previous ?? last;
  return match ? { from: match.index, to: match.index + match[0].length } : null;
}
export function replacementChanges(text: string, query: string, replacement: string): { from: number; to: number; insert: string }[] {
  if (!query) return [];
  return [...text.matchAll(literalPattern(query))].map(match => ({ from: match.index, to: match.index + match[0].length, insert: replacement }));
}
function literalPattern(query: string): RegExp { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); }
