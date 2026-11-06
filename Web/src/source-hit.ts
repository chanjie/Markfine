import type { SourceSegment } from './source-projection';

interface SpanMap {
  text: string;
  encoded: string;
  limit: number;
  segments: SourceSegment[];
  boundaries: readonly number[] | null;
}
export interface SourceHit { offset: number; kind: 'text' | 'boundary'; method: 'native' | 'geometry' | 'boundary' }
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const cache = new WeakMap<Element, SpanMap>();

/** Use iteration, not Segments.containing(): this WK build returned an overlapping CJK/emoji cluster there. */
export function graphemeBoundaries(text: string): number[] | null {
  const result = [0];
  for (const part of segmenter.segment(text)) {
    if (part.index !== result[result.length - 1] || !part.segment.length) return null;
    result.push(part.index + part.segment.length);
    if (result.length > 16_385) return null; // Bounded click work; huge/unverifiable spans keep the line fallback.
  }
  return result[result.length - 1] === text.length ? result : null;
}
function boundaryIndex(boundaries: readonly number[], offset: number): number {
  let low = 0, high = boundaries.length - 1;
  while (low < high) { const middle = (low + high) >> 1; if (boundaries[middle] < offset) low = middle + 1; else high = middle; }
  return low;
}

export function validSegments(value: unknown, textLength: number, sourceLength: number): value is SourceSegment[] {
  if (!Array.isArray(value) || !value.length) return false;
  let display = 0, previousSource = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 5 || !entry.every(Number.isSafeInteger)) return false;
    const [start, end, from, to, atomic] = entry;
    if (start !== display || end <= start || end > textLength || from < previousSource || to < from || to > sourceLength ||
        (atomic !== 0 && atomic !== 1) || (atomic === 0 && end - start !== to - from)) return false;
    display = end; previousSource = to;
  }
  return display === textLength;
}

