import './offline-policy';
import { Compartment, EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands';
import { editorMarkdown } from './editor-language';
import { blockPreview, composition } from './preview';
import { SaveMachine, protectClose, protectCloseAll, type Context } from './save-machine';
import { formatTransaction, findMatch, replacementChanges, literalPattern, physicalFormatShortcut } from './commands';
import { deletionTransaction } from './deletion';
import { imageMigrationChanges, migrateImageReferences, stagedReferences } from './migration';
import { newID } from './protocol';
import { documentOutline, type OutlineHeading } from './outline';
import { bodyLineHeight, editingLineHeight, defaultApplicationPreferences, normalizePreferences, preferencesEffect, sourceModeEffect } from './editor-preferences';
import { formatContext } from './format-context';
import { tableComposing, tableHasFocus, focusTableSelection, navigateTable, deleteTableCell,tableCopySelection,tableHasRange,tableCellSelection } from './table-editor';
import { renderBlock,configureImageSources } from './renderer';
import { t, setLanguage, localizePage, formatTimestamp } from './localization';
import { safeLink } from './links';
import { installOutlineResize, installScrollIndicators } from './ui-tools';
import { animateScroll, centerCaret, scrollReading, stopScroll, scrollToPosition } from './motion';
import { showHelp } from './help';
import { renderEmptyState } from './empty-state';
import { WorkspaceBrowser, type WorkspaceEntry } from './workspace-browser';
import { DiagramViewer } from './diagram-viewer';
import { replaceablePreview } from './preview-state';
import { tabLabel, closeTargets, showTabMenu, installReadingTabs, pathTooltip, type TabCloseScope } from './tab-navigation';
import { SearchHighlights } from './search-highlights';
import { CopyHighlight } from './copy-highlight';
import { exportHTML } from './document-output';
import { fileIcon } from './file-icons';
import { decodeFragment, headingTargets } from './heading-navigation';
import { DocumentTransition } from './document-transition';
import { sourceLinkTarget } from './inline-presentation';
import { referenceIndex } from './reference-context';
import { chapterRange,paragraphRange,copyMarkdown,imageSources,inlinePlainText,type SourceRange } from './content-fragment';
import { replaceImageDestinations } from './image-syntax';
import { ImageControls } from './image-controls';
import { contextMenu, preserveContextSelection, isContextGesture } from './context-menu';
import { slashMenu } from './slash-menu';
import { pairedPunctuation } from './paired-punctuation';
import { preserveLineEndings, lineEndings, serializeText, textPresentation, textParagraphRange, renderText, textSnapshot, selectedRawText } from './text-document';

declare global {
  var __markfineBootstrap: Context;
  var markfine: { receive(message: Record<string, unknown>): boolean; prepareSnapshot(source: string, mapping: Record<string, string>): string; stagedReferences(source: string): string[]; imageSources(source:string):string[];replaceImageDestinations(source:string,mapping:Record<string,string>):string;exportSnapshot(id: string): Promise<{ html: string; resources: string[] }> };
  var __markfineRenderDiagram: ((source: string, documentID: string) => Promise<SVGElement>) | undefined;
}
export interface EditorDocument {
  id: string; title: string; path: string; state: EditorState; saves: SaveMachine; locks: Compartment;
  imageLocked: boolean; closeLocked: boolean; copyLocked:boolean;numbers: Compartment; sourceStyles: Compartment; preview: boolean; unsupported: boolean; readerScroll?: number; savedAt?: number;
  scroll?: ReturnType<typeof EditorView.scrollIntoView>; scrollLeft?: number; unsubscribe: () => void;
  resume?: { mode: string; line: number; fraction: number }; resumeShown?: boolean;
  textFile: boolean; language: string; encoding: string;
}
interface PasteJob { id: string; documentID: string; revision: number; selection: EditorSelection; cancelRequested: boolean; failure?:string;tableTarget:boolean }
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
  private copyFeedbackID = 0;
  private copyFeedbackTimer = 0;
  private initialized = false;
  private mermaidPromise?: Promise<void>;
  private mermaidResolve?: () => void;
  private mermaidReject?: (error: Error) => void;
  private requests = new Map<string, (value: Record<string, unknown>) => void>();
  private preferences = { ...defaultApplicationPreferences };
  reading = false;
  private outlineHidden = false;
  private filesHidden = false;
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
  private openRequests = new Map<string, { replaceID?: string; pin: boolean; link?: boolean }>();
  private stalePreviewIDs = new Set<string>();
  private readonly diagramViewer = new DiagramViewer();
  private diagramTimers = new WeakMap<HTMLElement, number>();
  private diagramPromises = new WeakMap<HTMLElement, Promise<void>>();
  private positionJump = 0;
  private resumeTimer = 0;
  private findGeneration = 0;
  private pendingMatch?: { view: EditorView; position: number; run: () => void };
  private findOffset = 0;
  private searchRoom = 0;
  private readonly highlights = new SearchHighlights(() => byID(this.reading ? 'reader-content' : 'editor'));
  private readonly copyHighlight = new CopyHighlight();
  private diagnostics = new Map<string, number>();
  private readonly documentTransition = new DocumentTransition(byID('main'), byID('document-title'));
  private readonly imageControls=new ImageControls({source:id=>this.documents.get(id)?.state.doc.toString(),canEdit:id=>this.activeID===id&&!this.reading&&!this.composing()&&!this.documents.get(id)?.imageLocked&&!this.documents.get(id)?.copyLocked&&!this.closing,zoom:()=>this.zoom,change:(id,change)=>{this.edit(id,{changes:change,annotations:isolateHistory.of('full'),userEvent:'input.imageSize'});},measure:()=>this.view?.requestMeasure()});
  private readonly workspaceBrowser = new WorkspaceBrowser((kind, fields) => this.post(kind, fields), (entry, generation, pin) => this.openWorkspaceFile(entry, generation, pin),
    value => { this.applyPreferences({ showAllFiles: value }); this.persistPreference('showAllFiles', value); }, () => { this.applyLayout(); this.renderChrome(); });

  constructor() {
    preserveContextSelection(() => {
      const item = this.active, editable = !!item && !this.reading && !item.unsupported && !item.imageLocked && !item.copyLocked && !item.closeLocked && !this.composing();
      return [
        { label: t('复制', 'Copy'), disabled: !editable, run: () => { void this.copyContent(); } },
        { label: t('剪切', 'Cut'), disabled: !editable || !item || item.state.selection.main.empty, run: () => { void this.copyContent(undefined, true); } },
        { label: t('粘贴', 'Paste'), disabled: !editable, run: () => { this.requestPaste(); } }
      ];
    });
    byID<HTMLInputElement>('show-workspace-recents').onchange = event => { const value = (event.target as HTMLInputElement).checked; this.applyPreferences({ showWorkspaceRecents: value }); this.persistPreference('showWorkspaceRecents', value); };
    byID('toggle-outline').onclick = () => this.toggleOutline();
    byID('hide-outline').onclick = () => this.toggleOutline();
    byID('toggle-files').onclick = () => this.toggleFiles();
    byID('hide-files').onclick = () => this.toggleFiles();
    byID('toggle-reading').onclick = () => this.setReading(!this.reading);
    byID('exit-reading').onclick = () => this.setReading(false);
    byID('toggle-source').onclick = () => this.toggleSource();
    byID('move-outline').onclick = () => { const side = this.preferences.outlineSide === 'left' ? 'right' : 'left'; this.applyPreferences({ outlineSide: side }); this.persistPreference('outlineSide', side); };
    byID('move-files').onclick = () => { const side = this.preferences.filesSide === 'left' ? 'right' : 'left'; this.applyPreferences({ filesSide: side }); this.persistPreference('filesSide', side); };
    installReadingTabs(byID('tab-strip'), byID('tabs-trigger'));
    byID('resume-position').onclick = () => this.resumePosition();
    byID('open-unsupported').onclick = () => { if (this.active?.unsupported) this.post('openUnsupported', { documentID: this.activeID }); };
    byID('zoom-button').onclick = () => { const menu = byID('zoom-menu'); menu.hidden = !menu.hidden; byID('zoom-button').setAttribute('aria-expanded', String(!menu.hidden)); };
    for (const percent of [50, 75, 90, 100, 110, 125, 150, 175, 200]) {
      const button = document.createElement('button'); button.textContent = percent + '%'; button.setAttribute('role', 'menuitem'); button.dataset.percent = String(percent);
      button.onclick = () => { this.zoomBy(percent / 100 / this.zoom); byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); }; byID('zoom-menu').append(button);
    }
    document.addEventListener('pointerdown', event => { if (!(event.target instanceof Element && event.target.closest('.zoom-control'))) { byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); } });
    byID('document-title').onclick = () => this.setReading(false);
    installScrollIndicators();
    const resize = (side: 'left' | 'right', width: number, persist: boolean) => {
      const key = side === 'left' ? 'leftWidth' : 'rightWidth'; this.preferences[key] = Math.max(180, Math.min(360, width)); this.applyLayout();
      if (persist) this.persistPreference(key, this.preferences[key]);
    };
    for (const side of ['left', 'right'] as const) installOutlineResize(byID(side + '-resize'), (width, persist) => resize(side, width, persist), () => side);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyLayout());
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.documentTransition.cancel());
    document.addEventListener('keydown', () => this.documentTransition.cancel(), true);
    new ResizeObserver(() => this.applyLayout()).observe(byID('main'));
    byID('main').addEventListener('wheel', event => {
      this.documentTransition.cancel();
      if (event.metaKey || event.ctrlKey) { event.preventDefault(); this.zoomBy(Math.exp(-event.deltaY * .003)); }
      else { this.positionJump++; this.findGeneration++; cancelAnimationFrame(this.centerFrame); this.centerFrame = 0; for (const element of byID('main').querySelectorAll<HTMLElement>('.cm-scroller,.reader,pre,table,.diagram')) stopScroll(element); }
    }, { passive: false });
    byID('editor').addEventListener('pointerdown', event => { if (event.button !== 0 || isContextGesture(event)) return; this.documentTransition.cancel(); this.pointerSelecting = true; this.findGeneration++; if (this.view) stopScroll(this.view.scrollDOM); });
    byID('reader').addEventListener('pointerdown', () => { this.documentTransition.cancel(); this.positionJump++; this.findGeneration++; stopScroll(byID('reader')); });
    document.addEventListener('pointerup', () => { if (this.pointerSelecting) { this.pointerSelecting = false; if(!this.view||!tableHasRange(this.view))this.scheduleCenter(); } });
    byID('editor').addEventListener('compositionend', () => queueMicrotask(() => this.scheduleCenter()));
    byID('editor').addEventListener('transitionend', event => { if (event.target instanceof Element && event.target.classList.contains('link-syntax')) this.scheduleCenter(); });
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !byID('main').contains(event.target)) return;
      if (this.active?.textFile) return;
      const link = event.target.closest<HTMLElement>('[data-link-href],a[href]');
      if (link?.tagName === 'A') event.preventDefault();
      if (event.button !== 0 || !event.metaKey) return;
      const position = !link && this.sourceEditing && this.view?.contentDOM.contains(event.target) ? this.view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
      const href = link?.dataset.linkHref ?? link?.getAttribute('href') ??
        (position !== null && this.view ? sourceLinkTarget(this.view.state, position, this.view.state.field(referenceIndex).context) : null);
      if (!this.active || !href || !safeLink(href)) return;
      event.preventDefault(); event.stopPropagation();
      if (href.startsWith('#')) void this.navigateFragment(href.slice(1));
      else if (event.isTrusted) {
        const requestID = newID(); this.latestOpenRequest = requestID; this.openRequests.clear(); this.openRequests.set(requestID, { pin: true, link: true });
        this.post('openLink', { documentID: this.activeID, href, requestID });
      }
    }, true);
    byID('reader').addEventListener('scroll', () => this.updateReadingOutline());
    byID('reader').addEventListener('copy', event => { if (!this.active?.textFile) return; const text = this.readerSelection(); if (text) { event.preventDefault(); void this.copyContent(undefined, false, text, true); } });
    byID('tab-strip').ondblclick = event => { if (!this.reading && event.target instanceof Element && !event.target.closest('button,.tab')) this.command('new'); };
    byID('editor').addEventListener('table-paste', () => this.requestPaste());
    byID('editor').addEventListener('table-copy',event=>{const detail=(event as CustomEvent<{markdown:string;raw:boolean}>).detail;void this.copyContent(undefined,false,detail.markdown,detail.raw);});
    byID('editor').addEventListener('table-copy-request',event=>{void this.copyContent(undefined,!!(event as CustomEvent<{cut:boolean}>).detail.cut);});
    byID('dismiss-notice').onclick = () => { this.notice = ''; this.renderChrome(); };
    byID('cancel-paste').onclick = () => this.cancelPaste();
    byID('retry-paste').onclick=()=>this.resolvePaste('retry');byID('local-paste').onclick=()=>this.resolvePaste('local');
    byID<HTMLInputElement>('query').oninput = () => this.find(false, true);
    byID('find-next').onclick = () => this.find(false); byID('find-previous').onclick = () => this.find(true);
    byID('replace-one').onclick = () => this.replace(false); byID('replace-all').onclick = () => this.replace(true);
    byID('find-mode').onclick = () => this.setFindMode(byID('replace-row').hidden === true);
    byID('close-find').onclick = () => this.hideFind();
    byID('find-panel').addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.hideFind(); }
      else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault(); if (event.target.id === 'replacement') this.replace(false); else this.find(event.shiftKey);
      }
    });
    document.addEventListener('keydown', event => {
      const action = physicalFormatShortcut(event);
      if (action && event.target instanceof Element && event.target.closest('#editor') && !this.composing() && this.command(action)) {
        event.preventDefault(); event.stopPropagation();
      }
    }, true);
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || this.composing()) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && !byID('find-panel').hidden) { event.preventDefault(); this.hideFind(); return; }
      if (event.key === 'Escape' && !byID('zoom-menu').hidden) { byID('zoom-menu').hidden = true; byID('zoom-button').setAttribute('aria-expanded', 'false'); event.preventDefault(); return; }
      if (this.reading && !document.querySelector('dialog[open]') && !(event.target instanceof HTMLInputElement) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.key === 'Escape') { event.preventDefault(); this.setReading(false); return; }
        if (scrollReading(byID('reader'), event.key)) { this.positionJump++; this.findGeneration++; event.preventDefault(); return; }
      }
      if (event.ctrlKey && !event.metaKey && event.key === 'Tab') { event.preventDefault(); this.switchTab(event.shiftKey ? -1 : 1); }
    });
    window.addEventListener('error', event => { this.errors.push(String(event.message)); this.diagnostic('globalError'); });
    window.addEventListener('unhandledrejection', event => { this.errors.push(String(event.reason)); this.diagnostic('unhandledRejection'); });
    window.addEventListener('markfine-offline-blocked', () => this.diagnostic('blockedNetwork'));
    renderEmptyState();
  }
  post(kind: string, fields: Record<string, unknown> = {}): void {
    const { protocolVersion, sessionID, capability } = context;
    transport({ protocolVersion, sessionID, capability, kind, ...fields });
  }
  private diagnostic(event: string): void {
    const now = Date.now(); if (now - (this.diagnostics.get(event) ?? 0) < 5000) return;
    this.diagnostics.set(event, now); this.post('diagnostic', { event });
  }
  get active(): EditorDocument | undefined { return this.documents.get(this.activeID); }
  composing(): boolean { return !!this.view && (this.view.composing || this.view.state.field(composition) || tableComposing(this.view)); }
  setNotice(text: string): void { this.notice = text; this.renderChrome(); }
  private copyFeedback(text: string, id: number, duration = 0): void {
    if (id !== this.copyFeedbackID) return;
    clearTimeout(this.copyFeedbackTimer); const element = byID('copy-feedback'); element.textContent = text; element.hidden = !text;
    if (duration) this.copyFeedbackTimer = window.setTimeout(() => { if (id === this.copyFeedbackID) { element.hidden = true; element.textContent = ''; } }, duration);
  }
  private readerSelection(): string {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.anchorNode || !byID('reader').contains(selection.anchorNode)) return '';
    return this.active?.textFile ? selectedRawText(this.active.state.doc, byID('reader-content'), selection.getRangeAt(0)) ?? '' : selection.toString();
  }

  private viewportSnapshot(): ReturnType<typeof EditorView.scrollIntoView> {
    const view = this.view!, port = view.scrollDOM.getBoundingClientRect(), column = view.contentDOM.getBoundingClientRect();
    const point = { x: Math.max(port.left + 16, Math.min(port.right - 16, column.left + 16)), y: port.top + 6 };
    const doc = view.contentDOM.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    // Capture the actual displayed text before a pending height-map measure can move it.
    // posAtDOM does not flush layout; posAtCoords does, so it is only the control/widget fallback.
    const hit = doc.caretRangeFromPoint?.(point.x, point.y);
    if (hit && view.contentDOM.contains(hit.startContainer) && !hit.startContainer.parentElement?.closest('.markdown-block,.live-table')) {
      try {
        const position = view.posAtDOM(hit.startContainer, hit.startOffset), probe = hit.cloneRange();
        if (hit.startContainer.nodeType === Node.TEXT_NODE && hit.startOffset < hit.startContainer.textContent!.length) probe.setEnd(hit.startContainer, hit.startOffset + 1);
        const caret = [...probe.getClientRects()].find(rect => rect.height > 0);
        if (caret && Math.abs(caret.top - port.top) <= view.scrollDOM.clientHeight) return EditorView.scrollIntoView(position, { y: 'start', yMargin: caret.top - port.top, x: 'nearest' });
      } catch { /* Generated widgets may have no direct parent-view text coordinate. */ }
    }
    const position = view.posAtCoords(point, false);
    const caret = position === null ? null : view.coordsAtPos(position);
    if (position === null || !caret || Math.abs(caret.top - port.top) > view.scrollDOM.clientHeight) return view.scrollSnapshot();
    // A real visible text coordinate remains stable across re-created height maps and wrapped
    // lines. Let CodeMirror restore that coordinate; do not infer it from an estimated line top.
    return EditorView.scrollIntoView(position, { y: 'start', yMargin: caret.top - port.top, x: 'nearest' });
  }

  private load(message: Record<string, unknown>): void {
    const id = String(message.documentID);
    const openRequest = String(message.openRequestID ?? '');
    const stale = !!openRequest && openRequest !== this.latestOpenRequest;
    if (this.documents.has(id)) {
      if (!stale) { this.stalePreviewIDs.delete(id); this.activateOpenedDocument(id, message.fragment, openRequest); this.finishWorkspaceOpen(openRequest, id); }
      return;
    }
    const locks = new Compartment(), numbers = new Compartment(), sourceStyles = new Compartment();
    const source = String(message.markdown), separator = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
    const textFile = message.textFile === true, language = typeof message.language === 'string' ? message.language : '';
    const state = EditorState.create({ doc: source, extensions: [
      history(), preserveLineEndings(source), EditorView.lineWrapping, pairedPunctuation(),
      textFile ? textPresentation(language) : [editorMarkdown(), slashMenu(), blockPreview(id, element => this.hydrate(element, id)), documentOutline],
      EditorView.scrollHandler.of((view, range, options) => {
        const pending = this.pendingMatch;
        if (options.y !== 'center' || pending?.view !== view || pending.position !== range.head) return false;
        this.pendingMatch = undefined;
        // Let CodeMirror finish measuring the requested source range before our smooth scroll.
        // The new request replaces any pending tab snapshot; no old restoration can run after it.
        queueMicrotask(pending.run); return true;
      }),
      locks.of(EditorState.readOnly.of(this.reading || message.unsupported === true)), numbers.of([]),
      sourceStyles.of(this.sourceEditing && !textFile ? syntaxHighlighting(defaultHighlightStyle) : []),
      keymap.of([
        { key: 'Mod-s', run: () => { this.saveActive(); return true; } },
        {key:'Mod-c',run:()=>this.command('copy')},{key:'Mod-x',run:()=>this.command('cut')},
        // Consume this before CodeMirror's default Mod-/ comment command. The app owns
        // source/live presentation; a mode shortcut must never rewrite the Markdown.
        { key: 'Mod-/', run: () => { this.command('toggleSource'); return true; } },
        ...(['left', 'right', 'up', 'down'] as const).map(direction => ({ key: 'Arrow' + direction[0].toUpperCase() + direction.slice(1), run: (view: EditorView) => !this.sourceEditing && navigateTable(view, direction) })),
        ...Object.entries({ 'Mod-b': 'bold', 'Mod-i': 'italic', 'Mod-k': 'link', 'Mod-Alt-k': 'inlineCode', 'Mod-Alt-c': 'codeBlock',
          'Mod-Alt-q': 'quote', 'Mod-Alt-o': 'ordered', 'Mod-Alt-u': 'unordered', 'Mod-Alt-x': 'task', 'Mod-Alt-t': 'table',
          'Ctrl-Shift-`': 'strike', 'Ctrl-Mod-i': 'image', 'Mod-]': 'indent', 'Mod-[': 'outdent',
          'Mod-Shift-k': 'deleteLine', 'Mod-Alt-Shift-k': 'deleteParagraph',
          'Mod-0': 'heading0', 'Mod-1': 'heading1', 'Mod-2': 'heading2', 'Mod-3': 'heading3', 'Mod-4': 'heading4', 'Mod-5': 'heading5', 'Mod-6': 'heading6'
        }).map(([key, action]) => ({ key, run: () => this.command(action) })),
        ...historyKeymap, ...defaultKeymap
      ]),
      EditorView.contentAttributes.of(() => ({ 'aria-label': textFile ? t('纯文本正文', 'Plain text document') : t('Markdown 正文', 'Markdown document'), spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })),
      EditorView.exceptionSink.of(error => { this.errors.push(String(error)); this.diagnostic('editorException'); this.setNotice(t('编辑器发生异常，请保留当前内容：', 'Editor error. Keep your current content: ') + String(error)); }),
      EditorView.domEventHandlers({ copy:(event)=>{if(!this.reading&&!this.composing()){event.preventDefault();void this.copyContent();return true;}return false;},cut:(event)=>{if(!this.reading&&!this.composing()){event.preventDefault();void this.copyContent(undefined,true);return true;}return false;},paste: (event, view) => {
        if (view.composing || view.state.field(composition)) return false;
        event.preventDefault(); this.requestPaste(); return true;
      } }),
      EditorView.updateListener.of(update => {
        const item = this.documents.get(id); if (!item) return;
        item.state = update.state;
        if (update.docChanged || update.selectionSet) this.copyHighlight.clear();
        if (update.docChanged && this.collapsed.has(id)) this.collapsed.set(id, new Set([...this.collapsed.get(id)!].map(from => update.changes.mapPos(from))));
        if (update.docChanged) {
          this.findGeneration++; if (this.view) stopScroll(this.view.scrollDOM);
          if (!byID('find-panel').hidden) this.highlights.set(byID<HTMLInputElement>('query').value);
          if (!item.unsupported) item.preview = false; item.saves.edited(update.state.doc, update.state.field(lineEndings).key); this.updateCount();
        }
        // A focus-only blur must not replace a TOC button between mousedown and click.
        if (update.docChanged || update.selectionSet) this.renderOutline();
        if (update.docChanged || update.selectionSet || update.focusChanged) this.scheduleHint();
        if (update.docChanged && this.reading) this.renderReading();
        if (update.docChanged || update.selectionSet) this.scheduleCenter();
      })
    ] });
    const saves = new SaveMachine(context, id, state.doc, transport);
    saves.encoding = typeof message.encoding === 'string' ? message.encoding : 'UTF-8';
    saves.lineSeparator = separator;
    const item: EditorDocument = { id, title: String(message.title), path: String(message.path), state, saves, locks,
      imageLocked: false, closeLocked: false,copyLocked:false, numbers, sourceStyles, preview: message.preview === true, unsupported: message.unsupported === true, unsubscribe: () => {}, resume: message.resume as EditorDocument['resume'],
      textFile, language, encoding: typeof message.encoding === 'string' ? message.encoding : 'UTF-8' };
    saves.serialize = text => serializeText(text, item.state.field(lineEndings));
    saves.initializeLineEndings(state.field(lineEndings).key);
    this.documents.set(id, item); item.unsubscribe = saves.subscribe(() => this.renderChrome());
    if (stale) { this.stalePreviewIDs.add(id); return; }
    if (!this.composing()) this.activateOpenedDocument(id, message.fragment, openRequest); else this.renderChrome();
    this.finishWorkspaceOpen(openRequest, id);
  }

  private activateOpenedDocument(id: string, fragment: unknown, request: string): void {
    const changed = !!this.active && this.activeID !== id;
    const linked = typeof fragment === 'string' || this.openRequests.get(request)?.link === true;
    if (!this.activate(id)) return;
    const reveal = changed && linked ? this.documentTransition.begin() : () => {};
    if (typeof fragment === 'string') void this.navigateFragment(fragment, changed, reveal);
    else reveal();
  }

  activate(id: string): boolean {
    if (this.composing()) { this.setNotice(t('请先完成当前中文组词', 'Finish the current input composition first')); return false; }
    const next = this.documents.get(id); if (!next) return false;
    if (next.closeLocked) return false;
    this.documentTransition.cancel();
    if (id === this.activeID) return true;
    this.copyHighlight.clear();
    this.copyFeedback('', this.copyFeedbackID); this.copyFeedbackID++;
    this.rememberPosition(); this.resetSearchRoom(); this.dismissResume(); this.findGeneration++; this.positionJump++; this.pendingMatch = undefined;
    if (next.unsupported && this.reading) this.setReading(false);
    const previous = this.active;
    if (previous && this.view) {
      const scroll = !this.reading ? this.viewportSnapshot() : undefined;
      previous.state = this.view.state;
      if (this.reading) previous.readerScroll = byID('reader').scrollTop;
      else { previous.scroll = scroll; previous.scrollLeft = this.view.scrollDOM.scrollLeft; }
    }
    this.activeID = id;
    if (this.view) this.view.setState(next.state);
    else this.view = new EditorView({ state: next.state, parent: byID('editor') });
    this.view.scrollDOM.scrollLeft = next.scrollLeft ?? 0;
    this.view.dispatch({ effects: [preferencesEffect.of(this.preferences), sourceModeEffect.of(this.sourceEditing), next.scroll ?? EditorView.scrollIntoView(next.state.selection.main.head, { y: 'nearest' })] });
    if (!next.scroll && this.view.state.selection.main.head === 0) {
      // A reused EditorView keeps its DOM scroller across setState. A newly opened document
      // must not inherit another tab's offset, including a later layout/height correction.
      const initialDoc = this.view.state.doc, jump = this.positionJump, find = this.findGeneration;
      this.view.scrollDOM.scrollTop = 0; this.view.scrollDOM.scrollLeft = 0;
      this.view.requestMeasure({ key: next, read: () => null, write: (_, view) => {
        if (this.activeID === id && !this.reading && view.state.doc === initialDoc && view.state.selection.main.head === 0 &&
            this.positionJump === jump && this.findGeneration === find && !this.pointerSelecting && !this.composing()) view.scrollDOM.scrollTop = 0;
      } });
    }
    if (this.reading) { this.pin(next); this.renderReading(); byID('reader').scrollTop = next.readerScroll ?? 0; byID('reader').focus({ preventScroll: true }); }
    else if (next.unsupported) byID('unsupported').focus();
    else this.view.focus();
    this.notice = ''; this.renderChrome(); this.applyLayout(); this.post('activeDocument', { documentID: id });
    // Finish the tab's pending built-in scroll snapshot before subsequent wheel/find actions.
    // A public geometry read flushes CodeMirror's scheduled measure without changing selection.
    if (!this.reading && !next.unsupported) { this.view.coordsAtPos(this.view.state.selection.main.head); this.view.scrollDOM.scrollLeft = next.scrollLeft ?? 0; }
    if (!byID('find-panel').hidden) this.highlights.set(byID<HTMLInputElement>('query').value);
    this.offerResume(next);
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
    else { const transaction = item.state.update(spec); item.state = transaction.state; if (transaction.docChanged) { item.scroll = item.scroll?.map(transaction.changes); item.preview = false; item.saves.edited(item.state.doc, item.state.field(lineEndings).key); } }
    return true;
  }
  private lock(item: EditorDocument): void {
    this.edit(item.id, { effects: item.locks.reconfigure(EditorState.readOnly.of(this.reading || item.unsupported || item.imageLocked || item.closeLocked || item.copyLocked)) });
  }
  saveActive(): boolean {
    const item = this.active;
    if (!item || item.unsupported || this.composing() || item.imageLocked || item.closeLocked ||item.copyLocked) return false;
    this.notice = ''; item.saves.requestSave(); return true;
  }
  command(action: string): boolean {
    if (this.composing()) return false;
    // A modal confirmation/help/diagram must not leave menu commands operating on the document behind it.
    if (document.querySelector('dialog[open]') && action !== 'close') return false;
    if (action === 'toggleSource') { this.toggleSource(); return true; }
    if (action === 'toggleReading') { this.setReading(!this.reading); return true; }
    if (action === 'toggleLineNumbers') { this.applyPreferences({ lineNumbers: !this.preferences.lineNumbers }); this.persistPreference('lineNumbers', this.preferences.lineNumbers); return true; }
    if (action === 'toggleFocus') { this.applyPreferences({ focusMode: !this.preferences.focusMode }); this.persistPreference('focusMode', this.preferences.focusMode); return true; }
    if (action === 'help') { showHelp(byID<HTMLDialogElement>('help-dialog')); return true; }
    if (action === 'userGuide') { showHelp(byID<HTMLDialogElement>('help-dialog'), true); return true; }
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') { this.zoomBy(action === 'zoomReset' ? 1 / this.zoom : action === 'zoomIn' ? 1.1 : 1 / 1.1); return true; }
    if (action === 'toggleOutline') { this.toggleOutline(); return true; }
    if (action === 'toggleFiles') { this.toggleFiles(); return true; }
    if (action === 'new' || action === 'open') {
      if (this.closing) return false; this.post(action); return true;
    }
    if (action === 'save') return this.saveActive();
    if (action === 'export' || action === 'print') { if (!this.active || this.active.unsupported || this.closing || this.active.imageLocked) return false; this.post('exportDocument', { documentID: this.activeID, printing: action === 'print', mode: this.reading ? 'read' : this.sourceEditing || this.active.textFile ? 'source' : 'edit' }); return true; }
    if (action === 'close') {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
      if (dialog) { if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close(); return true; }
      if (this.active) void this.closeTab(this.active.id); else if (!this.closing) this.post('closeEmptyWindow'); return true;
    }
    if (action === 'nextTab' || action === 'previousTab') { this.switchTab(action === 'nextTab' ? 1 : -1); return true; }
    if (this.active?.unsupported) return false;
    if (action === 'replace' && this.reading) return false;
    if (action === 'find' || action === 'replace') { this.showFind(action === 'replace'); return true; }
    if (action === 'findNext' || action === 'findPrevious') { this.find(action === 'findPrevious'); return true; }
    if(action==='copy'||action==='cut'){
      if (this.reading) { const text = action === 'copy' && this.active?.textFile ? this.readerSelection() : ''; if (!text) return false; void this.copyContent(undefined, false, text, true); return true; }
      if(this.reading||!this.view||!(this.view.hasFocus||tableHasFocus(this.view)||tableHasRange(this.view))||this.active?.imageLocked||this.active?.copyLocked)return false;
      void this.copyContent(undefined,action==='cut');return true;
    }
    if (this.reading) return false;
    if (action === 'paste') { if (!this.view || !(this.view.hasFocus || tableHasFocus(this.view))) return false; this.requestPaste(); return true; }
    if (!this.view || !(this.view.hasFocus || tableHasFocus(this.view))) {
      if (['undo', 'redo'].includes(action) && document.activeElement instanceof HTMLInputElement) return document.execCommand(action);
      return false;
    }
    const item = this.active;
    if (!item || item.imageLocked || item.closeLocked ||item.copyLocked) return false;
    if (action === 'undo' || action === 'redo') { const cell = tableHasFocus(this.view); const result = action === 'undo' ? undo(this.view) : redo(this.view); if (cell) focusTableSelection(this.view); return result; }
    if (action === 'deleteLine' || action === 'deleteParagraph') {
      const table=tableCopySelection(this.view);if(table){this.view.dispatch({changes:table.clear,userEvent:'delete.cells',annotations:isolateHistory.of('full')});return true;}
      if (tableHasFocus(this.view)) return deleteTableCell(this.view);
      const state = this.view.state, line = state.doc.lineAt(state.selection.main.head);
      const range = action === 'deleteParagraph' ? textParagraphRange(state) : { from: line.from, to: line.to };
      const spec = item.textFile ? { changes: { ...range, to: range.to < state.doc.length ? range.to + 1 : range.to, insert: '' }, selection: EditorSelection.cursor(range.from), userEvent: 'delete.line' } : deletionTransaction(state, action); if (!spec) return false;
      this.view.dispatch({ ...spec, annotations: isolateHistory.of('full') }); return true;
    }
    if (item.textFile && !['indent', 'outdent'].includes(action)) return false;
    const transaction = formatTransaction(this.view.state, action);
    if (!transaction) return false;
    const cell = tableHasFocus(this.view);
    this.view.dispatch({ ...transaction, annotations: isolateHistory.of('full') }); if (cell) focusTableSelection(this.view); return true;
  }

  showFind(replace: boolean): void {
    if (!this.active || this.composing()) return;
    byID('find-panel').hidden = false; document.body.classList.add('finding'); this.applyLayout(); this.setFindMode(replace);
    const selected = this.active.state.sliceDoc(this.active.state.selection.main.from, this.active.state.selection.main.to);
    if (selected && !selected.includes('\n')) byID<HTMLInputElement>('query').value = selected;
    byID<HTMLInputElement>('query').focus(); byID<HTMLInputElement>('query').select();
    this.updateFindCount();
    this.highlights.set(byID<HTMLInputElement>('query').value);
  }
  private setFindMode(replace: boolean): void {
    replace &&= !this.reading; byID('replace-row').hidden = !replace;
    byID('find-mode').textContent = (replace ? t('替换', 'Replace') : t('查找', 'Find')) + ' ⇄';
    byID('find-mode').setAttribute('aria-expanded', String(replace)); byID<HTMLButtonElement>('find-mode').disabled = this.reading;
  }
  hideFind(): void {
    if (this.composing()) return;
    this.resetSearchRoom(); byID('find-panel').hidden = true; document.body.classList.remove('finding'); this.highlights.clear();
    // Closing the panel changes layout, but does not cancel the user's destination. The
    // in-flight positioning pass must still correct for CodeMirror's next height-map update.
    if (!this.reading) this.view?.focus(); else byID('reader').focus({ preventScroll: true });
  }
  find(backwards: boolean, fromStart = false): boolean {
    const item = this.active; if (!item || this.composing()) return false;
    const query = byID<HTMLInputElement>('query').value;
    const match = findMatch(item.state.doc.toString(), query, fromStart ? 0 : this.reading ? this.findOffset : backwards ? item.state.selection.main.from : item.state.selection.main.to, backwards);
    this.highlights.set(query); const generation = ++this.findGeneration;
    if (match) {
      this.findOffset = backwards ? match.from : match.to;
      if (!this.reading) this.edit(item.id, { selection: EditorSelection.single(match.from, match.to) });
      this.centerMatch(match.from, () => { if (generation === this.findGeneration && !byID('find-panel').hidden) { const block = this.matchBlock(match.from); this.highlights.flash(block,block ? this.matchRect(block,match.from) : undefined); } });
    }
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
    this.highlights.schedule();
  }

  private readerBlock(position: number): HTMLElement | undefined {
    if (!this.active) return;
    const line = this.active.state.doc.lineAt(position).number - 1;
    let target: HTMLElement | undefined;
    for (const block of byID('reader-content').querySelectorAll<HTMLElement>(':scope > [data-source-line]')) { if (Number(block.dataset.sourceLine) > line) continue; if (!target || Number(block.dataset.sourceLine) >= Number(target.dataset.sourceLine)) target = block; }
    return target;
  }
  private matchBlock(position: number): HTMLElement | undefined {
    if (this.reading) {
      const line = this.active!.state.doc.lineAt(position).number - 1;
      return [...byID('reader-content').querySelectorAll<HTMLElement>('[data-source-line]')].filter(node => Number(node.dataset.sourceLine) <= line).sort((a,b) => Number(b.dataset.sourceLine) - Number(a.dataset.sourceLine) || (a.contains(b) ? 1 : -1))[0];
    }
    if (!this.view) return;
    let node = syntaxTree(this.view.state).resolveInner(position);
    while (node.parent && node.name !== 'Table') node = node.parent;
    if (node.name === 'Table') {
      const first = this.view.state.doc.lineAt(node.from).number, row = this.view.state.doc.lineAt(position).number - first;
      return [...byID('editor').querySelectorAll<HTMLElement>(`.live-table[data-line="${first}"] tr`)][Math.max(0,row - 1)];
    }
    try { const at = this.view.domAtPos(position); return (at.node.nodeType === Node.ELEMENT_NODE ? at.node as Element : at.node.parentElement)?.closest<HTMLElement>('.cm-line,.live-table,.markdown-block') ?? undefined; } catch { return; }
  }
  private centerMatch(position: number, complete: () => void, immediate = false): void {
    if (this.reading) {
      const block = this.matchBlock(position), reader = byID('reader'); if (!block) return;
      const target = () => { const rect = this.matchRect(block,position) ?? block.getBoundingClientRect(); return reader.scrollTop + (rect.top+rect.bottom)/2 - reader.getBoundingClientRect().top - reader.clientHeight/2; };
      this.ensureSearchRoom(target()); animateScroll(reader, target(), undefined, immediate ? 0 : undefined, complete);
    } else if (this.view) {
      const view = this.view, scroller = view.scrollDOM, id = this.activeID, generation = this.findGeneration, selection = view.state.selection;
      const current = () => this.activeID === id && !this.reading && generation === this.findGeneration && view.state.selection.main.head === selection.main.head;
      const target = () => { if (!current() || position > view.state.doc.length) return scroller.scrollTop; const row = this.matchBlock(position), caret = row?.tagName === 'TR' ? row.getBoundingClientRect() : view.coordsAtPos(position), block = view.lineBlockAt(position); return caret ? scroller.scrollTop + (caret.top + caret.bottom) / 2 - scroller.getBoundingClientRect().top - scroller.clientHeight / 2 : view.documentTop + block.top + block.height / 2 - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight / 2; };
      this.pendingMatch = { view, position, run: () => {
        if (!current()) return;
        this.ensureSearchRoom(target()); animateScroll(scroller, target(), undefined, immediate ? 0 : undefined, () => {
          if (!current()) return;
          let finished = false; const finish = (top: number) => { if (finished || !current()) return; finished = true; animateScroll(scroller, top, undefined, immediate ? 0 : 140, complete); };
          view.requestMeasure({ read: target, write: finish }); window.setTimeout(() => { if (!finished) finish(target()); }, 80);
        });
      } };
      view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      view.coordsAtPos(position);
    }
  }
  private matchRect(block: HTMLElement, position: number): DOMRect | undefined {
    const query = byID<HTMLInputElement>('query').value; if (!this.active || !query) return;
    const line = this.reading ? Number(block.dataset.sourceLine ?? 0) + 1 : this.active.state.doc.lineAt(position).number;
    const from = this.active.state.doc.line(Math.max(1,Math.min(line,this.active.state.doc.lines))).from;
    const ordinal = [...this.active.state.doc.sliceString(from,position).matchAll(literalPattern(query))].length;
    return this.highlights.matchRect(block,ordinal);
  }
  private ensureSearchRoom(top: number): void {
    if (top >= 0 || byID('find-panel').hidden) return;
    this.searchRoom += -top; document.documentElement.style.setProperty('--search-top-room',this.searchRoom+'px'); byID('main').getBoundingClientRect(); this.view?.requestMeasure();
  }
  private resetSearchRoom(): void {
    if (!this.searchRoom) return;
    const scroller = this.reading ? byID('reader') : this.view?.scrollDOM, anchor = this.reading ? byID('reader-content').firstElementChild : this.view?.contentDOM.firstElementChild;
    const before = anchor?.getBoundingClientRect().top;
    this.searchRoom=0; document.documentElement.style.setProperty('--search-top-room','0px');
    if (scroller && anchor && before !== undefined) scroller.scrollTop += anchor.getBoundingClientRect().top-before;
    this.view?.requestMeasure();
  }

  requestPaste(): boolean {
    const item = this.active;
    if (!item || item.unsupported || this.reading || this.composing() || item.closeLocked || item.imageLocked ||item.copyLocked) return false;
    if (this.pasteJob || item.saves.pending) { this.setNotice(t('请先等待当前图片任务或该文档保存完成', 'Wait for the current image task or document save to finish')); return false; }
    const job: PasteJob = { id: newID(), documentID: item.id, revision: item.saves.revision, selection: item.state.selection, cancelRequested: false,tableTarget:!!this.view&&(tableHasFocus(this.view)||tableHasRange(this.view)) };
    this.pasteJob = job; item.imageLocked = true; this.lock(item); this.renderChrome();
    this.post('paste', { documentID: item.id, requestID: job.id, revision: job.revision, anchor: job.selection.main.anchor, head: job.selection.main.head });
    return true;
  }
  cancelPaste(): void {
    const job = this.pasteJob; if (!job) return;
    job.cancelRequested = true; this.post('cancelPaste', { documentID: job.documentID, requestID: job.id }); this.renderChrome();
  }
  private resolvePaste(action:'retry'|'local'):void{const job=this.pasteJob;if(!job||!job.failure)return;job.failure=undefined;this.renderChrome();this.post('resolvePaste',{documentID:job.documentID,requestID:job.id,action});}
  private pasteReceipt(message: Record<string, unknown>): void {
    const job = this.pasteJob;
    if (!job || message.requestID !== job.id || message.documentID !== job.documentID) return;
    const item = this.documents.get(job.documentID);
    if(message.canRetry===true&&!job.cancelRequested&&message.outcome==='failure'){job.failure=String(message.error);this.renderChrome();return;}
    this.pasteJob = null;
    if (!item) return;
    item.imageLocked = false; this.lock(item);
    if (message.outcome === 'success' && !job.cancelRequested && item.saves.revision === job.revision) {
      let insert = typeof message.reference === 'string' ? `![${t('图片', 'Image')}](${message.reference})` : typeof message.text === 'string' ? message.text : '';
      if(job.tableTarget)insert=insert.replace(/\r\n?|\n/g,' ').replace(/(?<!\\)\|/g,'\\|');
      if (insert) this.edit(item.id, { changes: { from: job.selection.main.from, to: job.selection.main.to, insert },
        selection: EditorSelection.single(job.selection.main.from + insert.length), userEvent: 'input.paste', annotations: isolateHistory.of('full') });
    } else if (message.outcome === 'failure') this.notice = String(message.error || t('粘贴失败，正文未改变', 'Paste failed. The document is unchanged'));
    this.renderChrome();
  }

  private async copyContent(range?:SourceRange,cut=false,provided?:string,raw=false):Promise<void>{
    const item=this.active;if(!item||item.unsupported||item.imageLocked||item.copyLocked||item.closeLocked||this.composing()||cut&&this.reading)return;
    const state=item.state,before=state.doc,table=!range&&this.view?tableCopySelection(this.view):undefined;
    const implicitRange=range===undefined&&provided===undefined;
    const cell=!range&&provided===undefined&&!table&&this.view&&!this.sourceEditing&&!item.textFile?tableCellSelection(this.view):undefined;
    if(cut&&!range&&provided===undefined&&!table&&state.selection.main.empty&&!cell?.selected)return;
    if(cell)range={from:cell.from,to:cell.to};
    if(!range&&provided===undefined&&!table){const selected=state.selection.main;range=selected.empty?(item.textFile?textParagraphRange(state):paragraphRange(state)):{from:selected.from,to:selected.to};}
    const flashRange=implicitRange&&!cut&&!table&&provided===undefined&&(cell?!cell.selected:state.selection.main.empty)?range:undefined;
    raw ||= item.textFile || !!cell;
    const markdown=provided??table?.markdown??(range?(item.textFile?state.sliceDoc(range.from,range.to):cell?inlinePlainText(state.sliceDoc(range.from,range.to),state.field(referenceIndex).context):copyMarkdown(state,range)):'');
    if(!markdown)return;
    if(new TextEncoder().encode(markdown).length>8*1_048_576){this.setNotice(t('复制内容超过 8 MiB，请缩小选区后重试。','The copied text exceeds 8 MiB. Select a smaller range and try again.'));return;}
    this.copyHighlight.clear();item.copyLocked=true;this.lock(item);const feedback=++this.copyFeedbackID;this.copyFeedback(t('正在复制…','Copying…'),feedback);
    let ticket:string|undefined,timer=0;
    try{
      const reservation=await this.request('beginCopy',{documentID:item.id});if(reservation.outcome!=='success'||typeof reservation.ticket!=='string')throw new Error(t('复制未开始，请稍后重试。','Copy could not start. Please try again.'));ticket=reservation.ticket;
      let removed=false;
      const snapshot=raw?{html:'',resources:[],imageBindings:[]}:await Promise.race([exportHTML(markdown,item.id,()=>this.ensureMermaid()),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error(t('复制准备超时，请重试。','Copy preparation timed out. Please try again.'))),45000);})]);clearTimeout(timer);
      if(!raw&&table?.syntheticHeader){const template=document.createElement('template');template.innerHTML=snapshot.html;template.content.querySelector('thead')?.remove();snapshot.html=template.innerHTML;}
      const bytes=(text:string)=>new TextEncoder().encode(text).length;
      if(bytes(snapshot.html)>32*1_048_576||snapshot.resources.length>512||snapshot.imageBindings.length>512||snapshot.resources.some(value=>bytes(value)>12_000)||snapshot.imageBindings.some(value=>bytes(value.source)>12_000||bytes(value.resource)>12_000))throw new Error(t('复制内容超过格式或资源上限，请缩小选区后重试。','The copied formatting or resources exceed the limit. Select a smaller range and try again.'));
      const result=await this.request('copyFragment',{documentID:item.id,ticket,revision:item.saves.revision,markdown,snapshot,raw});
      if(result.outcome!=='success')throw new Error(String(result.error||t('复制未完成','Copy did not finish')));
      if(cut&&this.documents.has(item.id)&&item.state.doc===before){
        const changes=table?table.clear:range?[{from:range.from,to:range.to,insert:''}]:[];
        if(changes.length){item.copyLocked=false;this.lock(item);this.edit(item.id,{changes,selection:EditorSelection.cursor(Math.min(changes[0].from,before.length-(range?range.to-range.from:0))),userEvent:'delete.cut',annotations:isolateHistory.of('full')});removed=true;}
      }
      if (this.activeID === item.id) {
        if(cut&&!removed){this.copyFeedback('',feedback);this.notice=t('已复制，剪切未执行。请重新选择后再试。','Copied. Cut was not applied; select the content and try again.');}
        else {
          this.copyFeedback(cut?t('已剪切','Cut'):t('已复制','Copied'),feedback,1200);
          if(flashRange&&this.view&&!this.reading&&item.state.doc===before)this.copyHighlight.show(this.view,flashRange);
        }
      }
    }catch(error){this.copyFeedback('',feedback);if(this.activeID===item.id)this.notice=String((error as Error).message||t('复制未完成','Copy did not finish'));}
    finally{clearTimeout(timer);if(ticket)this.post('abortCopy',{documentID:item.id,ticket});if(this.documents.has(item.id)){item.copyLocked=false;this.lock(item);}this.renderChrome();}
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
    if (!item || this.closing || item.imageLocked ||item.copyLocked|| this.composing()) return false;
    this.closing = true;
    try {
      if (id === this.activeID) this.rememberPosition();
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
      this.dismissResume();
      this.activeID = ''; const next = this.documents.keys().next().value;
      if (next) this.activate(next); else { this.hideFind(); this.view?.destroy(); this.view = null; byID('editor').replaceChildren(); if (this.reading) this.setReading(false); }
    }
  }
  private async closeAll(requestID: string): Promise<void> {
    this.rememberPosition();
    let permitted = false;
    if (!this.closing && !this.pasteJob && ![...this.documents.values()].some(item=>item.copyLocked) && !this.composing()) {
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
      image.onerror = () => { this.diagnostic('imageFailure'); image.classList.add('image-error'); image.title = t('图片暂不可用，请检查资源或存储访问设置。', 'Image unavailable. Check the resource or storage access settings.'); };
      const size = () => {
        this.imageControls.fit(image);
        this.view?.requestMeasure();
      };
      image.onload = size; if (image.complete) size();
      this.imageControls.bind(image,documentID);
    }
    for (const diagram of element.querySelectorAll<HTMLElement>('[data-diagram]')) {
      const source = diagram.dataset.diagram!, token = newID(); diagram.dataset.renderToken = token;
      const retained = !!diagram.querySelector('svg'); clearTimeout(this.diagramTimers.get(diagram));
      const render = () => { const promise = this.ensureMermaid().then(async () => {
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
        this.diagnostic('diagramFailure');
        if (!diagram.isConnected || diagram.dataset.renderToken !== token) return;
        const hint = diagram.querySelector('small') ?? document.createElement('small');
        hint.textContent = t('图表保留源码：', 'Diagram source retained: ') + String(error); if (!hint.isConnected) diagram.append(hint);
      }); this.diagramPromises.set(diagram, promise); return promise; };
      if (retained) this.diagramTimers.set(diagram, window.setTimeout(render, 160)); else render();
    }
  }
  private updateCount(): void {
    const item = this.active;
    byID('count').textContent = item && !item.unsupported ? `${item.state.doc.length.toLocaleString()} ${t('字符', 'characters')} · ${item.state.doc.lines} ${t('行', 'lines')}${item.textFile ? ' · '+item.encoding : ''}` : item ? '—' : 'Markdown · UTF-8';
    byID('zoom-button').textContent = `${Math.round(this.zoom * 100)}%`;
    this.updateFindCount();
  }
  private toggleOutline(): void {
    if (this.reading || !this.active || this.active.unsupported || this.active.textFile) return;
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
  private toggleFiles(): void {
    if (this.reading || !this.workspaceBrowser.root) return;
    this.filesHidden = !this.filesHidden;
    byID('files-panel').classList.toggle('collapsed', this.filesHidden);
    byID('files-content').inert = this.filesHidden;
    byID('toggle-files').setAttribute('aria-expanded', String(!this.filesHidden));
    this.view?.requestMeasure();
  }
  private scheduleHint(): void {
    clearTimeout(this.hintTimer); byID('format-hint').textContent = '';
    if (this.reading || this.active?.textFile || !this.preferences.shortcutHints || !this.view || this.composing()) return;
    this.hintTimer = window.setTimeout(() => {
      if (this.view && !this.composing() && (this.view.hasFocus || tableHasFocus(this.view))) byID('format-hint').textContent = formatContext(this.view.state);
    }, 450);
  }
  private renderOutline(): void {
    const tree = byID('outline-tree'); tree.replaceChildren();
    const item = this.active;
    if (!item || item.textFile || item.unsupported) { byID('outline-empty').hidden = false; return; }
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
        line.oncontextmenu=event=>{
          event.preventDefault();if(this.composing())return;const original=item.state.doc;
          const current=()=>this.activeID===item.id&&item.state.doc===original&&!item.imageLocked&&!item.copyLocked&&!item.closeLocked;
          const range=chapterRange(item.state,headings,heading.from);if(!range)return;
          const actions=[{label:t('复制','Copy'),disabled:!current(),run:()=>{if(current())void this.copyContent(range);}}];
          if(!this.reading)actions.push({label:t('剪切','Cut'),disabled:!current(),run:()=>{if(current())void this.copyContent(range,true);}}, {label:t('删除','Delete'),disabled:!current(),run:()=>{if(current())this.edit(item.id,{changes:{...range,insert:''},selection:EditorSelection.cursor(range.from),userEvent:'delete.chapter',annotations:isolateHistory.of('full')});}});
          contextMenu(event.clientX,event.clientY,actions,'outline-menu');
        };
        link.onmousedown = event => { if (event.button === 0) event.preventDefault(); };
        link.onclick = () => {
          if (this.composing() || !this.view) return;
          this.documentTransition.cancel();
          this.positionJump++; this.findGeneration++;
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
    document.getElementById('path-tooltip')?.remove();
    const tabs = byID('tabs'); tabs.replaceChildren();
    for (const item of this.documents.values()) {
      if (this.stalePreviewIDs.has(item.id)) continue;
      const row = document.createElement('div'); row.className = 'tab' + (item.id === this.activeID ? ' active' : '') + (item.preview || item.unsupported ? ' preview-tab' : ''); row.setAttribute('role', 'presentation');
      const select = document.createElement('button'); select.type = 'button'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(item.id === this.activeID));
      pathTooltip(select, item.path);
      if (item.saves.dirty) { const dot = document.createElement('span'); dot.className = 'dirty'; dot.setAttribute('aria-label', t('未保存', 'Unsaved')); select.append(dot); }
      select.append(document.createTextNode(tabLabel(item, [...this.documents.values()].filter(other => !this.stalePreviewIDs.has(other.id)))));
      row.oncontextmenu = event => { if (!this.composing() && !this.closing) showTabMenu(event, [...this.documents.keys()].filter(id => !this.stalePreviewIDs.has(id)), item.id, scope => void this.closeTabs(item.id, scope)); };
      select.onclick = () => this.activate(item.id);
      select.ondblclick = () => this.pin(item);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close-tab'; close.textContent = '×'; close.setAttribute('aria-label', `${t('关闭', 'Close')} ${this.displayTitle(item)}`);
      close.onclick = () => { void this.closeTab(item.id); }; close.disabled = item.imageLocked || item.closeLocked ||item.copyLocked;
      row.append(select, close); tabs.append(row);
    }
    const item = this.active;
    document.body.classList.toggle('text-file', !!item?.textFile);
    document.body.classList.toggle('no-document', !item || item.unsupported);
    byID('outline-panel').hidden = !item || item.unsupported || item.textFile;
    byID('toggle-outline').hidden = !item || item.unsupported || item.textFile;
    byID('toggle-files').hidden = !this.workspaceBrowser.root;
    byID('toggle-files').setAttribute('aria-expanded', String(!this.filesHidden));
    byID('files-content').inert = this.filesHidden || this.reading;
    byID('recent-panel').hidden = !!item || !!this.workspaceBrowser.root;
    byID('empty').hidden = !!item;
    if (!item && !this.wasEmpty) renderEmptyState(true); this.wasEmpty = !item;
    byID<HTMLButtonElement>('toggle-reading').disabled = !item || item.unsupported;
    byID<HTMLButtonElement>('toggle-source').disabled = !item || item.unsupported || item.textFile;
    byID<HTMLButtonElement>('zoom-button').disabled = !item || item.unsupported;
    byID('toggle-source').setAttribute('aria-pressed', String(this.sourceEditing));
    byID('unsupported').hidden = !item?.unsupported; byID('unsupported-name').textContent = item?.unsupported ? item.title : '';
    byID('editor').hidden = this.reading || !!item?.unsupported;
    const title = byID('document-title');
    title.replaceChildren();
    if (item) { const name = document.createElement('span'); name.className = 'document-name'; name.textContent = this.displayTitle(item); title.append(fileIcon(item.textFile ? item.language ? 'code' : 'text' : 'markdown'), name); }
    byID('notice').hidden = !this.notice; byID('notice-text').textContent = this.notice;
    byID('paste-progress').hidden = !this.pasteJob;
    if (this.pasteJob) byID('paste-label').textContent = this.pasteJob.failure??`${this.pasteJob.cancelRequested ? t('正在取消', 'Cancelling') : t('正在粘贴图片', 'Pasting image')}… · ${this.documents.get(this.pasteJob.documentID)?.title ?? ''}`;
    byID('retry-paste').hidden=byID('local-paste').hidden=!this.pasteJob?.failure;
    const labels = { loaded: '已打开', saving: '正在保存 · 可以继续输入', saved: '已保存', failure: '保存失败 · 编辑已保留', cancelled: '保存已取消', conflict: '检测到外部变更 · 未覆盖', unconfirmed: '保存结果未确认 · 请保留文档' };
    const english = { loaded: 'Opened', saving: 'Saving · You can keep typing', saved: 'Saved', failure: 'Save failed · Edits retained', cancelled: 'Save cancelled', conflict: 'External changes detected · Not overwritten', unconfirmed: 'Save unconfirmed · Keep this document open' };
    byID('status').textContent = item ? item.saves.error || `${t(labels[item.saves.state], english[item.saves.state])}${item.saves.dirty ? t(' · 有未保存修改', ' · Unsaved changes') : ''}${item.savedAt ? ' · ' + formatTimestamp(item.savedAt, this.preferences.timeZone) : ''}` : t('创建或打开 Markdown 文档', 'Create or open a Markdown document');
    this.updateCount(); this.renderOutline(); this.scheduleHint();
  }
  receive(message: Record<string, unknown>): boolean {
    if (message.protocolVersion !== 1 || message.sessionID !== context.sessionID) return false;
    const kind = message.kind;
    if(kind==='imageStorage'){
      const value=message.value as {prefixes?:unknown}|undefined;configureImageSources(value?.prefixes);
      for(const item of this.documents.values())this.edit(item.id,{effects:preferencesEffect.of(this.preferences)});
      this.readingDocument=undefined;if(this.reading)this.renderReading();return true;
    }
    if (kind === 'recentLocations') { this.renderRecent((message.items ?? []) as { id: string; name: string; path: string }[]); return true; }
    if (kind === 'clearPositions') { for (const item of this.documents.values()) item.resume = undefined; this.dismissResume(); return true; }
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
      this.activateOpenedDocument(String(message.documentID), message.fragment, request); this.finishWorkspaceOpen(request, String(message.documentID));
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
    else if (kind === 'closeReceipt'||kind==='copyReceipt'||kind==='beginCopyReceipt') {
      const id = String(message.requestID), resolve = this.requests.get(id); this.requests.delete(id); resolve?.(message);
    } else if (kind === 'closeAllReceipt') {
      const permitted = message.permitted === true;
      if (permitted) {
        this.documentTransition.cancel();
        for (const item of this.documents.values()) { item.unsubscribe(); item.saves.dispose(); }
        this.documents.clear(); this.stalePreviewIDs.clear(); this.activeID = ''; this.view?.destroy(); this.view = null; byID('editor').replaceChildren();
      }
      else { for (const item of this.documents.values()) { item.closeLocked = false; this.lock(item); } this.notice = t('关闭/退出已取消，所有编辑保持打开', 'Close / Quit cancelled. All documents remain open'); }
      this.closing = false; this.renderChrome();
    } else if (kind === 'mermaidReady') this.mermaidResolve?.();
    else if (kind === 'mermaidFailed') this.mermaidReject?.(new Error(String(message.error || t('离线图表加载失败', 'Offline diagram failed to load'))));
    else if (kind === 'notice') this.setNotice(String(message.text));
    else if (kind === 'hostCommand') {
      if (message.action === 'zoom' && typeof message.factor === 'number') {
        if (this.diagramViewer.open) this.diagramViewer.zoom(message.factor);
        else if (!document.querySelector('dialog[open]')) this.zoomBy(message.factor);
        return true;
      }
      if (message.action === 'closeAll') { void this.closeAll(String(message.requestID)); return true; }
      return this.command(String(message.action));
    }
    return true;
  }
  private applyPreferences(value: unknown): void {
    this.copyHighlight.clear();
    const before = this.preferences;
    this.preferences = normalizePreferences(value, this.preferences);
    byID<HTMLInputElement>('show-workspace-recents').checked = this.preferences.showWorkspaceRecents;
    setLanguage(this.preferences.locale); localizePage(); renderEmptyState();
    if (before.focusMode !== this.preferences.focusMode || before.lineNumbers !== this.preferences.lineNumbers || before.shortcutHints !== this.preferences.shortcutHints || before.locale !== this.preferences.locale)
      for (const item of this.documents.values()) this.edit(item.id, { effects: preferencesEffect.of(this.preferences) });
    let fonts = document.getElementById('user-fonts'); if (!fonts) { fonts = document.createElement('style'); fonts.id = 'user-fonts'; document.head.append(fonts); }
    const rules = `@font-face{font-family:"Markfine Latin";src:local(${JSON.stringify(this.preferences.fontEnglish)});unicode-range:U+0000-024F,U+1E00-1EFF}@font-face{font-family:"Markfine CJK";src:local(${JSON.stringify(this.preferences.fontChinese)});unicode-range:U+0250-1DFF,U+2000-10FFFF}`;
    if (fonts.textContent !== rules) fonts.textContent = rules;
    this.workspaceBrowser.setPreferences(this.preferences.showAllFiles, this.preferences.timeZone); this.moveOutline(this.preferences.outlineSide, before.outlineSide !== this.preferences.outlineSide);
    this.moveNavigation(byID('files-panel'), this.preferences.filesSide, before.filesSide !== this.preferences.filesSide);
    this.applyLayout(); this.renderChrome(); if (this.reading) this.renderReading(); else if (Object.entries(this.preferences).some(([key, value]) => key !== 'showWorkspaceRecents' && value !== before[key as keyof typeof before])) this.scheduleCenter();
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
    for (const side of ['left', 'right'] as const) {
      const width = this.preferences[side === 'left' ? 'leftWidth' : 'rightWidth'];
      const navigation = byID(side + '-navigation'); navigation.style.setProperty('--outline-width', `${width}px`);
      byID(side + '-resize').setAttribute('aria-valuenow', String(navigation.getBoundingClientRect().width || width));
    }
    root.style.setProperty('--outline-width', `${this.preferences[this.preferences.outlineSide === 'left' ? 'leftWidth' : 'rightWidth']}px`);
    root.style.setProperty('--content-zoom', String(this.zoom)); root.style.setProperty('--editor-height', `${byID('main').clientHeight}px`);
    root.style.setProperty('--line-spacing', String(this.preferences[this.reading ? 'readLineSpacing' : 'editLineSpacing']));
    root.style.setProperty('--body-line-height', String((this.reading || this.sourceEditing || this.active?.textFile ? bodyLineHeight : editingLineHeight) * this.preferences[this.reading ? 'readLineSpacing' : 'editLineSpacing']));
    root.dataset.appearance = this.preferences.appearance === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : this.preferences.appearance;
    root.dataset.theme = this.preferences[this.reading ? 'readTheme' : 'editTheme'];
    root.dataset.outlineSide = this.preferences.outlineSide;
    document.body.classList.toggle('line-numbers-on', this.preferences.lineNumbers); document.body.classList.toggle('source-mode', this.sourceEditing);
    byID('reader').classList.toggle('reader-line-numbers', this.preferences.lineNumbers); this.view?.requestMeasure();
    this.imageControls.refresh();
  }
  private scheduleCenter(): void {
    if (this.reading || this.pointerSelecting || this.composing() || this.centerFrame ||this.view&&tableHasRange(this.view)) return;
    this.centerFrame = requestAnimationFrame(() => { this.centerFrame = 0; if (this.view && !this.reading && !this.pointerSelecting && !this.composing()) centerCaret(this.view); });
  }
  setReading(enabled: boolean): void {
    if (enabled === this.reading || this.composing() || enabled && (!this.active || this.active.unsupported || this.pasteJob)) return;
    this.copyHighlight.clear();
    this.documentTransition.cancel();
    this.rememberPosition(); this.resetSearchRoom(); this.positionJump++; this.findGeneration++; this.highlights.clear();
    if (enabled) {
      this.pin(this.active!);
      this.outlineBeforeReading = this.outlineHidden;
      if (this.outlineHidden && !this.active?.textFile) this.toggleOutline();
      this.readingPosition = this.active!.state.selection.main.head;
      if (this.view) { this.active!.scroll = this.viewportSnapshot(); this.active!.scrollLeft = this.view.scrollDOM.scrollLeft; stopScroll(this.view.scrollDOM); }
      byID('find-panel').hidden = true;
      document.body.classList.remove('finding');
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); getSelection()?.removeAllRanges();
    } else if (this.active) this.active.readerScroll = byID('reader').scrollTop;
    this.reading = enabled;
    if (!byID('find-panel').hidden) { this.setFindMode(false); this.highlights.set(byID<HTMLInputElement>('query').value); }
    for (const item of this.documents.values()) this.lock(item);
    document.body.classList.toggle('reading', enabled); byID('reading-header').hidden = !enabled;
    byID('editor').hidden = enabled; byID('reader').hidden = !enabled;
    this.applyLayout();
    if (enabled) { this.renderReading(); byID('reader').scrollTop = this.active!.readerScroll ?? 0; byID('reader').focus({ preventScroll: true }); }
    else {
      if (this.outlineBeforeReading && !this.outlineHidden) this.toggleOutline();
      this.view?.focus(); this.scheduleCenter();
    }
    this.renderChrome();
    if (!enabled && this.view) this.view.coordsAtPos(this.view.state.selection.main.head);
    this.post('readingMode', { enabled });
  }
  private renderReading(): void {
    const item = this.active; if (!item || !this.reading) return;
    if (this.readingDocument === item.state.doc && this.readingID === item.id && this.readingLocale === this.preferences.locale) return;
    this.readingDocument = item.state.doc; this.readingID = item.id; this.readingLocale = this.preferences.locale;
    const content = byID('reader-content');
    content.classList.toggle('text-preview', item.textFile);
    if (item.textFile) { content.replaceChildren(renderText(item.state.doc.toString(), item.language)); return; }
    content.innerHTML = renderBlock(item.state.doc.toString(), item.id);
    for (const node of content.querySelectorAll<HTMLElement>('[data-source-line]')) node.dataset.line = String(Number(node.dataset.sourceLine) + 1);
    for (const heading of headingTargets(item.state.doc.toString())) {
      const element = content.querySelector<HTMLElement>(`h${heading.level}[data-source-line="${heading.line}"]`);
      if (element) element.id = heading.id;
    }
    this.hydrate(content, item.id);
  }
  private async navigateFragment(fragment: string, immediate = false, reveal: () => void = () => {}): Promise<void> {
    if (!immediate) this.documentTransition.cancel();
    const item = this.active; if (!item || item.unsupported || !this.view || this.composing()) { reveal(); return; }
    const id = decodeFragment(fragment);
    const heading = id === null || id === '' ? undefined : headingTargets(item.state.doc.toString()).find(heading => heading.id === id);
    if (id === null || id !== '' && !heading) { this.setNotice(t('未找到链接指向的章节。', 'The linked section was not found.')); reveal(); return; }
    this.dismissResume(); this.pin(item); this.positionJump++; this.findGeneration++;
    if (!this.reading) {
      const position = heading ? item.state.doc.line(heading.line + 1).from : 0;
      this.view.dispatch({ selection: EditorSelection.cursor(position) });
      cancelAnimationFrame(this.centerFrame); this.centerFrame = 0;
      this.view.focus(); this.centerMatch(position, reveal, immediate); return;
    }
    this.renderReading();
    const reader = byID('reader'), content = byID('reader-content'), jump = this.positionJump, source = item.state.doc;
    const target = heading ? content.querySelector<HTMLElement>(`h${heading.level}[data-source-line="${heading.line}"]`) : content;
    if (!target) { reveal(); return; }
    const scroll = () => animateScroll(reader, heading ? reader.scrollTop + target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 40 : 0, undefined, immediate ? 0 : undefined);
    scroll(); reveal();
    // Correct for local images/fonts/diagrams above the chapter, but never override a
    // subsequent wheel, tab, mode, find or TOC action while those resources finish.
    let timer = 0;
    const resources = Promise.all([document.fonts.ready, ...[...content.querySelectorAll('img')].map(image => image.decode().catch(() => {})), ...[...content.querySelectorAll<HTMLElement>('[data-diagram]')].map(diagram => this.diagramPromises.get(diagram))]);
    const ready = await Promise.race([resources.then(() => true), new Promise<boolean>(resolve => { timer = window.setTimeout(() => resolve(false), 5000); })]); clearTimeout(timer);
    if (ready && this.activeID === item.id && this.reading && item.state.doc === source && this.positionJump === jump) scroll();
  }
  private scrollReaderTo(element: HTMLElement): void {
    this.documentTransition.cancel();
    this.positionJump++; this.findGeneration++;
    const reader = byID('reader'); animateScroll(reader, reader.scrollTop + element.getBoundingClientRect().top - reader.getBoundingClientRect().top - 40);
  }
  private updateReadingOutline(): void {
    if (!this.reading || !this.active) return;
    const reader = byID('reader'), boundary = reader.getBoundingClientRect().top + reader.clientHeight * .25;
    let line = 1;
    for (const heading of byID('reader-content').querySelectorAll<HTMLElement>('[data-source-line]')) { if (heading.getBoundingClientRect().top > boundary) continue; line = Math.max(line, Number(heading.dataset.sourceLine) + 1); }
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
    if (!this.active || this.active.unsupported || this.active.textFile || this.composing()) return;
    this.copyHighlight.clear();
    this.documentTransition.cancel();
    const enabled = this.reading ? true : !this.sourceEditing; if (this.reading) this.setReading(false);
    this.sourceEditing = enabled;
    for (const item of this.documents.values()) this.edit(item.id, { effects: [sourceModeEffect.of(enabled), item.sourceStyles.reconfigure(enabled && !item.textFile ? syntaxHighlighting(defaultHighlightStyle) : [])] });
    this.applyLayout(); this.renderChrome(); this.view?.focus();
  }
  private moveOutline(side: 'left' | 'right', animate: boolean): void {
    this.moveNavigation(byID('outline-panel'), side, animate);
  }
  private moveNavigation(panel: HTMLElement, side: 'left' | 'right', animate: boolean): void {
    const target = byID(side === 'left' ? 'left-navigation' : 'right-navigation'); if (panel.parentElement === target) return;
    const before = panel.getBoundingClientRect(); target.append(panel); document.documentElement.dataset.outlineSide = side;
    const after = panel.getBoundingClientRect();
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const motion = panel.animate([{ transform: `translate(${before.left - after.left}px,${before.top - after.top}px)`, opacity: .65 }, { transform: 'translate(0,0)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.18,.75,.2,1)' });
      window.setTimeout(() => motion.finish(), 430);
    }
  }

  private async closeTabs(id: string, scope: TabCloseScope): Promise<void> {
    for (const target of closeTargets([...this.documents.keys()].filter(id => !this.stalePreviewIDs.has(id)), id, scope)) if (!await this.closeTab(target)) break;
  }
  private rememberPosition(): void {
    const item = this.active; if (!item || item.unsupported) return;
    let line = item.state.doc.lineAt(item.state.selection.main.head).number, fraction = 0;
    if (this.reading) {
      const boundary = byID('reader').getBoundingClientRect().top;
      const blocks = [...byID('reader-content').querySelectorAll<HTMLElement>(':scope > [data-source-line]')];
      const block = blocks.find(block => block.getBoundingClientRect().bottom > boundary + 1);
      if (block) { line = Number(block.dataset.sourceLine) + 1; const rect = block.getBoundingClientRect(); fraction = Math.max(0, Math.min(1, (boundary - rect.top) / Math.max(1, rect.height))); }
    }
    this.post('rememberPosition', { documentID: item.id, mode: this.reading ? 'read' : 'edit', line, fraction });
  }
  private dismissResume(): void { clearTimeout(this.resumeTimer); byID('resume-position').hidden = true; }
  private offerResume(item: EditorDocument): void {
    if (!item.resume || item.resumeShown || item.unsupported) return;
    item.resumeShown = true;
    byID('resume-position').textContent = item.resume.mode === 'read' ? t('继续上次阅读 →', 'Resume reading →') : t(`返回上次编辑的第 ${item.resume.line} 行 →`, `Return to line ${item.resume.line} →`);
    byID('resume-position').hidden = false; this.resumeTimer = window.setTimeout(() => this.dismissResume(), 5000);
  }
  private async resumePosition(): Promise<void> {
    const item = this.active, saved = item?.resume; if (!item || !saved || this.composing()) return;
    this.dismissResume(); const line = item.state.doc.line(Math.max(1, Math.min(saved.line, item.state.doc.lines)));
    if (saved.mode === 'read') {
      this.setReading(true); const jump = ++this.positionJump, id = item.id;
      const content = byID('reader-content'); let timer = 0;
      const resources = Promise.all([document.fonts.ready, ...[...content.querySelectorAll('img')].map(image => image.decode().catch(() => {})), ...[...content.querySelectorAll<HTMLElement>('[data-diagram]')].map(diagram => this.diagramPromises.get(diagram))]);
      const ready = await Promise.race([resources.then(() => true), new Promise<boolean>(resolve => { timer = window.setTimeout(() => resolve(false), 3000); })]); clearTimeout(timer);
      if (this.activeID !== id || !this.reading || jump !== this.positionJump) return;
      if (!ready) { this.setNotice(t('内容仍在加载，未执行位置跳转。', 'Content is still loading. The position jump was not performed.')); return; }
      const block = this.readerBlock(line.from), reader = byID('reader');
      if (block) animateScroll(reader, reader.scrollTop + block.getBoundingClientRect().top - reader.getBoundingClientRect().top + block.offsetHeight * saved.fraction);
    } else {
      this.setReading(false); this.edit(item.id, { selection: EditorSelection.cursor(line.from) }); this.view?.focus(); this.centerMatch(line.from, () => {});
    }
  }
  private renderRecent(items: { id: string; name: string; path: string }[]): void {
    byID('recent-list').replaceChildren(); byID('recent-empty').hidden = items.length > 0;
    for (const item of items) { const button = document.createElement('button'); button.className = 'recent-item'; button.title = item.path; const name = document.createElement('span'), path = document.createElement('small'); name.textContent = item.name; path.textContent = item.path; button.append(name, path); button.onclick = () => this.post('openRecent', { entryID: item.id }); byID('recent-list').append(button); }
  }
  async exportSnapshot(id: string): Promise<{ html: string; resources: string[] }> {
    const item = this.documents.get(id); if (!item || item.unsupported || item.imageLocked || this.composing()) throw new Error(t('当前文档暂时无法导出', 'The document cannot be exported right now'));
    return item.textFile ? textSnapshot(item.state.doc.toString()) : exportHTML(item.state.doc.toString(), id, () => this.ensureMermaid());
  }
}
const application = new EditorApplication();
globalThis.markfine = { receive: message => application.receive(message), prepareSnapshot: migrateImageReferences, stagedReferences,imageSources,replaceImageDestinations, exportSnapshot: id => application.exportSnapshot(id) };
application.post('ready');
