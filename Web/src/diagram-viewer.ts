import { t } from './localization';
export class DiagramViewer {
  private dialog: HTMLDialogElement;
  private canvas: HTMLElement;
  private stage: HTMLElement;
  private svg?: SVGElement;
  private scale = 1;
  private baseWidth = 800;
  private percent: HTMLButtonElement;
  constructor() {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'diagram-viewer'; this.dialog.className = 'diagram-viewer';
    const toolbar = document.createElement('div'); toolbar.className = 'diagram-toolbar';
    const title = document.createElement('span'); title.className = 'diagram-viewer-title';
    const button = (label: string, action: () => void) => { const value = document.createElement('button'); value.textContent = label; value.onclick = action; toolbar.append(value); return value; };
    toolbar.append(title); button('−', () => this.zoom(1 / 1.15)); this.percent = button('100%', () => this.setScale(1)); button('+', () => this.zoom(1.15));
    const fit = button('↔', () => this.fit()); fit.className = 'diagram-fit'; fit.title = t('适应窗口', 'Fit to window');
    const close = button('×', () => this.dialog.close()); close.className = 'diagram-close'; close.setAttribute('aria-label', t('关闭图表', 'Close diagram'));
    this.canvas = document.createElement('div'); this.canvas.className = 'diagram-canvas'; this.canvas.tabIndex = 0;
    this.stage = document.createElement('div'); this.stage.className = 'diagram-stage'; this.canvas.append(this.stage);
    this.dialog.append(toolbar, this.canvas); document.body.append(this.dialog);
    this.canvas.addEventListener('wheel', event => { if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.stopPropagation(); this.zoom(Math.exp(-event.deltaY * .004)); } }, { passive: false });
    let drag: { x: number; y: number; left: number; top: number } | undefined;
    this.canvas.onpointerdown = event => { if (event.button !== 0) return; drag = { x: event.clientX, y: event.clientY, left: this.canvas.scrollLeft, top: this.canvas.scrollTop }; this.canvas.setPointerCapture(event.pointerId); this.canvas.classList.add('dragging'); };
    this.canvas.onpointermove = event => { if (drag) this.canvas.scrollTo(drag.left - event.clientX + drag.x, drag.top - event.clientY + drag.y); };
    this.canvas.onpointerup = this.canvas.onpointercancel = () => { drag = undefined; this.canvas.classList.remove('dragging'); };
    this.dialog.onclose = () => { this.stage.replaceChildren(); this.svg = undefined; };
    this.dialog.onkeydown = event => { if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(1.15); } else if (event.key === '-') { event.preventDefault(); this.zoom(1 / 1.15); } };
  }
  get open(): boolean { return this.dialog.open; }
  show(svg: SVGElement): void {
    this.svg = svg.cloneNode(true) as SVGElement; this.svg.style.removeProperty('min-width'); this.svg.style.removeProperty('max-width');
    this.baseWidth = Number(svg.getAttribute('viewBox')?.split(/[ ,]+/)[2]) || 800;
    this.stage.replaceChildren(this.svg); this.dialog.querySelector('.diagram-viewer-title')!.textContent = t('流程图 · 拖动平移，⌘滚轮或捏合缩放', 'Diagram · Drag to pan, ⌘wheel or pinch to zoom');
    this.dialog.setAttribute('aria-label', t('图表放大查看', 'Diagram viewer')); (this.dialog.querySelector('.diagram-fit') as HTMLElement).title = t('适应窗口', 'Fit to window');
    this.dialog.querySelector('.diagram-close')!.setAttribute('aria-label', t('关闭图表', 'Close diagram'));
    if (!this.dialog.open) this.dialog.showModal(); this.fit(); this.canvas.focus();
  }
  zoom(factor: number): void { this.setScale(this.scale * factor); }
  private fit(): void { this.setScale(Math.min(1, (this.canvas.clientWidth - 80) / this.baseWidth)); this.canvas.scrollTo(0, 0); }
  private setScale(scale: number): void {
    const x = (this.canvas.scrollLeft + this.canvas.clientWidth / 2) / this.scale, y = (this.canvas.scrollTop + this.canvas.clientHeight / 2) / this.scale;
    this.scale = Math.max(.2, Math.min(5, scale)); if (this.svg) { this.svg.style.width = `${this.baseWidth * this.scale}px`; this.svg.style.height = 'auto'; }
    this.canvas.scrollTo(x * this.scale - this.canvas.clientWidth / 2, y * this.scale - this.canvas.clientHeight / 2);
    this.percent.textContent = `${Math.round(this.scale * 100)}%`;
  }
}
