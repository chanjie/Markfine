const pngPrefix = 'data:image/png;base64,';

export async function diagramPNG(
  svg: SVGSVGElement,
  resolveImages: (references: string[]) => Promise<Record<string, string>>
): Promise<string> {
  const box = svg.viewBox.baseVal;
  const width = Math.ceil(box.width), height = Math.ceil(box.height);
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000))
    throw new RangeError('Diagram dimensions exceed the PNG budget');

  const resources: Attr[] = [];
  for (const node of svg.querySelectorAll('image')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.localName === 'href' && attribute.value.startsWith('markfine:')) resources.push(attribute);
    }
  }
  const references = [...new Set(resources.map(attribute => attribute.value))];
  if (references.length > 24 || references.some(reference => new TextEncoder().encode(reference).length > 12_000))
    throw new Error('Too many diagram resources');
  if (references.length) {
    const replacements = await resolveImages(references);
    for (const attribute of resources) {
      const value = replacements[attribute.value];
      if (!value?.startsWith(pngPrefix)) throw new Error('A diagram resource could not be read');
      attribute.value = value;
    }
  }
  svg.style.removeProperty('width'); svg.style.removeProperty('height');
  svg.style.removeProperty('min-width'); svg.style.removeProperty('max-width');
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Diagram rasterization unavailable');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const encoded = canvas.toDataURL('image/png');
    if (!encoded.startsWith(pngPrefix + 'iVBORw0KGgo') || encoded.length - pngPrefix.length > 32 * 1_048_576)
      throw new Error('PNG size exceeds the export budget');
    return encoded.slice(pngPrefix.length);
  } finally {
    canvas.width = 0; canvas.height = 0;
  }
}
