import { Compartment, EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { editorMarkdown } from './editor-language';
import { blockPreview, composition } from './preview';
import { SaveMachine, protectClose, protectCloseAll, type Context } from './save-machine';
import { formatTransaction, findMatch, replacementChanges } from './commands';
import { imageMigrationChanges, migrateImageReferences, stagedReferences } from './migration';
import { newID } from './protocol';

declare global {
  var __markfineBootstrap: Context;
  var markfine: { receive(message: Record<string, unknown>): boolean; prepareSnapshot(source: string, mapping: Record<string, string>): string; stagedReferences(source: string): string[] };
  var __markfineRenderDiagram: ((source: string, documentID: string) => Promise<SVGElement>) | undefined;
}
export interface EditorDocument {
  id: string; title: string; path: string; state: EditorState; saves: SaveMachine; locks: Compartment;
  imageLocked: boolean; closeLocked: boolean; scroll?: ReturnType<EditorView['scrollSnapshot']>; unsubscribe: () => void;
}
interface PasteJob { id: string; documentID: string; revision: number; selection: EditorSelection; cancelRequested: boolean }
const context = globalThis.__markfineBootstrap;
const transport = (body: Record<string, unknown>): void => {
  const host = globalThis as unknown as { webkit: { messageHandlers: { markfine: { postMessage(body: unknown): void } } } };
  host.webkit.messageHandlers.markfine.postMessage(body);
};
const byID = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class EditorApplication {
  readonly documents = new Map<string, EditorDocument>();
  readonly errors: string[] = [];
  activeID = '';
  view: EditorView | null = null;
  pasteJob: PasteJob | null = null;
  closing = false;
  private notice = '';
  private initialized = false;
  private mermaidPromise?: Promise<void>;
  private mermaidResolve?: () => void;
  private mermaidReject?: (error: Error) => void;
  private requests = new Map<string, (value: Record<string, unknown>) => void>();

  constructor() {
    byID('new').onclick = () => this.command('new'); byID('open').onclick = () => this.command('open');
    byID('save').onclick = () => this.saveActive(); byID('dismiss-notice').onclick = () => { this.notice = ''; this.renderChrome(); };
    byID('cancel-paste').onclick = () => this.cancelPaste();
    byID<HTMLInputElement>('query').oninput = () => this.find(false, true);
    byID('find-next').onclick = () => this.find(false); byID('find-previous').onclick = () => this.find(true);
    byID('replace-one').onclick = () => this.replace(false); byID('replace-all').onclick = () => this.replace(true);
    byID('close-find').onclick = () => this.hideFind();
    byID('find-panel').addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.hideFind(); }
      else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault(); if (event.target.id === 'replacement') this.replace(false); else this.find(event.shiftKey);
      }
    });
    document.addEventListener('keydown', event => {
      if (event.isComposing || this.composing()) return;
      if (event.ctrlKey && !event.metaKey && event.key === 'Tab') { event.preventDefault(); this.switchTab(event.shiftKey ? -1 : 1); }
    });
    window.addEventListener('error', event => this.errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', event => this.errors.push(String(event.reason)));
  }
  post(kind: string, fields: Record<string, unknown> = {}): void {
    const { protocolVersion, sessionID, capability } = context;
    transport({ protocolVersion, sessionID, capability, kind, ...fields });
  }
  get active(): EditorDocument | undefined { return this.documents.get(this.activeID); }
  composing(): boolean { return !!this.view && (this.view.composing || this.view.state.field(composition)); }
  setNotice(text: string): void { this.notice = text; this.renderChrome(); }

  private load(message: Record<string, unknown>): void {
    const id = String(message.documentID);
    if (this.documents.has(id)) { this.activate(id); return; }
    const locks = new Compartment();
    const source = String(message.markdown), separator = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
    const state = EditorState.create({ doc: source, extensions: [
      history(), editorMarkdown(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, highlightActiveLine(),
      locks.of(EditorState.readOnly.of(false)),
      keymap.of([
        { key: 'Mod-s', run: () => { this.saveActive(); return true; } },
        ...Object.entries({ 'Mod-b': 'bold', 'Mod-i': 'italic', 'Mod-k': 'link', 'Mod-Alt-k': 'inlineCode', 'Mod-Alt-c': 'codeBlock',
          'Mod-Alt-q': 'quote', 'Mod-Alt-o': 'ordered', 'Mod-Alt-u': 'unordered', 'Mod-Alt-x': 'task', 'Mod-Alt-t': 'table',
          'Ctrl-Shift-`': 'strike', 'Ctrl-Mod-i': 'image', 'Mod-]': 'indent', 'Mod-[': 'outdent',
          'Mod-0': 'heading0', 'Mod-1': 'heading1', 'Mod-2': 'heading2', 'Mod-3': 'heading3', 'Mod-4': 'heading4', 'Mod-5': 'heading5', 'Mod-6': 'heading6'
        }).map(([key, action]) => ({ key, run: () => this.command(action) })),
        ...historyKeymap, ...defaultKeymap
      ]),
      blockPreview(id, element => this.hydrate(element, id)),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.exceptionSink.of(error => { this.errors.push(String(error)); this.setNotice('编辑器发生异常，请保留当前内容：' + String(error)); }),
      EditorView.domEventHandlers({ paste: (event, view) => {
        if (view.composing || view.state.field(composition)) return false;
        event.preventDefault(); this.requestPaste(); return true;
      } }),
      EditorView.updateListener.of(update => {
        const item = this.documents.get(id); if (!item) return;
        item.state = update.state;
        if (update.docChanged) { item.saves.edited(update.state.doc); this.updateCount(); }
      })
    ] });
    const saves = new SaveMachine(context, id, state.doc, transport);
    saves.lineSeparator = separator;
    const item: EditorDocument = { id, title: String(message.title), path: String(message.path), state, saves, locks,
      imageLocked: false, closeLocked: false, unsubscribe: () => {} };
    this.documents.set(id, item); item.unsubscribe = saves.subscribe(() => this.renderChrome());
    if (!this.composing()) this.activate(id); else this.renderChrome();
  }

  activate(id: string): boolean {
    if (this.composing()) { this.setNotice('请先完成当前中文组词'); return false; }
    const next = this.documents.get(id); if (!next) return false;
    const previous = this.active;
    if (previous && this.view) { previous.state = this.view.state; previous.scroll = this.view.scrollSnapshot(); }
    this.activeID = id;
    if (this.view) this.view.setState(next.state);
    else this.view = new EditorView({ state: next.state, parent: byID('editor') });
    this.view.dispatch({ effects: next.scroll ?? EditorView.scrollIntoView(next.state.selection.main.head, { y: 'nearest' }) });
    this.view.focus();
    this.notice = ''; this.renderChrome(); this.post('activeDocument', { documentID: id });
    return true;
  }
  private switchTab(direction: number): void {
    const ids = [...this.documents.keys()]; if (!ids.length) return;
    this.activate(ids[(ids.indexOf(this.activeID) + direction + ids.length) % ids.length]);
  }
  edit(id: string, spec: TransactionSpec): boolean {
    const item = this.documents.get(id); if (!item) return false;
    if (this.activeID === id && this.view) this.view.dispatch(spec);
    else { const transaction = item.state.update(spec); item.state = transaction.state; if (transaction.docChanged) item.saves.edited(item.state.doc); }
    return true;
  }
  private lock(item: EditorDocument): void {
    this.edit(item.id, { effects: item.locks.reconfigure(EditorState.readOnly.of(item.imageLocked || item.closeLocked)) });
  }
  saveActive(): boolean {
    const item = this.active;
    if (!item || this.composing() || item.imageLocked || item.closeLocked) return false;
    this.notice = ''; item.saves.requestSave(); return true;
  }
  command(action: string): boolean {
    if (this.composing()) return false;
    if (action === 'new' || action === 'open') {
      if (this.closing) return false; this.post(action); return true;
    }
    if (action === 'save') return this.saveActive();
    if (action === 'close') { if (this.active) void this.closeTab(this.active.id); return true; }
    if (action === 'nextTab' || action === 'previousTab') { this.switchTab(action === 'nextTab' ? 1 : -1); return true; }
    if (action === 'find' || action === 'replace') { this.showFind(action === 'replace'); return true; }
    if (action === 'findNext' || action === 'findPrevious') { this.find(action === 'findPrevious'); return true; }
    if (action === 'paste') { if (!this.view?.hasFocus) return false; this.requestPaste(); return true; }
    if (!this.view?.hasFocus) {
      if (['undo', 'redo'].includes(action) && document.activeElement instanceof HTMLInputElement) return document.execCommand(action);
      return false;
    }
    const item = this.active;
    if (!item || item.imageLocked || item.closeLocked) return false;
    if (action === 'undo') return undo(this.view);
    if (action === 'redo') return redo(this.view);
    const transaction = formatTransaction(this.view.state, action);
    if (!transaction) return false;
    this.view.dispatch({ ...transaction, annotations: isolateHistory.of('full') }); return true;
  }

  showFind(replace: boolean): void {
    if (!this.active || this.composing()) return;
    byID('find-panel').hidden = false; byID('replace-row').hidden = !replace;
    const selected = this.active.state.sliceDoc(this.active.state.selection.main.from, this.active.state.selection.main.to);
    if (selected && !selected.includes('\n')) byID<HTMLInputElement>('query').value = selected;
    byID<HTMLInputElement>('query').focus(); byID<HTMLInputElement>('query').select();
    this.updateFindCount();
  }
  hideFind(): void { if (this.composing()) return; byID('find-panel').hidden = true; this.view?.focus(); }
  find(backwards: boolean, fromStart = false): boolean {
    const item = this.active; if (!item || this.composing()) return false;
    const query = byID<HTMLInputElement>('query').value;
    const match = findMatch(item.state.doc.toString(), query, fromStart ? 0 : backwards ? item.state.selection.main.from : item.state.selection.main.to, backwards);
    if (match) this.edit(item.id, { selection: EditorSelection.single(match.from, match.to), scrollIntoView: true });
    this.updateFindCount(); return !!match;
  }
  replace(all: boolean): boolean {
    const item = this.active;
    if (!item || item.imageLocked || item.closeLocked || this.composing()) return false;
    const query = byID<HTMLInputElement>('query').value, replacement = byID<HTMLInputElement>('replacement').value;
    if (!query) return false;
    let changes;
    if (all) changes = replacementChanges(item.state.doc.toString(), query, replacement);
    else {
      let selection = item.state.selection.main;
      if (item.state.sliceDoc(selection.from, selection.to).toLowerCase() !== query.toLowerCase()) {
        if (!this.find(false)) return false; selection = item.state.selection.main;
      }
      changes = [{ from: selection.from, to: selection.to, insert: replacement }];
    }
    if (!changes.length) return false;
    this.edit(item.id, { changes, userEvent: 'input.replace', annotations: isolateHistory.of('full') });
    this.updateFindCount(); return true;
  }
  private updateFindCount(): void {
    if (byID('find-panel').hidden) return;
    const query = byID<HTMLInputElement>('query').value;
    byID('matches').textContent = query && this.active ? `${replacementChanges(this.active.state.doc.toString(), query, '').length} 处匹配` : '输入查找内容';
  }

  requestPaste(): boolean {
    const item = this.active;
    if (!item || this.composing() || item.closeLocked || item.imageLocked) return false;
    if (this.pasteJob || item.saves.pending) { this.setNotice('请先等待当前图片任务或该文档保存完成'); return false; }
    const job: PasteJob = { id: newID(), documentID: item.id, revision: item.saves.revision, selection: item.state.selection, cancelRequested: false };
    this.pasteJob = job; item.imageLocked = true; this.lock(item); this.renderChrome();
    this.post('paste', { documentID: item.id, requestID: job.id, revision: job.revision, anchor: job.selection.main.anchor, head: job.selection.main.head });
    return true;
  }
  cancelPaste(): void {
    const job = this.pasteJob; if (!job) return;
    job.cancelRequested = true; this.post('cancelPaste', { documentID: job.documentID, requestID: job.id }); this.renderChrome();
  }
  private pasteReceipt(message: Record<string, unknown>): void {
    const job = this.pasteJob;
    if (!job || message.requestID !== job.id || message.documentID !== job.documentID) return;
    const item = this.documents.get(job.documentID);
    this.pasteJob = null;
    if (!item) return;
    item.imageLocked = false; this.lock(item);
    if (message.outcome === 'success' && !job.cancelRequested && item.saves.revision === job.revision) {
      const insert = typeof message.reference === 'string' ? `![图片](${message.reference})` : typeof message.text === 'string' ? message.text : '';
      if (insert) this.edit(item.id, { changes: { from: job.selection.main.from, to: job.selection.main.to, insert },
        selection: EditorSelection.single(job.selection.main.from + insert.length), userEvent: 'input.paste', annotations: isolateHistory.of('full') });
    } else if (message.outcome === 'failure') this.notice = String(message.error || '粘贴失败，正文未改变');
    this.renderChrome();
  }

  private chooseClose(item: EditorDocument): Promise<'save' | 'discard' | 'cancel'> {
    const dialog = byID<HTMLDialogElement>('close-dialog');
    byID('close-title').textContent = `保存对“${item.title}”的更改？`;
    return new Promise(resolve => {
      const finish = (choice: 'save' | 'discard' | 'cancel') => { dialog.onclick = null; dialog.oncancel = null; dialog.close(); resolve(choice); };
      dialog.onclick = event => {
        const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-choice]') : null;
        if (button) finish(button.dataset.choice as 'save' | 'discard' | 'cancel');
      };
      dialog.oncancel = event => { event.preventDefault(); finish('cancel'); }; dialog.showModal();
    });
  }
  async closeTab(id: string): Promise<boolean> {
    const item = this.documents.get(id);
    if (!item || this.closing || item.imageLocked || this.composing()) return false;
    this.closing = true;
    try {
      if (!await protectClose(item.saves, () => this.chooseClose(item))) { this.setNotice('关闭已取消或保存未完成，编辑内容已保留'); return false; }
      item.closeLocked = true; this.lock(item);
      const result = await this.request('closeDocument', { documentID: id, revision: item.saves.revision });
      if (result.permitted !== true) { item.closeLocked = false; this.lock(item); this.setNotice('关闭未获确认，文档已保留'); return false; }
      this.remove(item); this.renderChrome(); return true;
    } finally { this.closing = false; }
  }
  private remove(item: EditorDocument): void {
    item.unsubscribe(); item.saves.dispose(); this.documents.delete(item.id);
    if (this.activeID === item.id) {
      this.activeID = ''; const next = this.documents.keys().next().value;
      if (next) this.activate(next); else { this.view?.destroy(); this.view = null; byID('editor').replaceChildren(); }
    }
  }
  private async closeAll(requestID: string): Promise<void> {
    let permitted = false;
    if (!this.closing && !this.pasteJob && !this.composing()) {
      this.closing = true;
      const ids = [...this.documents.keys()];
      permitted = await protectCloseAll([...this.documents.values()].map(item => item.saves), machine => this.chooseClose(this.documents.get(machine.documentID)!));
      permitted &&= ids.length === this.documents.size && ids.every(id => this.documents.has(id));
      if (permitted) for (const item of this.documents.values()) { item.closeLocked = true; this.lock(item); }
    }
    this.post('closeAllResult', { requestID, permitted, documents: [...this.documents.values()].map(item => ({ documentID: item.id, revision: item.saves.revision })) });
  }
  request(kind: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const requestID = newID();
    return new Promise(resolve => { this.requests.set(requestID, resolve); this.post(kind, { ...fields, requestID }); });
  }
  async ensureMermaid(): Promise<void> {
    if (!this.mermaidPromise) {
      this.mermaidPromise = new Promise<void>((resolve, reject) => { this.mermaidResolve = resolve; this.mermaidReject = reject; });
      this.post('loadMermaid');
    }
    return this.mermaidPromise;
  }
  private hydrate(element: HTMLElement, documentID: string): void {
    for (const image of element.querySelectorAll<HTMLImageElement>('img')) {
      image.onerror = () => { image.classList.add('image-error'); image.title = '本地图片不可用或超出文档权限'; };
      image.onload = () => this.view?.requestMeasure();
    }
    for (const diagram of element.querySelectorAll<HTMLElement>('[data-diagram]')) {
      void this.ensureMermaid().then(async () => {
        if (!diagram.isConnected) return;
        const svg = await globalThis.__markfineRenderDiagram!(diagram.dataset.diagram!, documentID);
        if (diagram.isConnected) { diagram.replaceChildren(svg); this.view?.requestMeasure(); }
      }).catch(error => { const hint = diagram.querySelector('small'); if (hint) hint.textContent = `图表保留源码：${String(error)}`; });
    }
  }
  private updateCount(): void {
    const item = this.active;
    byID('count').textContent = item ? `${item.state.doc.length.toLocaleString()} 字符 · ${item.state.doc.lines} 行` : 'Markdown · UTF-8';
    this.updateFindCount();
  }
  renderChrome(): void {
    const tabs = byID('tabs'); tabs.replaceChildren();
    for (const item of this.documents.values()) {
      const row = document.createElement('div'); row.className = 'tab' + (item.id === this.activeID ? ' active' : ''); row.setAttribute('role', 'presentation');
      const select = document.createElement('button'); select.type = 'button'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(item.id === this.activeID));
      select.title = item.path || '尚未保存';
      if (item.saves.dirty) { const dot = document.createElement('span'); dot.className = 'dirty'; dot.setAttribute('aria-label', '未保存'); select.append(dot); }
      select.append(document.createTextNode(item.title));
      if ([...this.documents.values()].filter(other => other.title === item.title).length > 1) {
        const suffix = document.createElement('small'); suffix.textContent = item.path ? item.path.split('/').at(-2) ?? '' : item.id.slice(0, 4); select.append(suffix);
      }
      select.onclick = () => this.activate(item.id);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close-tab'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${item.title}`);
      close.onclick = () => { void this.closeTab(item.id); }; close.disabled = item.imageLocked || item.closeLocked;
      row.append(select, close); tabs.append(row);
    }
    const item = this.active;
    byID('empty').hidden = !!item; byID<HTMLButtonElement>('save').disabled = !item || item.imageLocked || item.closeLocked;
    byID('notice').hidden = !this.notice; byID('notice-text').textContent = this.notice;
    byID('paste-progress').hidden = !this.pasteJob;
    if (this.pasteJob) byID('paste-label').textContent = `${this.pasteJob.cancelRequested ? '正在取消' : '正在粘贴图片'}… · ${this.documents.get(this.pasteJob.documentID)?.title ?? ''}`;
    const labels = { loaded: '已打开', saving: '正在保存 · 可以继续输入', saved: '已保存', failure: '保存失败 · 编辑已保留', cancelled: '保存已取消', conflict: '检测到外部变更 · 未覆盖', unconfirmed: '保存结果未确认 · 请保留文档' };
    byID('status').textContent = item ? item.saves.error || `${labels[item.saves.state]}${item.saves.dirty ? ' · 有未保存修改' : ''}` : '创建或打开 Markdown 文档';
    this.updateCount();
  }
  receive(message: Record<string, unknown>): boolean {
    if (message.protocolVersion !== 1 || message.sessionID !== context.sessionID) return false;
    const kind = message.kind;
    if (kind === 'initialize' && !this.initialized) {
      this.initialized = true;
      const build = message.build as { version: string; stage: string };
      byID('build-label').textContent = `${build.stage === 'mvp-candidate' ? 'MVP' : '开发构建'} · ${build.version}`;
      byID('build-label').title = '本地应用 · 无账号 · 无云同步'; this.renderChrome();
    } else if (kind === 'load') this.load(message);
    else if (kind === 'activate') this.activate(String(message.documentID));
    else if (kind === 'initialReady') {
      this.view?.focus();
    } else if (kind === 'saveReceipt') {
      const item = this.documents.get(String(message.documentID));
      if (!item || !item.saves.accepts(message)) return false;
      if (message.outcome === 'success') {
        const changes = imageMigrationChanges(item.state.doc.toString(), (message.migration ?? {}) as Record<string, string>);
        if (changes.length) this.edit(item.id, { changes, annotations: Transaction.addToHistory.of(false) });
        item.title = String(message.title); item.path = String(message.path);
      }
      item.saves.receive(message); this.renderChrome();
    } else if (kind === 'pasteReceipt') this.pasteReceipt(message);
    else if (kind === 'closeReceipt') {
      const id = String(message.requestID), resolve = this.requests.get(id); this.requests.delete(id); resolve?.(message);
    } else if (kind === 'closeAllReceipt') {
      const permitted = message.permitted === true;
      if (permitted) {
        for (const item of this.documents.values()) { item.unsubscribe(); item.saves.dispose(); }
        this.documents.clear(); this.activeID = ''; this.view?.destroy(); this.view = null; byID('editor').replaceChildren();
      }
      else { for (const item of this.documents.values()) { item.closeLocked = false; this.lock(item); } this.notice = '关闭/退出已取消，所有编辑保持打开'; }
      this.closing = false; this.renderChrome();
    } else if (kind === 'mermaidReady') this.mermaidResolve?.();
    else if (kind === 'mermaidFailed') this.mermaidReject?.(new Error(String(message.error || '离线图表加载失败')));
    else if (kind === 'notice') this.setNotice(String(message.text));
    else if (kind === 'hostCommand') {
      if (message.action === 'closeAll') { void this.closeAll(String(message.requestID)); return true; }
      return this.command(String(message.action));
    }
    return true;
  }
}
const application = new EditorApplication();
globalThis.markfine = { receive: message => application.receive(message), prepareSnapshot: migrateImageReferences, stagedReferences };
application.post('ready');
