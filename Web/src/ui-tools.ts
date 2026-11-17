import { t } from './localization';

/** Overlay indicators never change the scrollport's width while appearing or fading. */
class ScrollIndicator {
  private readonly root = document.createElement('div');
  private readonly vertical = this.rail('vertical');
  private readonly horizontal = this.rail('horizontal');
  private drag?: { rail: HTMLElement; pointer: number; offset: number; vertical: boolean };
  private readonly resize = new ResizeObserver(() => this.update());

  constructor(readonly element: HTMLElement, private readonly reschedule: () => void) {
    this.root.className = 'scroll-indicators';
    this.root.append(this.vertical, this.horizontal);
    // Native <dialog> elements occupy the top layer; an indicator appended to
    // body would otherwise be painted behind a scrolling modal.
    (element.closest('dialog[open]') ?? document.body).append(this.root);
    this.resize.observe(element);
  }
  private rail(orientation: 'vertical' | 'horizontal'): HTMLElement {
    const rail = document.createElement('div'), thumb = document.createElement('div');
    rail.className = `scroll-indicator-${orientation}`; thumb.className = 'scroll-indicator-thumb';
    rail.setAttribute('role', 'scrollbar'); rail.setAttribute('aria-orientation', orientation);
    rail.setAttribute('aria-label', orientation === 'vertical' ? t('垂直滚动条', 'Vertical scrollbar') : t('水平滚动条', 'Horizontal scrollbar'));
    rail.setAttribute('aria-valuemin', '0'); rail.tabIndex = -1; rail.append(thumb);
    rail.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this.element.dispatchEvent(new Event('scroll-indicator-start', { bubbles: true }));
      const vertical = orientation === 'vertical', thumbRect = thumb.getBoundingClientRect();
      const coordinate = vertical ? event.clientY : event.clientX;
      const start = vertical ? thumbRect.top : thumbRect.left, size = vertical ? thumbRect.height : thumbRect.width;
      this.drag = { rail, pointer: event.pointerId, offset: event.target === thumb ? coordinate - start : size / 2, vertical };
      rail.setPointerCapture(event.pointerId); this.move(event); this.update();
    });
    rail.addEventListener('pointermove', event => this.move(event));
    const end = (event: PointerEvent) => {
      if (this.drag?.rail !== rail || this.drag.pointer !== event.pointerId) return;
      this.drag = undefined; this.reschedule();
    };
    rail.addEventListener('pointerup', end); rail.addEventListener('pointercancel', end); rail.addEventListener('lostpointercapture', end);
    rail.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      this.element.dispatchEvent(new Event('scroll-indicator-start', { bubbles: true }));
      const vertical = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.element.clientHeight : 1;
      const horizontal = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.element.clientWidth : vertical;
      this.element.scrollBy({ top: event.deltaY * vertical, left: event.deltaX * horizontal });
    }, { passive: false });
    return rail;
  }
  private move(event: PointerEvent): void {
    const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    const rect = drag.rail.getBoundingClientRect(), thumb = drag.rail.firstElementChild!.getBoundingClientRect();
    const size = drag.vertical ? rect.height : rect.width, thumbSize = drag.vertical ? thumb.height : thumb.width;
    const coordinate = drag.vertical ? event.clientY - rect.top : event.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, (coordinate - drag.offset) / Math.max(1, size - thumbSize)));
    if (drag.vertical) this.element.scrollTop = fraction * (this.element.scrollHeight - this.element.clientHeight);
    else this.element.scrollLeft = fraction * (this.element.scrollWidth - this.element.clientWidth);
    this.update();
  }
  get dragging(): boolean { return !!this.drag; }
  update(): void {
    const rect = this.element.getBoundingClientRect();
    if (!this.element.isConnected || rect.width <= 0 || rect.height <= 0) { this.root.hidden = true; return; }
    this.root.hidden = false;
    Object.assign(this.root.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const draw = (rail: HTMLElement, vertical: boolean) => {
      const visible = vertical ? this.element.clientHeight : this.element.clientWidth;
      const full = vertical ? this.element.scrollHeight : this.element.scrollWidth;
      const position = vertical ? this.element.scrollTop : this.element.scrollLeft;
      rail.hidden = full <= visible + 1;
      if (rail.hidden) return;
      const track = vertical ? rail.clientHeight : rail.clientWidth;
      const size = Math.min(track, Math.max(28, track * visible / full));
      const start = Math.max(0, Math.min(track - size, (track - size) * position / (full - visible)));
      const thumb = rail.firstElementChild as HTMLElement;
      if (vertical) { thumb.style.height = `${size}px`; thumb.style.transform = `translateY(${start}px)`; }
      else { thumb.style.width = `${size}px`; thumb.style.transform = `translateX(${start}px)`; }
      rail.setAttribute('aria-valuemax', String(Math.round(full - visible)));
      rail.setAttribute('aria-valuenow', String(Math.round(position)));
    };
    draw(this.vertical, true); draw(this.horizontal, false);
  }
  destroy(): void { this.resize.disconnect(); this.root.remove(); }
}

export function installScrollIndicators(): void {
  const active = new Map<HTMLElement, { indicator: ScrollIndicator; timer: number }>();
  const hideLater = (element: HTMLElement) => {
    const state = active.get(element); if (!state) return;
    clearTimeout(state.timer);
    if (state.indicator.dragging) return;
    state.timer = window.setTimeout(() => {
      if (state.indicator.dragging) return;
      element.classList.remove('is-scrolling'); state.indicator.destroy(); active.delete(element);
    }, 750);
  };
  document.addEventListener('scroll', event => {
    if (!(event.target instanceof HTMLElement)) return;
    const element = event.target;
    let state = active.get(element);
    if (!state) {
      state = { indicator: new ScrollIndicator(element, () => hideLater(element)), timer: 0 };
      active.set(element, state);
    }
    element.classList.add('is-scrolling'); state.indicator.update(); hideLater(element);
    // Scrolling an ancestor can move an independently scrolling descendant.
    for (const [other, value] of active) if (other !== element) value.indicator.update();
  }, true);
  window.addEventListener('resize', () => { for (const state of active.values()) state.indicator.update(); });
}
export function installOutlineResize(element: HTMLElement, change: (width: number, persist: boolean) => void, side: () => 'left' | 'right' = () => document.documentElement.dataset.outlineSide === 'right' ? 'right' : 'left'): void {
  let start: { x: number; width: number; id: number } | undefined;
  element.onpointerdown = event => {
    if (event.button !== 0) return;
    start = { x: event.clientX, width: Number(element.getAttribute('aria-valuenow') || 220), id: event.pointerId };
    element.setPointerCapture(event.pointerId); event.preventDefault(); document.body.classList.add('resizing-outline');
  };
  element.onpointermove = event => { if (start) change(start.width + (side() === 'right' ? -1 : 1) * (event.clientX - start.x), false); };
  const finish = () => {
    if (!start) return;
    const id = start.id; start = undefined;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    document.body.classList.remove('resizing-outline'); change(Number(element.getAttribute('aria-valuenow')), true);
  };
  element.onpointerup = finish; element.onpointercancel = finish; element.onlostpointercapture = finish;
  element.onkeydown = event => {
    const current = Number(element.getAttribute('aria-valuenow') || 220);
    if (event.isComposing) return;
    const direction = side() === 'left' ? 1 : -1;
    const next = event.key === 'ArrowLeft' ? current - 10 * direction : event.key === 'ArrowRight' ? current + 10 * direction : event.key === 'Home' ? 180 : event.key === 'End' ? 360 : null;
    if (next !== null) { event.preventDefault(); change(next, true); }
  };
}
