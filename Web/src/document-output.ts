import { renderBlock, emptyReferences, type ReferenceContext } from './renderer';

export interface RenderedSnapshot { html:string;resources:string[];imageBindings:{source:string;resource:string}[] }

/** Render an immutable source snapshot without switching the editor's mode, selection or history. */
export async function exportHTML(source: string, documentID: string, mermaid: () => Promise<void>, context: ReferenceContext=emptyReferences): Promise<RenderedSnapshot> {
  const content = document.createElement('article'); content.innerHTML = renderBlock(source, documentID,context);
  for (const diagram of content.querySelectorAll<HTMLElement>('[data-diagram]')) {
    await mermaid();
    const svg = await globalThis.__markfineRenderDiagram!(diagram.dataset.diagram!, documentID);
    svg.removeAttribute('style'); diagram.replaceChildren(svg);
  }
  const imageBindings=[...content.querySelectorAll('img[data-image-source]')].map(image=>({source:image.getAttribute('data-image-source')!,resource:image.getAttribute('src')!}));
  for (const image of content.querySelectorAll('img')) { image.removeAttribute('loading'); image.removeAttribute('decoding'); }
  for (const node of content.querySelectorAll('*')) for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-')) node.removeAttributeNode(attribute);
  const resources = new Set<string>();
  for (const image of content.querySelectorAll('img,svg image')) { const src = image.getAttribute('src') ?? image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href'); if (src?.startsWith('markfine://app/image/')||src?.startsWith('markfine://app/remote-image/')) resources.add(src); }
  return { html: content.innerHTML, resources: [...resources], imageBindings };
}
