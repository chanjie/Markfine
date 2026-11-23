import { fittedImageWidth,imageOccurrences,imageWidthChange,type ImageOccurrence } from './image-syntax';
import type { ResourceChange } from './migration';
import { contextMenu, type MenuAction } from './context-menu';
import { localImageURL } from './renderer';
import { t } from './localization';

export function isPreviewImage(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('img[data-image-source],.image-placeholder[data-image-source],.image-size-button,.image-preview-block');
}

interface ImageHost { source:(id:string)=>string|undefined;canEdit:(id:string)=>boolean;canCopy:(id:string)=>boolean;copy:(id:string,source:string,asset?:{resource:string;path?:boolean})=>void;zoom:()=>number;change:(id:string,change:ResourceChange)=>void;measure:()=>void }
export class ImageControls {
  constructor(private readonly host:ImageHost){}
  private available(image:HTMLImageElement):number{
    const column=image.closest<HTMLElement>('.cm-content,.reading-content'),port=image.closest<HTMLElement>('.cm-scroller,.reader');
    if(!column||!port)return Math.max(1,image.parentElement?.clientWidth??1);
    const style=getComputedStyle(column),inset=parseFloat(getComputedStyle(document.getElementById('main')!).getPropertyValue('--content-inset'))||72;
    const visible=port.getBoundingClientRect().left+port.clientWidth-image.getBoundingClientRect().left-8;
    return Math.max(1,Math.min(column.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-8,port.clientWidth-inset-8,visible));
  }
  fit(image:HTMLImageElement):void{
    if(!image.naturalWidth)return;const width=fittedImageWidth(image.naturalWidth,this.available(image),this.host.zoom(),Number(image.dataset.imageWidth)||undefined);
    if(image.style.width!==width+'px')image.style.width=width+'px';image.style.height='auto';image.style.maxHeight='none';
    const button=image.parentElement?.querySelector<HTMLButtonElement>('.image-size-button');
    if(button){const percent=width/(image.naturalWidth*this.host.zoom())*100;button.textContent=t('比例 ','Size ')+(Math.round(percent*10)/10)+'%';}
  }
  refresh(){for(const image of document.querySelectorAll<HTMLImageElement>('#main img[data-image-source]'))this.fit(image);}
  bind(image:HTMLImageElement,id:string){
    const size=()=>{this.fit(image);this.host.measure();};image.onload=size;if(image.complete)size();
    this.bindCopyMenu(image,id);
    if(!this.host.canEdit(id))return;
    let frame=image.parentElement;if(!frame?.classList.contains('image-frame')){frame=document.createElement('span');frame.className='image-frame';image.replaceWith(frame);frame.append(image);}
    const button=document.createElement('button');button.type='button';button.className='image-size-button';button.setAttribute('aria-haspopup','menu');button.textContent=t('显示比例','Image size');frame.append(button);
    button.onmousedown=e=>{e.preventDefault();e.stopPropagation();};button.onclick=e=>{e.preventDefault();e.stopPropagation();const r=button.getBoundingClientRect();this.menu(image,id,r.left,r.bottom);};
    size();
  }
  bindCopyMenu(target:HTMLElement,id:string):void {
    const source=target.dataset.imageSource;
    if (!source) return;
    if (target instanceof HTMLImageElement) target.draggable=false;
    target.oncontextmenu=event=>{
      event.preventDefault();event.stopPropagation();
      if (!this.host.canCopy(id)) return;
      const image=target instanceof HTMLImageElement?target:undefined;
      const resource=image?.getAttribute('src')??'';
      const ready=!!image?.naturalWidth && new TextEncoder().encode(resource).length<=12_000;
      const local=localImageURL(source,id);
      const remote=/^https?:\/\//i.test(source);
      const copyPath=!!local && new TextEncoder().encode(local).length<=12_000;
      const current=()=>target.isConnected&&this.host.canCopy(id);
      const actions:MenuAction[]=[
        {label:t('复制原图','Copy Original Image'),disabled:!ready,run:()=>{if(ready&&current())this.host.copy(id,source,{resource});}},
        {label:t('复制图片链接','Copy Image Link'),disabled:!copyPath&&!remote,run:()=>{
          if(!current())return;
          if(copyPath)this.host.copy(id,source,{resource:local,path:true});
          else if(remote)this.host.copy(id,source);
        }},
      ];
      if(image&&this.host.canEdit(id))actions.push(...this.sizeActions(image,id));
      contextMenu(event.clientX,event.clientY,actions,'image-size-menu',true);
    };
  }
  private occurrence(image:HTMLImageElement,id:string):ImageOccurrence|undefined {
    const source=this.host.source(id);if(source===undefined)return;
    const items=imageOccurrences(source),block=image.closest<HTMLElement>('[data-source-from]'),from=Number(block?.dataset.sourceFrom);
    const exact=block&&items.find(item=>item.from===from);if(exact)return exact;
    const matches=items.filter(item=>item.destination===image.dataset.imageSource&&item.width===(Number(image.dataset.imageWidth)||undefined));return matches.length===1?matches[0]:undefined;
  }
  private menu(image:HTMLImageElement,id:string,x:number,y:number){
    const actions=this.sizeActions(image,id);
    if(actions.length)contextMenu(x,y,actions,'image-size-menu');
  }
  private sizeActions(image:HTMLImageElement,id:string):MenuAction[]{
    const source=this.host.source(id),item=this.occurrence(image,id);if(source===undefined||!item||!image.naturalWidth)return [];
    const maximum=()=>Math.max(0,Math.floor(this.available(image)/this.host.zoom()));
    const apply=(width?:number)=>{if(!this.host.canEdit(id)||this.host.source(id)!==source)return;if(width!==undefined&&width>maximum())return;const change=imageWidthChange(source,item.from,width);if(change)this.host.change(id,change);};
    return [{label:t('自动适应正文','Automatic fit'),run:()=>apply()},...[25,50,75,100,150,200].map(percent=>{const width=Math.max(1,Math.round(image.naturalWidth*percent/100));return {label:percent+'%',disabled:width>maximum()||image.naturalWidth*percent/100<1,run:()=>apply(width)};}),{label:t('自定义…','Custom…'),run:()=>this.custom(image,id,source,apply)}];
  }
  private custom(image:HTMLImageElement,id:string,source:string,apply:(width?:number)=>void){
    const dialog=document.createElement('dialog');dialog.className='image-size-dialog';const form=document.createElement('form');form.method='dialog';
    const title=document.createElement('h2');title.textContent=t('图片显示比例','Image display size');const label=document.createElement('label');label.textContent=t('相对原图','Relative to original');
    const input=document.createElement('input');input.type='number';input.step='any';input.required=true;input.min=String(100/image.naturalWidth);input.max=String(this.available(image)/(image.naturalWidth*this.host.zoom())*100);
    input.value=String(Math.round(image.getBoundingClientRect().width/(image.naturalWidth*this.host.zoom())*1000)/10);label.append(input,document.createTextNode('%'));
    const note=document.createElement('p');note.textContent=t('最大允许比例：','Maximum size: ')+(Math.floor(Number(input.max)*100)/100)+'%';
    const actions=document.createElement('div');actions.className='dialog-actions';const cancel=document.createElement('button');cancel.type='button';cancel.textContent=t('取消','Cancel');const confirm=document.createElement('button');confirm.type='submit';confirm.className='primary';confirm.textContent=t('确定','Apply');
    const close=()=>{dialog.close();dialog.remove();};cancel.onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
    form.onsubmit=e=>{e.preventDefault();input.max=String(this.available(image)/(image.naturalWidth*this.host.zoom())*100);if(!input.checkValidity()){input.reportValidity();return;}if(this.host.canEdit(id)&&this.host.source(id)===source)apply(Math.min(Math.floor(this.available(image)/this.host.zoom()),Math.max(1,Math.round(image.naturalWidth*Number(input.value)/100))));close();};
    actions.append(cancel,confirm);form.append(title,label,note,actions);dialog.append(form);document.body.append(dialog);dialog.showModal();input.focus();input.select();
  }
}
