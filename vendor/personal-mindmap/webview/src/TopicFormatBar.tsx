import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { INLINE_COLORS, type InlineFormat } from "../../src/core/inline-format";
import { t } from "./i18n";

const tools = [
  ["bold","inlineBold","B"], ["italic","inlineItalic","I"], ["underline","inlineUnderline","U"],
  ["strike","inlineStrike","S"], ["highlight","inlineHighlight","H"],
] as const;
const swatches = [
  ["red","inlineRed"], ["orange","inlineOrange"], ["blue","inlineBlue"], ["green","inlineGreen"], ["purple","inlinePurple"],
] as const;
type Color=keyof typeof INLINE_COLORS;
const colorKey="wmind-last-inline-color";
let latestColor:Color="red";
function readColor():Color{
  try{
    const saved=localStorage.getItem(colorKey);
    if(swatches.some(([color])=>color===saved))return saved as Color;
  }catch{}
  return latestColor;
}

export function TopicFormatBar({editor,apply,fixed=false}:{editor:RefObject<HTMLTextAreaElement|null>;apply:(format:InlineFormat)=>void;fixed?:boolean}){
  const bar=useRef<HTMLDivElement>(null);
  const [showColors,setShowColors]=useState(false);
  const [lastColor,setLastColor]=useState(readColor);
  const place=()=>{
    const field=editor.current,element=bar.current,stage=element?.parentElement;
    if(!field||!element||!stage)return;
    const win=field.ownerDocument.defaultView;
    const box=field.getBoundingClientRect(),bounds=fixed&&win?{top:0,left:0,width:win.innerWidth,height:win.innerHeight}:stage.getBoundingClientRect();
    const gap=8,above=box.top-bounds.top-element.offsetHeight-gap,below=box.bottom-bounds.top+gap;
    const bottom=Math.max(gap,bounds.height-element.offsetHeight-gap);
    const top=Math.max(gap,Math.min(above>=gap?above:below,bottom));
    const left=Math.max(gap,Math.min(box.left-bounds.left,bounds.width-element.offsetWidth-gap));
    element.style.top=`${top}px`;
    element.style.left=`${left}px`;
    element.dataset.paletteAbove=String(top+element.offsetHeight+52>bounds.height&&top>=52);
  };
  useLayoutEffect(place);
  useLayoutEffect(()=>{
    const field=editor.current,element=bar.current;
    if(!field||!element?.parentElement)return;
    const win=field.ownerDocument.defaultView;
    win?.addEventListener("scroll",place,true);
    win?.addEventListener("resize",place);
    const observer=new ResizeObserver(place);
    observer.observe(element.parentElement);observer.observe(field);
    return ()=>{observer.disconnect();win?.removeEventListener("scroll",place,true);win?.removeEventListener("resize",place);};
  },[editor,fixed]);
  const choose=(format:InlineFormat)=>{apply(format);setShowColors(false);};
  const chooseColor=(color:Color)=>{
    latestColor=color;setLastColor(color);
    try{localStorage.setItem(colorKey,color);}catch{}
    choose(color);
  };

  return <div ref={bar} className="wm-topic-format" style={fixed?{position:"fixed",width:"min(284px, calc(100vw - 16px))",zIndex:1000}:undefined} role="toolbar" aria-label={t("inlineFormat")}
    onPointerDown={event=>{event.preventDefault();event.stopPropagation();}}>
    {tools.map(([format,label,glyph])=>(
      <button key={format} type="button" className={`wm-topic-format-${format}`} aria-label={t(label)} title={t(label)} onClick={()=>choose(format)}>
        <span aria-hidden="true">{glyph}</span>
      </button>
    ))}
    <button type="button" className="wm-topic-format-quick-color" aria-label={t("inlineApplyLastColor")} title={t("inlineApplyLastColor")} onClick={()=>choose(lastColor)}>
      <span aria-hidden="true" style={{borderBottomColor:INLINE_COLORS[lastColor]}}>A</span>
    </button>
    <button type="button" className="wm-topic-format-colors" aria-label={t("inlineTextColor")} title={t("inlineTextColor")} aria-expanded={showColors} onClick={()=>setShowColors(open=>!open)}>
      <span aria-hidden="true">⌄</span>
    </button>
    {showColors&&<div className="wm-topic-format-palette" role="group" aria-label={t("inlineTextColor")}>
      {swatches.map(([color,label])=>(
        <button key={color} type="button" aria-label={t(label)} title={t(label)} onClick={()=>chooseColor(color)}>
          <span aria-hidden="true" style={{backgroundColor:INLINE_COLORS[color]}} />
        </button>
      ))}
      <button type="button" aria-label={t("inlineClearColor")} title={t("inlineClearColor")} onClick={()=>choose("clear-color")}>
        <span aria-hidden="true">×</span>
      </button>
    </div>}
  </div>;
}
