import { Annotation, EditorState, Transaction, countColumn, type ChangeSpec, type Text, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';

type Node = ReturnType<typeof syntaxTree>['topNode'];
interface Item { node: Node; from: number; to: number; number: number }
const explicitNumbering = Annotation.define<boolean>();
const protectedBlock = /^(FencedCode|CodeBlock|Table|CommentBlock|Comment|HTMLBlock)$/;
const maximumNumber = 999_999_999; // CommonMark ordered markers have at most nine digits.

function items(list: Node, doc: Text): Item[] {
  return list.getChildren('ListItem').flatMap(node => {
    const marker = node.getChild('ListMark');
    const value = marker && /^(\d{1,9})[.)]$/.exec(doc.sliceString(marker.from, marker.to));
    return marker && value ? [{ node, from: marker.from, to: marker.to - 1, number: Number(value[1]) }] : [];
  });
}

function enclosingLists(node: Node | null): Node[] {
  const result: Node[] = [];
  for (; node; node = node.parent) {
    if (protectedBlock.test(node.name)) return [];
    if (node.name === 'OrderedList') result.push(node);
  }
  return result;
}

function nearbyLists(state: EditorState, from: number, to = from): Node[] {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 20) ?? syntaxTree(state);
  const result = new Map<string, Node>();
  for (const position of [from, to]) for (const side of [-1, 1] as const) {
    for (const node of enclosingLists(tree.resolveInner(position, side))) result.set(`${node.from}:${node.to}`, node);
  }
  const after = tree.topNode.childAfter(to);
  if (after && after.from > to && !/\S/.test(state.sliceDoc(to, after.from))) {
    for (const node of enclosingLists(after)) result.set(`${node.from}:${node.to}`, node);
  }
  return [...result.values()];
}

/** Only a real list marker is actionable; numbers in prose, comments and code are not. */
export function orderedMarkerAt(state: EditorState, position: number): Node | null {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, position + 1), 20) ?? syntaxTree(state);
  for (const side of [1, -1] as const) {
    let node: Node | null = tree.resolveInner(position, side);
    while (node && node.name !== 'ListItem') { if (protectedBlock.test(node.name)) break; node = node.parent; }
    const marker = node?.name === 'ListItem' && node.parent?.name === 'OrderedList' ? node.getChild('ListMark') : null;
    if (marker && position >= marker.from && position <= marker.to) return node!.parent;
  }
  return null;
}

function precedingList(list: Node): Node | null {
  for (let node = list.prevSibling; node; node = node.prevSibling) if (node.name === 'OrderedList') return node;
  return null;
}
export function continuedStart(state: EditorState, list: Node): number | null {
  const previous = precedingList(list);
  const before = previous && items(previous, state.doc);
  if (!before?.length) return null;
  const start = before[0].number + before.length;
  return start <= maximumNumber ? start : null;
}

/** The slash/format command only joins a directly preceding top-level list across blank lines. */
export function orderedInsertionStart(state: EditorState, position: number): number {
  const tree = ensureSyntaxTree(state, position, 20) ?? syntaxTree(state);
  const before = tree.topNode.childBefore(position);
  if (!before || before.name !== 'OrderedList' || /\S/.test(state.sliceDoc(before.to, position))) return 1;
  const entries = items(before, state.doc), start = entries.length ? entries[0].number + entries.length : 1;
  return start <= maximumNumber ? start : 1;
}

function indentation(line: string): { from: number; text: string } {
  const quotes = /^(?:[ \t]*>[ \t]?)+/.exec(line)?.[0] ?? '';
  return { from: quotes.length, text: /^[ \t]*/.exec(line.slice(quotes.length))![0] };
}

