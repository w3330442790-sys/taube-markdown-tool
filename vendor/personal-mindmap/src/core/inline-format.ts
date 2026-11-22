/**
 * Selection formatting for the editable outline and the Markdown editor.
 *
 * The on-disk syntax is deliberately plain Markdown/HTML so the same text stays
 * readable in Obsidian, in .wmind files and in exported Markdown:
 *   <span style="color:#dc2626">重点</span>
 *   ==高亮==
 *   **重点**
 *
 * Only the exact color-span shape written by this module is recognized. This is
 * not an HTML sanitizer and must never be used to render arbitrary HTML.
 */

export type InlineFormat = "red" | "orange" | "blue" | "green" | "purple" | "highlight" | "bold" | "italic" | "underline" | "strike" | "clear-color";

export interface FormatResult {
  text: string;
  start: number;
  end: number;
}

export const INLINE_RED = "#dc2626";
export const INLINE_ORANGE = "#ea580c";
export const INLINE_COLORS = {
  red: INLINE_RED, orange: INLINE_ORANGE, blue: "#2563eb", green: "#15803d", purple: "#7c3aed",
} as const;

const MARKS = {
  bold: ["**", "**"], italic: ["<em>", "</em>"], underline: ["<u>", "</u>"],
  strike: ["~~", "~~"], highlight: ["==", "=="],
} as const;

const COLOR_RE = /<span\s+style="color:(#[0-9a-f]{6})"\s*>|<\/span>/gi;
const COLOR_VALUE_RE = /^#[0-9a-f]{6}$/i;

