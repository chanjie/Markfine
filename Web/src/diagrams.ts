export function validateDiagram(source: string): void {
  if (source.length > 20_000 || /^\s*---/.test(source) || /%%\s*\{|\b(?:click|callback)\b|(?:file|data|javascript|vbscript):|url\s*\(|<\s*(?:script|img|iframe|object|style)/i.test(source)) {
    throw new Error('图表包含禁止的配置、回调或主动内容');
  }
  if (!/^\s*(?:flowchart\b|graph\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|gantt\b)/.test(source)) {
    throw new Error('图表类型不在首发六类中');
  }
}
