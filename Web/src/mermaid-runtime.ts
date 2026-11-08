import './offline-policy';
import mermaid from 'mermaid';
import { validateDiagram } from './diagrams';
import { localImageURL } from './renderer';

const placeholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
  htmlLabels: false, flowchart: { htmlLabels: false }, theme: 'neutral', themeVariables: { fontSize: '20px' }, fontFamily: 'Markfine Latin, Markfine CJK, PingFang SC, sans-serif', maxTextSize: 20_000,
  secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'htmlLabels', 'flowchart', 'secure', 'suppressErrorRendering', 'fontFamily'] });
let serial: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function prepareDiagram(source: string, documentID: string): string {
  validateDiagram(source);
  // Normal URL labels are text, not rejected wholesale. Resource shapes get only document-scoped
  // local images or a fixed inert raster placeholder; no remote fetch or arbitrary data: payload.
  return source.replace(/\bimg\s*:\s*(["'])([^"'\n]*)\1/gi, (_whole, _quote: string, path: string) =>
    `img: "${localImageURL(path, documentID) ?? placeholder}"`);
}
function safeCSS(value: string): boolean {
  if (/@import|expression\s*\(|javascript\s*:/i.test(value)) return false;
  for (const match of value.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) if (!match[1].startsWith('#')) return false;
  return true;
}
globalThis.__markfineRenderDiagram = (source, documentID) => {
  const render = serial.then(async () => {
    // Several diagrams can become visible together. Yield between their synchronous
    // layouts so input, navigation and UI timers are not starved by a microtask chain.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    const prepared = prepareDiagram(source, documentID);
    // Mermaid's default temporary measuring node is appended to body. Here body is a
    // flex column, so that node can steal height from the editor while a graph lays out.
    const measuring = document.createElement('div');
    measuring.setAttribute('aria-hidden', 'true');
    measuring.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;pointer-events:none;';
    document.body.append(measuring);
    let svg: string;
    try { ({ svg } = await mermaid.render(`markfine-diagram-${++sequence}`, prepared, measuring)); }
    finally { measuring.remove(); }
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'), element = parsed.documentElement;
    if (element.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error(document.documentElement.lang.startsWith('en') ? 'Invalid diagram SVG' : '图表 SVG 无效');
    element.querySelectorAll('script,foreignObject,iframe,object,embed,a,animate,animateTransform,set').forEach(node => node.remove());
    for (const node of [element, ...element.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || (attr.name === 'style' && !safeCSS(attr.value))) node.removeAttributeNode(attr);
        if (/href$/i.test(attr.name)) {
          const allowedImage = node.localName === 'image' && (attr.value === placeholder || attr.value.startsWith(`markfine://app/image/${encodeURIComponent(documentID)}/`));
          if (!attr.value.startsWith('#') && !allowedImage) node.removeAttributeNode(attr);
        }
      }
      if (node.localName === 'style' && !safeCSS(node.textContent ?? '')) node.remove();
    }
    const result = document.importNode(element, true) as unknown as SVGElement;
    result.setAttribute('role', 'img'); result.setAttribute('aria-label', document.documentElement.lang.startsWith('en') ? 'Offline Mermaid diagram' : '离线 Mermaid 图表');
    return result;
  });
  serial = render.catch(() => undefined); return render;
};
