import { Direction, EditorView, RectangleMarker, layer } from '@codemirror/view';
import type { StateField } from '@codemirror/state';
import { sourceMode } from './editor-preferences';

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

function imageBoundaryCaret(view: EditorView, position: number): RectangleMarker | undefined {
  const rect = imageBoundaryRect(view, position);
  if (!rect) return;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const baseX = (view.textDirection === Direction.LTR ? scroller.left : scroller.right - view.scrollDOM.clientWidth * view.scaleX) - view.scrollDOM.scrollLeft * view.scaleX;
  const baseY = scroller.top - view.scrollDOM.scrollTop * view.scaleY;
  return new RectangleMarker('wrapped-caret', rect.left - baseX, rect.top - baseY, null, rect.height);
}

/** WebKit can draw its native caret as tall as an entire wrapped line. Draw
 * just the collapsed caret at wrapped lines and the source edges of images.
 * Keep native range selection and hand the caret back to the IME when composing. */
export function wrappedCaret(composing: StateField<boolean>) {
  return [
    EditorView.editorAttributes.of(view => ({ class: view.composing || view.state.field(composing) ? 'markfine-composing' : '' })),
    layer({
      above: true,
      class: 'wrapped-caret-layer',
      update(update, dom) {
        if (update.selectionSet)
          dom.classList.toggle('wrapped-caret-blink-reset');
        return update.selectionSet || update.docChanged || update.geometryChanged || update.viewportChanged ||
          update.focusChanged || update.startState.field(sourceMode) !== update.state.field(sourceMode) ||
          update.startState.field(composing) !== update.state.field(composing);
      },
      markers(view) {
        const state = view.state, selection = state.selection.main;
        if (!selection.empty || state.field(sourceMode) || selection.head < view.viewport.from || selection.head > view.viewport.to)
          return [];
        const imageCaret = imageBoundaryCaret(view, selection.head);
        if (imageCaret) return [imageCaret];
        const { node } = view.domAtPos(selection.head, selection.assoc || 1);
        const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
        if (!line || !view.contentDOM.contains(line)) return [];
        const lineStyle = getComputedStyle(line);
        const rowHeight = parseFloat(lineStyle.lineHeight);
        const padding = parseFloat(lineStyle.paddingTop) + parseFloat(lineStyle.paddingBottom);
        if (!(rowHeight > 0 && line.getBoundingClientRect().height / view.scaleY - padding > rowHeight * 1.5))
          return [];
        const marker = RectangleMarker.forRange(view, 'wrapped-caret', selection)[0];
        if (!marker || !(marker.height > 0)) return [];
        const maxHeight = rowHeight * view.scaleY;
        if (marker.height <= maxHeight + 1) return [marker];
        // At a wrap boundary keep the caret's x-position and use the neighboring
        // glyph on the side chosen by CodeMirror for the vertical extent.
        const logicalLine = state.doc.lineAt(selection.head);
        const neighbor = selection.assoc < 0 ? selection.head - 1 : selection.head;
        const glyph = neighbor >= logicalLine.from && neighbor < logicalLine.to ? view.coordsForChar(neighbor) : null;
        const origin = view.scrollDOM.getBoundingClientRect().top - view.scrollDOM.scrollTop * view.scaleY;
        const height = glyph ? Math.min(maxHeight, glyph.bottom - glyph.top) : maxHeight;
        const top = glyph && height > 0 ? glyph.top - origin : marker.top;
        return [new RectangleMarker('wrapped-caret', marker.left, top, null, height > 0 ? height : maxHeight)];
      },
    }),
  ];
}
