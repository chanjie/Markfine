/** Structural subset of a Lezer node. No parser or DOM dependency in the renderer's mapping path. */
export interface SyntaxBranch {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: SyntaxBranch | null;
  readonly nextSibling: SyntaxBranch | null;
}
interface TextPiece {
  kind: 'text';
  text: string;
  from: number;
  to: number;
  linear: boolean;
  trim: boolean;
}
interface ImagePiece { kind: 'image'; from: number; to: number }
type Piece = TextPiece | ImagePiece;
interface ProjectionGroup {
  kind: 'inline' | 'table' | 'code';
  line: number;
  from: number;
  to: number;
  pieces: Piece[];
}
export interface SourceProjection { groups: ProjectionGroup[]; signature: string; length: number }
/** [displayFrom, displayTo, sourceFrom, sourceTo, atomic]. Offsets are UTF-16, not UTF-8 bytes. */
export type SourceSegment = [number, number, number, number, 0 | 1];
export interface MappingToken {
  type: string;
  content: string;
  map: [number, number] | null;
  children: MappingToken[] | null;
  meta: unknown;
}
interface SourceMeta { spikeSegments?: SourceSegment[]; spikeBoundary?: [number, number] }

export function sourceMeta(meta: unknown): SourceMeta {
  return meta && typeof meta === 'object' ? meta as SourceMeta : {};
}
function addMeta(token: MappingToken, meta: SourceMeta): void {
  token.meta = { ...(token.meta && typeof token.meta === 'object' ? token.meta : {}), ...meta };
}

