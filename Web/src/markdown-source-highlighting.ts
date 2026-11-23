import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Share the incremental Markdown parser with live editing. Source highlighting
// only colors its tokens; it does not introduce replacements or a second parser.
export const markdownSourceHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.heading, class: 'md-source-heading' },
  { tag: [tags.quote, tags.comment], class: 'md-source-comment' },
  { tag: [tags.link, tags.url], class: 'md-source-link' },
  { tag: [tags.monospace, tags.labelName, tags.string], class: 'md-source-code' },
  { tag: [tags.emphasis, tags.strong, tags.strikethrough], class: 'md-source-emphasis' },
  { tag: [tags.processingInstruction, tags.punctuation, tags.escape, tags.character], class: 'md-source-marker' },
]));