/** Keep an item's continuation blocks attached when its marker gains or loses a digit. */
function indentItem(doc: Text, item: Item, delta: number, shifts: Map<number, number>, map = (at: number) => at): void {
  if (!delta) return;
  const first = doc.lineAt(item.from), before = indentation(first.text);
  const gap = /^[ \t]*/.exec(doc.sliceString(item.to + 1, first.to))![0];
  const column = countColumn(doc.sliceString(first.from + before.from, item.to + 1) + gap, 4);
  for (let number = first.number + 1; number <= doc.lineAt(Math.max(item.node.from, item.node.to - 1)).number; number++) {
    const line = doc.line(number), prefix = indentation(line.text);
    if (!line.text.trim() || countColumn(prefix.text, 4) < column) continue; // Leave lazy continuation text alone.
    const at = map(line.from);
    shifts.set(at, (shifts.get(at) ?? 0) + delta);
  }
}
function indentChanges(doc: Text, shifts: Map<number, number>): ChangeSpec[] {
  return [...shifts].flatMap(([at, delta]) => {
    if (!delta || at > doc.length) return [];
    const line = doc.lineAt(at), prefix = indentation(line.text);
    if (line.from !== at || !line.text.trim()) return [];
    const width = countColumn(prefix.text, 4) + delta;
    return width >= 0 ? [{ from: at + prefix.from, to: at + prefix.from + prefix.text.length, insert: ' '.repeat(width) }] : [];
  });
}
function numberedChanges(state: EditorState, list: Node, start: number, sharedShifts?: Map<number, number>): ChangeSpec[] {
  const entries = items(list, state.doc);
  if (!entries.length || start < 0 || start + entries.length - 1 > maximumNumber) return [];
  const shifts = sharedShifts ?? new Map<number, number>(), changes: ChangeSpec[] = [];
  entries.forEach((item, index) => {
    const number = String(start + index), old = state.sliceDoc(item.from, item.to);
    if (old !== number) {
      changes.push({ from: item.from, to: item.to, insert: number });
      indentItem(state.doc, item, number.length - old.length, shifts);
    }
  });
  return sharedShifts ? changes : [...changes, ...indentChanges(state.doc, shifts)];
}

export function listNumberingTransaction(state: EditorState, position: number, action: 'restart' | 'continue'): TransactionSpec | null {
  if (state.readOnly) return null;
  const list = orderedMarkerAt(state, position); if (!list) return null;
  const start = action === 'restart' ? 1 : continuedStart(state, list); if (start === null) return null;
  const changes = numberedChanges(state, list, start); if (!changes.length) return null;
  return { changes, userEvent: 'input.listNumber', annotations: [explicitNumbering.of(true), isolateHistory.of('full')] };
}

function structuralChange(transaction: Transaction, from: number, to: number, newFrom: number, newTo: number): boolean {
  if (transaction.startState.doc.lineAt(from).number !== transaction.startState.doc.lineAt(to).number ||
      transaction.newDoc.lineAt(newFrom).number !== transaction.newDoc.lineAt(newTo).number) return true;
  // Plain text input inside an existing item must not silently tidy imported numbering.
  const touchesMarker = (state: EditorState, from: number, to: number) => {
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 20) ?? syntaxTree(state);
    for (const position of [from, to]) for (const side of [-1, 1] as const) {
      for (let node: Node | null = tree.resolveInner(position, side); node; node = node.parent) {
        if (protectedBlock.test(node.name)) break;
        if (node.name !== 'ListItem' || node.parent?.name !== 'OrderedList') continue;
        const marker = node.getChild('ListMark'); if (marker && from <= marker.to + 1 && to >= marker.from) return true;
      }
    }
    return false;
  };
  return touchesMarker(transaction.startState, from, to) || touchesMarker(transaction.state, newFrom, newTo);
}

