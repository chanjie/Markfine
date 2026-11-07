import { Compartment, EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands';
import { editorMarkdown } from './editor-language';
import { blockPreview, composition } from './preview';
import { SaveMachine, protectClose, protectCloseAll, type Context } from './save-machine';
import { formatTransaction, findMatch, replacementChanges } from './commands';
import { imageMigrationChanges, migrateImageReferences, stagedReferences } from './migration';
import { newID } from './protocol';
import { documentOutline, type OutlineHeading } from './outline';
import { defaultApplicationPreferences, normalizePreferences, preferencesEffect, sourceModeEffect } from './editor-preferences';
import { formatContext } from './format-context';
import { tableComposing, tableHasFocus, focusTableSelection, navigateTable } from './table-editor';
import { renderBlock } from './renderer';
import { t, setLanguage, localizePage, formatTimestamp } from './localization';
import { safeLink } from './links';
import { installOutlineResize, installScrollIndicators } from './ui-tools';
import { animateScroll, centerCaret, scrollReading, stopScroll, scrollToPosition } from './motion';
import { showHelp } from './help';
import { renderEmptyState } from './empty-state';
import { WorkspaceBrowser, type WorkspaceEntry } from './workspace-browser';
import { DiagramViewer } from './diagram-viewer';
import { replaceablePreview } from './preview-state';

declare global {
  var __markfineBootstrap: Context;
  var markfine: { receive(message: Record<string, unknown>): boolean; prepareSnapshot(source: string, mapping: Record<string, string>): string; stagedReferences(source: string): string[] };
  var __markfineRenderDiagram: ((source: string, documentID: string) => Promise<SVGElement>) | undefined;
}
export interface EditorDocument {
  id: string; title: string; path: string; state: EditorState; saves: SaveMachine; locks: Compartment;
  imageLocked: boolean; closeLocked: boolean; numbers: Compartment; sourceStyles: Compartment; preview: boolean; unsupported: boolean; readerScroll?: number; savedAt?: number;
  scroll?: ReturnType<EditorView['scrollSnapshot']>; unsubscribe: () => void;
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
  private preferences = { ...defaultApplicationPreferences };
  reading = false;
  private outlineHidden = false;
  private outlineBeforeReading = false;
  private outlineTimer = 0;
  private centerFrame = 0;
  private pointerSelecting = false;
  private preferenceTimers = new Map<string, number>();
  private readingDocument?: EditorState['doc'];
  private readingID = '';
  private readingLocale = '';
  private readingPosition = 0;
  private wasEmpty = true;
  private collapsed = new Map<string, Set<number>>();
  private hintTimer = 0;
  sourceEditing = false;
  private latestOpenRequest = '';
  private openRequests = new Map<string, { replaceID?: string; pin: boolean }>();
  private stalePreviewIDs = new Set<string>();
  private readonly diagramViewer = new DiagramViewer();
  private diagramTimers = new WeakMap<HTMLElement, number>();
  private readonly workspaceBrowser = new WorkspaceBrowser((kind, fields) => this.post(kind, fields), (entry, generation, pin) => this.openWorkspaceFile(entry, generation, pin),
    value => { this.applyPreferences({ showAllFiles: value }); this.persistPreference('showAllFiles', value); }, () => this.applyLayout());

  constructor() {
    byID('toggle-outline').onclick = () => this.toggleOutline();
    byID('hide-outline').onclick = () => this.toggleOutline();
    byID('toggle-reading').onclick = () => this.setReading(!this.reading);
    byID('exit-reading').onclick = () => this.setReading(false);
    byID('toggle-source').onclick = () => this.toggleSource();
    byID('move-outline').onclick = () => { const side = this.preferences.outlineSide === 'left' ? 'right' : 'left'; this.applyPreferences({ outlineSide: side }); this.persistPreference('outlineSide', side); };
    byID('open-unsupported').onclick = () => { if (this.active?.unsupported) this.post('openUnsupported', { documentID: this.activeID }); };
    byID('zoom-button').onclick = () => { const menu = byID('zoom-menu'); menu.hidden = !menu.hidden; byID('zoom-button').setAttribute('aria-expanded', String(!menu.hidden)); };
    for (const percent of [50, 75, 90, 100, 110, 125, 150, 175, 200]) {
      const button = document.createElement('button'); button.textContent = percent + '%'; button.setAttribute('role', 'menuitem'); button.dataset.percent = String(percent);
      button.onclick = () => { this.zoomBy(percent / 100 / this.zoom); byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); }; byID('zoom-menu').append(button);
    }
    document.addEventListener('pointerdown', event => { if (!(event.target instanceof Element && event.target.closest('.zoom-control'))) { byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); } });
    byID('document-title').onclick = () => this.setReading(false);
    installScrollIndicators();
    installOutlineResize(byID('outline-resize'), (width, persist) => {
      this.preferences.outlineWidth = Math.max(180, Math.min(360, width)); this.applyLayout();
      if (persist) this.persistPreference('outlineWidth', this.preferences.outlineWidth);
    });
    new ResizeObserver(() => { this.applyLayout(); this.scheduleCenter(); }).observe(byID('main'));
    byID('main').addEventListener('wheel', event => {
      if (event.metaKey || event.ctrlKey) { event.preventDefault(); this.zoomBy(Math.exp(-event.deltaY * .003)); }
      else for (const element of byID('main').querySelectorAll<HTMLElement>('.cm-scroller,.reader,pre,table,.diagram')) stopScroll(element);
    }, { passive: false });
    byID('editor').addEventListener('pointerdown', () => { this.pointerSelecting = true; if (this.view) stopScroll(this.view.scrollDOM); });
    document.addEventListener('pointerup', () => { if (this.pointerSelecting) { this.pointerSelecting = false; this.scheduleCenter(); } });
    byID('editor').addEventListener('compositionend', () => queueMicrotask(() => this.scheduleCenter()));
    byID('editor').addEventListener('transitionend', event => { if (event.target instanceof Element && event.target.classList.contains('link-syntax')) this.scheduleCenter(); });
    document.addEventListener('click', event => {
      const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-link-href],a[href]') : null;
      if (!link || !byID('main').contains(link)) return;
      if (link.tagName === 'A') event.preventDefault();
      if (event.button !== 0 || !event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      const href = link.dataset.linkHref ?? link.getAttribute('href');
      if (!this.active || !href || !safeLink(href)) return;
      if (href.startsWith('#')) { const anchor = byID('reader-content').querySelector<HTMLElement>('[id="' + CSS.escape(decodeURIComponent(href.slice(1))) + '"]'); if (anchor && this.reading) this.scrollReaderTo(anchor); }
      else if (event.isTrusted) this.post('openLink', { documentID: this.activeID, href });
    }, true);
    byID('reader').addEventListener('scroll', () => this.updateReadingOutline());
    byID('tab-strip').ondblclick = event => { if (event.target instanceof Element && !event.target.closest('button,.tab')) this.command('new'); };
    byID('editor').addEventListener('table-paste', () => this.requestPaste());
    byID('dismiss-notice').onclick = () => { this.notice = ''; this.renderChrome(); };
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
      if (event.defaultPrevented || event.isComposing || this.composing()) return;
      if (event.key === 'Escape' && !byID('zoom-menu').hidden) { byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); event.preventDefault(); return; }
      if (this.reading && !document.querySelector('dialog[open]') && !(event.target instanceof HTMLInputElement) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.key === 'Escape') { event.preventDefault(); this.setReading(false); return; }
        if (scrollReading(byID('reader'), event.key)) { event.preventDefault(); return; }
      }
      if (event.ctrlKey && !event.metaKey && event.key === 'Tab') { event.preventDefault(); this.switchTab(event.shiftKey ? -1 : 1); }
    });
    window.addEventListener('error', event => this.errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', event => this.errors.push(String(event.reason)));
    renderEmptyState();
  }
  post(kind: string, fields: Record<string, unknown> = {}): void {
    const { protocolVersion, sessionID, capability } = context;
    transport({ protocolVersion, sessionID, capability, kind, ...fields });
  }
  get active(): EditorDocument | undefined { return this.documents.get(this.activeID); }
  composing(): boolean { return !!this.view && (this.view.composing || this.view.state.field(composition) || tableComposing(this.view)); }
  setNotice(text: string): void { this.notice = text; this.renderChrome(); }

  private load(message: Record<string, unknown>): void {
    const id = String(message.documentID);
    const openRequest = String(message.openRequestID ?? '');
    const stale = !!openRequest && openRequest !== this.latestOpenRequest;
    if (this.documents.has(id)) { if (!stale) { this.stalePreviewIDs.delete(id); this.activate(id); this.finishWorkspaceOpen(openRequest, id); } return; }
    const locks = new Compartment(), numbers = new Compartment(), sourceStyles = new Compartment();
    const source = String(message.markdown), separator = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
    const state = EditorState.create({ doc: source, extensions: [
      history(), editorMarkdown(), EditorView.lineWrapping,
      locks.of(EditorState.readOnly.of(this.reading || message.unsupported === true)), numbers.of([]),
      sourceStyles.of(this.sourceEditing ? syntaxHighlighting(defaultHighlightStyle) : []),
      keymap.of([
        { key: 'Mod-s', run: () => { this.saveActive(); return true; } },
        ...(['left', 'right', 'up', 'down'] as const).map(direction => ({ key: 'Arrow' + direction[0].toUpperCase() + direction.slice(1), run: (view: EditorView) => !this.sourceEditing && navigateTable(view, direction) })),
        ...Object.entries({ 'Mod-b': 'bold', 'Mod-i': 'italic', 'Mod-k': 'link', 'Mod-Alt-k': 'inlineCode', 'Mod-Alt-c': 'codeBlock',
          'Mod-Alt-q': 'quote', 'Mod-Alt-o': 'ordered', 'Mod-Alt-u': 'unordered', 'Mod-Alt-x': 'task', 'Mod-Alt-t': 'table',
          'Ctrl-Shift-`': 'strike', 'Ctrl-Mod-i': 'image', 'Mod-]': 'indent', 'Mod-[': 'outdent',
          'Mod-0': 'heading0', 'Mod-1': 'heading1', 'Mod-2': 'heading2', 'Mod-3': 'heading3', 'Mod-4': 'heading4', 'Mod-5': 'heading5', 'Mod-6': 'heading6'
        }).map(([key, action]) => ({ key, run: () => this.command(action) })),
        ...historyKeymap, ...defaultKeymap
      ]),
      blockPreview(id, element => this.hydrate(element, id)),
      documentOutline,
      EditorView.contentAttributes.of(() => ({ 'aria-label': t('Markdown 正文', 'Markdown document'), spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })),
      EditorView.exceptionSink.of(error => { this.errors.push(String(error)); this.setNotice(t('编辑器发生异常，请保留当前内容：', 'Editor error. Keep your current content: ') + String(error)); }),
      EditorView.domEventHandlers({ paste: (event, view) => {
        if (view.composing || view.state.field(composition)) return false;
        event.preventDefault(); this.requestPaste(); return true;
      } }),
      EditorView.updateListener.of(update => {
        const item = this.documents.get(id); if (!item) return;
        item.state = update.state;
        if (update.docChanged && this.collapsed.has(id)) this.collapsed.set(id, new Set([...this.collapsed.get(id)!].map(from => update.changes.mapPos(from))));
        if (update.docChanged) { if (!item.unsupported) item.preview = false; item.saves.edited(update.state.doc); this.updateCount(); }
        // A focus-only blur must not replace a TOC button between mousedown and click.
        if (update.docChanged || update.selectionSet) this.renderOutline();
        if (update.docChanged || update.selectionSet || update.focusChanged) this.scheduleHint();
        if (update.docChanged && this.reading) this.renderReading();
        if (update.docChanged || update.selectionSet || update.focusChanged) this.scheduleCenter();
      })
    ] });
    const saves = new SaveMachine(context, id, state.doc, transport);
    saves.lineSeparator = separator;
    const item: EditorDocument = { id, title: String(message.title), path: String(message.path), state, saves, locks,
      imageLocked: false, closeLocked: false, numbers, sourceStyles, preview: message.preview === true, unsupported: message.unsupported === true, unsubscribe: () => {} };
    this.documents.set(id, item); item.unsubscribe = saves.subscribe(() => this.renderChrome());
    if (stale) { this.stalePreviewIDs.add(id); return; }
    if (!this.composing()) this.activate(id); else this.renderChrome();
    this.finishWorkspaceOpen(openRequest, id);
  }

  activate(id: string): boolean {
    if (this.composing()) { this.setNotice(t('请先完成当前中文组词', 'Finish the current input composition first')); return false; }
    const next = this.documents.get(id); if (!next) return false;
    if (next.closeLocked) return false;
    if (next.unsupported && this.reading) this.setReading(false);
    const previous = this.active;
    if (previous && this.view) { previous.state = this.view.state; previous.scroll = this.view.scrollSnapshot(); if (this.reading) previous.readerScroll = byID('reader').scrollTop; }
    this.activeID = id;
    if (this.view) this.view.setState(next.state);
    else this.view = new EditorView({ state: next.state, parent: byID('editor') });
    this.view.dispatch({ effects: [preferencesEffect.of(this.preferences), sourceModeEffect.of(this.sourceEditing), next.scroll ?? EditorView.scrollIntoView(next.state.selection.main.head, { y: 'nearest' })] });
    this.applyLayout();
    if (this.reading) { this.renderReading(); byID('reader').scrollTop = next.readerScroll ?? 0; byID('reader').focus({ preventScroll: true }); }
    else if (next.unsupported) byID('unsupported').focus();
    else { this.view.focus(); this.scheduleCenter(); }
    this.notice = ''; this.renderChrome(); this.post('activeDocument', { documentID: id });
    return true;
  }
  private switchTab(direction: number): void {
    const ids = [...this.documents.keys()]; if (!ids.length) return;
    this.activate(ids[(ids.indexOf(this.activeID) + direction + ids.length) % ids.length]);
  }
  edit(id: string, spec: TransactionSpec): boolean {
    const item = this.documents.get(id); if (!item) return false;
    if (item.unsupported && spec.changes) return false;
    if (this.activeID === id && this.view) this.view.dispatch(spec);
    else { const transaction = item.state.update(spec); item.state = transaction.state; if (transaction.docChanged) { item.preview = false; item.saves.edited(item.state.doc); } }
    return true;
  }
  private lock(item: EditorDocument): void {
    this.edit(item.id, { effects: item.locks.reconfigure(EditorState.readOnly.of(this.reading || item.unsupported || item.imageLocked || item.closeLocked)) });
  }
  saveActive(): boolean {
    const item = this.active;
    if (!item || item.unsupported || this.composing() || item.imageLocked || item.closeLocked) return false;
    this.notice = ''; item.saves.requestSave(); return true;
  }
  command(action: string): boolean {
    if (this.composing()) return false;
    if (action === 'toggleSource') { this.toggleSource(); return true; }
    if (action === 'toggleReading') { this.setReading(!this.reading); return true; }
    if (action === 'toggleLineNumbers') { this.applyPreferences({ lineNumbers: !this.preferences.lineNumbers }); this.persistPreference('lineNumbers', this.preferences.lineNumbers); return true; }
    if (action === 'help') { showHelp(byID<HTMLDialogElement>('help-dialog')); return true; }
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') { this.zoomBy(action === 'zoomReset' ? 1 / this.zoom : action === 'zoomIn' ? 1.1 : 1 / 1.1); return true; }
    if (action === 'toggleOutline') { this.toggleOutline(); return true; }
    if (action === 'new' || action === 'open') {
      if (this.closing) return false; this.post(action); return true;
    }
    if (action === 'save') return this.saveActive();
    if (action === 'close') {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
      if (dialog) { if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close(); return true; }
      if (this.active) void this.closeTab(this.active.id); else if (!this.closing) this.post('closeEmptyWindow'); return true;
    }
    if (action === 'nextTab' || action === 'previousTab') { this.switchTab(action === 'nextTab' ? 1 : -1); return true; }
    if (this.reading || this.active?.unsupported) return false;
    if (action === 'find' || action === 'replace') { this.showFind(action === 'replace'); return true; }
    if (action === 'findNext' || action === 'findPrevious') { this.find(action === 'findPrevious'); return true; }
    if (action === 'paste') { if (!this.view || !(this.view.hasFocus || tableHasFocus(this.view))) return false; this.requestPaste(); return true; }
    if (!this.view || !(this.view.hasFocus || tableHasFocus(this.view))) {
      if (['undo', 'redo'].includes(action) && document.activeElement instanceof HTMLInputElement) return document.execCommand(action);
      return false;
    }
    const item = this.active;
    if (!item || item.imageLocked || item.closeLocked) return false;
    if (action === 'undo' || action === 'redo') { const cell = tableHasFocus(this.view); const result = action === 'undo' ? undo(this.view) : redo(this.view); if (cell) focusTableSelection(this.view); return result; }
    const transaction = formatTransaction(this.view.state, action);
    if (!transaction) return false;
    const cell = tableHasFocus(this.view);
    this.view.dispatch({ ...transaction, annotations: isolateHistory.of('full') }); if (cell) focusTableSelection(this.view); return true;
  }

  showFind(replace: boolean): void {
    if (!this.active || this.composing()) return;
    byID('find-panel').hidden = false; byID('replace-row').hidden = !replace;
    const selected = this.active.state.sliceDoc(this.active.state.selection.main.from, this.active.state.selection.main.to);
    if (selected && !selected.includes('\n')) byID<HTMLInputElement>('query').value = selected;
    byID<HTMLInputElement>('query').focus(); byID<HTMLInputElement>('query').select();
    this.updateFindCount();
  }
  hideFind(): void { if (this.composing()) return; byID('find-panel').hidden = true; if (!this.reading) { this.view?.focus(); this.scheduleCenter(); } }
  find(backwards: boolean, fromStart = false): boolean {
    const item = this.active; if (!item || this.composing()) return false;
    const query = byID<HTMLInputElement>('query').value;
    const match = findMatch(item.state.doc.toString(), query, fromStart ? 0 : backwards ? item.state.selection.main.from : item.state.selection.main.to, backwards);
    if (match) this.edit(item.id, { selection: EditorSelection.single(match.from, match.to), scrollIntoView: true });
    this.updateFindCount(); return !!match;
  }
  replace(all: boolean): boolean {
    const item = this.active;
    if (!item || this.reading || item.imageLocked || item.closeLocked || this.composing()) return false;
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
    byID('matches').textContent = query && this.active ? `${replacementChanges(this.active.state.doc.toString(), query, '').length} ${t('处匹配', 'matches')}` : t('输入查找内容', 'Enter search text');
  }

  requestPaste(): boolean {
    const item = this.active;
    if (!item || item.unsupported || this.reading || this.composing() || item.closeLocked || item.imageLocked) return false;
    if (this.pasteJob || item.saves.pending) { this.setNotice(t('请先等待当前图片任务或该文档保存完成', 'Wait for the current image task or document save to finish')); return false; }
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
      const insert = typeof message.reference === 'string' ? `![${t('图片', 'Image')}](${message.reference})` : typeof message.text === 'string' ? message.text : '';
      if (insert) this.edit(item.id, { changes: { from: job.selection.main.from, to: job.selection.main.to, insert },
        selection: EditorSelection.single(job.selection.main.from + insert.length), userEvent: 'input.paste', annotations: isolateHistory.of('full') });
    } else if (message.outcome === 'failure') this.notice = String(message.error || t('粘贴失败，正文未改变', 'Paste failed. The document is unchanged'));
    this.renderChrome();
  }

  private chooseClose(item: EditorDocument): Promise<'save' | 'discard' | 'cancel'> {
    const dialog = byID<HTMLDialogElement>('close-dialog');
    byID('close-title').textContent = t(`保存对“${this.displayTitle(item)}”的更改？`, `Save changes to “${this.displayTitle(item)}”?`);
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
      if (!await protectClose(item.saves, () => this.chooseClose(item))) { this.setNotice(t('关闭已取消或保存未完成，编辑内容已保留', 'Close cancelled or save incomplete. Your edits are retained')); return false; }
      item.closeLocked = true; this.lock(item);
      const result = await this.request('closeDocument', { documentID: id, revision: item.saves.revision });
      if (result.permitted !== true) { item.closeLocked = false; this.lock(item); this.setNotice(t('关闭未获确认，文档已保留', 'Close was not confirmed. The document remains open')); return false; }
      this.remove(item); this.renderChrome(); return true;
    } finally { this.closing = false; }
  }
  private remove(item: EditorDocument): void {
    this.stalePreviewIDs.delete(item.id);
    item.unsubscribe(); item.saves.dispose(); this.documents.delete(item.id);
    if (this.activeID === item.id) {
      this.activeID = ''; const next = this.documents.keys().next().value;
      if (next) this.activate(next); else { this.view?.destroy(); this.view = null; byID('editor').replaceChildren(); if (this.reading) this.setReading(false); }
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
      // Reading is a complete local render; do not leave document images waiting on editor viewport activity.
      image.loading = this.reading ? 'eager' : 'lazy';
      image.onerror = () => { image.classList.add('image-error'); image.title = t('本地图片不可用或超出文档权限', 'Local image is unavailable or outside document permissions'); };
      const size = () => {
        if (image.naturalWidth > 0) { image.style.setProperty('--image-width', image.naturalWidth + 'px'); image.style.width = 'calc(var(--image-width) * var(--content-zoom))'; }
        this.view?.requestMeasure();
      };
      image.onload = size; if (image.complete) size();
    }
    for (const diagram of element.querySelectorAll<HTMLElement>('[data-diagram]')) {
      const source = diagram.dataset.diagram!, token = newID(); diagram.dataset.renderToken = token;
      const retained = !!diagram.querySelector('svg'); clearTimeout(this.diagramTimers.get(diagram));
      const render = () => void this.ensureMermaid().then(async () => {
        if (!diagram.isConnected) return;
        const svg = await globalThis.__markfineRenderDiagram!(source, documentID);
        const width = Number(svg.getAttribute('viewBox')?.split(/[ ,]+/)[2]);
        if (Number.isFinite(width) && width > 0) { svg.style.removeProperty('max-width'); svg.style.width = `calc(${width}px * var(--content-zoom))`; svg.style.minWidth = `calc(${width * .8}px * var(--content-zoom))`; svg.style.height = 'auto'; }
        if (diagram.isConnected && diagram.dataset.renderToken === token) {
          const tools = document.createElement('div'); tools.className = 'diagram-tools';
          const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = t('放大查看 ↗', 'Enlarge ↗'); expand.onmousedown = event => event.preventDefault();
          expand.onclick = event => { event.preventDefault(); event.stopPropagation(); this.diagramViewer.show(svg); }; tools.append(expand);
          const canvas = document.createElement('div'); canvas.className = 'diagram-inline'; canvas.append(svg); diagram.replaceChildren(tools, canvas); this.view?.requestMeasure();
        }
      }).catch(error => {
        if (!diagram.isConnected || diagram.dataset.renderToken !== token) return;
        const hint = diagram.querySelector('small') ?? document.createElement('small');
        hint.textContent = t('图表保留源码：', 'Diagram source retained: ') + String(error); if (!hint.isConnected) diagram.append(hint);
      });
      if (retained) this.diagramTimers.set(diagram, window.setTimeout(render, 160)); else render();
    }
  }
  private updateCount(): void {
    const item = this.active;
    byID('count').textContent = item && !item.unsupported ? `${item.state.doc.length.toLocaleString()} ${t('字符', 'characters')} · ${item.state.doc.lines} ${t('行', 'lines')}` : item ? '—' : 'Markdown · UTF-8';
    byID('zoom-button').textContent = `${Math.round(this.zoom * 100)}%`;
    this.updateFindCount();
  }
  private toggleOutline(): void {
    if (this.reading) return;
    this.outlineHidden = !this.outlineHidden;
    clearTimeout(this.outlineTimer);
    if (this.outlineHidden) {
      byID('outline-panel').classList.add('collapsed'); byID('outline').inert = true;
      this.outlineTimer = window.setTimeout(() => { if (this.outlineHidden) byID('outline').hidden = true; }, 240);
    } else {
      byID('outline').hidden = false; byID('outline').inert = false;
      // Commit the collapsed geometry before transitioning back; state must not depend on a future frame.
      byID('outline').getBoundingClientRect(); byID('outline-panel').classList.remove('collapsed');
      this.outlineTimer = window.setTimeout(() => {
        if (this.outlineHidden) return;
        for (const element of [byID('outline-panel'), byID('outline')]) for (const animation of element.getAnimations()) animation.finish();
        this.view?.requestMeasure();
      }, 240);
    }
    byID('toggle-outline').setAttribute('aria-expanded', String(!this.outlineHidden));
    this.view?.requestMeasure();
  }
  private scheduleHint(): void {
    clearTimeout(this.hintTimer); byID('format-hint').textContent = '';
    if (this.reading || !this.preferences.shortcutHints || !this.view || this.composing()) return;
    this.hintTimer = window.setTimeout(() => {
      if (this.view && !this.composing() && (this.view.hasFocus || tableHasFocus(this.view))) byID('format-hint').textContent = formatContext(this.view.state);
    }, 450);
  }
  private renderOutline(): void {
    const tree = byID('outline-tree'); tree.replaceChildren();
    const item = this.active;
    if (!item) { byID('outline-empty').hidden = false; return; }
    const headings = item.state.field(documentOutline), collapsed = this.collapsed.get(item.id) ?? new Set<number>();
    this.collapsed.set(item.id, collapsed);
    byID('outline-empty').hidden = headings.length > 0;
    const position = this.reading ? this.readingPosition : item.state.selection.main.head;
    let current = -1;
    const flatten = (items: OutlineHeading[]) => { for (const heading of items) { if (heading.from <= position) current = heading.from; flatten(heading.children); } }; flatten(headings);
    const append = (items: OutlineHeading[], parent: HTMLElement, depth: number) => {
      for (const heading of items) {
        const row = document.createElement('div'); row.className = 'outline-item'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
        const line = document.createElement('div'); line.className = 'outline-row' + (heading.from === current ? ' current' : ''); line.style.paddingLeft = `${depth * 14}px`;
        const toggle = document.createElement('button'); toggle.className = 'outline-disclosure' + (collapsed.has(heading.from) ? ' folded' : ''); toggle.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m3 1 4 4-4 4"/></svg>';
        toggle.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
        toggle.disabled = !heading.children.length; toggle.setAttribute('aria-label', `${collapsed.has(heading.from) ? t('展开', 'Expand') : t('折叠', 'Collapse')} ${heading.title}`);
        if (heading.children.length) row.setAttribute('aria-expanded', String(!collapsed.has(heading.from)));
        toggle.onclick = () => { if (collapsed.has(heading.from)) collapsed.delete(heading.from); else collapsed.add(heading.from); this.renderOutline(); };
        const link = document.createElement('button'); link.className = 'outline-link'; link.textContent = heading.title; link.title = heading.title;
        link.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
        link.onclick = () => {
          if (this.composing() || !this.view) return;
          if (this.reading) {
            const line = item.state.doc.lineAt(heading.from).number - 1;
            const target = byID('reader-content').querySelector<HTMLElement>(`h${heading.level}[data-source-line="${line}"]`);
            if (target) this.scrollReaderTo(target);
          } else { this.view.dispatch({ selection: EditorSelection.cursor(heading.from) }); this.view.focus(); scrollToPosition(this.view, heading.from); }
        };
        line.append(toggle, link); row.append(line); parent.append(row);
        if (!collapsed.has(heading.from) && heading.children.length) { const group = document.createElement('div'); group.setAttribute('role', 'group'); row.append(group); append(heading.children, group, depth + 1); }
      }
    };
    append(headings, tree, 0);
  }
  renderChrome(): void {
    const tabs = byID('tabs'); tabs.replaceChildren();
    for (const item of this.documents.values()) {
      if (this.stalePreviewIDs.has(item.id)) continue;
      const row = document.createElement('div'); row.className = 'tab' + (item.id === this.activeID ? ' active' : '') + (item.preview || item.unsupported ? ' preview-tab' : ''); row.setAttribute('role', 'presentation');
      const select = document.createElement('button'); select.type = 'button'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(item.id === this.activeID));
      select.title = item.path || t('尚未保存', 'Not yet saved');
      if (item.saves.dirty) { const dot = document.createElement('span'); dot.className = 'dirty'; dot.setAttribute('aria-label', t('未保存', 'Unsaved')); select.append(dot); }
      select.append(document.createTextNode(this.displayTitle(item)));
      if ([...this.documents.values()].filter(other => other.title === item.title).length > 1) {
        const suffix = document.createElement('small'); suffix.textContent = item.path ? item.path.split('/').at(-2) ?? '' : item.id.slice(0, 4); select.append(suffix);
      }
      select.onclick = () => this.activate(item.id);
      select.ondblclick = () => this.pin(item);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close-tab'; close.textContent = '×'; close.setAttribute('aria-label', `${t('关闭', 'Close')} ${this.displayTitle(item)}`);
      close.onclick = () => { void this.closeTab(item.id); }; close.disabled = item.imageLocked || item.closeLocked;
      row.append(select, close); tabs.append(row);
    }
    const item = this.active;
    byID('empty').hidden = !!item;
    if (!item && !this.wasEmpty) renderEmptyState(true); this.wasEmpty = !item;
    byID<HTMLButtonElement>('toggle-reading').disabled = !item || item.unsupported;
    byID<HTMLButtonElement>('toggle-source').disabled = !item || item.unsupported;
    byID<HTMLButtonElement>('zoom-button').disabled = !item || item.unsupported;
    byID('toggle-source').setAttribute('aria-pressed', String(this.sourceEditing));
    byID('unsupported').hidden = !item?.unsupported; byID('unsupported-name').textContent = item?.unsupported ? item.title : '';
    byID('editor').hidden = this.reading || !!item?.unsupported;
    byID('document-title').textContent = item ? this.displayTitle(item) : '';
    byID('notice').hidden = !this.notice; byID('notice-text').textContent = this.notice;
    byID('paste-progress').hidden = !this.pasteJob;
    if (this.pasteJob) byID('paste-label').textContent = `${this.pasteJob.cancelRequested ? t('正在取消', 'Cancelling') : t('正在粘贴图片', 'Pasting image')}… · ${this.documents.get(this.pasteJob.documentID)?.title ?? ''}`;
    const labels = { loaded: '已打开', saving: '正在保存 · 可以继续输入', saved: '已保存', failure: '保存失败 · 编辑已保留', cancelled: '保存已取消', conflict: '检测到外部变更 · 未覆盖', unconfirmed: '保存结果未确认 · 请保留文档' };
    const english = { loaded: 'Opened', saving: 'Saving · You can keep typing', saved: 'Saved', failure: 'Save failed · Edits retained', cancelled: 'Save cancelled', conflict: 'External changes detected · Not overwritten', unconfirmed: 'Save unconfirmed · Keep this document open' };
    byID('status').textContent = item ? item.saves.error || `${t(labels[item.saves.state], english[item.saves.state])}${item.saves.dirty ? t(' · 有未保存修改', ' · Unsaved changes') : ''}${item.savedAt ? ' · ' + formatTimestamp(item.savedAt, this.preferences.timeZone) : ''}` : t('创建或打开 Markdown 文档', 'Create or open a Markdown document');
    this.updateCount(); this.renderOutline(); this.scheduleHint();
  }
  receive(message: Record<string, unknown>): boolean {
    if (message.protocolVersion !== 1 || message.sessionID !== context.sessionID) return false;
    const kind = message.kind;
    if (this.workspaceBrowser.receive(message)) { if (kind === 'workspace') { this.latestOpenRequest = ''; this.openRequests.clear(); this.cleanupStalePreviews(''); } return true; }
    if (kind === 'openFailed') { if (message.openRequestID === this.latestOpenRequest) this.finishWorkspaceOpen(String(message.openRequestID), ''); return true; }
    if (kind === 'initialize' && !this.initialized) {
      this.initialized = true;
      this.applyPreferences(message.preferences); this.renderChrome();
    } else if (kind === 'load') this.load(message);
    else if (kind === 'activate') {
      const request = String(message.openRequestID ?? ''); if (request && request !== this.latestOpenRequest) return true;
      this.stalePreviewIDs.delete(String(message.documentID));
      const item = this.documents.get(String(message.documentID)); if (item && message.pin === true) this.pin(item);
      this.activate(String(message.documentID)); this.finishWorkspaceOpen(request, String(message.documentID));
    }
    else if (kind === 'initialReady') {
      if (!this.reading) this.view?.focus();
    } else if (kind === 'preferences') this.applyPreferences(message.preferences);
    else if (kind === 'saveReceipt') {
      const item = this.documents.get(String(message.documentID));
      if (!item || !item.saves.accepts(message)) return false;
      if (message.outcome === 'success') {
        const changes = imageMigrationChanges(item.state.doc.toString(), (message.migration ?? {}) as Record<string, string>);
        if (changes.length) this.edit(item.id, { changes, annotations: Transaction.addToHistory.of(false) });
        item.title = String(message.title); item.path = String(message.path);
        item.savedAt = typeof message.savedAt === 'number' ? message.savedAt : Date.now();
      }
      item.saves.receive(message); this.renderChrome();
    } else if (kind === 'pasteReceipt') this.pasteReceipt(message);
    else if (kind === 'closeReceipt') {
      const id = String(message.requestID), resolve = this.requests.get(id); this.requests.delete(id); resolve?.(message);
    } else if (kind === 'closeAllReceipt') {
      const permitted = message.permitted === true;
      if (permitted) {
        for (const item of this.documents.values()) { item.unsubscribe(); item.saves.dispose(); }
        this.documents.clear(); this.stalePreviewIDs.clear(); this.activeID = ''; this.view?.destroy(); this.view = null; byID('editor').replaceChildren();
      }
      else { for (const item of this.documents.values()) { item.closeLocked = false; this.lock(item); } this.notice = t('关闭/退出已取消，所有编辑保持打开', 'Close / Quit cancelled. All documents remain open'); }
      this.closing = false; this.renderChrome();
    } else if (kind === 'mermaidReady') this.mermaidResolve?.();
    else if (kind === 'mermaidFailed') this.mermaidReject?.(new Error(String(message.error || t('离线图表加载失败', 'Offline diagram failed to load'))));
    else if (kind === 'notice') this.setNotice(String(message.text));
    else if (kind === 'hostCommand') {
      if (message.action === 'zoom' && typeof message.factor === 'number') { if (this.diagramViewer.open) this.diagramViewer.zoom(message.factor); else this.zoomBy(message.factor); return true; }
      if (message.action === 'closeAll') { void this.closeAll(String(message.requestID)); return true; }
      return this.command(String(message.action));
    }
    return true;
  }
  private applyPreferences(value: unknown): void {
    const before = this.preferences;
    this.preferences = normalizePreferences(value, this.preferences);
    setLanguage(this.preferences.locale); localizePage(); renderEmptyState();
    if (before.focusMode !== this.preferences.focusMode || before.lineNumbers !== this.preferences.lineNumbers || before.shortcutHints !== this.preferences.shortcutHints || before.locale !== this.preferences.locale)
      for (const item of this.documents.values()) this.edit(item.id, { effects: preferencesEffect.of(this.preferences) });
    let fonts = document.getElementById('user-fonts'); if (!fonts) { fonts = document.createElement('style'); fonts.id = 'user-fonts'; document.head.append(fonts); }
    const rules = `@font-face{font-family:"Markfine Latin";src:local(${JSON.stringify(this.preferences.fontEnglish)});unicode-range:U+0000-024F,U+1E00-1EFF}@font-face{font-family:"Markfine CJK";src:local(${JSON.stringify(this.preferences.fontChinese)});unicode-range:U+0250-1DFF,U+2000-10FFFF}`;
    if (fonts.textContent !== rules) fonts.textContent = rules;
    this.workspaceBrowser.setPreferences(this.preferences.showAllFiles); this.moveOutline(this.preferences.outlineSide, before.outlineSide !== this.preferences.outlineSide);
    this.applyLayout(); this.renderChrome(); if (this.reading) this.renderReading(); else this.scheduleCenter();
  }
  private displayTitle(item: EditorDocument): string { return item.path ? item.title : t('未命名', 'Untitled'); }
  private persistPreference(key: string, value: unknown, delay = 0): void {
    clearTimeout(this.preferenceTimers.get(key));
    if (delay) this.preferenceTimers.set(key, window.setTimeout(() => { this.preferenceTimers.delete(key); this.post('setPreference', { key, value }); }, delay));
    else this.post('setPreference', { key, value });
  }
  private get zoom(): number { return this.preferences[this.reading ? 'readZoom' : 'editZoom']; }
  private zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const key = this.reading ? 'readZoom' : 'editZoom'; this.preferences[key] = Math.max(.5, Math.min(2, this.zoom * factor));
    this.applyLayout(); this.updateCount(); this.persistPreference(key, this.preferences[key], 200);
    // Commit CSS geometry in this input turn. Persistence must never be the repaint trigger.
    byID('main').getBoundingClientRect();
  }
  private applyLayout(): void {
    const root = document.documentElement;
    root.style.setProperty('--outline-width', `${this.preferences.outlineWidth}px`);
    root.style.setProperty('--content-zoom', String(this.zoom)); root.style.setProperty('--editor-height', `${byID('main').clientHeight}px`);
    root.dataset.theme = this.preferences[this.reading ? 'readTheme' : 'editTheme'];
    root.dataset.outlineSide = this.preferences.outlineSide;
    document.body.classList.toggle('line-numbers-on', this.preferences.lineNumbers); document.body.classList.toggle('source-mode', this.sourceEditing);
    byID('outline-resize').setAttribute('aria-valuenow', String(this.preferences.outlineWidth));
    byID('reader').classList.toggle('reader-line-numbers', this.preferences.lineNumbers); this.view?.requestMeasure();
  }
  private scheduleCenter(): void {
    if (this.reading || this.pointerSelecting || this.composing() || this.centerFrame) return;
    this.centerFrame = requestAnimationFrame(() => { this.centerFrame = 0; if (this.view && !this.reading && !this.pointerSelecting && !this.composing()) centerCaret(this.view); });
  }
  setReading(enabled: boolean): void {
    if (enabled === this.reading || this.composing() || enabled && (!this.active || this.active.unsupported || this.pasteJob)) return;
    if (enabled) {
      this.pin(this.active!);
      this.outlineBeforeReading = this.outlineHidden;
      if (this.outlineHidden) this.toggleOutline();
      this.readingPosition = this.active!.state.selection.main.head;
      if (this.view) { this.active!.scroll = this.view.scrollSnapshot(); stopScroll(this.view.scrollDOM); }
      byID('find-panel').hidden = true;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); getSelection()?.removeAllRanges();
    } else if (this.active) this.active.readerScroll = byID('reader').scrollTop;
    this.reading = enabled;
    for (const item of this.documents.values()) this.lock(item);
    document.body.classList.toggle('reading', enabled); byID('reading-header').hidden = !enabled;
    byID('editor').hidden = enabled; byID('reader').hidden = !enabled;
    this.applyLayout();
    if (enabled) { this.renderReading(); byID('reader').scrollTop = this.active!.readerScroll ?? 0; byID('reader').focus({ preventScroll: true }); }
    else {
      if (this.outlineBeforeReading && !this.outlineHidden) this.toggleOutline();
      this.view?.focus(); this.scheduleCenter();
    }
    this.renderChrome(); this.post('readingMode', { enabled });
  }
  private renderReading(): void {
    const item = this.active; if (!item || !this.reading) return;
    if (this.readingDocument === item.state.doc && this.readingID === item.id && this.readingLocale === this.preferences.locale) return;
    this.readingDocument = item.state.doc; this.readingID = item.id; this.readingLocale = this.preferences.locale;
    const content = byID('reader-content'); content.innerHTML = renderBlock(item.state.doc.toString(), item.id);
    for (const node of content.querySelectorAll<HTMLElement>('[data-source-line]')) node.dataset.line = String(Number(node.dataset.sourceLine) + 1);
    const slugs = new Map<string, number>();
    for (const heading of content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
      const base = (heading.textContent ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
      const count = slugs.get(base) ?? 0; heading.id = base + (count ? '-' + count : ''); slugs.set(base, count + 1);
    }
    this.hydrate(content, item.id);
  }
  private scrollReaderTo(element: HTMLElement): void {
    const reader = byID('reader'); animateScroll(reader, reader.scrollTop + element.getBoundingClientRect().top - reader.getBoundingClientRect().top - 40);
  }
  private updateReadingOutline(): void {
    if (!this.reading || !this.active) return;
    const reader = byID('reader'), boundary = reader.getBoundingClientRect().top + reader.clientHeight * .25;
    let line = 1;
    for (const heading of byID('reader-content').querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) { if (heading.getBoundingClientRect().top > boundary) break; line = Number(heading.dataset.sourceLine) + 1; }
    const position = this.active.state.doc.line(Math.max(1, Math.min(line, this.active.state.doc.lines))).from;
    if (position !== this.readingPosition) { this.readingPosition = position; this.renderOutline(); }
  }
  private pin(item: EditorDocument): void { if (!item.unsupported && !item.closeLocked && item.preview) { item.preview = false; this.renderChrome(); } }
  private openWorkspaceFile(entry: WorkspaceEntry, generation: string, pin: boolean): void {
    if (this.closing || this.composing()) return;
    const requestID = newID(), current = this.active;
    this.latestOpenRequest = requestID; this.openRequests.clear();
    this.openRequests.set(requestID, { replaceID: replaceablePreview(current, this.composing()) ? current!.id : undefined, pin });
    this.post('openWorkspaceEntry', { entryID: entry.id, generation, requestID });
  }
  private finishWorkspaceOpen(request: string, id: string): void {
    if (!request) return;
    const plan = this.openRequests.get(request); this.openRequests.delete(request);
    const next = this.documents.get(id); if (next && plan?.pin) this.pin(next);
    const old = plan?.replaceID && this.documents.get(plan.replaceID);
    if (id && old && old.id !== id && replaceablePreview(old, this.composing())) this.retirePreview(old);
    this.cleanupStalePreviews(id);
  }
  private cleanupStalePreviews(retain: string): void {
    for (const id of this.stalePreviewIDs) {
      this.stalePreviewIDs.delete(id); const item = this.documents.get(id);
      if (item && id !== retain && replaceablePreview(item)) this.retirePreview(item);
    }
  }
  private retirePreview(item: EditorDocument): void {
    item.closeLocked = true; this.lock(item);
    void this.request('closeDocument', { documentID: item.id, revision: item.saves.revision }).then(result => {
      if (result.permitted === true) this.remove(item); else { item.closeLocked = false; this.lock(item); } this.renderChrome();
    });
  }
  private toggleSource(): void {
    if (!this.active || this.active.unsupported || this.composing()) return;
    const enabled = this.reading ? true : !this.sourceEditing; if (this.reading) this.setReading(false);
    this.sourceEditing = enabled;
    for (const item of this.documents.values()) this.edit(item.id, { effects: [sourceModeEffect.of(enabled), item.sourceStyles.reconfigure(enabled ? syntaxHighlighting(defaultHighlightStyle) : [])] });
    this.applyLayout(); this.renderChrome(); this.view?.focus();
  }
  private moveOutline(side: 'left' | 'right', animate: boolean): void {
    const panel = byID('outline-panel'), target = byID(side === 'left' ? 'left-navigation' : 'right-navigation'); if (panel.parentElement === target) return;
    const before = panel.getBoundingClientRect(); target.append(panel); document.documentElement.dataset.outlineSide = side;
    const after = panel.getBoundingClientRect();
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const motion = panel.animate([{ transform: `translate(${before.left - after.left}px,${before.top - after.top}px)`, opacity: .65 }, { transform: 'translate(0,0)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.18,.75,.2,1)' });
      window.setTimeout(() => motion.finish(), 430);
    }
  }
}
const application = new EditorApplication();
globalThis.markfine = { receive: message => application.receive(message), prepareSnapshot: migrateImageReferences, stagedReferences };
application.post('ready');
