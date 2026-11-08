import MarkdownIt from 'markdown-it';
import { annotateSourceMaps, boundaryAttribute, mappedText, projectSource, sourceMeta, type SyntaxBranch } from './source-projection';
import { installSelectedGFM } from './gfm-extensions';
import { safeLink } from './links';
import { t } from './localization';
import { highlightCode } from './code-highlighting';
import { imageLabel } from './image-syntax';
export { validateDiagram } from './diagrams';

export const markdown = new MarkdownIt('commonmark', { html: false, typographer: false });
installSelectedGFM(markdown);
// HTML stays disabled. Comments are opaque escaped text, not executable markup or Markdown.
markdown.inline.ruler.before('text', 'markfine-comment', (state, silent) => {
  if (!state.src.startsWith('<!--', state.pos)) return false;
  const end = state.src.indexOf('-->', state.pos + 4), to = end < 0 ? state.posMax : end + 3;
  if (!silent) { const token = state.push('markfine_comment', '', 0); token.content = state.src.slice(state.pos, to); }
  state.pos = to; return true;
});
markdown.renderer.rules.markfine_comment = (tokens, index) => `<span class="markdown-comment">${mappedText(markdown.utils.escapeHtml(tokens[index].content), tokens[index].meta)}</span>`;
markdown.block.ruler.before('paragraph', 'markfine-comment-block', (state, start, end, silent) => {
  const from = state.bMarks[start] + state.tShift[start];
  if (state.sCount[start] - state.blkIndent >= 4 || !state.src.startsWith('<!--', from)) return false;
  const limit = end < state.bMarks.length ? state.bMarks[end] : state.src.length;
  const close = state.src.indexOf('-->', from + 4); let next = start + 1;
  if (close >= 0 && close < limit) {
    while (next < end && state.bMarks[next] <= close + 2) next++;
    if (state.src.slice(close + 3, state.eMarks[next - 1]).trim()) return false;
  } else next = end;
  if (silent) return true;
  const token = state.push('markfine_comment_block', '', 0); token.block = true; token.map = [start, next];
  token.content = state.getLines(start, next, state.blkIndent, false).replace(/\n$/, ''); state.line = next; return true;
});
markdown.renderer.rules.markfine_comment_block = (tokens, index) => `<pre class="markdown-comment comment-block" data-source-line="${tokens[index].map?.[0] ?? 0}">${mappedText(markdown.utils.escapeHtml(tokens[index].content), tokens[index].meta)}</pre>\n`;
const validateLink = markdown.validateLink;
markdown.validateLink = href => validateLink(href) || /^file:/i.test(href) && safeLink(href);

const defaultText = markdown.renderer.rules.text!;
markdown.renderer.rules.text = (tokens, index, options, env, renderer) =>
  mappedText(defaultText(tokens, index, options, env, renderer), tokens[index].meta);
const defaultInlineCode = markdown.renderer.rules.code_inline!;
markdown.renderer.rules.code_inline = (tokens, index, options, env, renderer) => sourceMeta(tokens[index].meta).spikeSegments ?
  `<code>${mappedText(markdown.utils.escapeHtml(tokens[index].content), tokens[index].meta)}</code>` :
  defaultInlineCode(tokens, index, options, env, renderer);

