import { RangeSet, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

// Include a bullet replacement that starts exactly at the first source character.
const listPrefix = Decoration.mark({ class: 'live-list-prefix', inclusiveStart: true });

/** Measure the real first-line prefix, including nested whitespace and any rendered bullet/checkbox. */
export function listWrapPrefix(state: EditorState, body: SyntaxNode) {
  const marker = body.prevSibling;
  if (marker?.name !== 'ListMark' || body.parent?.name !== 'ListItem') return null;
  const line = state.doc.lineAt(marker.from);
  if (body.from >= line.to) return null;
  const checkbox = body.name === 'Task' ? body.getChild('TaskMarker') : null;
  const end = checkbox ? checkbox.to + (/^[ \t]*/.exec(state.sliceDoc(checkbox.to, line.to))?.[0].length ?? 0) : body.from;
  return end < line.to ? listPrefix.range(line.from, end) : null;
}

const listIndents = StateEffect.define<DecorationSet>();
const indents = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(listIndents)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field)
});

export function listWrap(composing: StateField<boolean>) {
  return [indents, ViewPlugin.fromClass(class {
    private prefixes = new Set<Element>();
    private widths = new WeakMap<Element, number>();
    private pending = false;
    private scanNeeded = false;
    private destroyed = false;
    private observer = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries) {
        // The editor may be hidden while reading. Keep the last visible size.
        if (contentRect.width > 0) this.widths.set(target, contentRect.width);
      }
      this.schedule();
    });

    constructor(readonly view: EditorView) { this.docViewUpdate(); }

    update(update: ViewUpdate) {
      if (update.startState.field(composing) && !update.state.field(composing)) this.schedule();
    }

    docViewUpdate() {
      this.scanNeeded = true;
      this.schedule();
    }

    private schedule() {
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        if (this.destroyed) return;
        // CodeMirror creates plugins before mounting a new document's line DOM.
        if (this.scanNeeded) {
          const prefixes = new Set(this.view.contentDOM.querySelectorAll(':scope > .cm-line > .live-list-prefix'));
          for (const prefix of this.prefixes) if (!prefixes.has(prefix)) this.observer.unobserve(prefix);
          for (const prefix of prefixes) if (!this.prefixes.has(prefix)) this.observer.observe(prefix);
          this.prefixes = prefixes;
          this.scanNeeded = false;
        }
        if (this.view.composing || this.view.state.field(composing)) return;
        const ranges = [];
        for (const prefix of this.prefixes) {
          const width = this.widths.get(prefix);
          if (width !== undefined && prefix.parentElement) ranges.push(Decoration.line({
            attributes: { style: `--list-hanging-indent:${width.toFixed(3)}px` }
          }).range(this.view.posAtDOM(prefix.parentElement)));
        }
        const next = Decoration.set(ranges, true);
        if (!RangeSet.eq([this.view.state.field(indents)], [next])) this.view.dispatch({ effects: listIndents.of(next) });
      });
    }

    destroy() { this.destroyed = true; this.observer.disconnect(); }
  })];
}
