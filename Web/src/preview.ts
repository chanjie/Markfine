import { EditorSelection, StateEffect, StateField, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { renderBlock, localImageURL, remoteImageURL, type ReferenceContext } from './renderer';
import { referenceIndex, refreshReferences } from './reference-context';
import { mappedCaretAtPoint } from './source-hit';
import { editorPreferences, preferencesEffect, sourceMode, sourceModeEffect } from './editor-preferences';
import { TableWidget, tableRows } from './table-editor';
import { inlineDecorations } from './inline-presentation';
import { t } from './localization';
import { highlightCode } from './code-highlighting';
import { imageOccurrences, fittedImageWidth } from './image-syntax';
import { pendingListLine, tableConstruction, tableCellWriteback } from './markdown-input-state';
import { sourceTablePosition, sourceTablePresentation } from './table-construction';

export const composingEffect = StateEffect.define<boolean>();
const viewportEffect = StateEffect.define<{ from: number; to: number }>();
export const composition = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(composingEffect)) value = effect.value;
    return value;
  }
});
const viewport = StateField.define<{ from: number; to: number }>({
  create: state => ({ from: 0, to: Math.min(state.doc.length, 6_000) }),
  update: (value, transaction) => {
    value = { from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to, 1) };
    for (const effect of transaction.effects) if (effect.is(viewportEffect)) value = effect.value;
    return value;
  }
});

const imageRangeCache = new WeakMap<Tree, readonly { from: number; to: number }[]>();
export function imageRanges(tree: Tree, doc: Text): readonly { from: number; to: number }[] {
  const cached = imageRangeCache.get(tree); if (cached) return cached;
  const images: { from: number; to: number }[] = []; let offset = 0;
  // Search text chunks instead of visiting every inline syntax node on each edit.
  // Image syntax always begins with ![, and the tree remains the authority.
  for (const part of doc.iter()) {
    for (let at = part.indexOf('!'); at >= 0; at = part.indexOf('!', at + 1)) {
      const position = offset + at; if (position >= tree.length) break;
      if (doc.sliceString(position, position + 2) !== '![') continue;
      let node = tree.resolveInner(position, 1);
      while (node.parent && node.name !== 'Image' && node.from >= position) node = node.parent;
      if (node.name !== 'Image' || node.from !== position) continue;
      let parent = node.parent, excluded = false;
      while (parent) {
        if (['Image', 'Table', 'FencedCode', 'CodeBlock'].includes(parent.name)) { excluded = true; break; }
        parent = parent.parent;
      }
      if (!excluded) images.push({ from: node.from, to: node.to });
    }
    offset += part.length; if (offset >= tree.length) break;
  }
  imageRangeCache.set(tree, images); return images;
}

class ListMarker extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: ListMarker) { return this.text === other.text; }
  toDOM() { const element = document.createElement('span'); element.className = 'list-bullet'; element.textContent = this.text; element.setAttribute('aria-hidden', 'true'); return element; }
}
class TaskMarker extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly checked: boolean) { super(); }
  eq(other: TaskMarker) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const button = document.createElement('button'); button.className = 'task-checkbox'; button.type = 'button'; button.setAttribute('role', 'checkbox');
    button.setAttribute('aria-checked', String(this.checked)); button.setAttribute('aria-label', t('切换任务完成状态', 'Toggle task completion')); button.textContent = this.checked ? '☑' : '☐';
    button.onmousedown = event => event.preventDefault(); button.onclick = () => {
      if (!view.state.readOnly && !view.composing) view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' }, userEvent: 'input.task' });
    }; return button;
  }
  ignoreEvent() { return true; }
}

