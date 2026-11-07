/** Only explicit modifier-clicks may send these destinations to the native opener. No WebView navigation. */
export function safeLink(href: string): boolean {
  if (!href || href.length > 8192 || /[\u0000-\u0020\u007f]/.test(href) || href.startsWith('//') || href.includes('\\')) return false;
  try { if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(href))) return false; } catch { return false; }
  if (!/^[a-z][a-z\d+.-]*:/i.test(href)) return true;
  try {
    const url = new URL(href);
    return !url.username && !url.password && (['http:', 'https:'].includes(url.protocol) || url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost'));
  } catch { return false; }
}
