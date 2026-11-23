import { Direction, EditorView, RectangleMarker, layer } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { sourceMode } from './editor-preferences';

export const composingEffect = StateEffect.define<boolean>();
export const composition = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(composingEffect)) value = effect.value;
    return value;
  }
});

/** Use the source glyph, not the preview widget adjacent to the source end.
 * Caret drawing and caret-driven scrolling must agree on this coordinate. */
export function imageBoundaryRect(view: EditorView, position: number): DOMRect | undefined {
  if (view.state.field(sourceMode, false) !== false) return;
  for (const side of [-1, 1] as const) {
    const char = side < 0 ? position - 1 : position;
    if (char < 0 || char >= view.state.doc.length) continue;
    // domAtPos at the boundary can refer to the preview element. Resolve the
    // glyph itself, then check the edge of its reference span in the source.
    const dom = view.domAtPos(char, 1);
    const reference = (dom.node instanceof Element ? dom.node : dom.node.parentElement)?.closest('.image-reference');
    if (!reference || view.posAtDOM(reference, side < 0 ? reference.childNodes.length : 0) !== position) continue;
    const glyph = view.coordsForChar(char);
    if (!glyph || !(glyph.bottom > glyph.top)) continue;
    const caret = view.coordsAtPos(position, side);
    const x = caret && Math.abs(caret.top - glyph.top) < 2 && caret.bottom - caret.top < glyph.bottom - glyph.top + 3
      ? caret.left : side < 0 ? glyph.right : glyph.left;
    return new DOMRect(x, glyph.top, 0, glyph.bottom - glyph.top);
  }
}

function caretRect(view: EditorView): DOMRect | undefined {
  const selection = view.state.selection.main;
  const { head, assoc } = selection, side = assoc < 0 ? -1 : 1;
  const image = imageBoundaryRect(view, head);
  if (image) return image;
  const caret = view.coordsAtPos(head, side);
  if (!caret || caret.bottom <= caret.top) return;
  const { node } = view.domAtPos(head, side);
  const element = node instanceof Element ? node : node.parentElement;
  const line = element?.closest('.cm-line');
  if (!line || !view.contentDOM.contains(line) || line.classList.contains('image-source-collapsed')) return;
  const rowHeight = parseFloat(getComputedStyle(element ?? line).lineHeight) * view.scaleY;
  if (!(rowHeight > 0 && caret.bottom - caret.top > rowHeight + 1))
    return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);

  // WebKit sometimes reports the height of the whole wrapped logical line.
  // Use the neighboring glyph on the selected side to locate the visual row.
  const logicalLine = view.state.doc.lineAt(head);
  const neighbor = side < 0 || head === logicalLine.to ? head - 1 : head;
  const glyph = neighbor >= logicalLine.from && neighbor < logicalLine.to ? view.coordsForChar(neighbor) : null;
  return new DOMRect(caret.left, glyph && glyph.bottom > glyph.top ? glyph.top : caret.top, 0,
    glyph && glyph.bottom > glyph.top ? Math.min(rowHeight, glyph.bottom - glyph.top) : rowHeight);
}

/** Share the paragraph-sized collapsed caret without replacing native selections or IME UI. */
export function editorCaret() {
  return [
    composition,
    EditorView.domEventHandlers({
      compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
      compositionend: (_event, view) => {
        queueMicrotask(() => { if (!view.composing) view.dispatch({ effects: composingEffect.of(false) }); });
        return false;
      }
    }),
    EditorView.editorAttributes.of(view => ({ class: view.composing || view.state.field(composition) ? 'markfine-composing' : '' })),
    layer({
      above: true,
      class: 'editor-caret-layer',
      update(update, dom) {
        if (update.selectionSet) dom.classList.toggle('editor-caret-blink-reset');
        return update.selectionSet || update.docChanged || update.geometryChanged || update.viewportChanged ||
          update.focusChanged || update.startState.readOnly !== update.state.readOnly ||
          update.startState.field(sourceMode, false) !== update.state.field(sourceMode, false) ||
          update.startState.field(composition) !== update.state.field(composition);
      },
      markers(view) {
        const state = view.state, selection = state.selection.main;
        if (view.root.activeElement !== view.contentDOM || state.readOnly || !view.contentDOM.isContentEditable ||
            view.composing || state.field(composition) || !selection.empty ||
            selection.head < view.viewport.from || selection.head > view.viewport.to)
          return [];
        const rect = caretRect(view);
        if (!rect) return [];
        const scroller = view.scrollDOM.getBoundingClientRect();
        const baseX = (view.textDirection === Direction.LTR ? scroller.left : scroller.right - view.scrollDOM.clientWidth * view.scaleX) - view.scrollDOM.scrollLeft * view.scaleX;
        const baseY = scroller.top - view.scrollDOM.scrollTop * view.scaleY;
        // The zero-height marker anchors its center; CSS supplies the same
        // paragraph caret height regardless of the underlying text style.
        return [new RectangleMarker('editor-caret', rect.left - baseX, rect.top + rect.height / 2 - baseY, null, 0)];
      },
    }),
  ];
}
