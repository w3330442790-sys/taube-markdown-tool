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

export function TopicFormatBar({editor,apply}:{editor:RefObject<HTMLTextAreaElement|null>;apply:(format:InlineFormat)=>void}){
  const bar=useRef<HTMLDivElement>(null);
  const [showColors,setShowColors]=useState(false);
  const place=()=>{
    const field=editor.current,element=bar.current,stage=element?.parentElement;
    if(!field||!element||!stage)return;
    const box=field.getBoundingClientRect(),bounds=stage.getBoundingClientRect();
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
    if(typeof ResizeObserver==="undefined"||!bar.current?.parentElement||!editor.current)return;
    const observer=new ResizeObserver(place);
    observer.observe(bar.current.parentElement);observer.observe(editor.current);
    return ()=>observer.disconnect();
  },[editor]);
  const choose=(format:InlineFormat)=>{apply(format);setShowColors(false);};

  return <div ref={bar} className="wm-topic-format" role="toolbar" aria-label={t("inlineFormat")}
    onPointerDown={event=>{event.preventDefault();event.stopPropagation();}}>
    {tools.map(([format,label,glyph])=>(
      <button key={format} type="button" className={`wm-topic-format-${format}`} aria-label={t(label)} title={t(label)} onClick={()=>choose(format)}>
        <span aria-hidden="true">{glyph}</span>
      </button>
    ))}
    <button type="button" className="wm-topic-format-colors" aria-label={t("inlineTextColor")} title={t("inlineTextColor")} aria-expanded={showColors} onClick={()=>setShowColors(open=>!open)}>
      <span aria-hidden="true">A</span><span aria-hidden="true">⌄</span>
    </button>
    {showColors&&<div className="wm-topic-format-palette" role="group" aria-label={t("inlineTextColor")}>
      {swatches.map(([color,label])=>(
        <button key={color} type="button" aria-label={t(label)} title={t(label)} onClick={()=>choose(color)}>
          <span aria-hidden="true" style={{backgroundColor:INLINE_COLORS[color]}} />
        </button>
      ))}
      <button type="button" aria-label={t("inlineClearColor")} title={t("inlineClearColor")} onClick={()=>choose("clear-color")}>
        <span aria-hidden="true">×</span>
      </button>
    </div>}
  </div>;
}