interface ImageMeasurement { height: number; width: number; naturalWidth: number; naturalHeight: number }
const imageObservers = new WeakMap<HTMLElement, ResizeObserver>();
class BlockWidget extends WidgetType {
  private readonly initialEstimate: number;
  constructor(readonly source: string, readonly from: number, readonly documentID: string,
              readonly context: ReferenceContext, readonly hydrate: (element: HTMLElement) => void,
              readonly imageHeights?: Map<string, ImageMeasurement>, readonly imageURL?: string | null) {
    super(); this.initialEstimate = this.imageHeights?.get(this.imageKey)?.height ?? -1;
  }
  private get imageKey(): string { return `${this.from}\0${this.context.key}\0${this.source}\0${this.imageURL ?? ''}`; }
  get estimatedHeight(): number { return this.initialEstimate; }
  eq(other: BlockWidget): boolean {
    return this.source === other.source && this.from === other.from && this.documentID === other.documentID &&
      this.context === other.context && this.imageURL === other.imageURL && this.initialEstimate === other.initialEstimate;
  }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('section');
    element.className = 'markdown-block';
    element.dataset.sourceFrom = String(this.from);
    element.dataset.sourceLength = String(this.source.length);
    element.dataset.previewSource = this.source;
    element.dataset.previewContext = String(this.context.key);
    element.dataset.previewURL = this.imageURL ?? '';
    element.dataset.line = String(view.state.doc.lineAt(this.from).number);
    element.classList.add('source-line-number');
    const node = view.state.field(referenceIndex).tree.topNode.childAfter(this.from);
    const syntax = node && node.from >= this.from && node.to <= this.from + this.source.length ? { node, from: this.from } : undefined;
    element.innerHTML = renderBlock(this.source, this.documentID, this.context, syntax);
    this.hydrate(element);
    if (this.imageHeights) {
      const remembered = this.imageHeights.get(this.imageKey), image = element.querySelector('img');
      if (remembered && image && !image.naturalWidth) {
        // A rematerialized lazy image may have its top far above the viewport.
        // Reserve the known intrinsic ratio before WebKit loads its bytes so
        // the visible bottom cannot collapse to the alt-text line.
        image.style.width = `${remembered.width}px`;
        image.style.aspectRatio = `${remembered.naturalWidth} / ${remembered.naturalHeight}`;
      }
      // Keep the last measured block height for CodeMirror's offscreen height
      // map. A later viewport/decorations rebuild otherwise replaces a tall
      // image with one estimated line even though the widget still exists.
      const observer = new ResizeObserver(() => {
        const image = element.querySelector('img'), height = element.getBoundingClientRect().height;
        const width = image?.getBoundingClientRect().width ?? 0;
        if (!element.isConnected || !image?.naturalWidth || !image.naturalHeight || height <= 0 || width <= 0) return;
        if (!this.imageHeights!.has(this.imageKey) && this.imageHeights!.size >= 256) {
          this.imageHeights!.delete(this.imageHeights!.keys().next().value!);
        }
        this.imageHeights!.set(this.imageKey, { height, width, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
      });
      observer.observe(element); imageObservers.set(element, observer);
    }
    return element;
  }
  updateDOM(element: HTMLElement, view: EditorView): boolean {
    if (this.imageHeights && element.dataset.previewSource === this.source &&
        element.dataset.previewContext === String(this.context.key) &&
        element.dataset.previewURL === (this.imageURL ?? '') &&
        element.dataset.sourceFrom === String(this.from)) return true;
    // Editing a diagram must not discard the last valid SVG while a new render is pending.
    const current = element.querySelector<HTMLElement>('[data-diagram]'); if (!current) return false;
    const next = document.createElement('div'); next.innerHTML = renderBlock(this.source, this.documentID, this.context);
    const diagram = next.querySelector<HTMLElement>('[data-diagram]'); if (!diagram) return false;
    element.dataset.sourceFrom = String(this.from); element.dataset.sourceLength = String(this.source.length); element.dataset.line = String(view.state.doc.lineAt(this.from).number);
    current.dataset.diagram = diagram.dataset.diagram;
    this.hydrate(element); return true;
  }
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest('a,.image-size-button');
  }
  destroy(element: HTMLElement): void { imageObservers.get(element)?.disconnect(); imageObservers.delete(element); }
}

