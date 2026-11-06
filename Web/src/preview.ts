import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderBlock, type ReferenceContext } from './renderer';
import { referenceIndex, refreshReferences } from './reference-context';
import { mappedCaretAtPoint } from './source-hit';

export const composingEffect = StateEffect.define<boolean>();
const viewportEffect = StateEffect.define<{ from: number; to: number }>();
export const composition = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(composingEffect)) value = effect.value;
    return value;
  }
});
const viewport = StateField.define<{ from: number; to: number }>({
  create: state => ({ from: 0, to: Math.min(state.doc.length, 6_000) }),
  update: (value, transaction) => {
    value = { from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to, 1) };
    for (const effect of transaction.effects) if (effect.is(viewportEffect)) value = effect.value;
    return value;
  }
});

class BlockWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly documentID: string,
              readonly context: ReferenceContext, readonly hydrate: (element: HTMLElement) => void) { super(); }
  eq(other: BlockWidget): boolean {
    return this.source === other.source && this.from === other.from && this.documentID === other.documentID && this.context === other.context;
  }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('section');
    element.className = 'markdown-block';
    element.dataset.sourceFrom = String(this.from);
    element.dataset.sourceLength = String(this.source.length);
    const node = view.state.field(referenceIndex).tree.topNode.childAfter(this.from);
    const syntax = node && node.from >= this.from && node.to <= this.from + this.source.length ? { node, from: this.from } : undefined;
    element.innerHTML = renderBlock(this.source, this.documentID, this.context, syntax);
    this.hydrate(element);
    return element;
  }
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest('a');
  }
}

export function previewBlockRanges(state: EditorState): { from: number; to: number; source: string }[] {
  const index = state.field(referenceIndex);
  const tree = index.tree;
  const range = state.field(viewport);
  const blocks = [];
  // Only visit top-level syntax nodes near the viewport; do not parse/render the whole Markdown on every keypress.
  for (let node = tree.topNode.childAfter(range.from); node && node.from <= range.to; node = node.nextSibling) {
    if (node.to <= node.from || node.name === 'LinkReference') continue;
    const from = state.doc.lineAt(node.from).from;
    const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
    if (state.selection.ranges.some(selection => selection.from <= to && selection.to >= from)) continue;
    const source = state.doc.sliceString(from, to);
    // Do not display stale/missing reference targets while a full syntax context is still being computed.
    if (!index.ready && source.includes('[')) continue;
    blocks.push({ from, to, source });
  }
  return blocks;
}

function decorations(state: EditorState, documentID: string, hydrate: (element: HTMLElement) => void): DecorationSet {
  const context = state.field(referenceIndex).context;
  const widgets = previewBlockRanges(state).map(({ from, to, source }) =>
    Decoration.replace({ widget: new BlockWidget(source, from, documentID, context, hydrate), block: true }).range(from, to));
  return Decoration.set(widgets, true);
}

/** Prefer verified text maps; unsupported/non-text output retains explicit boundary/line fallback. */
function renderedPosition(view: EditorView, target: EventTarget | null, point: { x: number; y: number }): number | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const block = element?.closest<HTMLElement>('.markdown-block[data-source-from]');
  if (!block || !view.contentDOM.contains(block)) return null;
  const from = Number(block.dataset.sourceFrom);
  const relativeLine = Number(element?.closest('[data-source-line]')?.getAttribute('data-source-line') ?? 0);
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(relativeLine)) return null;
  const hit = element && mappedCaretAtPoint(block, element, point);
  if (hit && from + hit.offset <= view.state.doc.length) return from + hit.offset;
  const line = Math.min(view.state.doc.lines, view.state.doc.lineAt(Math.min(from, view.state.doc.length)).number + Math.max(0, relativeLine));
  return view.state.doc.line(line).from;
}

const renderedSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || view.composing || view.state.field(composition) ||
      (event.target instanceof Element && event.target.closest('a'))) return null;
  let start = renderedPosition(view, event.target, { x: event.clientX, y: event.clientY });
  if (start === null) return null;
  let original = view.state.selection;
  let last = { x: event.clientX, y: event.clientY, position: start };
  return {
    get(current, extend) {
      const target = view.dom.ownerDocument.elementFromPoint(current.clientX, current.clientY);
      // Revealing source can change layout under a stationary pointer. Do not relocate a click on mouseup.
      const position = current === event ? start! : current.type === 'mouseup' && current.clientX === last.x && current.clientY === last.y ? last.position :
        renderedPosition(view, target, { x: current.clientX, y: current.clientY }) ?? view.posAtCoords({ x: current.clientX, y: current.clientY }, false) ?? start!;
      last = { x: current.clientX, y: current.clientY, position };
      return EditorSelection.single(extend ? original.main.anchor : start!, position);
    },
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start!);
        last.position = update.changes.mapPos(last.position);
        original = original.map(update.changes);
      }
    }
  };
});

export function blockPreview(documentID: string, hydrate: (element: HTMLElement) => void) {
  const field = StateField.define<DecorationSet>({
    create: state => decorations(state, documentID, hydrate),
    update: (value, transaction) => {
      if (transaction.state.field(composition)) return value.map(transaction.changes);
      if (transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(viewportEffect) || effect.is(composingEffect)) ||
          transaction.startState.field(referenceIndex) !== transaction.state.field(referenceIndex)) return decorations(transaction.state, documentID, hydrate);
      return value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const visible = ViewPlugin.fromClass(class {
    private frame = 0;
    constructor(readonly view: EditorView) { this.schedule(); }
    update() { this.schedule(); }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.view.composing || this.view.state.field(composition)) return;
        if (!this.view.state.field(referenceIndex).ready) {
          const before = this.view.state;
          forceParsing(this.view, this.view.state.doc.length, 5);
          if (this.view.state === before) this.view.dispatch({ effects: refreshReferences.of(null) });
          if (!this.view.state.field(referenceIndex).ready) this.schedule();
        }
        const current = this.view.state.field(viewport);
        const from = Math.max(0, this.view.viewport.from - 2_000);
        const to = Math.min(this.view.state.doc.length, this.view.viewport.to + 2_000);
        if (current.from > this.view.viewport.from || current.to < this.view.viewport.to ||
            Math.abs(current.from - from) > 500 || Math.abs(current.to - to) > 500) {
          this.view.dispatch({ effects: viewportEffect.of({ from, to }) });
        }
      });
    }
    destroy() { cancelAnimationFrame(this.frame); }
  });
  return [composition, viewport, referenceIndex, field, visible, renderedSelection, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
    compositionend: (_event, view) => {
      queueMicrotask(() => { if (!view.composing) view.dispatch({ effects: composingEffect.of(false) }); });
      return false;
    }
  })];
}
