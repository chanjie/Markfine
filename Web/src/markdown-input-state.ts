import { Annotation, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { sourceMode } from './editor-preferences';

export const tableCellWriteback = Annotation.define<boolean>();
export const finishTableConstruction = StateEffect.define<null>();

/** Keep newly recognized or extended table syntax editable until the writer leaves its source.
 * Replacing a still-being-typed delimiter row removes WebKit's native insertion
 * node and can reset the DOM selection to the beginning of the document. */
export const tableConstruction = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some(effect => effect.is(finishTableConstruction))) return null;
    const head = tr.state.selection.main.head;
    if (value) {
      value = { from: tr.changes.mapPos(value.from), to: tr.changes.mapPos(value.to, 1) };
      const line = tr.newDoc.lineAt(head);
      if (head < value.from || head > value.to || tr.docChanged && !line.text && line.number > 1 && !tr.newDoc.line(line.number - 1).text.trim()) value = null;
      if (value) return value;
    }
    if (!tr.docChanged || tr.annotation(tableCellWriteback) || tr.startState.field(sourceMode, false) || !tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose')) return value;
    let table = syntaxTree(tr.state).resolveInner(head, -1);
    while (table.parent && table.name !== 'Table') table = table.parent;
    if (table.name !== 'Table') return null;
    const oldPosition = tr.changes.invertedDesc.mapPos(table.from, 1);
    let previous = syntaxTree(tr.startState).resolveInner(Math.min(tr.startState.doc.length, oldPosition + 1), 1);
    while (previous.parent && previous.name !== 'Table') previous = previous.parent;
    if (previous.name !== 'Table') return { from: table.from, to: table.to };
    // The first character on a line after an existing table is also a GFM row.
    // Replacing that new native text node with the old table's widget would
    // redirect the following keystrokes. Edits inside an existing cell retain
    // their normal child editor instead of entering construction presentation.
    let extendsFromOutside = false;
    tr.changes.iterChanges(from => {
      if (from > previous.to && tr.startState.doc.lineAt(from).number > tr.startState.doc.lineAt(previous.to).number) extendsFromOutside = true;
    });
    return extendsFromOutside ? { from: table.from, to: table.to } : null;
  }
});

/** Shared transient input intent, independent of format-command implementation. */
export const pendingListLine = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (value !== null) {
      value = tr.changes.mapPos(value);
      const line = tr.newDoc.lineAt(Math.min(value, tr.newDoc.length));
      if (line.from !== value || !/^ {0,3}-[ \t]*$/.test(line.text)) value = null;
    }
    const editing = tr.isUserEvent('delete') || tr.isUserEvent('undo') || tr.isUserEvent('redo');
    if (!tr.docChanged || tr.startState.field(sourceMode, false) || !(tr.isUserEvent('input.type') || editing) || tr.isUserEvent('input.type.compose')) return value;
    tr.changes.iterChanges((from, to, newFrom, _newTo, inserted) => {
      const typedDash = from === to && inserted.toString() === '-';
      if (!typedDash && !editing) return;
      const before = tr.startState.doc.lineAt(from), line = tr.newDoc.lineAt(newFrom);
      if (typedDash && before.text.trim() || before.number < 2 || !/^ {0,3}-$/.test(line.text)) return;
      const previous = tr.startState.doc.line(before.number - 1);
      let node = syntaxTree(tr.startState).resolveInner(previous.to, -1);
      while (node.parent && node.name !== 'Paragraph' && !/^SetextHeading/.test(node.name)) node = node.parent;
      if (node.name === 'Paragraph' && node.parent?.name === 'Document' || editing && node.name === 'SetextHeading2') value = line.from;
    });
    return value;
  }
});
