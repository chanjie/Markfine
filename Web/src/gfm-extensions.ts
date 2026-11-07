import type { MarkdownIt } from 'markdown-it';
import { editorMarkdownLanguage } from './editor-language';
import { t } from './localization';

/** Candidate adapter: share the declared GFM lexer instead of accepting the libraries' differing defaults. */
export function installSelectedGFM(md: MarkdownIt): void {
  md.enable(['table', 'strikethrough']);
  md.disable('linkify');
  md.options.linkify = false;
  // Delimiter identities are opaque keys to markdown-it's pair balancer. Keep one- and two-tilde
  // runs distinct so a single opener cannot pair with a double closer. No extra source characters.
  const single = 126, double = 0xE000;
  md.inline.ruler.at('strikethrough', (state, silent) => {
    if (silent || state.src.charCodeAt(state.pos) !== 126) return false;
    const run = state.scanDelims(state.pos, true);
    const markup = '~'.repeat(run.length);
    if (run.length > 2) state.pending += markup;
    else {
      state.push('text', '', 0).content = markup;
      state.delimiters.push({ marker: run.length === 1 ? single : double, length: 0,
        token: state.tokens.length - 1, end: -1, open: run.can_open, close: run.can_close });
    }
    state.pos += run.length;
    return true;
  });
  md.inline.ruler2.at('strikethrough', state => {
    const stacks = [state.delimiters, ...state.tokens_meta.flatMap(meta => meta?.delimiters ? [meta.delimiters] : [])];
    for (const delimiters of stacks) for (const opener of delimiters) {
      if (![single, double].includes(opener.marker) || opener.end < 0) continue;
      const closer = delimiters[opener.end];
      for (const [delimiter, nesting, type] of [[opener, 1, 's_open'], [closer, -1, 's_close']] as const) {
        const token = state.tokens[delimiter.token];
        token.type = type; token.tag = 'del'; token.nesting = nesting;
        token.content = ''; token.markup = opener.marker === single ? '~' : '~~';
      }
    }
  });

  md.core.ruler.after('inline', 'spike-gfm-autolinks', state => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const result: typeof block.children = [];
      let links = 0;
      for (const token of block.children) {
        if (token.type === 'link_open') links++;
        if (token.type !== 'text' || links || !/[.:@]/.test(token.content)) result.push(token);
        else {
          const ranges: { from: number; to: number }[] = [];
          // A text fragment is not a standalone block: e.g. a fragment after a strike may start
          // with literal ~~~ and must not become a fence. Prefix a neutral paragraph for scanning.
          const prefix = 'x ';
          editorMarkdownLanguage.parser.parse(prefix + token.content).iterate({ enter(node) {
            if (['CodeBlock', 'FencedCode', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'Link', 'Image', 'Autolink'].includes(node.name)) return false;
            if (node.name === 'URL' && node.from >= prefix.length) ranges.push({ from: node.from - prefix.length, to: node.to - prefix.length });
          } });
          let cursor = 0;
          const text = (content: string, level = token.level) => {
            if (!content) return;
            const item = new state.Token('text', '', 0); item.content = content; item.level = level; result.push(item);
          };
          for (const range of ranges) {
            const label = token.content.slice(range.from, range.to);
            const destination = label.startsWith('www.') ? `http://${label}` : /^(?:https?:\/\/|mailto:|xmpp:)/.test(label) ? label : `mailto:${label}`;
            const href = md.normalizeLink(destination);
            if (!md.validateLink(href)) continue;
            text(token.content.slice(cursor, range.from));
            const open = new state.Token('link_open', 'a', 1); open.attrSet('href', href); open.level = token.level; open.markup = 'linkify';
            result.push(open); text(label, token.level + 1);
            const close = new state.Token('link_close', 'a', -1); close.level = token.level; close.markup = 'linkify'; result.push(close);
            cursor = range.to;
          }
          text(token.content.slice(cursor));
        }
        if (token.type === 'link_close') links--;
      }
      block.children = result;
    }
  });

  // This rule runs before the autolink postpass, and only for a list item's FIRST paragraph.
  md.core.ruler.after('inline', 'spike-task-lists', state => {
    state.tokens.forEach((token, index) => {
      if (token.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open' || state.tokens[index - 2]?.type !== 'list_item_open') return;
      const match = /^\[([ xX])\][ \t\r\n]+/.exec(token.content);
      if (!match) return;
      const body: NonNullable<typeof token.children> = [];
      md.inline.parse(token.content.slice(match[0].length), md, state.env, body);
      const checked = match[1] !== ' ';
      const marker = new state.Token('html_inline', '', 0);
      marker.content = `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox" class="task-marker" aria-label="${checked ? t('已完成', 'Completed') : t('未完成', 'Incomplete')}"> `;
      token.children = [marker, ...body];
    });
  });
}
