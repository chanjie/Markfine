import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import swift from 'highlight.js/lib/languages/swift';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import ruby from 'highlight.js/lib/languages/ruby';
import powershell from 'highlight.js/lib/languages/powershell';
for (const [name, language] of Object.entries({ javascript, typescript, python, bash, swift, go, rust, java, cpp, csharp, json, yaml, xml, css, sql, ruby, powershell })) hljs.registerLanguage(name, language);
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export interface CodeHighlight { html: string; ranges: { from: number; to: number; className: string }[] }
const cache = new Map<string, CodeHighlight>();
export function highlightCode(source: string, language: string): CodeHighlight {
  language = language.toLowerCase(); const key = language + '\0' + source;
  const existing = cache.get(key); if (existing) return existing;
  if (source.length > 100_000 || !hljs.getLanguage(language)) return { html: escape(source), ranges: [] };
  let html: string;
  try { html = hljs.highlight(source, { language, ignoreIllegals: true }).value.replace(/&#x27;/g, "'"); } catch { return { html: escape(source), ranges: [] }; }
  const ranges: CodeHighlight['ranges'] = [], stack: string[] = []; let offset = 0;
  for (const match of html.matchAll(/<span class="([^"]+)">|<\/span>|([^<]+)/g)) {
    if (match[1]) stack.push(match[1]);
    else if (match[0] === '</span>') stack.pop();
    else {
      const length = match[0].replace(/&(?:amp|lt|gt|quot|#x27);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" })[value]!).length;
      if (stack.length && length) ranges.push({ from: offset, to: offset + length, className: stack.join(' ') }); offset += length;
    }
  }
  if (offset !== source.length) return { html: escape(source), ranges: [] };
  const value = { html, ranges }; if (cache.size >= 48) cache.delete(cache.keys().next().value!); cache.set(key, value); return value;
}
