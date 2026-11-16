import { EditorSelection, Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { sourceMode } from './editor-preferences';
import { formatTransaction } from './commands';
import { focusTableSelection } from './table-editor';
import { t } from './localization';

export const slashChoices = [
  ...Array.from({length:6},(_,i)=>({action:'heading'+(i+1),icon:'H'+(i+1),zh:'标题 '+(i+1),en:'Heading '+(i+1),shortcut:'⌘'+(i+1)})),
  {action:'unordered',icon:'☷',zh:'无序列表',en:'Bullet list',shortcut:'⌥⌘U'}, {action:'ordered',icon:'1.',zh:'有序列表',en:'Numbered list',shortcut:'⌥⌘O'},
  {action:'task',icon:'☑',zh:'任务列表',en:'Task list',shortcut:'⌥⌘X'}, {action:'quote',icon:'❞',zh:'引用',en:'Quote',shortcut:'⌥⌘Q'},
  {action:'codeBlock',icon:'</>',zh:'代码块',en:'Code block',shortcut:'⌥⌘C'}, {action:'table',icon:'▦',zh:'表格',en:'Table',shortcut:'⌥⌘T'},
  {action:'link',icon:'↗',zh:'链接',en:'Link',shortcut:'⌘K'}, {action:'image',icon:'▧',zh:'图片引用',en:'Image reference',shortcut:'⌃⌘I'}
];
export function slashLinePosition(view: Pick<EditorView,'state'|'composing'>, text: '' | '/' = ''): number | null {
  const state=view.state,selection=state.selection.main;
  if (view.composing || state.readOnly || state.field(sourceMode) || !selection.empty) return null;
  const line=state.doc.lineAt(selection.head); if(line.text!==text || selection.head!==line.from+text.length) return null;
  for(let node=syntaxTree(state).resolveInner(line.from,1);node;){
    if(/^(FencedCode|CodeBlock|Table|CommentBlock|Comment|HTMLBlock)$/.test(node.name))return null;
    if(!node.parent)break;node=node.parent;
  }
  return line.from;
}
export function slashPosition(view: Pick<EditorView,'state'|'composing'>): number | null { return slashLinePosition(view, '/'); }
const emptyHint = ViewPlugin.fromClass(class {
  decorations = Decoration.none;
  constructor(readonly view: EditorView) { this.refresh(); }
  update() { this.refresh(); }
  refresh() {
    const at = slashLinePosition(this.view);
    this.decorations = at === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'empty-format-line', attributes: { 'data-placeholder': t('输出/选择常用组件并快速插入', 'Type / to choose and insert a common component') } }).range(at)]);
  }
}, { decorations: value => value.decorations });
const plugin=ViewPlugin.fromClass(class {
  menu?: HTMLElement; index=0; from=-1; timer=0; private dismissed?: object; private abort=new AbortController();
  constructor(readonly view: EditorView){
    view.scrollDOM.addEventListener('scroll',()=>this.position(),{signal:this.abort.signal});
    window.addEventListener('resize',()=>this.position(),{signal:this.abort.signal});
    document.addEventListener('pointerdown',e=>{if(this.menu&&!this.menu.contains(e.target as Node)&&!view.dom.contains(e.target as Node))this.close();},{capture:true,signal:this.abort.signal});
  }
  update(update: ViewUpdate){
    if(!update.docChanged&&!update.selectionSet&&!update.focusChanged)return;
    const from=slashPosition(this.view);
    if(from===null){this.close();return;}
    if(this.menu){this.from=from;this.schedule();return;}
    if(update.docChanged&&this.dismissed!==update.state.doc){this.from=from;this.index=0;this.schedule();}
  }
  schedule(){clearTimeout(this.timer);this.timer=window.setTimeout(()=>{if(slashPosition(this.view)===this.from){if(!this.menu)this.open();this.position();}},0);}
  open(){
    const menu=document.createElement('div');menu.className='slash-menu';menu.id='slash-menu';menu.setAttribute('role','listbox');menu.setAttribute('aria-label',t('插入格式','Insert format'));this.menu=menu;
    for(const [index,item]of slashChoices.entries()){
      const button=document.createElement('button'),icon=document.createElement('span'),label=document.createElement('span'),shortcut=document.createElement('span');
      button.type='button';button.id='slash-option-'+index;button.setAttribute('role','option');icon.className='slash-icon';icon.textContent=item.icon;label.textContent=t(item.zh,item.en);shortcut.className='slash-shortcut';shortcut.textContent=item.shortcut;button.append(icon,label,shortcut);
      button.onmousedown=e=>e.preventDefault();button.onclick=()=>this.choose(index);menu.append(button);
    }
    document.body.append(menu);this.highlight();
  }
  highlight(){this.menu?.querySelectorAll('button').forEach((b,i)=>{b.classList.toggle('selected',i===this.index);b.setAttribute('aria-selected',String(i===this.index));});this.view.contentDOM.setAttribute('aria-controls','slash-menu');this.view.contentDOM.setAttribute('aria-activedescendant','slash-option-'+this.index);this.menu?.children[this.index]?.scrollIntoView({block:'nearest'});}
  position(){if(!this.menu)return;const point=this.view.coordsAtPos(this.from+1);if(!point)return;this.menu.style.left=Math.max(6,Math.min(point.left,innerWidth-this.menu.offsetWidth-6))+'px';this.menu.style.top=Math.max(6,point.bottom+this.menu.offsetHeight+6<innerHeight?point.bottom+6:point.top-this.menu.offsetHeight-6)+'px';}
  handle(key:string):boolean{
    if(!this.menu||this.view.composing)return false;
    if(key==='Escape'){this.dismissed=this.view.state.doc;this.close();return true;}
    if(key==='Enter'){this.choose(this.index);return true;}
    this.index=(this.index+(key==='ArrowDown'?1:-1)+slashChoices.length)%slashChoices.length;this.highlight();return true;
  }
  choose(index:number){
    const from=this.from;if(slashPosition(this.view)!==from){this.close();return;}
    const state=this.view.state,removed=state.update({changes:{from,to:from+1,insert:''},selection:EditorSelection.cursor(from)});
    const action=slashChoices[index].action,spec=formatTransaction(removed.state,action);this.close();if(!spec)return;
    const formatted=removed.state.update(spec);const selection=formatted.state.selection;
    this.view.dispatch({changes:removed.changes.compose(formatted.changes),selection,userEvent:'input.format',annotations:isolateHistory.of('full'),scrollIntoView:true});
    this.view.focus();if(action==='table')queueMicrotask(()=>focusTableSelection(this.view));
  }
  close(){clearTimeout(this.timer);this.menu?.remove();this.menu=undefined;this.view.contentDOM.removeAttribute('aria-controls');this.view.contentDOM.removeAttribute('aria-activedescendant');}
  destroy(){this.abort.abort();this.close();}
});
export function slashMenu(){return [emptyHint,plugin,Prec.highest(keymap.of(['ArrowDown','ArrowUp','Enter','Escape'].map(key=>({key,run:(view:EditorView)=>view.plugin(plugin)?.handle(key)??false}))))];}
