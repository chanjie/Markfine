import MarkdownIt from 'markdown-it';
import { annotateSourceMaps, boundaryAttribute, mappedText, projectSource, sourceMeta, type SyntaxBranch } from './source-projection';
import { installSelectedGFM } from './gfm-extensions';
export { validateDiagram } from './diagrams';

export const markdown = new MarkdownIt('commonmark', { html: false, typographer: false });
installSelectedGFM(markdown);

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

markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  const source = String(token.attrGet('src') ?? '');
  const alt = token.content;
  const url = localImageURL(source, String(env?.documentID ?? ''));
  const escape = markdown.utils.escapeHtml;
  const boundary = boundaryAttribute(token.meta);
  if (!url) return `<span class="image-placeholder"${boundary}>图片未加载 · ${escape(alt)} <code>${escape(source)}</code></span>`;
  return `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async"${boundary}>`;
};

markdown.renderer.rules.link_open = (tokens, index) => {
  const token = tokens[index];
  const href = String(token.attrGet('href') ?? '');
  let allowed = false;
  try {
    const url = new URL(href);
    allowed = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { /* Relative/unsafe navigation has no permission in this spike. */ }
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
  if (token.info.trim() === 'mermaid') return `<div class="diagram"${boundaryAttribute(token.meta)} data-source-line="${token.map?.[0] ?? 0}" data-diagram="${markdown.utils.escapeHtml(token.content)}"><pre><code>${markdown.utils.escapeHtml(token.content)}</code></pre><small>离线图表加载中</small></div>`;
  if (!sourceMeta(token.meta).spikeSegments || options.highlight) return defaultFence(tokens, index, options, env, renderer);
  const language = token.info.trim().split(/\s+/)[0];
  const attr = language ? ` class="${markdown.utils.escapeHtml((options.langPrefix ?? 'language-') + language)}"` : '';
  return `<pre data-source-line="${token.map?.[0] ?? 0}"><code${attr}>${mappedText(markdown.utils.escapeHtml(token.content), token.meta)}</code></pre>\n`;
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
  const key = `${documentID}\0${context.key}\0${source}\0${projection?.signature ?? 'unmapped'}`;
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
