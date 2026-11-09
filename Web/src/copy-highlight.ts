import type { EditorView } from '@codemirror/view';
import { tableTextViews } from './table-editor';

interface TextRect { left: number; top: number; right: number; bottom: number }
const bounds = (element: HTMLElement): TextRect => {
  const rect = element.getBoundingClientRect(), left = rect.left + element.clientLeft, top = rect.top + element.clientTop;
  return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
};
function intersect(a: TextRect, b: TextRect): TextRect | null {
  const rect = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return rect.right - rect.left > .5 && rect.bottom - rect.top > 1 ? rect : null;
}

/** Inline decorations can return overlapping boxes; paint each part of a text line only once. */
export function mergeCopyRects(rects: readonly TextRect[]): TextRect[] {
  const rows: TextRect[] = [];
  for (const rect of rects) {
    let current = { ...rect };
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i], overlap = Math.min(row.bottom, current.bottom) - Math.max(row.top, current.top);
      if (overlap < Math.min(row.bottom - row.top, current.bottom - current.top) * .6 || current.left > row.right + 1 || current.right < row.left - 1) continue;
      current = { left: Math.min(row.left, current.left), top: Math.min(row.top, current.top), right: Math.max(row.right, current.right), bottom: Math.max(row.bottom, current.bottom) };
      rows.splice(i, 1);
    }
    rows.push(current);
  }
  return rows;
}

function textRects(view: EditorView, from: number, to: number, clip: TextRect): TextRect[] {
  if (!intersect(view.contentDOM.getBoundingClientRect(), clip)) return [];
  const rects: TextRect[] = [], doc = view.contentDOM.ownerDocument;
  // Read actual visible source text without selecting it or rewriting CodeMirror's DOM.
  const walker = doc.createTreeWalker(view.contentDOM, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node instanceof Element ? (node.matches('.live-table,.markdown-block,.syntax-marker,.link-syntax:not(.expanded),.cm-widgetBuffer,.list-bullet,button,[aria-hidden=true]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT
  });
  let node: Node | null, visited = 0;
  while ((node = walker.nextNode()) && visited++ < 5_000 && rects.length < 1_024) {
    if (!node.textContent?.length) continue;
    const start = view.posAtDOM(node, 0), end = view.posAtDOM(node, node.textContent.length);
    if (end - start !== node.textContent.length || start >= to || end <= from) continue;
    const range = doc.createRange(); range.setStart(node, Math.max(0, from - start)); range.setEnd(node, Math.min(end, to) - start);
    for (const rect of range.getClientRects()) { const visible = intersect(rect, clip); if (visible) rects.push(visible); }
  }
  return rects;
}

/** A short-lived, viewport-clipped visual receipt, never an editor or DOM selection. */
export class CopyHighlight {
  private element?: HTMLElement;
  private timer = 0;
  private events?: AbortController;

  show(view: EditorView, range: { from: number; to: number }): void {
    this.clear();
    // Feedback is best-effort: a disappearing DOM node must not turn a successful copy into an error.
    try { this.paint(view, range); } catch { this.clear(); }
  }

  private paint(view: EditorView, range: { from: number; to: number }): void {
    const clip = bounds(view.scrollDOM), rects = textRects(view, range.from, range.to, clip);
    for (const target of tableTextViews(view, range.from, range.to)) {
      const scroll = target.view.dom.closest<HTMLElement>('.table-scroll');
      const cellClip = scroll && intersect(clip, bounds(scroll));
      if (cellClip) rects.push(...textRects(target.view, target.from, target.to, cellClip));
    }
    const rows = mergeCopyRects(rects).slice(0, 1_024); if (!rows.length) return;
    const element = document.createElement('div'); element.className = 'copy-range-feedback'; element.setAttribute('aria-hidden', 'true');
    for (const rect of rows) {
      const piece = document.createElement('span');
      Object.assign(piece.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.right - rect.left + 'px', height: rect.bottom - rect.top + 'px' });
      element.append(piece);
    }
    this.element = element; document.body.append(element);
    this.events = new AbortController(); const options = { capture: true, signal: this.events.signal };
    for (const event of ['scroll', 'wheel', 'pointerdown', 'keydown', 'input', 'compositionstart', 'visibilitychange']) document.addEventListener(event, () => this.clear(), options);
    for (const event of ['resize', 'blur']) window.addEventListener(event, () => this.clear(), options);
    this.timer = window.setTimeout(() => this.clear(), 1_000);
  }

  clear(): void {
    clearTimeout(this.timer); this.timer = 0; this.events?.abort(); this.events = undefined; this.element?.remove(); this.element = undefined;
  }
}
