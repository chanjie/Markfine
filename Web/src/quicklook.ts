import { markdown, renderDocument, localImageURL } from './renderer';
import { imageLabel } from './image-syntax';
import { setLanguage, t } from './localization';

declare global {
  var markfineQuickLookImage: (source: string) => string | null;
  var markfineQuickLookRender: (source: string, english: boolean) => string;
}

const escape = markdown.utils.escapeHtml;
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], source = String(token.attrGet('src') ?? ''), { alt, width } = imageLabel(token.content);
  const data = localImageURL(source, 'preview') ? globalThis.markfineQuickLookImage(source) : null;
  return data?.startsWith('data:image/') ? `<img src="${escape(data)}" alt="${escape(alt)}"${width ? ` width="${width}"` : ''}>` :
    `<span class="image-placeholder">${t('图片不可用', 'Image unavailable')} · ${escape(alt || source)}</span>`;
};
const fence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (token.info.trim() !== 'mermaid') return fence(tokens, index, options, env, renderer);
  return `<div class="diagram-source"><small>${t('Mermaid 图表源码（快速查看不绘制图表）', 'Mermaid source (diagrams are not drawn in Quick Look)')}</small><pre><code>${escape(token.content)}</code></pre></div>`;
};

globalThis.markfineQuickLookRender = (source, english) => {
  setLanguage(english ? 'en' : 'zh-Hans');
  return renderDocument(source, 'preview');
};