export function localImageURL(source: string, documentID: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(source); } catch { return null; }
  if (!decoded || /[\\:%?#\u0000-\u001f]/.test(decoded) || !/\.(png|jpe?g|gif|webp|tiff?|heic)$/i.test(decoded)) return null;
  const parts = decoded.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return `markfine://app/image/${encodeURIComponent(documentID)}/${parts.map(encodeURIComponent).join('/')}`;
}

let remoteImagePrefixes: string[] = [];
export function configureImageSources(prefixes: unknown): void {
  remoteImagePrefixes = Array.isArray(prefixes) ? prefixes.filter((value): value is string => typeof value === 'string' && value.startsWith('https://') && value.length <= 8192).slice(0,2) : [];
  cache.clear();
}
export function remoteImageURL(source: string, documentID: string): string | null {
  if (!remoteImagePrefixes.some(prefix => source.startsWith(prefix))) return null;
  const bytes = new TextEncoder().encode(source); if (bytes.length > 8192) return null;
  return `markfine://app/remote-image/${encodeURIComponent(documentID)}/${btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}

markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  const source = String(token.attrGet('src') ?? '');
  const { alt, width } = imageLabel(token.content);
  const url = localImageURL(source, String(env?.documentID ?? '')) ?? remoteImageURL(source, String(env?.documentID ?? ''));
  const escape = markdown.utils.escapeHtml;
  const boundary = boundaryAttribute(token.meta);
  if (!url) return `<span class="image-placeholder"${boundary}>${t('图片未加载', 'Image not loaded')} · ${escape(alt)} <code>${escape(source)}</code></span>`;
  return `<img src="${escape(url)}" alt="${escape(alt)}" data-image-source="${escape(source)}"${width ? ` width="${width}" data-image-width="${width}"` : ''} loading="lazy" decoding="async"${boundary}>`;
};

markdown.renderer.rules.link_open = (tokens, index) => {
  const token = tokens[index];
  const href = String(token.attrGet('href') ?? '');
  const allowed = safeLink(href);
  token.meta = { allowed };
  const title = token.attrGet('title');
  const titleAttribute = title === null ? '' : ` title="${markdown.utils.escapeHtml(String(title))}"`;
  return allowed ? `<a href="${markdown.utils.escapeHtml(href)}"${titleAttribute} rel="noreferrer noopener">` : `<span class="blocked-link"${titleAttribute}>`;
};
markdown.renderer.rules.link_close = (tokens, index) => {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].type === 'link_close') depth++;
    if (tokens[i].type === 'link_open') {
      if (depth-- === 0) return tokens[i].meta?.allowed ? '</a>' : '</span>';
    }
  }
  return '</span>';
};

const defaultFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (token.info.trim() === 'mermaid') return `<div class="diagram"${boundaryAttribute(token.meta)} data-source-line="${token.map?.[0] ?? 0}" data-diagram="${markdown.utils.escapeHtml(token.content)}"><pre><code>${markdown.utils.escapeHtml(token.content)}</code></pre><small>${t('离线图表加载中', 'Loading offline diagram')}</small></div>`;
  const language = markdown.utils.unescapeAll(token.info.trim()).split(/\s+/)[0];
  if (!sourceMeta(token.meta).spikeSegments && !language || options.highlight) return defaultFence(tokens, index, options, env, renderer);
  const attr = language ? ` class="${markdown.utils.escapeHtml((options.langPrefix ?? 'language-') + language)}"` : '';
  return `<pre data-source-line="${token.map?.[0] ?? 0}"><code${attr}>${mappedText(highlightCode(token.content, language).html, token.meta)}</code></pre>\n`;
};
const defaultCodeBlock = markdown.renderer.rules.code_block!;
markdown.renderer.rules.code_block = (tokens, index, options, env, renderer) => sourceMeta(tokens[index].meta).spikeSegments ?
  `<pre data-source-line="${tokens[index].map?.[0] ?? 0}"><code>${mappedText(markdown.utils.escapeHtml(tokens[index].content), tokens[index].meta)}</code></pre>\n` :
  defaultCodeBlock(tokens, index, options, env, renderer);

markdown.core.ruler.push('spike-source-map', state => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1) token.attrSet('data-source-line', String(token.map[0]));
  }
});

export interface ReferenceDefinition { readonly href: string; readonly title: string }
export type References = Readonly<Record<string, ReferenceDefinition>>;
export interface ReferenceContext { readonly key: number; readonly references: References }
export const emptyReferences: ReferenceContext = Object.freeze({ key: 0, references: Object.freeze(Object.create(null)) });

/** Parse only a syntax block that might contain definitions, never render the whole document for this index. */
export function extractReferences(source: string): References {
  const references: Record<string, ReferenceDefinition> = Object.create(null);
  const env = { references };
  const normalized = source.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  markdown.block.parse(normalized, markdown, env, []);
  for (const definition of Object.values(references)) Object.freeze(definition);
  return Object.freeze(references);
}

const cache = new Map<string, string>();
export function renderBlock(source: string, documentID: string, context: ReferenceContext = emptyReferences,
                            syntax?: { node: SyntaxBranch; from: number }): string {
  const projection = syntax ? projectSource(source, syntax.node, syntax.from, markdown.utils.unescapeAll) : undefined;
  const key = `${t('zh', 'en')}\0${documentID}\0${context.key}\0${source}\0${projection?.signature ?? 'unmapped'}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // The block parser may add definitions to env. Never mutate a shared document context.
  const references = Object.assign(Object.create(null), context.references);
  const env = { documentID, references };
  const tokens = markdown.parse(source, env);
  if (projection) annotateSourceMaps(tokens, projection);
  const html = markdown.renderer.render(tokens, markdown.options, env);
  if (cache.size >= 96) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}

export function linkTarget(source: string, context: ReferenceContext = emptyReferences): string | null {
  const tokens = markdown.parseInline(source, { references: Object.assign(Object.create(null), context.references) });
  const token = tokens.flatMap(token => token.children ?? []).find(token => token.type === 'link_open');
  const href = token?.attrGet('href');
  return typeof href === 'string' && safeLink(href) ? href : null;
}
