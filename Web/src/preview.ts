import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderBlock, type ReferenceContext } from './renderer';
import { referenceIndex, refreshReferences } from './reference-context';
import { mappedCaretAtPoint } from './source-hit';
import { editorPreferences, preferencesEffect, sourceMode, sourceModeEffect } from './editor-preferences';
import { TableWidget } from './table-editor';
import { inlineDecorations } from './inline-presentation';
import { t } from './localization';
import { highlightCode } from './code-highlighting';

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

class BlockWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly documentID: string,
              readonly context: ReferenceContext, readonly hydrate: (element: HTMLElement) => void) { super(); }
  eq(other: BlockWidget): boolean {
    return this.source === other.source && this.from === other.from && this.documentID === other.documentID && this.context === other.context;
  }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('section');
    element.className = 'markdown-block';
    element.dataset.sourceFrom = String(this.from);
    element.dataset.sourceLength = String(this.source.length);
    element.dataset.line = String(view.state.doc.lineAt(this.from).number);
    element.classList.add('source-line-number');
    const node = view.state.field(referenceIndex).tree.topNode.childAfter(this.from);
    const syntax = node && node.from >= this.from && node.to <= this.from + this.source.length ? { node, from: this.from } : undefined;
    element.innerHTML = renderBlock(this.source, this.documentID, this.context, syntax);
    this.hydrate(element);
    return element;
  }
  updateDOM(element: HTMLElement, view: EditorView): boolean {
    // Editing a diagram must not discard the last valid SVG while a new render is pending.
    const current = element.querySelector<HTMLElement>('[data-diagram]'); if (!current) return false;
    const next = document.createElement('div'); next.innerHTML = renderBlock(this.source, this.documentID, this.context);
    const diagram = next.querySelector<HTMLElement>('[data-diagram]'); if (!diagram) return false;
    element.dataset.sourceFrom = String(this.from); element.dataset.sourceLength = String(this.source.length); element.dataset.line = String(view.state.doc.lineAt(this.from).number);
    current.dataset.diagram = diagram.dataset.diagram;
    this.hydrate(element); return true;
  }
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest('a');
  }
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

function decorations(state: EditorState, documentID: string, hydrate: (element: HTMLElement) => void): DecorationSet {
  const index = state.field(referenceIndex), range = state.field(viewport);
  const raw = state.field(sourceMode), numbers = state.field(editorPreferences).lineNumbers;
  const result: ReturnType<Decoration['range']>[] = raw ? [] : inlineDecorations(state, index.tree, range.from, range.to, index.context);
  const position = state.selection.main.head;
  let active = index.tree.resolveInner(position, -1);
  while (active.parent && !/^(Paragraph|Task|ATXHeading[1-6]|SetextHeading[12]|Table|FencedCode|CodeBlock|HTMLBlock)$/.test(active.name)) active = active.parent;
  const focus = state.field(editorPreferences).focusMode;
  const muted = (from: number, to: number) => focus && (active.name === 'Document' ? !(position >= from && position <= to) : (to < active.from || from > active.to));
  const lines = new Map<number, Set<string>>();
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
  index.tree.iterate({ from: range.from, to: range.to, enter(ref) {
    const node = ref.node, name = node.name;
    if (raw && name !== 'FencedCode' && name !== 'CodeBlock') return;
    if (name === 'Table') {
      result.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(node.from, node.to), node.from, muted(node.from, node.to)), block: true }).range(node.from, node.to)); return false;
    }
    if (name === 'Image') {
      const source = state.sliceDoc(node.from, node.to);
      result.push(Decoration.widget({ widget: new BlockWidget(source, node.from, documentID, index.context, hydrate), side: 1 }).range(node.to));
      mark(node.from, node.to, 'image-reference'); return false;
    }
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name);
    if (heading) lineClass(node.from, node.to, `live-heading live-h${heading[1]}`);
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
      mark(node.from, end, 'syntax-marker');
    }
    if (name === 'QuoteMark') result.push(Decoration.replace({}).range(node.from, node.to));
    if (name === 'ListMark' && /^[-+*]$/.test(state.sliceDoc(node.from, node.to))) result.push(Decoration.replace({ widget: new ListMarker('•') }).range(node.from, node.to));
    if (name === 'TaskMarker') result.push(Decoration.replace({ widget: new TaskMarker(node.from, node.to, /x/i.test(state.sliceDoc(node.from, node.to))) }).range(node.from, node.to));
  } });
  for (const [from, classes] of lines) result.push(Decoration.line({ class: [...classes].join(' ') + (numbers ? ' source-line-number' : ''), attributes: numbers ? { 'data-line': String(state.doc.lineAt(from).number) } : undefined }).range(from));
  return Decoration.set(result, true);
}

/** Prefer verified text maps; unsupported/non-text output retains explicit boundary/line fallback. */
function renderedPosition(view: EditorView, target: EventTarget | null, point: { x: number; y: number }): number | null {
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
  if (event.button !== 0 || view.composing || view.state.field(composition) ||
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
  const field = StateField.define<DecorationSet>({
    create: state => decorations(state, documentID, hydrate),
    update: (value, transaction) => {
      if (transaction.state.field(composition)) return value.map(transaction.changes);
      if (transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(viewportEffect) || effect.is(composingEffect) || effect.is(preferencesEffect) || effect.is(sourceModeEffect)) ||
          transaction.startState.field(referenceIndex) !== transaction.state.field(referenceIndex)) return decorations(transaction.state, documentID, hydrate);
      return value;
    },
    provide: field => EditorView.decorations.from(field)
  });
  const visible = ViewPlugin.fromClass(class {
    private frame = 0;
    constructor(readonly view: EditorView) { this.schedule(); }
    update() { this.schedule(); }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
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
      });
    }
    destroy() { cancelAnimationFrame(this.frame); }
  });
  return [composition, viewport, referenceIndex, editorPreferences, sourceMode, field, visible, renderedSelection, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
    compositionend: (_event, view) => {
      queueMicrotask(() => { if (!view.composing) view.dispatch({ effects: composingEffect.of(false) }); });
      return false;
    }
  })];
}
