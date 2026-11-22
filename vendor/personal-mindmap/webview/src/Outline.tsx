// 大纲视图:可编辑的缩进列表,快捷键与画布一致(Enter 同级、Tab 缩进、Shift+Tab 反缩进)
import { useEffect, useRef, useState } from "react";
import * as ops from "../../src/core/ops";
import { applyInlineFormat, type InlineFormat } from "../../src/core/inline-format";
import { TopicFormatBar } from "./TopicFormatBar";
import { indexDoc } from "../../src/core/query";
import type { MindDoc, Topic } from "../../src/core/types";
import type { Actions } from "./App";
import { t } from "./i18n";
import {isRichText} from './rich';
import {fillRichElement} from './RichTopic';
import type {Host} from './host';

interface Row {
  topic: Topic;
  depth: number;
}

function flatten(doc: MindDoc): Row[] {
  const rows: Row[] = [];
  const visit = (tp: Topic, depth: number) => {
    rows.push({ topic: tp, depth });
    if (!tp.collapsed) for (const c of tp.children ?? []) visit(c, depth + 1);
  };
  visit(doc.root, 0);
  for (const f of doc.floating ?? []) visit(f, 0);
  return rows;
}


export function Outline({ actions: a,docked,wrap,host }: { actions: Actions;docked?:boolean;wrap?:boolean;host?:Host }) {
  const rows = flatten(a.doc);
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focusId, setFocusId] = useState<string | null>(a.selection[0] ?? a.doc.root.id);
  const pendingFocus = useRef<{ id: string; caret: "end" | "all" } | null>(null);
  useEffect(()=>{const id=a.selection[0];if(id){setFocusId(id);refs.current.get(id)?.scrollIntoView({block:'nearest'});}},[a.selection[0]]);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const el = refs.current.get(p.id);
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    if (p.caret === "all") el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  });

  const focusRow = (id: string, caret: "end" | "all" = "end") => {
    pendingFocus.current = { id, caret };
    setFocusId(id);
    a.select([id]);
  };

  return (
    <div className="wm-outline" style={docked?{padding:0,flex:1,minHeight:0,overflow:"auto",position:"relative",inset:"auto"}:undefined}>
      <div className="wm-outline-inner" style={docked?{maxWidth:"none",padding:0}:undefined}>
        {rows.map(({ topic, depth }, i) => (
          <OutlineRow
            host={host}
            wrap={wrap}
            key={topic.id}
            topic={topic}
            depth={depth}
            isRoot={topic.id === a.doc.root.id}
            active={focusId === topic.id}
            readOnly={a.readOnly}
            setRef={(el) => (el ? refs.current.set(topic.id, el) : refs.current.delete(topic.id))}
            onFocus={() => {
              setFocusId(topic.id);
              a.select([topic.id]);
            }}
            onToggle={() => a.readOnly?a.feature('fold',topic.id):a.apply((d) => ops.toggleCollapsed(d, topic.id))}
            onCommit={(text) => a.apply((d) => ops.setText(d, topic.id, text))}
            onKey={(e, draft) => {
              if(a.readOnly){if(e.key==="Enter"||e.key==="Tab")e.preventDefault();return;}
              const d = a.doc;
              const commitText = (doc: MindDoc) => (draft !== topic.text ? ops.setText(doc, topic.id, draft) : doc);
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const e2 = indexDoc(d).get(topic.id)!;
                const r = e2.parent ? ops.addSibling(commitText(d), topic.id, false, { text: "" }) : ops.addChild(commitText(d), topic.id, { text: "" }, 0);
                a.apply(() => r.doc, [r.id]);
                focusRow(r.id);
              } else if (e.key === "Tab") {
                e.preventDefault();
                a.apply((doc) => (e.shiftKey ? ops.outdent(commitText(doc), topic.id) : ops.indent(commitText(doc), topic.id)));
                focusRow(topic.id);
              } else if (e.key === "Backspace" && draft === "" && topic.id !== d.root.id && !topic.children?.length) {
                e.preventDefault();
                const prev = rows[i - 1]?.topic.id ?? d.root.id;
                a.apply((doc) => ops.remove(doc, topic.id), [prev]);
                focusRow(prev);
              } else if (e.key === "ArrowUp" && !e.nativeEvent.isComposing) {
                const el = e.currentTarget;
                if (el.selectionStart === 0 || !el.value.slice(0, el.selectionStart).includes("\n")) {
                  e.preventDefault();
                  const prev = rows[i - 1];
                  if (prev) focusRow(prev.topic.id);
                }
              } else if (e.key === "ArrowDown" && !e.nativeEvent.isComposing) {
                const el = e.currentTarget;
                if (!el.value.slice(el.selectionEnd).includes("\n")) {
                  e.preventDefault();
                  const next = rows[i + 1];
                  if (next) focusRow(next.topic.id);
                }
              } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
                e.preventDefault();
                a.apply((doc) => ops.toggleCollapsed(doc, topic.id));
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function OutlineRow({
  host,
  topic,
  wrap,
  depth,
  isRoot,
  active,
  readOnly,
  setRef,
  onFocus,
  onToggle,
  onCommit,
  onKey,
}: {
  host?:Host;
  topic: Topic;
  wrap?:boolean;
  depth: number;
  isRoot: boolean;
  active: boolean;
  readOnly: boolean;
  setRef: (el: HTMLTextAreaElement | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onCommit: (text: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>, draft: string) => void;
}) {
  const [draft, setDraft] = useState(topic.text);
  const [formatBar, setFormatBar] = useState(false);
  const selectionRevision=useRef(0);
  const preview=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement|null>(null);
  const rich=isRichText(topic.text)&&!active;
  useEffect(()=>{if(preview.current)fillRichElement(preview.current,topic.text,{renderMath:host?.renderMath,resolveImage:host?.resolveResource});},[topic.text,rich,host]);
  useEffect(() => setDraft(topic.text), [topic.text]);
  useEffect(() => {
    if (!active || readOnly) setFormatBar(false);
  }, [active, readOnly]);
  const hasKids = !!topic.children?.length;
  const applyFormat = (format: InlineFormat) => {
    const field=input.current;
    if(!formatBar||!field||field.selectionStart===field.selectionEnd)return;
    const result=applyInlineFormat(draft,field.selectionStart,field.selectionEnd,format,true);
    if(result.text===draft)return;
    setDraft(result.text);
    onCommit(result.text);
    const revision=++selectionRevision.current;
    requestAnimationFrame(() => {
      const el = input.current;
      if(!el||el.ownerDocument.activeElement!==el||selectionRevision.current!==revision)return;
      el.setSelectionRange(result.start, result.end);
      setFormatBar(result.start!==result.end);
    });
  };
  return (
    <div className={"wm-orow" + (isRoot ? " wm-orow-root" : "") + (active ? " wm-active" : "")} style={{ paddingLeft: 8 + depth * 22 }}>
      <button className={"wm-obullet" + (hasKids ? " wm-has-kids" : "") + (topic.collapsed ? " wm-collapsed" : "")} onClick={hasKids ? onToggle : undefined} tabIndex={-1}>
        <span />
      </button>
      <textarea
        ref={element=>{input.current=element;setRef(element);}}
        className="wm-otext"
        rows={1}
        style={rich?{display:'none'}:wrap===false?{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}:undefined}
        value={draft}
        readOnly={readOnly}
        placeholder={t("emptyText")}
        onFocus={onFocus}
        onChange={(e) => { setDraft(e.target.value); setFormatBar(false); }}
        onSelect={e=>setFormatBar(!readOnly&&e.currentTarget.selectionStart!==e.currentTarget.selectionEnd)}
        onPointerUp={e=>setFormatBar(!readOnly&&e.currentTarget.selectionStart!==e.currentTarget.selectionEnd)}
        onBlur={() => {
          selectionRevision.current++;
          setFormatBar(false);
          if (draft !== topic.text) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && formatBar) {
            e.preventDefault();
            e.stopPropagation();
            selectionRevision.current++;
            e.currentTarget.setSelectionRange(e.currentTarget.selectionEnd,e.currentTarget.selectionEnd);
            setFormatBar(false);
            return;
          }
          onKey(e, draft);
        }}
      />
      {rich&&<div ref={preview} role="button" tabIndex={0} style={{flex:1,minWidth:0,padding:'5px 4px',whiteSpace:wrap===false?'nowrap':'normal',overflow:'hidden',textOverflow:'ellipsis',cursor:'text'}} onClick={()=>{onFocus();requestAnimationFrame(()=>input.current?.focus());}} onKeyDown={event=>{if(event.key==='Enter'){onFocus();requestAnimationFrame(()=>input.current?.focus());}}}/>}
      {active&&!readOnly&&formatBar&&<TopicFormatBar editor={input} apply={applyFormat} fixed />}
    </div>
  );
}