export function previewBlockRanges(state: EditorState): { from: number; to: number; source: string }[] {
  const index = state.field(referenceIndex);
  const tree = index.tree;
  const range = state.field(viewport);
  const blocks = [];
  // Only visit top-level syntax nodes near the viewport; do not parse/render the whole Markdown on every keypress.
  for (let node = tree.topNode.childAfter(range.from); node && node.from <= range.to; node = node.nextSibling) {
    if (node.to <= node.from || node.name === 'LinkReference') continue;
    const from = state.doc.lineAt(node.from).from;
    const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
    if (state.selection.ranges.some(selection => selection.from <= to && selection.to >= from)) continue;
    const source = state.doc.sliceString(from, to);
    // Do not display stale/missing reference targets while a full syntax context is still being computed.
    if (!index.ready && source.includes('[')) continue;
    blocks.push({ from, to, source });
  }
  return blocks;
}

function decorations(state: EditorState, documentID: string, hydrate: (element: HTMLElement) => void,
                     imageHeights: Map<string, ImageMeasurement>,
                     imageURL: (source: string, context: ReferenceContext) => string | null): DecorationSet {
  const index = state.field(referenceIndex), range = state.field(viewport);
  const raw = state.field(sourceMode), numbers = state.field(editorPreferences).lineNumbers;
  const result: ReturnType<Decoration['range']>[] = raw ? [] : inlineDecorations(state, index.tree, range.from, range.to, index.context);
  const position = state.selection.main.head;
  let active = index.tree.resolveInner(position, -1);
  while (active.parent && !/^(Paragraph|Task|ATXHeading[1-6]|SetextHeading[12]|Table|FencedCode|CodeBlock|HTMLBlock|CommentBlock)$/.test(active.name)) active = active.parent;
  const focus = state.field(editorPreferences).focusMode;
  const pending = state.field(pendingListLine, false);
  let activeFrom = active.from, activeTo = active.to;
  if (active.name === 'Paragraph' || pending != null && active.from < pending && active.to >= pending) {
    let item = active.parent;
    while (item && !['ListItem', 'Document'].includes(item.name)) item = item.parent;
    if (item?.name === 'ListItem') { activeFrom = item.from; activeTo = item.to; }
    else { const line = state.doc.lineAt(position); activeFrom = line.from; activeTo = line.to; }
  }
  const muted = (from: number, to: number) => focus && (active.name === 'Document' ? !(position >= from && position <= to) : (to < activeFrom || from > activeTo));
  const lines = new Map<number, Set<string>>();
  const headingStarts = new Map<number, string>();
  const lineAttributes = new Map<number, Record<string, string>>();
  const lineClass = (from: number, to: number, className: string) => {
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      const start = state.doc.line(number).from;
      if (!lines.has(start)) lines.set(start, new Set()); lines.get(start)!.add(className);
    }
  };
  for (let n = state.doc.lineAt(Math.min(range.from, state.doc.length)).number; n <= state.doc.lineAt(Math.min(range.to, state.doc.length)).number; n++) {
    const line = state.doc.line(n); lineClass(line.from, line.to, (muted(line.from, line.to) ? 'unfocused-block' : 'focused-block') + (raw ? ' source-line' : ''));
  }
  const mark = (from: number, to: number, className: string) => { if (to > from) result.push(Decoration.mark({ class: className }).range(from, to)); };
  let activeTableRendered = false;
  index.tree.iterate({ from: range.from, to: range.to, enter(ref) {
    const node = ref.node, name = node.name;
    if (/^SetextHeading/.test(name) && pending != null && pending >= node.from && pending <= node.to) return false;
    if (name === 'CommentBlock') { lineClass(node.from, node.to, 'markdown-comment'); return false; }
    if (name === 'Comment') { mark(node.from, node.to, 'markdown-comment'); return false; }
    if (raw && name !== 'FencedCode' && name !== 'CodeBlock') return;
    if (name === 'HorizontalRule') {
      lineClass(node.from, node.to, 'live-thematic');
      mark(node.from, node.to, 'thematic-source'); return false;
    }
    if (name === 'Table') {
      if (node.from === active.from && node.to === active.to) activeTableRendered = true;
      const construction = state.field(tableConstruction, false);
      if (construction && node.from <= construction.to && node.to >= construction.from) {
        const presentation = sourceTablePresentation(state, node, range);
        result.push(...presentation.marks, ...inlineDecorations(state, index.tree, node.from, node.to, index.context, true, true));
        for (const line of presentation.lines) {
          lineClass(line.from, line.to, line.className); lineAttributes.set(line.from, line.attributes);
        }
        return false;
      }
      result.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(node.from, node.to), node.from, muted(node.from, node.to)), block: true }).range(node.from, node.to)); return false;
    }
    if (name === 'Image') return false;
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name);
    if (heading) {
      lineClass(node.from, node.to, `live-heading live-h${heading[1]}`);
      const first = state.doc.lineAt(node.from).from;
      lineClass(first, first, 'heading-start'); headingStarts.set(first, 'H' + heading[1]);
    }
    if (name === 'Blockquote') lineClass(node.from, node.to, 'live-quote');
    if (name === 'FencedCode' || name === 'CodeBlock') {
      const source = state.sliceDoc(node.from, node.to);
      const language = node.getChild('CodeInfo'), body = node.getChild('CodeText');
      const info = language ? state.sliceDoc(language.from, language.to).trim().split(/\s+/)[0] : '';
      if (!raw && info === 'mermaid') {
        const widget = new BlockWidget(source, node.from, documentID, index.context, hydrate);
        if (position >= node.from && position <= node.to) result.push(Decoration.widget({ widget, block: true, side: 1 }).range(node.to));
        else { result.push(Decoration.replace({ widget, block: true }).range(node.from, node.to)); return false; }
      }
      if (body && info !== 'mermaid') for (const span of highlightCode(state.sliceDoc(body.from, body.to), info).ranges) mark(body.from + span.from, body.from + span.to, span.className);
      if (!raw) lineClass(node.from, node.to, 'live-code'); return false;
    }
    if (name === 'HeaderMark') {
      const end = name === 'HeaderMark' && /^ATX/.test(node.parent?.name ?? '') ? Math.min(node.to + 1, node.parent!.to) : node.to;
      const editing = state.selection.ranges.some(range => range.from <= end && range.to >= node.from);
      mark(node.from, end, editing ? 'editing-syntax-marker' : 'syntax-marker');
    }
    if (name === 'QuoteMark') result.push(Decoration.replace({}).range(node.from, node.to));
    if (name === 'ListMark' && /^[-+*]$/.test(state.sliceDoc(node.from, node.to))) result.push(Decoration.replace({ widget: new ListMarker('•') }).range(node.from, node.to));
    if (name === 'TaskMarker') result.push(Decoration.replace({ widget: new TaskMarker(node.from, node.to, /x/i.test(state.sliceDoc(node.from, node.to))) }).range(node.from, node.to));
  } });
  if (!raw) for (const image of imageRanges(index.tree, state.doc)) {
    // Keep image decorations in the height map after they leave the source
    // viewport. CodeMirror still creates image DOM only for visible ranges.
    const source = state.sliceDoc(image.from, image.to);
    // The preview is a block, potentially taller than the viewport. An inline
    // widget is virtualized with its source line, so approaching it from below
    // can replace the visible bottom of a tall image with its top. Give
    // CodeMirror a real block in its height map instead.
    result.push(Decoration.widget({ widget: new BlockWidget(source, image.from, documentID, index.context, hydrate,
      imageHeights, imageURL(source, index.context)), block: true, side: -1 }).range(image.to));
    mark(image.from, image.to, 'image-reference');
  }
  // Virtual height changes can move the viewport away from a focused child
  // editor. Retain only its active table decoration so the existing cell DOM
  // is not destroyed; do not render the intervening document or replace a
  // source table that is still being constructed through its native text node.
  if (!raw && active.name === 'Table' && !activeTableRendered) {
    const construction = state.field(tableConstruction, false);
    if (!construction || active.from > construction.to || active.to < construction.from) {
      result.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(active.from, active.to), active.from, false), block: true }).range(active.from, active.to));
    }
  }
  for (const [from, classes] of lines) {
    const attributes: Record<string, string> = { ...lineAttributes.get(from) };
    if (numbers) attributes['data-line'] = String(state.doc.lineAt(from).number);
    if (headingStarts.has(from)) attributes['data-heading'] = headingStarts.get(from)!;
    result.push(Decoration.line({ class: [...classes].join(' ') + (numbers ? ' source-line-number' : ''), attributes }).range(from));
  }
  return Decoration.set(result, true);
}

