import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

// The markdown() default is CommonMark only. Its GFM base also adds these three extras,
// which are not part of our declared rendering scope, so remove them explicitly.
const singleStrike = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
const doubleStrike = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
const punctuation = /[\p{P}\p{S}]/u;
const support = markdown({ base: markdownLanguage, extensions: {
  remove: ['Subscript', 'Superscript', 'Emoji'],
  parseInline: [{ name: 'Strikethrough', after: 'Emphasis', parse(context, next, position) {
    if (next !== 126) return -1;
    if (context.char(position - 1) === 126) {
      let slash = position - 2;
      while (context.char(slash) === 92) slash--;
      if ((position - 2 - slash) % 2 === 0) return -1;
    }
    let length = 1;
    while (context.char(position + length) === 126) length++;
    if (length > 2) return -1;
    const before = [...context.slice(Math.max(context.offset, position - 2), position)].at(-1) ?? '';
    const after = [...context.slice(position + length, Math.min(context.end, position + length + 2))][0] ?? '';
    const spaceBefore = !before || /\s/u.test(before), spaceAfter = !after || /\s/u.test(after);
    const punctBefore = punctuation.test(before), punctAfter = punctuation.test(after);
    return context.addDelimiter(length === 1 ? singleStrike : doubleStrike, position, position + length,
      !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
      !spaceBefore && (!punctBefore || spaceAfter || punctAfter));
  } }]
} });
export const editorMarkdownLanguage = support.language;
export function editorMarkdown() { return support; }