/** Incremental, affected-list-only repair, folded into the user's original undo transaction. */
export function orderedListEditing(composing: (state: EditorState) => boolean = () => false) {
  return EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || transaction.startState.readOnly || transaction.annotation(explicitNumbering) ||
        transaction.annotation(Transaction.addToHistory) === false || transaction.isUserEvent('input.type.compose') ||
        composing(transaction.startState) || !(transaction.isUserEvent('input') || transaction.isUserEvent('delete'))) return transaction;
    const ranges: { from: number; to: number; newFrom: number; newTo: number }[] = [];
    transaction.changes.iterChangedRanges((from, to, newFrom, newTo) => {
      if (structuralChange(transaction, from, to, newFrom, newTo)) ranges.push({ from, to, newFrom, newTo });
    });
    if (!ranges.length) return transaction;
    const oldLists = new Map<string, Node>();
    for (const range of ranges) for (const list of nearbyLists(transaction.startState, range.from, range.to)) oldLists.set(`${list.from}:${list.to}`, list);

    // CodeMirror's Return command already changes later digits. Adjust their original
    // continuation indentation *before* parsing the new list structure (9 → 10, etc.).
    const shifts = new Map<number, number>();
    for (const list of oldLists.values()) for (const item of items(list, transaction.startState.doc)) {
      const from = transaction.changes.mapPos(item.from, -1);
      const marker = /^(\d{1,9})[.)](?:\s|$)/.exec(transaction.newDoc.sliceString(from, Math.min(transaction.newDoc.length, from + 11)));
      const deleted = ranges.some(range => range.from <= item.node.from && range.to >= item.node.to);
      if (!deleted && marker) {
        let digits = marker[1].length;
        const line = transaction.startState.doc.lineAt(item.from), prefix = transaction.startState.sliceDoc(line.from, item.from);
        // Splitting the item's first line moves its later blocks under the newly
        // inserted sibling. Its width, not the old marker's width, owns that indent.
        for (const range of ranges) {
          if (range.from < item.to + 1 || range.from > line.to || transaction.newDoc.lineAt(range.newFrom).number === transaction.newDoc.lineAt(range.newTo).number) continue;
          const inserted = /^([ \t>]*)(\d{1,9})([.)])(?:[ \t]|$)/.exec(transaction.newDoc.lineAt(range.newTo).text);
          if (inserted && inserted[1] === prefix && inserted[3] === transaction.startState.sliceDoc(item.to, item.to + 1)) digits = inserted[2].length;
        }
        indentItem(transaction.startState.doc, item, digits - (item.to - item.from), shifts, at => transaction.changes.mapPos(at, 1));
      }
    }
    const alignment = indentChanges(transaction.newDoc, shifts);
    const aligned = alignment.length ? transaction.state.update({ changes: alignment, filter: false }) : null;
    const state = aligned?.state ?? transaction.state;
    const lists = new Map<string, Node>();
    for (const range of ranges) {
      const from = aligned ? aligned.changes.mapPos(range.newFrom) : range.newFrom;
      const to = aligned ? aligned.changes.mapPos(range.newTo, 1) : range.newTo;
      for (const list of nearbyLists(state, from, to)) lists.set(`${list.from}:${list.to}`, list);
    }
    const changes: ChangeSpec[] = [], normalizationShifts = new Map<number, number>();
    for (const list of lists.values()) {
      const entries = items(list, state.doc); if (!entries.length) continue;
      let start = entries[0].number;
      for (const old of oldLists.values()) {
        const before = items(old, transaction.startState.doc), first = before[0];
        if (!first || !ranges.some(range => range.from <= first.node.from && range.to >= first.node.to)) continue;
        // Removing the first item retains the original start; a new list created by
        // splitting or explicitly editing its first marker retains its own start.
        const survivor = before.slice(1).find(item => !ranges.some(range => range.from <= item.node.from && range.to >= item.node.to));
        if (!survivor) continue;
        const mapped = transaction.changes.mapPos(survivor.from, -1);
        if ((aligned ? aligned.changes.mapPos(mapped) : mapped) === entries[0].from) { start = first.number; break; }
      }
      changes.push(...numberedChanges(state, list, start, normalizationShifts));
    }
    changes.push(...indentChanges(state.doc, normalizationShifts));
    return alignment.length || changes.length ? [transaction, { changes: alignment, sequential: true }, { changes, sequential: true }] : transaction;
  });
}
