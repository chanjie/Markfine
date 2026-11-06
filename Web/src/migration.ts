import { editorMarkdownLanguage } from './editor-language';

export interface ResourceChange { from: number; to: number; insert: string }
export function stagedReferences(source: string): string[] {
  if (!source.includes('markfine-staging/')) return [];
  const candidates = [...new Set(source.match(/markfine-staging\/image-[a-f\d-]+\.(?:png|jpg)/gi) ?? [])];
  const identity = Object.fromEntries(candidates.map(path => [path, path]));
  return [...new Set(imageMigrationChanges(source, identity).map(change => source.slice(change.from, change.to)))];
}
/** Only image destination nodes are rewritten. Code, prose, ordinary links and other documents are untouched. */
export function imageMigrationChanges(source: string, mapping: Readonly<Record<string, string>>): ResourceChange[] {
  if (!Object.keys(mapping).length || !source.includes('markfine-staging/')) return [];
  const changes: ResourceChange[] = [];
  editorMarkdownLanguage.parser.parse(source).iterate({ enter(node) {
    if (node.name !== 'Image' && node.name !== 'LinkReference') return;
    const raw = source.slice(node.from, node.to);
    const destination = (node.name === 'Image' ? /\]\(\s*(<?)(markfine-staging\/image-[a-f\d-]+\.(?:png|jpg))(?=>?(?:\s|\)))/i :
      /:\s*(<?)(markfine-staging\/image-[a-f\d-]+\.(?:png|jpg))(?=>?(?:\s|$))/i).exec(raw);
    if (!destination) return false;
    const old = destination[2], replacement = mapping[old];
    if (typeof replacement !== 'string' || /[\u0000-\u0020<>"()\\]/.test(replacement)) return false;
    const from = node.from + destination.index + destination[0].indexOf(old);
    changes.push({ from, to: from + old.length, insert: replacement });
    return false;
  } });
  return changes.sort((a, b) => a.from - b.from);
}
export function migrateImageReferences(source: string, mapping: Readonly<Record<string, string>>): string {
  let result = source;
  for (const change of imageMigrationChanges(source, mapping).reverse()) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  return result;
}
