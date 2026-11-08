import { editorMarkdownLanguage } from './editor-language';
import type { ResourceChange } from './migration';

export function imageLabel(value: string): { alt: string; width?: number } {
  const text = value.replace(/\\\|/g, '|'), match = /^(.*)\|([1-9]\d{0,5})$/s.exec(text);
  return match && Number(match[2]) <= 100_000 ? { alt: match[1], width: Number(match[2]) } : { alt: text };
}
export interface ImageOccurrence { from: number; to: number; labelFrom: number; labelTo: number; label: string; width?: number; destination?: string }
export function imageOccurrences(source: string): ImageOccurrence[] {
  const result: ImageOccurrence[] = [];
  editorMarkdownLanguage.parser.parse(source).iterate({ enter(ref) {
    if (ref.name !== 'Image') return;
    const marks = ref.node.getChildren('LinkMark'); if (marks.length < 2) return false;
    const label = source.slice(marks[0].to, marks[1].from), parsed = imageLabel(label);
    const url = ref.node.getChild('URL');
    result.push({ from: ref.from, to: ref.to, labelFrom: marks[0].to, labelTo: marks[1].from, label: parsed.alt, width: parsed.width,
      destination: url ? source.slice(url.from, url.to).replace(/^<|>$/g, '') : undefined });
    return false;
  } });
  return result;
}
export function imageWidthChange(source: string, from: number, width?: number): ResourceChange | null {
  const image = imageOccurrences(source).find(image => image.from === from);
  if (!image || width !== undefined && (!Number.isFinite(width) || width < 1 || width > 100_000)) return null;
  const inTable = source.slice(source.lastIndexOf('\n', image.from - 1) + 1, image.from).includes('|');
  const label = source.slice(image.labelFrom, image.labelTo).replace(/(?:\\?\|)[1-9]\d{0,5}$/, '');
  return { from: image.labelFrom, to: image.labelTo, insert: label + (width === undefined ? '' : (inTable ? '\\|' : '|') + Math.round(width)) };
}
export function fittedImageWidth(original: number, available: number, zoom = 1, stored?: number): number {
  if (![original, available, zoom].every(value => Number.isFinite(value) && value > 0)) return 0;
  return Math.min((stored && stored > 0 ? stored : original) * zoom, available);
}

/** Rewrite image destinations only, including reference definitions. Never touch similar prose/code. */
export function replaceImageDestinations(source: string, mapping: Readonly<Record<string, string>>): string {
  const changes: ResourceChange[] = [];
  editorMarkdownLanguage.parser.parse(source).iterate({ enter(ref) {
    if (ref.name !== 'Image' && ref.name !== 'LinkReference') return;
    const url = ref.node.getChild('URL'); if (!url) return false;
    const raw = source.slice(url.from, url.to), angle = raw.startsWith('<'), destination = angle ? raw.slice(1, -1) : raw;
    const replacement = mapping[destination];
    if (typeof replacement === 'string' && !/[\u0000-\u0020<>"()\\]/.test(replacement)) changes.push({ from: url.from, to: url.to, insert: angle ? '<' + replacement + '>' : replacement });
    return false;
  } });
  let result = source; for (const change of changes.sort((a,b) => b.from-a.from)) result = result.slice(0,change.from)+change.insert+result.slice(change.to);
  return result;
}
