import { t } from './localization';
export class DiagramViewer {
  private dialog: HTMLDialogElement;
  private canvas: HTMLElement;
  private stage: HTMLElement;
  private svg?: SVGElement;
  private scale = 1;
  private baseWidth = 800;
  private baseHeight = 600;
  private percent: HTMLButtonElement;
  private save: HTMLButtonElement;
  private status: HTMLElement;
  private saving = false;
  private documentID = '';
  constructor(private readonly savePNG: (svg: SVGSVGElement, id: string) => Promise<string>) {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'diagram-viewer'; this.dialog.className = 'diagram-viewer';
    const toolbar = document.createElement('div'); toolbar.className = 'diagram-toolbar';
    const title = document.createElement('span'); title.className = 'diagram-viewer-title';
    const button = (label: string, action: () => void) => { const value = document.createElement('button'); value.textContent = label; value.onclick = action; toolbar.append(value); return value; };
    toolbar.append(title); button('−', () => this.zoom(1 / 1.15)); this.percent = button('100%', () => this.setScale(1)); button('+', () => this.zoom(1.15));
    const fit = button('↔', () => this.fit()); fit.className = 'diagram-fit'; fit.title = t('适应窗口', 'Fit to window');
    this.save = button('', () => { void this.exportPNG(); }); this.save.className = 'diagram-save';
    const close = button('×', () => this.dialog.close()); close.className = 'diagram-close'; close.setAttribute('aria-label', t('关闭图表', 'Close diagram'));
    this.canvas = document.createElement('div'); this.canvas.className = 'diagram-canvas'; this.canvas.tabIndex = 0;
    this.stage = document.createElement('div'); this.stage.className = 'diagram-stage'; this.canvas.append(this.stage);
    this.status = document.createElement('div'); this.status.className = 'diagram-status'; this.status.setAttribute('role', 'status'); this.status.hidden = true;
    this.dialog.append(toolbar, this.canvas, this.status); document.body.append(this.dialog);
    this.canvas.addEventListener('wheel', event => { if (event.metaKey || event.ctrlKey) { event.preventDefault(); event.stopPropagation(); this.zoom(Math.exp(-event.deltaY * .004)); } }, { passive: false });
    let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
    const endDrag = () => {
      const id = drag?.id;
      drag = undefined;
      this.canvas.classList.remove('dragging');
      if (id !== undefined && this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    };
    this.canvas.onpointerdown = event => {
      if (drag || !event.isPrimary || event.button !== 0 || event.ctrlKey || !this.stage.contains(event.target as Node)) return;
      event.preventDefault();
      this.canvas.focus({ preventScroll: true });
      this.canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.canvas.scrollLeft, top: this.canvas.scrollTop };
      this.canvas.classList.add('dragging');
    };
    this.canvas.ondragstart = event => event.preventDefault();
    this.canvas.onpointermove = event => {
      if (drag?.id !== event.pointerId) return;
      // Discard movement beyond the scroll edges, so reversing direction pans
      // immediately and repeated movement against a boundary does not scroll.
      const left = Math.max(0, Math.min(this.canvas.scrollWidth - this.canvas.clientWidth, drag.left + drag.x - event.clientX));
      const top = Math.max(0, Math.min(this.canvas.scrollHeight - this.canvas.clientHeight, drag.top + drag.y - event.clientY));
      if (left !== drag.left || top !== drag.top) this.canvas.scrollTo({ left, top, behavior: 'instant' });
      drag = { id: drag.id, x: event.clientX, y: event.clientY, left, top };
    };
    this.canvas.onpointerup = this.canvas.onpointercancel = this.canvas.onlostpointercapture = event => {
      if (drag?.id === event.pointerId) endDrag();
    };
    this.dialog.onclose = () => { if (!this.dialog.open) { endDrag(); this.stage.replaceChildren(); this.svg = undefined; } };
    this.dialog.onkeydown = event => { if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(1.15); } else if (event.key === '-') { event.preventDefault(); this.zoom(1 / 1.15); } };
  }
  get open(): boolean { return this.dialog.open; }
  show(svg: SVGElement, documentID: string): void {
    this.documentID = documentID;
    this.save.textContent = t('保存 PNG…', 'Save PNG…');
    this.save.title = t('按 100% 尺寸保存完整图表', 'Save the whole diagram at 100% size');
    this.status.hidden = true;
    this.svg = svg.cloneNode(true) as SVGElement; this.svg.style.removeProperty('min-width'); this.svg.style.removeProperty('max-width');
    this.baseWidth = Number(svg.getAttribute('viewBox')?.split(/[ ,]+/)[2]) || 800;
    this.baseHeight = Number(svg.getAttribute('viewBox')?.split(/[ ,]+/)[3]) || 600;
    this.stage.replaceChildren(this.svg); this.dialog.querySelector('.diagram-viewer-title')!.textContent = t('流程图 · 拖动平移，⌘滚轮或捏合缩放', 'Diagram · Drag to pan, ⌘wheel or pinch to zoom');
    this.dialog.setAttribute('aria-label', t('图表放大查看', 'Diagram viewer')); (this.dialog.querySelector('.diagram-fit') as HTMLElement).title = t('适应窗口', 'Fit to window');
    this.dialog.querySelector('.diagram-close')!.setAttribute('aria-label', t('关闭图表', 'Close diagram'));
    if (!this.dialog.open) this.dialog.showModal(); this.fit(); this.canvas.focus();
  }
  zoom(factor: number): void { if (Number.isFinite(factor) && factor > 0) this.setScale(this.scale * factor); }
  private async exportPNG(): Promise<void> {
    const svg = this.svg;
    if (this.saving || !(svg instanceof SVGSVGElement)) return;
    const snapshot = svg.cloneNode(true) as SVGSVGElement;
    this.save.disabled = this.saving = true;
    const status = (message: string) => {
      if (this.svg !== svg || !this.open) return;
      this.status.textContent = message; this.status.hidden = !message;
    };
    status(t('正在准备 PNG…', 'Preparing PNG…'));
    try {
      const outcome = await this.savePNG(snapshot, this.documentID);
      if (outcome === 'success') status(t('已保存 PNG', 'PNG saved'));
      else if (outcome === 'cancelled') status('');
      else throw new Error();
    } catch (error) {
      status(error instanceof RangeError
        ? t('图表太大，无法按 100% 尺寸保存。', 'This diagram is too large to save at 100% size.')
        : t('无法保存 PNG。请检查图表资源或保存位置后重试。', 'PNG could not be saved. Check the diagram resources or destination and try again.'));
    } finally { this.save.disabled = this.saving = false; }
  }
  private fit(): void { this.setScale(Math.min(1, (this.canvas.clientWidth - 80) / this.baseWidth, (this.canvas.clientHeight - 80) / this.baseHeight)); this.canvas.scrollTo(0, 0); }
  private setScale(scale: number): void {
    const port = this.canvas.getBoundingClientRect(), before = this.svg?.getBoundingClientRect();
    const centerX = port.left + this.canvas.clientWidth / 2, centerY = port.top + this.canvas.clientHeight / 2;
    const x = before?.width ? (centerX - before.left) / before.width : .5, y = before?.height ? (centerY - before.top) / before.height : .5;
    this.scale = Math.max(.2, Math.min(5, scale));
    if (this.svg) {
      this.svg.style.width = `${this.baseWidth * this.scale}px`; this.svg.style.height = `${this.baseHeight * this.scale}px`;
      const after = this.svg.getBoundingClientRect();
      this.canvas.scrollBy({ left: after.left + x * after.width - centerX, top: after.top + y * after.height - centerY, behavior: 'instant' });
    }
    this.percent.textContent = `${Math.round(this.scale * 100)}%`;
  }
}
