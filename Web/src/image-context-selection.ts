import { EditorState, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** The native secondary click can re-anchor its DOM selection at the end of
 * an image block even after pointerdown/mousedown have been cancelled. */
export class ImageContextSelection {
  private active?: {
    view: EditorView;
    doc: EditorState['doc'];
    left: number;
    top: number;
    native?: { anchor: Node; anchorOffset: number; focus: Node; focusOffset: number };
  };
  private timer = 0;
  readonly filter = EditorState.transactionFilter.of(tr => this.blocks(tr) ? [] : tr);

  constructor(private readonly view: () => EditorView | null) {
    document.addEventListener('pointerdown', () => this.clear(), true);
    document.addEventListener('wheel', () => this.clear(), { capture: true, passive: true });
    document.addEventListener('keydown', () => this.clear(), true);
    document.addEventListener('beforeinput', () => this.clear(), true);
    document.addEventListener('compositionstart', () => this.clear(), true);
    document.addEventListener('selectstart', event => {
      const active = this.current();
      if (active && event.target instanceof Node && active.view.contentDOM.contains(event.target)) event.preventDefault();
    }, true);
    document.addEventListener('selectionchange', () => this.repair(), true);
  }

  begin(): void {
    const view = this.view();
    if (!view || view.composing) return;
    if (this.current()?.view !== view) {
      const selection = view.dom.ownerDocument.getSelection();
      const anchor = selection?.anchorNode, focus = selection?.focusNode;
      const native = selection && anchor && focus && view.contentDOM.contains(anchor) && view.contentDOM.contains(focus)
        ? { anchor, anchorOffset: selection.anchorOffset, focus, focusOffset: selection.focusOffset }
        : undefined;
      this.active = { view, doc: view.state.doc, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, native };
    }
    clearTimeout(this.timer); this.timer = window.setTimeout(() => this.clear(), 500);
  }

  protectMenu(): void {
    this.begin();
    this.repair();
    const active = this.current();
    if (active) this.restoreScroll(active);
  }

  private current() {
    const active = this.active;
    return active && active.view === this.view() && active.view.state.doc === active.doc ? active : undefined;
  }

  private blocks(tr: Transaction): boolean {
    const active = this.current();
    return !!active && active.view.state === tr.startState && !tr.docChanged && !!tr.selection && tr.isUserEvent('select');
  }

  private repair(): void {
    const active = this.current(), saved = active?.native;
    if (!active || !saved || document.activeElement !== active.view.contentDOM ||
        !active.view.contentDOM.contains(saved.anchor) || !active.view.contentDOM.contains(saved.focus)) return;
    const selection = document.getSelection();
    if (!selection || selection.anchorNode === saved.anchor && selection.anchorOffset === saved.anchorOffset &&
        selection.focusNode === saved.focus && selection.focusOffset === saved.focusOffset) return;
    try {
      selection.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset);
      this.restoreScroll(active);
    } catch { /* The editor's selection transaction is still guarded if DOM nodes changed. */ }
  }

  private restoreScroll(active: NonNullable<ImageContextSelection['active']>): void {
    const scroller = active.view.scrollDOM;
    if (scroller.scrollLeft !== active.left || scroller.scrollTop !== active.top)
      scroller.scrollTo({ left: active.left, top: active.top, behavior: 'instant' });
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.active = undefined;
  }
}
