import { markdown } from './renderer';

export interface HeadingTarget { id: string; level: number; line: number }
/** Same plain-text, Unicode-aware anchors in live/source navigation and the reader. */
export function headingTargets(source: string): HeadingTarget[] {
  const tokens = markdown.parse(source, {}), used = new Set<string>(), result: HeadingTarget[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || !token.map) continue;
    const inline = tokens[index + 1];
    const text = (inline?.children ?? []).map(child => ['text', 'code_inline', 'image', 'markfine_comment'].includes(child.type) ? child.content : /^(soft|hard)break$/.test(child.type) ? ' ' : '').join('');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
    let id = base, suffix = 0;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id); result.push({ id, level: Number(token.tag.slice(1)), line: token.map[0] });
  }
  return result;
}

export function decodeFragment(fragment: string): string | null {
  try { return decodeURIComponent(fragment); } catch { return null; }
}