export function projectSource(source: string, root: SyntaxBranch, base: number, decode: (value: string) => string): SourceProjection {
  const groups: ProjectionGroup[] = [];
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  function lineAt(position: number): number {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >> 1; if (starts[middle] <= position) low = middle; else high = middle; }
    return low;
  }
  const raw = (node: SyntaxBranch) => source.slice(node.from - base, node.to - base);

  function inline(node: SyntaxBranch, kind: 'inline' | 'table'): ProjectionGroup {
    const pieces: Piece[] = [];
    let lineStart = true;
    function text(value: string, from: number, to: number, linear = true, trim = false) {
      if (!value) return;
      pieces.push({ kind: 'text', text: value.replace(/\0/g, '\uFFFD'), from, to, linear, trim });
      lineStart = value.endsWith('\n');
    }
    function literal(from: number, to: number) {
      let cursor = from;
      while (cursor < to) {
        const newline = source.indexOf('\n', cursor);
        const end = newline >= cursor && newline < to ? newline : to;
        let start = cursor, stop = end;
        if (lineStart) while (start < stop && /[ \t]/.test(source[start])) start++;
        if (end < to) while (stop > start && /[ \t]/.test(source[stop - 1])) stop--;
        text(source.slice(start, stop), start, stop, true, true);
        if (end < to) { text('\n', end, end + 1, true, true); lineStart = true; }
        cursor = end < to ? end + 1 : to;
      }
    }
    function content(parent: SyntaxBranch, from = parent.from, to = parent.to) {
      let cursor = from;
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.to <= from || child.from >= to) continue;
        if (child.from > cursor) literal(cursor - base, child.from - base);
        visit(child);
        cursor = child.to;
      }
      if (cursor < to) literal(cursor - base, to - base);
    }
    function visit(child: SyntaxBranch) {
      if (['EmphasisMark', 'StrikethroughMark', 'HeaderMark', 'LinkMark', 'TaskMarker'].includes(child.name)) return;
      if (child.name === 'QuoteMark') { lineStart = true; return; }
      if (child.name === 'Entity') {
        const value = decode(raw(child));
        text(value, child.from - base, child.to - base, false);
      } else if (child.name === 'Escape') {
        text(raw(child).slice(1), child.from - base + 1, child.to - base);
      } else if (child.name === 'HardBreak') {
        const from = child.from - base, to = child.to - base;
        const newline = source.indexOf('\n', from);
        text('\n', newline >= from && newline < to ? newline : to, newline >= from && newline < to ? newline + 1 : to,
          newline >= from && newline < to, true);
      } else if (child.name === 'Image') {
        pieces.push({ kind: 'image', from: child.from - base, to: child.to - base });
        lineStart = false;
      } else if (child.name === 'Link') {
        let opening: SyntaxBranch | null = null, closing: SyntaxBranch | null = null;
        for (let part = child.firstChild; part; part = part.nextSibling) {
          if (part.name === 'LinkMark' && raw(part) === '[' && !opening) opening = part;
          else if (part.name === 'LinkMark' && raw(part) === ']' && opening) { closing = part; break; }
        }
        if (opening && closing) content(child, opening.to, closing.from);
        else literal(child.from - base, child.to - base); // Verification below rejects an incompatible interpretation.
      } else if (child.name === 'InlineCode') {
        let first: SyntaxBranch | null = null, last: SyntaxBranch | null = null;
        for (let part = child.firstChild; part; part = part.nextSibling) if (part.name === 'CodeMark') { first ??= part; last = part; }
        if (!first || !last || first === last) { literal(child.from - base, child.to - base); return; }
        let from = first.to - base, to = last.from - base;
        const value = source.slice(from, to).replace(/\n/g, ' ');
        if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) { from++; to--; }
        // Offsets remain linear for normalized newlines. Container-prefix differences fail the text check safely.
        text(source.slice(from, to).replace(/\n/g, ' '), from, to);
      } else if (child.name === 'HTMLTag' || child.name === 'Comment') {
        text(raw(child), child.from - base, child.to - base); // html:false displays literal source, not active markup.
      } else content(child);
    }
    content(node);
    // Only raw source whitespace is trimmed. An entity/code span that displays whitespace is meaningful.
    while (pieces.length) {
      const first = pieces[0];
      if (first.kind !== 'text' || !first.trim) break;
      const count = /^[ \t\n]*/.exec(first.text)![0].length;
      first.text = first.text.slice(count); first.from += count;
      if (first.text) break;
      pieces.shift();
    }
    while (pieces.length) {
      const last = pieces[pieces.length - 1];
      if (last.kind !== 'text' || !last.trim) break;
      const count = /[ \t\n]*$/.exec(last.text)![0].length;
      last.text = last.text.slice(0, last.text.length - count); last.to -= count;
      if (last.text) break;
      pieces.pop();
    }
    return { kind, line: lineAt(node.from - base), from: node.from - base, to: node.to - base, pieces };
  }

  function code(node: SyntaxBranch): ProjectionGroup {
    const pieces: Piece[] = [];
    for (let part = node.firstChild; part; part = part.nextSibling) if (part.name === 'CodeText') {
      const from = part.from - base, to = part.to - base;
      pieces.push({ kind: 'text', text: source.slice(from, to), from, to, linear: true, trim: false });
    }
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'text' && !last.text.endsWith('\n')) {
      const end = last.to;
      pieces.push({ kind: 'text', text: '\n', from: end, to: source[end] === '\n' ? end + 1 : end,
        linear: source[end] === '\n', trim: false });
    }
    return { kind: 'code', line: lineAt(node.from - base), from: node.from - base, to: node.to - base, pieces };
  }
  function collect(node: SyntaxBranch) {
    if (node.name === 'Paragraph' || node.name === 'Task' || /^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) {
      groups.push(inline(node, 'inline'));
    } else if (node.name === 'CommentBlock') groups.push({ kind: 'inline', line: lineAt(node.from - base), from: node.from - base, to: node.to - base,
      pieces: [{ kind: 'text', text: raw(node), from: node.from - base, to: node.to - base, linear: true, trim: false }] });
    else if (node.name === 'TableCell') groups.push(inline(node, 'table'));
    else if (node.name === 'FencedCode' || node.name === 'CodeBlock') groups.push(code(node));
    else for (let child = node.firstChild; child; child = child.nextSibling) collect(child);
  }
  collect(root);
  return { groups, length: source.length, signature: JSON.stringify(groups) };
}

