import { StateEffect, StateField, type ChangeDesc, type EditorState, type Text } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { emptyReferences, extractReferences, type ReferenceContext, type ReferenceDefinition, type References } from './renderer';

interface IndexedBlock {
  readonly from: number;
  readonly to: number;
  readonly text: Text;
  readonly references: References;
}
export interface ReferenceIndex {
  readonly context: ReferenceContext;
  readonly ready: boolean;
  readonly tree: ReturnType<typeof syntaxTree>;
  readonly blocks: readonly IndexedBlock[];
  /** Diagnostic count of block-parser calls; not a latency/performance measurement. */
  readonly blockParses: number;
}
let nextContextKey = 0;
export const refreshReferences = StateEffect.define<null>();

function sameReferences(a: References, b: References): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key].href === b[key]?.href && a[key].title === b[key]?.title);
}

function containsBracket(text: Text): boolean {
  for (const part of text.iter()) if (part.includes('[')) return true;
  return false;
}

function indexReferences(state: EditorState, previous?: ReferenceIndex, changes?: ChangeDesc): ReferenceIndex {
  const oldBlocks = (previous?.blocks ?? []).map(block => changes ? {
    ...block, from: changes.mapPos(block.from, 1), to: changes.mapPos(block.to, -1)
  } : block);
  // Full-document *syntax* context is necessary even when the definition is below the viewport.
  // Work is time-sliced; a view plugin continues unfinished parsing, not a full Markdown render per key.
  const tree = ensureSyntaxTree(state, state.doc.length, 5);
  if (!tree) return {
    context: previous?.context ?? emptyReferences, ready: false, tree: syntaxTree(state), blocks: oldBlocks,
    blockParses: previous?.blockParses ?? 0
  };
  const reusable = new Map(oldBlocks.map(block => [`${block.from}:${block.to}`, block]));
  const blocks: IndexedBlock[] = [];
  const references: Record<string, ReferenceDefinition> = Object.create(null);
  let blockParses = previous?.blockParses ?? 0;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const text = state.doc.slice(node.from, node.to);
    const old = reusable.get(`${node.from}:${node.to}`);
    let block: IndexedBlock;
    if (old && old.text.eq(text)) block = old;
    else {
      const candidate = node.name !== 'FencedCode' && node.name !== 'CodeBlock' && containsBracket(text);
      const local = candidate ? extractReferences(text.toString()) : emptyReferences.references;
      if (candidate) blockParses++;
      block = { from: node.from, to: node.to, text, references: local };
    }
    blocks.push(block);
    // markdown-it normalizes labels; first definition wins across containers and blocks too.
    for (const [label, definition] of Object.entries(block.references)) {
      if (!Object.hasOwn(references, label)) references[label] = definition;
    }
  }
  const oldContext = previous?.context ?? emptyReferences;
  const context = sameReferences(oldContext.references, references) ? oldContext : Object.freeze({
    key: ++nextContextKey, references: Object.freeze(references)
  });
  return { context, ready: true, tree, blocks, blockParses };
}

export const referenceIndex = StateField.define<ReferenceIndex>({
  create: state => indexReferences(state),
  update: (value, transaction) => {
    if (transaction.docChanged || !value.ready || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ||
        transaction.effects.some(effect => effect.is(refreshReferences))) {
      return indexReferences(transaction.state, value, transaction.docChanged ? transaction.changes : undefined);
    }
    return value;
  }
});
