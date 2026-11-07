export function installScrollIndicators(): void {
  const timers = new WeakMap<Element, number>();
  document.addEventListener('scroll', event => {
    if (!(event.target instanceof HTMLElement)) return;
    const element = event.target;
    element.classList.add('is-scrolling'); clearTimeout(timers.get(element));
    timers.set(element, window.setTimeout(() => element.classList.remove('is-scrolling'), 750));
  }, true);
}
export function installOutlineResize(element: HTMLElement, change: (width: number, persist: boolean) => void): void {
  let start: { x: number; width: number; id: number } | undefined;
  element.onpointerdown = event => {
    if (event.button !== 0) return;
    start = { x: event.clientX, width: Number(element.getAttribute('aria-valuenow') || 220), id: event.pointerId };
    element.setPointerCapture(event.pointerId); event.preventDefault(); document.body.classList.add('resizing-outline');
  };
  element.onpointermove = event => { if (start) change(start.width + (document.documentElement.dataset.outlineSide === 'right' ? -1 : 1) * (event.clientX - start.x), false); };
  const finish = () => {
    if (!start) return;
    if (element.hasPointerCapture(start.id)) element.releasePointerCapture(start.id);
    start = undefined; document.body.classList.remove('resizing-outline'); change(Number(element.getAttribute('aria-valuenow')), true);
  };
  element.onpointerup = finish; element.onpointercancel = finish; element.onlostpointercapture = finish;
  element.onkeydown = event => {
    const current = Number(element.getAttribute('aria-valuenow') || 220);
    const next = event.key === 'ArrowLeft' ? current - 10 : event.key === 'ArrowRight' ? current + 10 : event.key === 'Home' ? 180 : event.key === 'End' ? 360 : null;
    if (next !== null) { event.preventDefault(); change(next, true); }
  };
}
