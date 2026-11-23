import type { EditorView } from '@codemirror/view';
import { tableCaretRect } from './table-editor';
import { referenceIndex } from './reference-context';
import { imageBoundaryRect } from './wrapped-caret';

const animations = new WeakMap<HTMLElement, { frame: number; timer: number; top: number; left: number }>();
export function stopScroll(element: HTMLElement): void {
  const running = animations.get(element); if (running) { cancelAnimationFrame(running.frame); clearTimeout(running.timer); }
  animations.delete(element);
}
export function scrollDuration(distance: number): number { return Math.min(700, Math.max(140, 140 + Math.sqrt(Math.max(0, distance)) * 10)); }
export function animateScroll(element: HTMLElement, top: number, left = element.scrollLeft, duration?: number, complete?: () => void, readTop?: () => number): void {
  stopScroll(element);
  top = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, top));
  left = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, left));
  duration ??= scrollDuration(Math.max(Math.abs(top - element.scrollTop), Math.abs(left - element.scrollLeft)));
  if (duration <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) { element.scrollTo(left, top); complete?.(); return; }
  const fromTop = element.scrollTop, fromLeft = element.scrollLeft, start = performance.now();
  const running = { frame: 0, timer: 0, top, left }; animations.set(element, running);
  // A virtualized destination can move as its real blocks replace estimated
  // heights. Follow its measured position within this animation, not an old
  // absolute offset. Ordinary fixed-destination scrolling remains unchanged.
  const currentTop = () => readTop ? Math.max(0, Math.min(element.scrollHeight - element.clientHeight, readTop())) : top;
  // A background/minimized WebView can suspend animation frames. Always commit the final destination.
  running.timer = window.setTimeout(() => {
    if (animations.get(element) !== running) return;
    cancelAnimationFrame(running.frame); running.top = currentTop(); element.scrollTo(left, running.top); animations.delete(element); complete?.();
  }, duration + 60);
  const advance = (now: number) => {
    const progress = Math.min(1, (now - start) / duration), eased = 1 - (1 - progress) ** 4;
    running.top = currentTop();
    element.scrollTo(fromLeft + (left - fromLeft) * eased, fromTop + (running.top - fromTop) * eased);
    if (progress < 1) running.frame = requestAnimationFrame(advance); else { clearTimeout(running.timer); animations.delete(element); complete?.(); }
  };
  running.frame = requestAnimationFrame(advance);
}
export function centerCaret(view: EditorView): void {
  if (!view.dom.contains(document.activeElement) || view.composing || !view.state.selection.main.empty) return;
  scrollToPosition(view, view.state.selection.main.head);
}
export function scrollToPosition(view: EditorView, position: number): void {
  const first = view.state.field(referenceIndex).tree.topNode.firstChild;
  if (first && position <= first.to) { if (view.scrollDOM.scrollTop > 0) animateScroll(view.scrollDOM, 0); return; }
  const scroller = view.scrollDOM;
  const target = () => {
    const caret = tableCaretRect(view) ?? imageBoundaryRect(view, position) ?? view.coordsAtPos(position), viewport = scroller.getBoundingClientRect();
    const block = !caret ? view.lineBlockAt(position) : null;
    const center = caret ? (caret.top + caret.bottom) / 2 : view.documentTop + block!.top + block!.height / 2;
    return scroller.scrollTop + center - (viewport.top + scroller.clientHeight / 2);
  };
  const top = target();
  if (Math.abs(top - scroller.scrollTop) > 2) animateScroll(scroller, top, undefined, undefined, undefined, target);
}

export function readingScrollDistance(kind: string, height: number, viewport: number, line = 30): number {
  const max = viewport * .72;
  if (/^H[1-6]$/.test(kind)) return Math.min(max, Math.max(line * 2, height + 20));
  if (kind === 'PRE') return Math.min(max, line * 6);
  if (kind === 'TABLE') return Math.min(max, line * 4);
  if (kind === 'LI') return Math.min(max, Math.max(line * 2, Math.min(height, line * 4)));
  if (kind === 'IMG' || kind === 'DIAGRAM') return Math.min(max, Math.max(line * 3, height));
  return Math.min(max, Math.max(line * 2, height + 20));
}
export function scrollReading(reader: HTMLElement, key: string): boolean {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) return false;
  const base = animations.get(reader), top = base?.top ?? reader.scrollTop;
  if (key === 'Home' || key === 'End') { animateScroll(reader, key === 'Home' ? 0 : reader.scrollHeight); return true; }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const selection = getSelection();
    const selectedBlock = selection?.anchorNode?.parentElement?.closest<HTMLElement>('pre,table,.diagram');
    const box = reader.getBoundingClientRect();
    const wide = selectedBlock && reader.contains(selectedBlock) && selectedBlock.scrollWidth > selectedBlock.clientWidth + 1 ? selectedBlock :
      [...reader.querySelectorAll<HTMLElement>('pre,table,.diagram')].find(element => {
        const rect = element.getBoundingClientRect(); return rect.top < box.bottom && rect.bottom > box.top && element.scrollWidth > element.clientWidth + 1;
      });
    const target = wide ?? reader;
    if (target.scrollWidth > target.clientWidth + 1) {
      animateScroll(target, target.scrollTop, (animations.get(target)?.left ?? target.scrollLeft) + (key === 'ArrowRight' ? 1 : -1) * target.clientWidth * .65); return true;
    }
  }
  const box = reader.getBoundingClientRect();
  const block = [...reader.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,pre,table,img,.diagram')].find(element => element.getBoundingClientRect().bottom > box.top + reader.clientHeight * .25);
  const line = block ? parseFloat(getComputedStyle(block).lineHeight) || 30 : 30;
  const distance = key === 'PageDown' || key === 'PageUp' || key === 'ArrowLeft' || key === 'ArrowRight' ? reader.clientHeight * .82 :
    readingScrollDistance(block?.classList.contains('diagram') ? 'DIAGRAM' : block?.tagName ?? 'P', block?.getBoundingClientRect().height ?? 60, reader.clientHeight, line);
  animateScroll(reader, top + (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(key) ? -1 : 1) * distance); return true;
}
