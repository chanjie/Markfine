import { literalPattern } from './commands';
// CSS Highlight ranges do not rewrite CodeMirror or table DOM and never enter undo history.
interface HighlightRegistry { set(name: string, value: unknown): void; delete(name: string): void }
const registry = () => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
function textRanges(block: HTMLElement, query: string, limit = 20_000): Range[] {
  if (!query) return [];
  const nodes: Text[] = [], ends: number[] = [], ranges: Range[] = []; const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node: Node | null, length = 0;
  while ((node = walker.nextNode())) if (!node.parentElement?.closest('button,svg,small,.diagram-tools,.syntax-marker,.link-syntax:not(.expanded)')) { nodes.push(node as Text); ends.push(length += (node as Text).length); }
  const text = nodes.map(node => node.data).join('');
  const locate = (offset: number) => { let low = 0, high = ends.length - 1; while (low < high) { const mid = (low + high) >> 1; if (ends[mid] < offset) low = mid + 1; else high = mid; } return nodes[low] ? { node: nodes[low], offset: offset - (low ? ends[low - 1] : 0) } : null; };
  for (const match of text.matchAll(literalPattern(query))) {
    if (ranges.length >= limit) break;
    const start = locate(match.index), end = locate(match.index + match[0].length); if (!start || !end) continue;
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); ranges.push(range);
  }
  return ranges;
}
export class SearchHighlights {
  private query = '';
  private frame = 0;
  private blinkTimer = 0;
  private current?: HTMLElement;
  private currentRect?: DOMRect;
  private timer = 0;
  constructor(private scope: () => HTMLElement) {
    new MutationObserver(() => this.schedule()).observe(document.getElementById('main')!, { childList: true, subtree: true, characterData: true });
  }
  set(query: string): void { if (!query) { this.clear(); return; } this.query = query; this.current = undefined; this.stopBlink(); this.schedule(); }
  clear(): void { this.query = ''; clearTimeout(this.timer); cancelAnimationFrame(this.frame); this.timer = 0; this.frame = 0; this.stopBlink(); registry()?.delete('markfine-matches'); registry()?.delete('markfine-current'); }
  schedule(): void {
    if (!this.query || this.frame || this.timer) return;
    const refresh = () => { clearTimeout(this.timer); cancelAnimationFrame(this.frame); this.timer = 0; this.frame = 0; this.refresh(); };
    this.frame = requestAnimationFrame(refresh); this.timer = window.setTimeout(refresh, 80);
  }
  refresh(): void {
    const api = registry(), Constructor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!api || !Constructor) return;
    const ranges: Range[] = [], current: Range[] = [];
    if (this.query) for (const block of this.scope().querySelectorAll<HTMLElement>('.cm-line,p,h1,h2,h3,h4,h5,h6,li,th,td,pre')) {
      if (block.querySelector('.cm-line,p,li,th,td,pre')) continue;
      for (const range of textRanges(block,this.query,20_000-ranges.length)) {
        ranges.push(range);
        if ((this.current === block || this.current?.contains(block)) && (!this.currentRect || [...range.getClientRects()].some(rect => rect.bottom > this.currentRect!.top + 1 && rect.top < this.currentRect!.bottom - 1))) current.push(range);
      }
      if (ranges.length >= 20_000) break;
    }
    api.set('markfine-matches', new Constructor(...ranges)); api.set('markfine-current', new Constructor(...current));
  }
  matchRect(block: HTMLElement, ordinal = 0): DOMRect | undefined { const ranges = textRanges(block,this.query); return ranges[Math.min(ordinal,ranges.length-1)]?.getBoundingClientRect(); }
  flash(block?: HTMLElement, rect?: DOMRect): void {
    this.stopBlink(); this.current = block; this.currentRect = rect; this.refresh();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { document.documentElement.classList.add('search-flash-on'); return; }
    let count = 0;
    const pulse = () => { document.documentElement.classList.toggle('search-flash-on', count % 2 === 0); if (++count < 6) this.blinkTimer = window.setTimeout(pulse, 180); else this.stopBlink(); }; pulse();
  }
  private stopBlink(): void { clearTimeout(this.blinkTimer); document.documentElement.classList.remove('search-flash-on'); }
}
