import type { EditorState } from '@codemirror/state';
import { editorMarkdownLanguage } from './editor-language';
import type { OutlineHeading } from './outline';
import { markdown, linkTarget, type ReferenceContext } from './renderer';
import { referenceIndex } from './reference-context';

export interface SourceRange { from: number; to: number }
export function chapterRange(state: EditorState, headings: readonly OutlineHeading[], from: number): SourceRange | null {
  const flat: OutlineHeading[] = [];
  const collect = (items: readonly OutlineHeading[]) => { for (const item of items) { flat.push(item); collect(item.children); } };
  collect(headings); const index = flat.findIndex(item => item.from === from); if (index < 0) return null;
  const start = state.doc.lineAt(flat[index].from).from;
  const next = flat.slice(index + 1).find(item => item.level <= flat[index].level);
  return { from: start, to: next ? state.doc.lineAt(next.from).from : state.doc.length };
}
export function paragraphRange(state: EditorState): SourceRange {
  const position = state.selection.main.head;
  let node = editorMarkdownLanguage.parser.parse(state.doc.toString()).resolveInner(position, -1);
  while (node.parent && !/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|FencedCode|CodeBlock|CommentBlock|HTMLBlock|Table)$/.test(node.name)) node = node.parent;
  if (node.name === 'Document') { const line = state.doc.lineAt(position); return { from: line.from, to: line.to }; }
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to };
}

export function copyMarkdown(state: EditorState, range: SourceRange): string {
  const source=state.doc.toString(),context=state.field(referenceIndex).context;
  let result=source.slice(range.from,range.to);const before:{at:number;text:string}[]=[],after:{at:number;text:string}[]=[];
  const tree=editorMarkdownLanguage.parser.parse(source);
  tree.iterate({from:range.from,to:range.to,enter(ref){
    if(['StrongEmphasis','Emphasis','Strikethrough','InlineCode'].includes(ref.name)){
      const marks=ref.node.getChildren(ref.name==='InlineCode'?'CodeMark':ref.name==='Strikethrough'?'StrikethroughMark':'EmphasisMark');
      if(marks.length<2)return;const first=marks[0],last=marks.at(-1)!;
      if(range.from>=first.to&&range.from<last.from)before.push({at:ref.from,text:source.slice(first.from,first.to)});
      if(range.to>first.to&&range.to<=last.from)after.push({at:ref.to,text:source.slice(last.from,last.to)});
    }
  }});
  result=before.sort((a,b)=>a.at-b.at).map(v=>v.text).join('')+result+after.sort((a,b)=>a.at-b.at).map(v=>v.text).join('');
  let enclosing=tree.resolveInner(range.from,1);
  while(enclosing.parent&&!(enclosing.from<=range.from&&enclosing.to>=range.to&&/^(Link|ATXHeading[1-6]|SetextHeading[12]|FencedCode|CodeBlock)$/.test(enclosing.name)))enclosing=enclosing.parent;
  if(enclosing.from<=range.from&&enclosing.to>=range.to){
    if(enclosing.name==='Link'){
      const marks=enclosing.getChildren('LinkMark'),href=linkTarget(source.slice(enclosing.from,enclosing.to),context);
      if(href&&marks.length>=2&&range.from>=marks[0].to&&range.to<=marks[1].from)result='['+result+']('+href+')';
    }else if(/Heading/.test(enclosing.name)&&range.from>enclosing.from){const level=Number(enclosing.name.at(-1));result='#'.repeat(level)+' '+result;}
    else if(/^(FencedCode|CodeBlock)$/.test(enclosing.name)&&range.from>enclosing.from){
      const fence='`'.repeat(Math.max(3,...[...result.matchAll(/`+/g)].map(m=>m[0].length+1)));result=fence+'\n'+result+'\n'+fence;
    }
  }
  if(enclosing.name==='Link')for(let parent=enclosing.parent;parent;parent=parent.parent){if(/^(ATXHeading[1-6]|SetextHeading[12])$/.test(parent.name)&&range.from>parent.from&&range.to<=parent.to){result='#'.repeat(Number(parent.name.at(-1)))+' '+result;break;}}
  const used=new Set<string>(),references=new Proxy({...context.references},{get(target,key){if(typeof key==='string'&&Object.hasOwn(target,key))used.add(key);return Reflect.get(target,key);}});
  markdown.parse(result,{references});
  const definitions=Object.entries(context.references).filter(([label])=>used.has(label)).map(([label,value])=>'['+label.replace(/[\\\[\]]/g,'\\$&')+']: <'+value.href+'>'+(value.title?' '+JSON.stringify(value.title):''));
  if(definitions.length)result+='\n\n'+definitions.join('\n');return result;
}
export function imageSources(source:string):string[]{
  const result:string[]=[];for(const token of markdown.parse(source,{}))for(const child of token.children??[])if(child.type==='image'){const src=child.attrGet('src');if(src)result.push(String(src));}
  return [...new Set(result)];
}
export function inlinePlainText(source: string, context?: ReferenceContext): string {
  return markdown.parseInline(source, { references: context?.references ?? {} }).flatMap(token => token.children ?? []).map(token =>
    token.type === 'text' || token.type === 'code_inline' || token.type === 'image' ? token.content :
    token.type === 'softbreak' || token.type === 'hardbreak' ? '\n' : '').join('');
}