/** A partial tree must not destroy an unchanged table's live child editors. */
function retainUnparsedActiveTable(previous: DecorationSet, next: DecorationSet, transaction: Transaction): DecorationSet {
  const state = transaction.state, index = state.field(referenceIndex);
  if (index.ready || state.field(sourceMode) || transaction.docChanged && transaction.annotation(tableCellWriteback) !== true) return next;
  const oldSelection = transaction.startState.selection.main, selection = state.selection.main;
  const retained: ReturnType<Decoration['range']>[] = [];
  previous.between(oldSelection.from, oldSelection.to, (from, to, decoration) => {
    const widget = decoration.spec.widget;
    if (retained.length || !(widget instanceof TableWidget) || oldSelection.from < from || oldSelection.to > to ||
        transaction.startState.sliceDoc(from, to) !== widget.source) return;
    const mappedFrom = transaction.changes.mapPos(from, 1), mappedTo = transaction.changes.mapPos(to, -1);
    if (mappedFrom >= mappedTo || index.tree.length > mappedFrom || selection.from < mappedFrom || selection.to > mappedTo) return;
    const construction = state.field(tableConstruction, false);
    if (construction && mappedFrom <= construction.to && mappedTo >= construction.from) return;
    const source = state.sliceDoc(mappedFrom, mappedTo);
    if (transaction.docChanged) {
      const rows = tableRows(widget.source, from), current = tableRows(source, mappedFrom);
      const cell = rows.flatMap(row => row.cells).find(cell => oldSelection.from >= cell.from && oldSelection.to <= cell.to);
      if (!cell || rows.length !== current.length || rows.some((row, i) => row.cells.length !== current[i].cells.length)) return;
      let insideCell = true;
      transaction.changes.iterChanges((start, end, _newStart, _newEnd, inserted) => {
        if (start < cell.from || end > cell.to || /[\r\n]/.test(inserted.toString())) insideCell = false;
      });
      if (!insideCell) return;
    }
    // Read the current authoritative source; retain presentation only. Completed
    // parsing, source mode, structural edits, or leaving the table use normal rendering.
    retained.push(Decoration.replace({ widget: new TableWidget(source, mappedFrom, false), block: true }).range(mappedFrom, mappedTo));
  });
  return retained.length ? next.update({ add: retained, sort: true }) : next;
}