function matchGroup(tokens: readonly MappingToken[], group: ProjectionGroup): { token: MappingToken; meta: SourceMeta }[] | null {
  let pieceIndex = 0, pieceOffset = 0;
  const annotations: { token: MappingToken; meta: SourceMeta }[] = [];
  function consume(value: string): SourceSegment[] | null {
    let offset = 0;
    const segments: SourceSegment[] = [];
    while (offset < value.length) {
      const piece = group.pieces[pieceIndex];
      if (!piece || piece.kind !== 'text') return null;
      const length = Math.min(value.length - offset, piece.text.length - pieceOffset);
      if (piece.text.slice(pieceOffset, pieceOffset + length) !== value.slice(offset, offset + length) ||
          (!piece.linear && (pieceOffset !== 0 || length !== piece.text.length))) return null;
      const from = piece.linear ? piece.from + pieceOffset : piece.from;
      const to = piece.linear ? from + length : piece.to;
      const last = segments[segments.length - 1];
      if (piece.linear && last && last[4] === 0 && last[1] === offset && last[3] === from) { last[1] += length; last[3] = to; }
      else segments.push([offset, offset + length, from, to, piece.linear ? 0 : 1]);
      offset += length; pieceOffset += length;
      if (pieceOffset === piece.text.length) { pieceIndex++; pieceOffset = 0; }
    }
    return segments;
  }
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'code_block' || token.type === 'fence' || token.type === 'markfine_comment' || token.type === 'markfine_comment_block') {
      const segments = consume(token.content);
      if (segments === null) return null;
      if (segments.length) annotations.push({ token, meta: { spikeSegments: segments } });
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      if (consume('\n') === null) return null;
    } else if (token.type === 'image') {
      const piece = group.pieces[pieceIndex];
      if (!piece || piece.kind !== 'image' || pieceOffset) return null;
      annotations.push({ token, meta: { spikeBoundary: [piece.from, piece.to] } });
      pieceIndex++;
    } else if (token.type !== 'html_inline' && !token.type.endsWith('_open') && !token.type.endsWith('_close')) return null;
  }
  return pieceIndex === group.pieces.length && pieceOffset === 0 ? annotations : null;
}

/** Only publish maps when an entire inline/code group's rendered text agrees, never by substring search. */
export function annotateSourceMaps(tokens: readonly MappingToken[], projection: SourceProjection): void {
  const used = new Set<ProjectionGroup>();
  let tableLine: number | null = null, tableColumn = 0;
  for (const token of tokens) {
    if (token.type === 'tr_open') { tableLine = token.map?.[0] ?? null; tableColumn = 0; }
    if (token.type === 'tr_close') tableLine = null;
    if (token.type !== 'inline' && token.type !== 'code_block' && token.type !== 'fence' && token.type !== 'markfine_comment_block') continue;
    const kind = token.type === 'markfine_comment_block' ? 'inline' : token.type !== 'inline' ? 'code' : token.map ? 'inline' : 'table';
    const line = token.map?.[0] ?? tableLine;
    const candidates = projection.groups.filter(group => group.kind === kind && group.line === line);
    const group = kind === 'table' ? candidates[tableColumn++] : candidates.find(candidate => !used.has(candidate));
    if (!group) continue;
    used.add(group);
    const annotations = matchGroup(token.type === 'inline' ? token.children ?? [] : [token], group);
    if (!annotations) continue;
    for (const { token: child, meta } of annotations) addMeta(child, meta);
    if (token.type === 'fence') addMeta(token, { spikeBoundary: [group.from, group.to] });
  }
}

export function mappedText(html: string, meta: unknown): string {
  const segments = sourceMeta(meta).spikeSegments;
  return segments?.length ? `<span data-source-segments="${JSON.stringify(segments)}">${html}</span>` : html;
}
export function boundaryAttribute(meta: unknown): string {
  const boundary = sourceMeta(meta).spikeBoundary;
  return boundary ? ` data-source-boundary="${boundary.join(',')}"` : '';
}
