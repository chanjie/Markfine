export type FileKind = 'folder' | 'markdown' | 'text' | 'code' | 'image' | 'pdf' | 'office' | 'archive' | 'media' | 'file';
export function fileKind(name: string, directory: boolean): FileKind {
  if (directory) return 'folder';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['txt', 'log', 'rtf'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff', 'svg', 'ico', 'icns'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key'].includes(ext)) return 'office';
  if (['zip', 'gz', 'bz2', 'xz', 'tar', '7z', 'rar', 'dmg'].includes(ext)) return 'archive';
  if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'media';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'swift', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'sh', 'rb', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'sql', 'vue', 'svelte'].includes(ext)) return 'code';
  return 'file';
}
const drawings: Record<FileKind, string> = {
  folder: '<path d="M2 5.5h6l2 2h12v12H2z"/><path d="M2 8V4h6l2 2h10v1.5"/>',
  markdown: '<path d="M3 5h18v14H3zM6 15V9l3 3 3-3v6M16 9v6m-2-2 2 2 2-2"/>',
  file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5"/>',
  text: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h8"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m3 18 6-5 4 3 4-6 4 8"/>',
  pdf: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 17c6-3 7-7 4-7-2 0 0 7 4 7"/>',
  office: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 11h8M8 14h8M8 17h5"/>',
  archive: '<path d="M4 3h16v18H4zM10 3v3h4v3h-4v3h4v3h-4v3h4"/>',
  media: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4z"/>'
};
export function fileIcon(kind: FileKind): HTMLElement {
  const icon = document.createElement('span'); icon.className = 'file-icon file-icon-' + kind; icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${drawings[kind]}</svg>`;
  return icon;
}