/** Prefer verified text maps; unsupported/non-text output retains explicit boundary/line fallback. */
function renderedPosition(view: EditorView, target: EventTarget | null, point: { x: number; y: number }): number | null {
  const table = sourceTablePosition(view, target, point); if (table !== null) return table;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const block = element?.closest<HTMLElement>('.markdown-block[data-source-from]');
  if (!block || !view.contentDOM.contains(block)) return null;
  const from = Number(block.dataset.sourceFrom);
  const relativeLine = Number(element?.closest('[data-source-line]')?.getAttribute('data-source-line') ?? 0);
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(relativeLine)) return null;
  const hit = element && mappedCaretAtPoint(block, element, point);
  if (hit && from + hit.offset <= view.state.doc.length) return from + hit.offset;
  const line = Math.min(view.state.doc.lines, view.state.doc.lineAt(Math.min(from, view.state.doc.length)).number + Math.max(0, relativeLine));
  return view.state.doc.line(line).from;
}

const renderedSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.ctrlKey || view.composing || view.state.field(composition) ||
      (event.target instanceof Element && event.target.closest('a'))) return null;
  let start = renderedPosition(view, event.target, { x: event.clientX, y: event.clientY });
  if (start === null) return null;
  let original = view.state.selection;
  let last = { x: event.clientX, y: event.clientY, position: start };
  return {
    get(current, extend) {
      const target = view.dom.ownerDocument.elementFromPoint(current.clientX, current.clientY);
      // Revealing source can change layout under a stationary pointer. Do not relocate a click on mouseup.
      const position = current === event ? start! : current.type === 'mouseup' && current.clientX === last.x && current.clientY === last.y ? last.position :
        renderedPosition(view, target, { x: current.clientX, y: current.clientY }) ?? view.posAtCoords({ x: current.clientX, y: current.clientY }, false) ?? start!;
      last = { x: current.clientX, y: current.clientY, position };
      return EditorSelection.single(extend ? original.main.anchor : start!, position);
    },
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start!);
        last.position = update.changes.mapPos(last.position);
        original = original.map(update.changes);
      }
    }
  };
});

