import { renderDocument, emptyReferences, type ReferenceContext } from './renderer';

export interface RenderedSnapshot { html:string;resources:string[];imageBindings:{source:string;resource:string}[] }

/** Render an immutable source snapshot without switching the editor's mode, selection or history. */
export async function exportHTML(source: string, documentID: string, mermaid: () => Promise<void>, context: ReferenceContext=emptyReferences, forOutput = false): Promise<RenderedSnapshot> {
  const content = document.createElement('article'); content.innerHTML = renderDocument(source, documentID,context);
  for (const diagram of content.querySelectorAll<HTMLElement>('[data-diagram]')) {
    await mermaid();
    const svg = await globalThis.__markfineRenderDiagram!(diagram.dataset.diagram!, documentID);
    svg.removeAttribute('style'); diagram.replaceChildren(svg);
  }
  if (forOutput) isolateImageLines(content);
  const imageBindings=[...content.querySelectorAll('img[data-image-source]')].map(image=>({source:image.getAttribute('data-image-source')!,resource:image.getAttribute('src')!}));
  for (const image of content.querySelectorAll('img')) { image.removeAttribute('loading'); image.removeAttribute('decoding'); }
  for (const node of content.querySelectorAll('*')) for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-')) node.removeAttributeNode(attribute);
  const resources = new Set<string>();
  for (const image of content.querySelectorAll('img,svg image')) { const src = image.getAttribute('src') ?? image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href'); if (src?.startsWith('markfine://app/image/')||src?.startsWith('markfine://app/remote-image/')) resources.add(src); }
  return { html: content.innerHTML, resources: [...resources], imageBindings };
}

/** Split only direct, unambiguously standalone image lines; inline images stay in their paragraph. */
export function isolateImageLines(content: HTMLElement): void {
  const splitNodes = (nodes: readonly Node[]): Node[][] => {
    const lines: Node[][] = [[]];
    for (const node of nodes) {
      let pieces: Node[][];
      if (node.nodeType === Node.TEXT_NODE) pieces = (node.textContent ?? '').split('\n').map(text => text ? [document.createTextNode(text)] : []);
      else if (node instanceof Element && node.childNodes.length) {
        pieces = splitNodes([...node.childNodes]).map(children => {
          const copy = node.cloneNode(false) as Element; copy.append(...children); return [copy];
        });
      } else pieces = [[node.cloneNode(true)]];
      lines.at(-1)!.push(...pieces[0]);
      lines.push(...pieces.slice(1));
    }
    return lines;
  };
  for (const paragraph of content.querySelectorAll<HTMLParagraphElement>('p')) {
    if (!paragraph.querySelector('img,.image-placeholder')) continue;
    const lines = splitNodes([...paragraph.childNodes]);
    const imageLine = (nodes: Node[]) => {
      const meaningful = nodes.filter(node => node.nodeType !== Node.TEXT_NODE || !!node.textContent?.trim());
      if (meaningful.length !== 1 || !(meaningful[0] instanceof Element)) return false;
      const element = meaningful[0];
      return element.tagName === 'IMG' || element.classList.contains('image-placeholder') ||
        element.tagName === 'A' && element.children.length === 1 && element.firstElementChild?.tagName === 'IMG' && !element.textContent?.trim();
    };
    if (!lines.some(imageLine)) continue;
    const result: HTMLParagraphElement[] = [];
    let current: HTMLParagraphElement | undefined;
    const make = () => paragraph.cloneNode(false) as HTMLParagraphElement;
    for (const line of lines) {
      if (imageLine(line)) {
        current = undefined; const image = make(); image.classList.add('output-image-block'); image.append(...line); result.push(image);
      } else {
        if (!current) { current = make(); result.push(current); }
        else current.append(document.createTextNode('\n'));
        current.append(...line);
      }
    }
    paragraph.replaceWith(...result);
  }
}
