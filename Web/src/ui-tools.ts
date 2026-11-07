export function installScrollIndicators(): void {
  const timers = new WeakMap<Element, number>();
  document.addEventListener('scroll', event => {
    if (!(event.target instanceof HTMLElement)) return;
    const element = event.target;
    element.classList.add('is-scrolling'); clearTimeout(timers.get(element));
    timers.set(element, window.setTimeout(() => element.classList.remove('is-scrolling'), 750));
  }, true);
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