export function blockPreview(documentID: string, hydrate: (element: HTMLElement) => void) {
  const imageHeights = new Map<string, ImageMeasurement>();
  const pendingImages = new Map<string, HTMLImageElement>();
  const failedImages = new Set<string>();
  const loadedImages = new Map<string, { width: number; height: number }>();
  let measureView: EditorView | undefined;
  const urls = new Map<string, string | null>();
  const previewURL = (source: string, context: ReferenceContext): string | null => {
    const key = `${context.key}\0${source}`;
    if (urls.has(key)) return urls.get(key)!;
    const direct = imageOccurrences(source)[0]?.destination;
    const url = direct && (localImageURL(direct, documentID) ?? remoteImageURL(direct, documentID));
    // Parse the already-escaped renderer output as text: creating a detached
    // <img> just to read its URL can itself start a resource request.
    const fallback = url || /<img\s[^>]*\bsrc="(markfine:\/\/app\/(?:image|remote-image)\/[^"]+)"/.exec(renderBlock(source, documentID, context))?.[1] || null;
    // Remote-image eligibility can change with S3 preferences; only memoize
    // local URLs, which are independent of those settings.
    if (fallback?.startsWith('markfine://app/image/')) {
      if (urls.size >= 256) urls.delete(urls.keys().next().value!);
      urls.set(key, fallback);
    }
    return fallback;
  };
  const imageLoader = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { measureView = view; this.schedule(); }
    private timer = 0;
    update(update: ViewUpdate) {
      if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(preferencesEffect)))) failedImages.clear();
      if (update.docChanged || update.viewportChanged || update.geometryChanged ||
          update.startState.field(referenceIndex) !== update.state.field(referenceIndex) ||
          update.transactions.some(transaction => transaction.effects.some(effect => effect.is(sourceModeEffect) || effect.is(preferencesEffect)))) this.schedule();
    }
    schedule() {
      if (this.timer) return;
      this.timer = window.setTimeout(() => { this.timer = 0; this.load(); }, 0);
    }
    load() {
      if (this.view.state.field(sourceMode)) return;
      const index = this.view.state.field(referenceIndex);
      if (!index.ready) return;
      const visible = this.view.viewport;
      const occurrences = imageRanges(index.tree, this.view.state.doc)
        .filter(image => image.to >= visible.from - 6000 && image.from <= visible.to + 6000);
      const needed = occurrences.map(image => {
        const source = this.view.state.sliceDoc(image.from, image.to);
        const url = previewURL(source, index.context);
        const key = `${image.from}\0${index.context.key}\0${source}\0${url ?? ''}`;
        return { key, source, url };
      });
      const column = this.view.contentDOM;
      const port = this.view.scrollDOM, style = getComputedStyle(column);
      const main = document.getElementById('main');
      const inset = main ? parseFloat(getComputedStyle(main).getPropertyValue('--content-inset')) || 72 : 72;
      const visibleWidth = port.getBoundingClientRect().left + port.clientWidth - column.getBoundingClientRect().left - 12;
      const available = Math.max(1, Math.min(column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8,
        port.clientWidth - inset - 8, visibleWidth));
      const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-zoom')) || 1;
      let changed = false;
      for (const item of needed) {
        if (!item.url) continue;
        const previous = imageHeights.get(item.key);
        if (previous) {
          const occurrence = imageOccurrences(item.source)[0];
          const width = fittedImageWidth(previous.naturalWidth, available, zoom, occurrence?.width);
          if (Math.abs(width - previous.width) >= 1) {
            imageHeights.set(item.key, { ...previous, width,
              height: Math.max(1, previous.height + (width - previous.width) * previous.naturalHeight / previous.naturalWidth) });
            changed = true;
          }
          continue;
        }
        const known = loadedImages.get(item.url);
        if (known) {
          const occurrence = imageOccurrences(item.source)[0];
          const width = fittedImageWidth(known.width, available, zoom, occurrence?.width);
          if (!imageHeights.has(item.key) && imageHeights.size >= 256) imageHeights.delete(imageHeights.keys().next().value!);
          imageHeights.set(item.key, { width, height: width * known.height / known.width + 41,
            naturalWidth: known.width, naturalHeight: known.height });
          changed = true;
          continue;
        }
        if (failedImages.has(item.url) || pendingImages.has(item.url)) continue;
        if (pendingImages.size >= 2) break;
        const probe = new Image(); probe.decoding = 'async'; pendingImages.set(item.url, probe);
        probe.onload = () => {
          pendingImages.delete(item.url!);
          if (measureView !== this.view || !probe.naturalWidth || !probe.naturalHeight) return;
          if (!loadedImages.has(item.url!) && loadedImages.size >= 64) loadedImages.delete(loadedImages.keys().next().value!);
          loadedImages.set(item.url!, { width: probe.naturalWidth, height: probe.naturalHeight });
          this.schedule();
        };
        probe.onerror = () => {
          pendingImages.delete(item.url!);
          failedImages.add(item.url!); this.schedule();
        };
        probe.src = item.url;
      }
      if (changed) {
        this.view.dispatch({ effects: viewportEffect.of(this.view.state.field(viewport)) });
      }
    }
    destroy() {
      clearTimeout(this.timer);
      if (measureView === this.view) measureView = undefined;
      for (const image of pendingImages.values()) { image.onload = null; image.onerror = null; image.src = ''; }
      pendingImages.clear();
    }
  });
  const field = StateField.define<DecorationSet>({
    create: state => decorations(state, documentID, hydrate, imageHeights, previewURL),
    update: (value, transaction) => {
      if (transaction.state.field(composition)) return value.map(transaction.changes);
      if (transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(viewportEffect) || effect.is(composingEffect) || effect.is(preferencesEffect) || effect.is(sourceModeEffect)) ||
          transaction.startState.field(referenceIndex) !== transaction.state.field(referenceIndex)) {
        return retainUnparsedActiveTable(value, decorations(transaction.state, documentID, hydrate, imageHeights, previewURL), transaction);
      }
      return value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const visible = ViewPlugin.fromClass(class {
    private frame = 0;
    private timer = 0;
    constructor(readonly view: EditorView) { this.schedule(); }
    update() { this.schedule(); }
    schedule() {
      if (this.frame || this.timer) return;
      const run = () => {
        cancelAnimationFrame(this.frame); clearTimeout(this.timer); this.frame = 0; this.timer = 0;
        if (this.view.composing || this.view.state.field(composition)) return;
        if (!this.view.state.field(referenceIndex).ready) {
          const before = this.view.state;
          forceParsing(this.view, this.view.state.doc.length, 5);
          if (this.view.state === before) this.view.dispatch({ effects: refreshReferences.of(null) });
          if (!this.view.state.field(referenceIndex).ready) this.schedule();
        }
        const current = this.view.state.field(viewport);
        const from = Math.max(0, this.view.viewport.from - 2_000);
        const to = Math.min(this.view.state.doc.length, this.view.viewport.to + 2_000);
        if (current.from > this.view.viewport.from || current.to < this.view.viewport.to ||
            Math.abs(current.from - from) > 500 || Math.abs(current.to - to) > 500) {
          this.view.dispatch({ effects: viewportEffect.of({ from, to }) });
        }
      };
      this.frame = requestAnimationFrame(run);
      // A minimized or detached WebView can suspend animation frames even
      // while its viewport and syntax state continue to change.
      this.timer = window.setTimeout(run, 120);
    }
    destroy() { cancelAnimationFrame(this.frame); clearTimeout(this.timer); }
  });
  return [composition, viewport, referenceIndex, editorPreferences, sourceMode, field, visible, imageLoader, renderedSelection, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
    compositionend: (_event, view) => {
      queueMicrotask(() => { if (!view.composing) view.dispatch({ effects: composingEffect.of(false) }); });
      return false;
    }
  })];
}