interface ColorSpan {
  openStart: number;
  contentStart: number;
  contentEnd: number;
  closeEnd: number;
  color: string;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function normalize(text: string, start: number, end: number): { start: number; end: number } {
  const from = clamp(start, text.length);
  const to = clamp(end, text.length);
  return to < from ? { start: to, end: from } : { start: from, end: to };
}

/** Innermost color span that completely surrounds the selection. */
function enclosingColor(text: string, start: number, end: number): ColorSpan | null {
  const stack: Array<{ openStart: number; contentStart: number; color: string }> = [];
  let best: ColorSpan | null = null;
  // A fresh regex per call: a global regex carries lastIndex between calls and
  // would silently skip the opening tag on the second use.
  const scan = new RegExp(COLOR_RE.source, "gi");
  for (const match of text.matchAll(scan)) {
    const index = match.index ?? 0;
    if (match[1]) {
      stack.push({ openStart: index, contentStart: index + match[0].length, color: match[1].toLowerCase() });
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    const closeEnd = index + match[0].length;
    if (open.openStart <= start && index >= end && (!best || open.openStart > best.openStart)) {
      best = {
        openStart: open.openStart,
        contentStart: open.contentStart,
        contentEnd: index,
        closeEnd,
        color: open.color,
      };
    }
  }
  return best;
}

function colorSpan(color: string, body: string): string {
  return `<span style="color:${color}">${body}</span>`;
}

function balancedMarks(text:string):boolean{
  return Object.values(MARKS).every(([open,close])=>{
    const opening=text.split(open).length-1;
    return open===close?opening%2===0:opening===text.split(close).length-1;
  })&&!/<\/?span\b/i.test(text);
}

function replaceColorRange(text:string, start:number, end:number, color:string|undefined, span:ColorSpan):FormatResult {
  let left=span.contentStart,right=span.contentEnd;
  if(start>left||end<right){
    for(;;){
      const pair=Object.values(MARKS).find(([open,close])=>{
        const inner=text.slice(left+open.length,right-close.length);
        return left+open.length<=start&&end<=right-close.length&&text.startsWith(open,left)&&
          text.slice(right-close.length,right)===close&&!inner.includes(open)&&!inner.includes(close);
      });
      if(!pair)break;
      left+=pair[0].length;right-=pair[1].length;
    }
  }
  const before=text.slice(left,start), selected=text.slice(start,end), after=text.slice(end,right);
  if((before||after)&&![before,selected,after].every(balancedMarks))return {text,start,end};
  const prefix=text.slice(0,span.openStart)+text.slice(span.contentStart,left)+(before?colorSpan(span.color,before):"");
  const replacement=color?colorSpan(color,selected):selected;
  const from=prefix.length+(color?`<span style="color:${color}">`.length:0);
  return {text:prefix+replacement+(after?colorSpan(span.color,after):"")+text.slice(right,span.contentEnd)+text.slice(span.closeEnd),start:from,end:from+selected.length};
}

function toggleColor(text: string, start: number, end: number, color: string, selectionOnly:boolean): FormatResult {
  if (start === end) {
    const open = `<span style="color:${color}">`;
    const next = text.slice(0, start) + open + "</span>" + text.slice(end);
    return { text: next, start: start + open.length, end: start + open.length };
  }
  const span = enclosingColor(text, start, end);
  if (span) {
    if(selectionOnly&&start>=span.contentStart){
      return replaceColorRange(text,start,end,span.color===color?undefined:color,span);
    }
    const inner = text.slice(span.contentStart, span.contentEnd);
    const oldOpen = text.slice(span.openStart, span.contentStart);
    if (span.color === color.toLowerCase()) {
      const next = text.slice(0, span.openStart) + inner + text.slice(span.closeEnd);
      return {
        text: next,
        start: Math.max(span.openStart, start - oldOpen.length),
        end: Math.max(span.openStart, end - oldOpen.length),
      };
    }
    // Recolor the whole phrase instead of nesting a second span.
    const newOpen = `<span style="color:${color}">`;
    const next = text.slice(0, span.openStart) + newOpen + inner + "</span>" + text.slice(span.closeEnd);
    const shift = newOpen.length - oldOpen.length;
    return { text: next, start: start + shift, end: end + shift };
  }
  const selected = text.slice(start, end);
  const exact = /^<span\s+style="color:(#[0-9a-f]{6})"\s*>([\s\S]*)<\/span>$/i.exec(selected);
  if (exact) {
    const inner = exact[2];
    if (exact[1].toLowerCase() === color.toLowerCase()) {
      return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
    }
    const replacement = colorSpan(color, inner);
    const openLength = `<span style="color:${color}">`.length;
    return {
      text: text.slice(0, start) + replacement + text.slice(end),
      start: start + openLength,
      end: start + replacement.length - "</span>".length,
    };
  }
  if(selectionOnly&&/<\/?span\b/i.test(selected))return {text,start,end};
  const replacement = colorSpan(color, selected);
  const openLength = `<span style="color:${color}">`.length;
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    start: start + openLength,
    end: start + replacement.length - "</span>".length,
  };
}

function clearColor(text: string, start: number, end: number, selectionOnly:boolean): FormatResult {
  if (start === end) return { text, start, end };
  const span = enclosingColor(text, start, end);
  if (span) {
    if(selectionOnly&&start>=span.contentStart)return replaceColorRange(text,start,end,undefined,span);
    const oldOpen = text.slice(span.openStart, span.contentStart);
    const next = text.slice(0, span.openStart) + text.slice(span.contentStart, span.contentEnd) + text.slice(span.closeEnd);
    return {
      text: next,
      start: Math.max(span.openStart, start - oldOpen.length),
      end: Math.max(span.openStart, end - oldOpen.length),
    };
  }
  const selected = text.slice(start, end);
  const exact = /^<span\s+style="color:#[0-9a-f]{6}"\s*>([\s\S]*)<\/span>$/i.exec(selected);
  if (exact) {
    const inner = exact[1];
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  return { text, start, end };
}

function adjacentPair(text:string,start:number,end:number,open:string,close:string):boolean{
  return start>=open.length&&text.slice(start-open.length,start)===open&&text.startsWith(close,end);
}

function toggleMarks(text:string,start:number,end:number,[open,close]:readonly [string,string],selectionOnly:boolean):FormatResult {
  if(selectionOnly&&open===close){
    const raw=text.slice(start,end),trimmed=raw.trim();
    if(!trimmed)return {text,start,end};
    start+=raw.indexOf(trimmed);end=start+trimmed.length;
  }
  const selected=text.slice(start,end);
  if(selected&&selected.length>=open.length+close.length&&selected.startsWith(open)&&selected.endsWith(close)){
    const inner=selected.slice(open.length,selected.length-close.length);
    return {text:text.slice(0,start)+inner+text.slice(end),start,end:start+inner.length};
  }
  if(selected){
    let outerStart=start,outerEnd=end;
    for(;;){
      if(adjacentPair(text,outerStart,outerEnd,open,close)){
        return {text:text.slice(0,outerStart-open.length)+text.slice(outerStart,outerEnd)+text.slice(outerEnd+close.length),start:start-open.length,end:end-open.length};
      }
      if(!selectionOnly)break;
      const pair=Object.values(MARKS).find(([left,right])=>adjacentPair(text,outerStart,outerEnd,left,right));
      const color=!pair&&enclosingColor(text,outerStart,outerEnd);
      if(pair){outerStart-=pair[0].length;outerEnd+=pair[1].length;}
      else if(color&&color.contentStart===outerStart&&color.contentEnd===outerEnd){outerStart=color.openStart;outerEnd=color.closeEnd;}
      else break;
    }
  }
  const next=text.slice(0,start)+open+selected+close+text.slice(end);
  return {text:next,start:start+open.length,end:end+open.length};
}

/** Apply a format to a selected range and return the selection inside the new text. */
export function applyInlineFormat(text: string, start: number, end: number, format: InlineFormat, selectionOnly=false): FormatResult {
  const range = normalize(text, start, end);
  if(selectionOnly&&[...text.matchAll(/<[^>\r\n]*>|\*\*|~~|==/g)].some(match=>
    [range.start,range.end].some(position=>position>match.index&&position<match.index+match[0].length)))return {text,...range};
  switch (format) {
    case "red":
    case "orange":
    case "blue":
    case "green":
    case "purple":
      return toggleColor(text, range.start, range.end, INLINE_COLORS[format],selectionOnly);
    case "clear-color":
      return clearColor(text, range.start, range.end, selectionOnly);
    case "highlight":
    case "bold":
    case "italic":
    case "underline":
    case "strike":
      return toggleMarks(text,range.start,range.end,MARKS[format],selectionOnly);
    default:
      return { text, start: range.start, end: range.end };
  }
}

/** The exact color syntax recognized by the rich renderer; exported for tests. */
export function isInlineColor(value: string): boolean {
  return COLOR_VALUE_RE.test(value);
}