/** Clamp grapheme interiors, and map one-to-many entities only to their source edges. */
export function mapTextOffset(text: string, segments: readonly SourceSegment[], offset: number,
                              boundaries: readonly number[] | null = graphemeBoundaries(text)): { offset: number; kind: 'text' | 'boundary' } | null {
  if (!boundaries || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  const index = boundaryIndex(boundaries, offset);
  if (boundaries[index] !== offset) {
    const start = boundaries[index - 1], end = boundaries[index];
    offset = offset - start <= end - offset ? start : end;
  }
  const segment = segments.find(entry => offset >= entry[0] && offset < entry[1]) ??
    (offset === text.length ? segments[segments.length - 1] : undefined);
  if (!segment) return null;
  const [start, end, from, to, atomic] = segment;
  if (!atomic) return { offset: from + offset - start, kind: 'text' };
  const inside = offset > start && offset < end;
  return { offset: offset - start <= end - offset ? from : to, kind: inside || from === to ? 'boundary' : 'text' };
}

function spanMap(span: HTMLElement, limit: number): SpanMap | null {
  const text = span.textContent ?? '', encoded = span.dataset.sourceSegments;
  if (!encoded || span.childNodes.length !== 1 || span.firstChild?.nodeType !== Node.TEXT_NODE) return null;
  const old = cache.get(span);
  if (old && old.text === text && old.encoded === encoded && old.limit === limit) return old;
  let segments: unknown;
  try { segments = JSON.parse(encoded); } catch { return null; }
  if (!validSegments(segments, text.length, limit)) return null;
  const result = { text, encoded, limit, segments, boundaries: graphemeBoundaries(text) };
  cache.set(span, result);
  return result;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};
function nativeCaret(doc: CaretDocument, x: number, y: number): { node: Node; offset: number } | null {
  try {
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  } catch { return null; }
}

function rectDistance(rect: DOMRect, x: number, y: number): number {
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  return dy * dy + dx * dx;
}

function visualCaret(span: HTMLElement, offsets: readonly number[], point: { x: number; y: number }): number | null {
  const range = span.ownerDocument.createRange();
  let best: number | null = null, bestVertical = Infinity, bestHorizontal = Infinity;
  for (const offset of offsets) {
    range.setStart(span.firstChild!, offset); range.collapse(true);
    for (const rect of range.getClientRects()) {
      if (rect.height <= 0) continue;
      const vertical = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
      const horizontal = Math.abs(rect.left - point.x);
      if (vertical < bestVertical || (vertical === bestVertical && horizontal < bestHorizontal)) {
        best = offset; bestVertical = vertical; bestHorizontal = horizontal;
      }
    }
  }
  return best;
}

function checkedNativeOffset(span: HTMLElement, map: SpanMap, offset: number, point: { x: number; y: number }): number | null {
  if (!map.boundaries || !Number.isSafeInteger(offset) || offset < 0 || offset > map.text.length) return null;
  const index = boundaryIndex(map.boundaries, offset);
  const ordered = map.boundaries.slice(Math.max(0, index - 2), Math.min(map.boundaries.length, index + 3));
  if (ordered.length < 2) return null;
  const range = span.ownerDocument.createRange();
  range.setStart(span.firstChild!, ordered[0]); range.setEnd(span.firstChild!, ordered[ordered.length - 1]);
  // A native offset can be one glyph off around fallback CJK fonts. Verify nearby caret geometry,
  // but don't trust a distant native answer just because its source-map offsets are well formed.
  if (![...range.getClientRects()].some(rect => point.x >= rect.left - 0.5 && point.x <= rect.right + 0.5 && point.y >= rect.top && point.y <= rect.bottom)) return null;
  return visualCaret(span, ordered, point);
}

export function mappedCaretAtPoint(block: HTMLElement, target: Element, point: { x: number; y: number }): SourceHit | null {
  const limit = Number(block.dataset.sourceLength);
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const boundary = target.closest<HTMLElement>('[data-source-boundary]');
  if (boundary && block.contains(boundary)) {
    const values = boundary.dataset.sourceBoundary?.split(',').map(Number);
    if (!values || values.length !== 2 || !values.every(Number.isSafeInteger) || values[0] < 0 || values[1] < values[0] || values[1] > limit) return null;
    const rect = boundary.getBoundingClientRect();
    return { offset: point.x < rect.left + rect.width / 2 ? values[0] : values[1], kind: 'boundary', method: 'boundary' };
  }
  // Application-generated labels/markers have no character-for-character source representation.
  if (target.closest('img,svg,.diagram,.image-placeholder,.task-marker')) return null;
  const doc = block.ownerDocument;
  const caret = nativeCaret(doc, point.x, point.y);
  if (caret?.node.nodeType === Node.TEXT_NODE) {
    const span = caret.node.parentElement?.closest<HTMLElement>('[data-source-segments]');
    if (span && block.contains(span) && span.firstChild === caret.node) {
      const map = spanMap(span, limit);
      const checked = map && checkedNativeOffset(span, map, caret.offset, point);
      const result = map && checked !== null && mapTextOffset(map.text, map.segments, checked, map.boundaries);
      if (result) return { ...result, method: checked === caret.offset ? 'native' : 'geometry' };
    }
  }
  // WK may return the edge of contentEditable=false instead of its text. Use bounded DOM Range geometry then.
  const direct = target.closest<HTMLElement>('[data-source-segments]');
  const scope = block.contains(target) ? target : block;
  const candidates = direct && block.contains(direct) ? [direct] : [...scope.querySelectorAll<HTMLElement>('[data-source-segments]')];
  let closest: HTMLElement | null = null, distance = Infinity;
  for (const span of candidates) for (const rect of span.getClientRects()) {
    const score = rectDistance(rect, point.x, point.y);
    if (score < distance) { closest = span; distance = score; }
  }
  const map = closest && spanMap(closest, limit);
  if (!closest || !map || !map.boundaries || map.text.length > 4_096 || map.boundaries.length > 1_025) return null;
  const offsets = map.boundaries;
  const best = visualCaret(closest, offsets, point);
  const result = best === null ? null : mapTextOffset(map.text, map.segments, best, map.boundaries);
  return result ? { ...result, method: 'geometry' } : null;
}
