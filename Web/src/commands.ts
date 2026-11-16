import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { t } from './localization';
import { orderedInsertionStart } from './ordered-lists';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { pendingListLine } from './markdown-input-state';

export function physicalFormatShortcut(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'metaKey' | 'altKey' | 'isComposing'>): string | null {
  // Pinyin keyboards can report “·” or “～” for this physical key. Do not bind a
  // text character or steal any composing, plain punctuation or other modifier chord.
  return event.code === 'Backquote' && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && !event.isComposing ? 'strike' : null;
}

export function formatTransaction(state: EditorState, action: string): TransactionSpec | null {
  const selection = state.selection.main;
  const { from, to } = selection;
  const selected = state.sliceDoc(from, to);
  const edit = (insert: string, anchor = from + insert.length, head = anchor): TransactionSpec => ({
    changes: { from, to, insert }, selection: EditorSelection.single(anchor, head), userEvent: 'input.format', scrollIntoView: true
  });
  const wrappers: Record<string, string> = { bold: '**', italic: '*', inlineCode: '`', strike: '~~' };
  if (wrappers[action]) {
    const wanted = { bold: 'StrongEmphasis', italic: 'Emphasis', inlineCode: 'InlineCode', strike: 'Strikethrough' }[action];
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 20) ?? syntaxTree(state);
    for (let node = tree.resolveInner(from, 1); node; ) {
      if (node.name === wanted && node.to >= to) {
        const marks = node.getChildren(action === 'inlineCode' ? 'CodeMark' : action === 'strike' ? 'StrikethroughMark' : 'EmphasisMark');
        const first = marks[0], last = marks.at(-1);
        const inner = first && last && from >= first.to && to <= last.from &&
          /^[*_~`]*$/.test(state.sliceDoc(first.to, from)) && /^[*_~`]*$/.test(state.sliceDoc(to, last.from));
        if (first && last && first !== last && (inner || from === node.from && to === node.to)) {
          const changes = state.changes([{ from: first.from, to: first.to, insert: '' }, { from: last.from, to: last.to, insert: '' }]);
          return { changes, selection: state.selection.map(changes, 1), userEvent: 'input.format', scrollIntoView: true };
        }
      }
      if (!node.parent) break; node = node.parent;
    }
    const mark = action === 'inlineCode' ? '`'.repeat(Math.max(1, ...[...selected.matchAll(/`+/g)].map(run => run[0].length + 1))) : wrappers[action];
    const pad = action === 'inlineCode' && (/^`|`$/.test(selected) || /^ .* $/.test(selected) && /\S/.test(selected)) ? ' ' : '';
    return edit(mark + pad + selected + pad + mark, from + mark.length + pad.length, to + mark.length + pad.length);
  }
  if (action === 'link' || action === 'image') {
    const label = selected || (action === 'image' ? t('图片', 'Image') : t('链接文字', 'Link text')), target = action === 'image' ? 'image.png' : 'https://';
    const prefix = `${action === 'image' ? '!' : ''}[${label}](`;
    return edit(prefix + target + ')', from + prefix.length, from + prefix.length + target.length);
  }
  if (action === 'codeBlock') {
    const fence = '`'.repeat(Math.max(3, ...[...selected.matchAll(/`+/g)].map(run => run[0].length + 1)));
    const [before, after] = blockBoundaries(state, from, to);
    const insert = before + fence + '\n' + selected + '\n' + fence + after;
    return edit(insert, from + before.length + fence.length + 1, from + before.length + fence.length + 1 + selected.length);
  }
  if (action === 'table') {
    const [before, after] = blockBoundaries(state, from, to), label = t('标题', 'Heading');
    const insert = before + `| ${label} | ${label} |\n| --- | --- |\n| ${t('内容', 'Content')} | ${t('内容', 'Content')} |` + (after || '\n\n');
    return edit(insert, from + before.length + 2, from + before.length + 2 + label.length);
  }
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
  const heading = /^heading([0-6])$/.exec(action);
  const underlines = new Map<number, { from: number; to: number; title: number }>();
  if (heading) syntaxTree(state).iterate({ from: first.from, to: last.to, enter(ref) {
    if (!/^SetextHeading/.test(ref.name)) return;
    const pending = state.field(pendingListLine, false);
    if (pending != null && pending >= ref.from && pending <= ref.to) return false;
    const mark = ref.node.getChild('HeaderMark');
    if (mark) {
      const line = state.doc.lineAt(mark.from);
      underlines.set(line.from, { from: line.from - 1, to: line.to, title: ref.from });
    }
    return false;
  } });
  let lines = Array.from({ length: last.number - first.number + 1 }, (_, i) => state.doc.line(first.number + i)).filter(line => !underlines.has(line.from));
  if (!lines.length && underlines.size) lines = [state.doc.lineAt(underlines.values().next().value!.title)];
  const parts = lines.map(line => {
    const container = /^(?:[ \t]*>[ \t]?)+[ \t]*/.exec(line.text)?.[0] ?? /^[ \t]*/.exec(line.text)![0];
    const list = /^(?:[-+*] \[[ xX]\][ \t]+|[-+*][ \t]+|\d{1,9}[.)][ \t]+)/.exec(line.text.slice(container.length))?.[0] ?? '';
    const at = container.length + list.length, title = /^#{1,6}(?:[ \t]+|$)/.exec(line.text.slice(at))?.[0] ?? '';
    return { line, container, list, title, at };
  });
  const kind = (list: string) => /^[-+*] \[[ xX]\]/.test(list) ? 'task' : /^[-+*]/.test(list) ? 'unordered' : list ? 'ordered' : '';
  const remove = parts.every(part => action === 'quote' ? /^(?:[ \t]*)>/.test(part.line.text) : kind(part.list) === action);
  const start = action === 'ordered' ? orderedInsertionStart(state, first.from) : 1;
  const changes: { from: number; to?: number; insert: string }[] = [];
  for (const [index, part] of parts.entries()) {
    const { line, container, title, at } = part;
    if (heading) {
      const level = Number(heading[1]);
      changes.push({ from: line.from + at, to: line.from + at + title.length, insert: level ? '#'.repeat(level) + ' ' : '' });
      if (level === 0 && title) {
        let node = syntaxTree(state).resolveInner(line.from + at, 1);
        while (node.parent && !/^ATXHeading/.test(node.name)) node = node.parent;
        const marks = node.getChildren('HeaderMark'), closing = marks.length > 1 ? marks.at(-1) : null;
        if (/^ATXHeading/.test(node.name) && closing) {
          let start = closing.from;
          while (start > line.from + at + title.length && /[ \t]/.test(state.sliceDoc(start - 1, start))) start--;
          changes.push({ from: start, to: node.to, insert: '' });
        }
      }
    }
    else if (action === 'quote') {
      const indent = /^[ \t]*/.exec(line.text)![0].length;
      changes.push({ from: line.from + indent, to: line.from + indent + (remove ? /^> ?/.exec(line.text.slice(indent))![0].length : 0), insert: remove ? '' : '> ' });
    } else if (['unordered', 'ordered', 'task'].includes(action)) {
      changes.push({ from: line.from + container.length, to: line.from + at + title.length,
        insert: remove ? '' : action === 'unordered' ? '- ' : action === 'ordered' ? `${start + index}. ` : '- [ ] ' });
    } else if (action === 'indent') changes.push({ from: line.from, insert: '  ' });
    else if (action === 'outdent') changes.push({ from: line.from, to: line.from + (/^(?: {1,2}|\t)/.exec(line.text)?.[0].length ?? 0), insert: '' });
    else return null;
  }
  let followsProse = false;
  if (first.number > 1) {
    const previous = state.doc.line(first.number - 1);
    let node = syntaxTree(state).resolveInner(previous.to, -1);
    while (node.parent && node.name !== 'Paragraph') node = node.parent;
    followsProse = !!previous.text.trim() && node.name === 'Paragraph' && node.parent?.name === 'Document';
  }
  if (['unordered', 'ordered', 'task'].includes(action) && !remove && followsProse && !parts[0].list) {
    const change = changes[0];
    if (change.from === first.from) change.insert = '\n' + change.insert;
    else changes.unshift({ from: first.from, insert: '\n' });
  }
  for (const underline of underlines.values()) changes.push({ from: underline.from, to: underline.to, insert: '' });
  changes.sort((a, b) => a.from - b.from);
  const changeSet = state.changes(changes);
  return { changes: changeSet, selection: state.selection.map(changeSet, 1), userEvent: 'input.format', scrollIntoView: true };
}

function blockBoundaries(state: EditorState, from: number, to: number): [string, string] {
  const before = state.sliceDoc(Math.max(0, from - 2), from), after = state.sliceDoc(to, Math.min(state.doc.length, to + 2));
  return [from === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n',
    to === state.doc.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'];
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
export function literalPattern(query: string): RegExp { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); }
