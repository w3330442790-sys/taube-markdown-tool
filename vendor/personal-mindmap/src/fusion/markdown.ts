import type { MindDoc, Topic, Range, Structure } from '../core/types';
import { hasMarkdownAssets } from '../core/markdown-assets';
import { parseMarkdown, serializeMarkdown, normalizeKinds, convertLevelKind, markerText, frontmatterValue, setFrontmatterValue, splitMarker, splitBlockId, type ParseOptions } from '../../vendor/gogoga/src/markdown';
import { createNode, type MindDoc as MarkdownDoc, type MindNode } from '../../vendor/gogoga/src/model';
import { preserveFormat, matchLines } from '../../vendor/gogoga/src/merge';

export type MarkdownFusionOptions = Omit<ParseOptions, 'lines' | 'fallbackTitle'>;
type SourceNode = Partial<Omit<MindNode, 'parent' | 'children'>>;
interface SourceDoc { frontmatter: string; preamble: string; rootFromHeading: boolean; style: MarkdownDoc['style']; original?: string; snapshot?: string }
const EXT = /\n?<!-- wmind-fusion:v1 ([^\r\n]*?) -->\s*$/;
const GOGOGA_THEMES = new Set(['snow', 'rainbow', 'business', 'warm', 'mono', 'line', 'forest']);
function extension(source: string): { body: string; saved?: MindDoc; canonical?: string; identities?: Record<string,string> } {
  const match = EXT.exec(source);
  if (match) try {
    const payload = JSON.parse(decodeURIComponent(match[1])) as MindDoc & { doc?: MindDoc; canonical?: string; identities?: Record<string,string> };
    const saved = payload.doc ?? payload;
    if (saved && typeof saved === 'object' && saved.root && typeof saved.root.text === 'string' && typeof saved.root.id === 'string') return { body: source.slice(0, match.index), saved, canonical: payload.canonical, identities: payload.identities };
  } catch { /* Malformed comments are ordinary Markdown, never discard them. */ }
  return {body: source};
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const clean = (doc: MindDoc): string => JSON.stringify(doc, (key, value) => key === 'markdown' ? undefined : value);
const sourceNode = (node: MindNode): SourceNode => {
  const { parent: _parent, children: _children, hiddenAfter: _after, hiddenFirst: _first, ...rest } = node;
  return copy(rest);
};

/** Convert the upstream syntax tree without losing its source-only fields. */
export function markdownTreeToDoc(parsed: MarkdownDoc, lines?: Map<MindNode, number>): MindDoc {
  const relationships: NonNullable<MindDoc['relationships']> = [];
  const anchors = new Map<string, string>();
  const all: MindNode[] = [];
  const collect = (n: MindNode) => { all.push(n); if (n.anchor) anchors.set(n.anchor, n.id); n.children.forEach(collect); };
  collect(parsed.root);
  const convert = (n: MindNode): Topic => {
    const topic: Topic = { id: n.id, text: n.text, markdown: { ...sourceNode(n), sourceLine: lines?.get(n) } };
    if (n.note) topic.note = n.note;
    if (n.folded) topic.collapsed = true;
    if (n.color) topic.style = { fill: n.color };
    for (const key of ['width', 'side', 'callout', 'calloutColor', 'hidden', 'blockId'] as const) if (n[key] !== undefined) topic[key] = n[key];
    if (n.float) topic.position = { ...n.float };
    topic.children = n.children.filter(c => !c.float || n !== parsed.root).map(convert);
    for (const [key, upstream] of [['boundaries', 'box'], ['summaries', 'summary']] as const) {
      const ranges: Range[] = [];
      n.children.forEach((c, i) => {
        const range = c[upstream];
        if (!range) return;
        ranges.push({ id: `${upstream}-${c.id}`, from: c.id, to: n.children[Math.min(n.children.length - 1, i + range.span - 1)].id,
          text: upstream === 'box' ? c.box!.title : c.summary!.text,
          ...(upstream === 'summary' && c.summary!.width ? { width: c.summary!.width } : {}) });
      });
      if (ranges.length) topic[key] = ranges;
    }
    return topic;
  };
  const doc: MindDoc = { version: 1, root: convert(parsed.root), markdown: {
    frontmatter: parsed.frontmatter, preamble: parsed.preamble, rootFromHeading: parsed.rootFromHeading, style: copy(parsed.style),
  } };
  const floating = parsed.root.children.filter(n => n.float).map(convert);
  if (floating.length) doc.floating = floating;
  for (const n of all) for (const r of n.rels ?? []) {
    const to = anchors.get(r.to);
    if (to) relationships.push({id: `rel-${n.id}-${relationships.length}`, from: n.id, to, text: r.label, ...(r.c ? { markdownControl: r.c } : {})});
  }
  if (relationships.length) doc.relationships = relationships;
  const aliases: Record<string, Structure> = {'logic-right':'logic', 'mindmap':'map', 'org-down':'org', 'tree-right':'tree'};
  const value = frontmatterValue(parsed.frontmatter, 'mindmap-structure') ?? frontmatterValue(parsed.frontmatter, 'structure');
  const structure = value ? aliases[value] ?? value : null;
  if (structure && ['map', 'logic', 'org', 'tree'].includes(structure)) doc.structure = structure as Structure;
  const theme = frontmatterValue(parsed.frontmatter, 'mindmap-theme') ?? frontmatterValue(parsed.frontmatter, 'theme');
  if (theme) {
    const id = theme.replace(/^['"]|['"]$/g, '');
    doc.theme = frontmatterValue(parsed.frontmatter, 'mindmap-theme') !== null && GOGOGA_THEMES.has(id) ? `gogoga-${id}` : id;
  }
  return doc;
}

export function parseMarkdownDoc(source: string, title: string, options: MarkdownFusionOptions = {}): MindDoc {
  const {body, saved, canonical, identities} = extension(source);
  const lines = new Map<MindNode, number>();
  const parsed = parseMarkdown(body, { ...options, fallbackTitle: title, showHidden: true, lines });
  const digest=(key:string)=>{let a=2166136261,b=3335557771;for(const char of key){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),2246822519);}return (a>>>0).toString(36)+(b>>>0).toString(36);};
  const stable=(node:MindNode,path:string)=>{
    node.id='md-'+digest(node.blockId?'block:'+node.blockId:node.anchor?'anchor:'+node.anchor:path);
    const repeats=new Map<string,number>();
    for(const child of node.children){const occurrence=repeats.get(child.text)??0;repeats.set(child.text,occurrence+1);stable(child,path+'/'+child.text+'#'+occurrence);}
  };
  stable(parsed.root,'root');
  const doc = markdownTreeToDoc(parsed, lines);
  if (saved && canonical === serializeMarkdown(parsed)) {
    const restore = (current: Topic | undefined, prior: Topic): Topic => ({...copy(prior), ...(current?.markdown ? {markdown: current.markdown} : {}), ...(prior.children ? {children: prior.children.map((child, i) => restore(current?.children?.[i], child))} : {})});
    const restored = {...copy(saved), markdown: doc.markdown, root: restore(doc.root, saved.root)};
    if (saved.floating) restored.floating = saved.floating.map((node, i) => restore(doc.floating?.[i], node));
    Object.assign(doc, restored);
  } else
  if (saved) {
    try {
      const ids = new Map<string, string>();
      const flatten = (root: Topic): Topic[] => [root, ...(root.children ?? []).flatMap(flatten)];
      const previous = [saved.root, ...(saved.floating ?? [])].flatMap(flatten);
      const currentTopics = [doc.root, ...(doc.floating ?? [])].flatMap(flatten);
      const baseline = canonical ? markdownTreeToDoc(parseMarkdown(canonical, {...options, fallbackTitle:title, showHidden:true})) : undefined;
      if (baseline) {
        const topics=[baseline.root,...(baseline.floating??[])].flatMap(flatten);
        const baselineIds=new Map<string,string>();
        for(const topic of topics){
          const anchor=(topic.markdown as SourceNode|undefined)?.anchor;
          const candidates=previous.filter(prior=>prior.text===topic.text);
          const id=(anchor?identities?.[anchor]:undefined)??(candidates.length===1?candidates[0].id:undefined);
          if(id)baselineIds.set(topic.id,id);
        }
        for(const topic of topics){
          topic.id=baselineIds.get(topic.id)??topic.id;
          for(const key of ['boundaries','summaries'] as const)for(const range of topic[key]??[]){range.from=baselineIds.get(range.from)??range.from;range.to=baselineIds.get(range.to)??range.to;}
        }
        for(const relation of baseline.relationships??[]){relation.from=baselineIds.get(relation.from)??relation.from;relation.to=baselineIds.get(relation.to)??relation.to;}
      }
      const baselineTopics=baseline?[baseline.root,...(baseline.floating??[])].flatMap(flatten):[];
      const rangeKey=(r:Range)=>JSON.stringify([r.from,r.to,r.text??'',r.width??null]);
      const relationKey=(r:NonNullable<MindDoc['relationships']>[number])=>{
        const c=r.markdownControl as {x:number;y:number}|undefined;
        return JSON.stringify([r.from,r.to,markerText(r.text??''),c?[Math.round(c.x),Math.round(c.y)]:null]);
      };
      const sameNative=<T>(a:T[],b:T[],key:(item:T)=>string)=>JSON.stringify(a.map(key).sort())===JSON.stringify(b.map(key).sort());
      let needsRecovery=false;
      const matched = new Set<string>();
      const locate = (current: Topic): Topic | undefined => {
        const anchor = (current.markdown as SourceNode | undefined)?.anchor;
        const id = anchor ? identities?.[anchor] : undefined;
        if (id && currentTopics.filter(n => (n.markdown as SourceNode | undefined)?.anchor === anchor).length === 1) return previous.find(n => n.id === id);
        const candidates = previous.filter(n => n.text === current.text);
        return candidates.length === 1 && currentTopics.filter(n => n.text === current.text).length === 1 ? candidates[0] : undefined;
      };
      const overlay = (current: Topic) => {
        const prior = locate(current);
        if (!prior) { current.children?.forEach(overlay); return; }
        matched.add(prior.id);
        const fill = current.style?.fill;
        ids.set(current.id, prior.id);
        const { text: _text, note: _note, collapsed: _collapsed, position: _position, children, markdown: _markdown,
          boundaries: _boundaries, summaries: _summaries, width: _width, side: _side, hidden: _hidden,
          callout: _callout, calloutColor: _calloutColor, blockId: _blockId, ...extra } = prior;
        Object.assign(current, extra);
        if (current.style) { current.style = { ...current.style }; if (fill) current.style.fill = fill; else delete current.style.fill; }
        current.children?.forEach(overlay);
        for (const key of ['boundaries', 'summaries'] as const) {
          const ranges=(current[key]??[]).map(range=>({...range,from:ids.get(range.from)??range.from,to:ids.get(range.to)??range.to}));
          const before=baselineTopics.find(topic=>topic.id===prior.id)?.[key]??[];
          if(baseline&&sameNative(ranges,before,rangeKey))current[key]=prior[key]?copy(prior[key]):undefined;
          else {
            current[key]=ranges.length?ranges.map(range=>{
              const source=before.find(r=>r.from===range.from);
              const candidates=(prior[key]??[]).filter(r=>rangeKey(r)===rangeKey(source??range));
              const original=candidates.length===1?candidates[0]:undefined;
              if(candidates.length>1)needsRecovery=true;
              return {...original,...range,id:original?.id??range.id};
            }):undefined;
            // Additional overlapping groups have no independent native marker. Retain their
            // originals in recovery when a real marker edit prevents an exact reconciliation.
            if((prior[key]?.length??0)>before.length)needsRecovery=true;
          }
        }
      };
      const {root, floating, markdown: _markdown, relationships: _rels, theme: _theme, structure: _structure, ...extra} = saved;
      Object.assign(doc, extra);
      overlay(doc.root);
      doc.floating?.forEach(overlay);
      const relations=(doc.relationships??[]).map(r=>({...r,from:ids.get(r.from)??r.from,to:ids.get(r.to)??r.to}));
      if(baseline&&sameNative(relations,baseline.relationships??[],relationKey))doc.relationships=saved.relationships?copy(saved.relationships):undefined;
      else {
        const originals=saved.relationships??[];
        const associations=new Map<number,number>();const used=new Set<number>();
        // Resolve unchanged labels first, so an edited parallel edge cannot steal its sibling's style.
        for(const [i,r]of relations.entries()){
          const candidates=originals.map((prior,j)=>({prior,j})).filter(({prior,j})=>!used.has(j)&&relationKey(prior)===relationKey(r));
          if(candidates.length===1){associations.set(i,candidates[0].j);used.add(candidates[0].j);}
          else if(candidates.length>1)needsRecovery=true;
        }
        for(const [i,r]of relations.entries())if(!associations.has(i)){
          const candidates=originals.map((prior,j)=>({prior,j})).filter(({prior,j})=>!used.has(j)&&prior.from===r.from&&prior.to===r.to);
          if(candidates.length===1){associations.set(i,candidates[0].j);used.add(candidates[0].j);}
          else if(candidates.length>1)needsRecovery=true;
        }
        doc.relationships=relations.length?relations.map((r,i)=>{
          const at=associations.get(i),prior=at===undefined?undefined:originals[at];
          const unchanged=prior&&relationKey(prior)===relationKey(r);
          return {...prior,...r,id:prior?.id??r.id,text:unchanged?prior.text:r.text};
        }):undefined;
        if(originals.some(prior=>!(baseline?.relationships??[]).some(r=>relationKey(r)===relationKey(prior))))needsRecovery=true;
      }
      if (matched.size < previous.length||needsRecovery) {
        doc.fusionWarnings = ['Some saved metadata could not be matched safely after Markdown edits; it is retained in fusionRecovery.'];
        doc.fusionRecovery = saved;
      }
    } catch { /* An invalid extension remains ordinary source content on the next write. */ }
  }
  const metadata = doc.markdown as SourceDoc;
  metadata.original = source;
  metadata.snapshot = clean(doc);
  return doc;
}

function toMarkdownTree(doc: MindDoc, title: string, options: MarkdownFusionOptions): MarkdownDoc {
  const meta = doc.markdown as SourceDoc | undefined;
  const fallback = parseMarkdown('', { ...options, fallbackTitle: title });
  const tree: MarkdownDoc = { ...fallback, rootFromHeading: true, ...(meta ? {frontmatter: meta.frontmatter, preamble: meta.preamble, rootFromHeading: meta.rootFromHeading, style: meta.style} : {}) };
  const nodes = new Map<string, MindNode>();
  const build = (topic: Topic, parent: MindNode | null): MindNode => {
    const old = (topic.markdown ?? {}) as SourceNode;
    const depth = parent ? parent.depth + 1 : 0;
    const n = createNode({ ...old, parent, id: topic.id, text: topic.text, note: topic.note ?? '', folded: !!topic.collapsed,
      kind: old.kind ?? (depth < 3 ? 'heading' : 'list'), level: old.level ?? (depth < 3 ? depth + 1 : 0),
      color: topic.style?.fill, float: topic.position, box: undefined, summary: undefined, rels: undefined });
    for (const key of ['width', 'side', 'callout', 'calloutColor', 'hidden', 'blockId'] as const) (n as unknown as Record<string, unknown>)[key] = topic[key];
    nodes.set(topic.id, n);
    n.children = (topic.children ?? []).map(c => build(c, n));
    if (!parent) n.children.push(...(doc.floating ?? []).map(c => build(c, n)));
    for (const [key, upstream] of [['boundaries', 'box'], ['summaries', 'summary']] as const) for (const range of topic[key] ?? []) {
      const start = n.children.findIndex(c => c.id === range.from), end = n.children.findIndex(c => c.id === range.to);
      if (start < 0 || end < start) continue;
      if (upstream === 'box') n.children[start].box = { span: end - start + 1, title: range.text ?? '' };
      else n.children[start].summary = { span: end - start + 1, text: range.text ?? '', ...(range.width ? {width: Number(range.width)} : {}) };
    }
    return n;
  };
  tree.root = build(doc.root, null);
  normalizeKinds(tree);
  // Markdown lists following a heading otherwise serialize before it or become its children.
  const keepSiblingOrder=(parent:MindNode)=>{
    let headingSeen=false;
    for(const node of parent.children){
      if(parent.kind==='heading'&&parent.level<6){
        if(node.kind==='heading')headingSeen=true;
        else if(headingSeen){node.kind='heading';node.level=parent.level+1;}
      }
      keepSiblingOrder(node);
    }
  };
  keepSiblingOrder(tree.root);
  const used = new Set([...nodes.values()].map(n => n.anchor).filter(Boolean));
  let anchorIndex = 0;
  for (const n of nodes.values()) if (!n.anchor) {
    let anchor: string;
    do { anchor = `wf${++anchorIndex}`; } while (used.has(anchor));
    n.anchor = anchor; used.add(anchor);
  }
  for (const r of doc.relationships ?? []) {
    const from = nodes.get(r.from), to = nodes.get(r.to);
    if (!from || !to) continue;
    to.anchor ??= `wm${nodes.size}_${[...nodes.keys()].indexOf(r.to)}`;
    (from.rels ??= []).push({to: to.anchor, label: r.text ?? '', ...(r.markdownControl ? {c: r.markdownControl as {x:number;y:number}} : {})});
  }
  if (doc.structure) {
    const gogoga = frontmatterValue(tree.frontmatter, 'mindmap-structure') !== null;
    const names = {map:'mindmap', logic:'logic-right', org:'org-down', tree:'tree-right'};
    tree.frontmatter = setFrontmatterValue(tree.frontmatter, gogoga ? 'mindmap-structure' : 'structure', gogoga ? names[doc.structure] : doc.structure);
  }
  if (doc.theme) {
    const gogoga = frontmatterValue(tree.frontmatter, 'mindmap-theme') !== null;
    const theme = gogoga && doc.theme.startsWith('gogoga-') ? doc.theme.slice(7) : doc.theme;
    tree.frontmatter = setFrontmatterValue(tree.frontmatter, gogoga ? 'mindmap-theme' : 'theme', theme);
  }
  return tree;
}

/** All primary metadata is portable in an ignored HTML comment, so nothing is silently dropped. */
export function markdownFusionLosses(doc: MindDoc): string[] {
  return Array.isArray(doc.fusionWarnings) ? doc.fusionWarnings.filter((warning): warning is string => typeof warning === 'string') : [];
}

/** Match gogoga's whole-sibling-level conversion while keeping the primary document intact. */
export function convertPrimaryLevelKind(doc:MindDoc,id:string,kind:'heading'|'list'):MindDoc {
  const tree=toMarkdownTree(doc,doc.root.text,{});
  const all:MindNode[]=[];const visit=(node:MindNode)=>{all.push(node);node.children.forEach(visit);};visit(tree.root);
  const target=all.find(node=>node.id===id);
  if(!target||!convertLevelKind(target,kind,tree.style))return doc;
  normalizeKinds(tree);
  const next=copy(doc);
  const byId=new Map(all.map(node=>[node.id,node]));
  const update=(topic:Topic)=>{
    const node=byId.get(topic.id);
    if(node)topic.markdown={...(topic.markdown as SourceNode|undefined),...sourceNode(node)};
    topic.children?.forEach(update);
  };
  [next.root,...(next.floating??[])].forEach(update);
  if(next.markdown)(next.markdown as SourceDoc).snapshot='';
  return next;
}

export function writeMarkdownDoc(source: string, doc: MindDoc, title: string, options: MarkdownFusionOptions = {}): string {
  const meta = doc.markdown as SourceDoc | undefined;
  if (meta?.original === source && meta.snapshot === clean(doc)) return source;
  const {body} = extension(source);
  const tree = toMarkdownTree(doc, title, options);
  const next = serializeMarkdown(tree);
  const merged = preserveFormat(body, next, text => serializeMarkdown(parseMarkdown(text, {...options, fallbackTitle: title, showHidden: true})));
  // Persist the primary model (including IDs and custom fields), excluding source snapshots.
  const identities: Record<string, string> = {};
  const identify = (n: MindNode) => { if (n.anchor) identities[n.anchor] = n.id; n.children.forEach(identify); };
  identify(tree.root);
  const portable = JSON.stringify({doc, canonical: next, identities}, (key, value) => key === 'markdown' ? undefined : value);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return merged.trimEnd() + newline + '<!-- wmind-fusion:v1 ' + encodeURIComponent(portable) + ' -->' + newline;
}

export interface SourceSpan { from: number; to: number; target: number }

/** One-time cleanup of old map-owned files; new/user-authored files are opt-out. */
export function repairMindmapMarkdown(source:string,title:string,record?:{source:string;doc:MindDoc;quoteGapRepair?:1;quoteGapRepairBefore?:string},options:MarkdownFusionOptions={}):{text:string;doc:MindDoc;spans:SourceSpan[]}|null {
  const migration=migrateMarkdownMetadata(source,title);
  if(!migration&&(!record||(record.quoteGapRepair===1&&!(record.quoteGapRepairBefore===source&&record.source!==source))))return null;
  const body=migration?.text??source;
  const lines=body.match(/[^\n]*\n|[^\n]+$/g)??[];
  const opaque:boolean[]=[];
  let fence:{char:string;length:number}|undefined,html:string|undefined;
  let frontmatter=lines[0]?.replace(/\r?\n$/,'')==='---';
  for(let i=0;i<lines.length;i++){
    const line=lines[i].replace(/\r?\n$/,'');
    if(frontmatter){opaque[i]=true;if(i>0&&/^(---|\.\.\.)$/.test(line))frontmatter=false;continue;}
    const mark=/^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence){opaque[i]=true;if(mark&&mark[1][0]===fence.char&&mark[1].length>=fence.length&&!mark[2].trim())fence=undefined;continue;}
    if(!html&&mark){opaque[i]=true;fence={char:mark[1][0],length:mark[1].length};continue;}
    opaque[i]=!!html||/^( {4}|\t)/.test(line);
    // Comments may begin midway through prose. Code-span literals do not open comments.
    const prose=line.replace(/(`+)[^`]*?\1/g,'');
    for(const token of prose.match(/<!--|-->|%%|<\/?(?:pre|script|style|textarea)\b[^>]*>/gi)??[]){
      const lower=token.toLowerCase();
      if(html){if(lower===html)html=undefined;continue;}
      if(lower==='<!--')html='-->';
      else if(lower==='%%')html='%%';
      else if(/^<(pre|script|style|textarea)\b/.test(lower))html=`</${/^<(\w+)/.exec(lower)![1]}>`;
      else continue;
      opaque[i]=true;
    }
  }
  const removed=new Set<number>();
  for(let i=0;i<lines.length;i++){
    if(opaque[i]||!/^ {0,3}>/.test(lines[i]))continue;
    let previous=i-1;while(previous>=0&&!lines[previous].trim()&&!opaque[previous])previous--;
    if(previous===i-1||previous<0||opaque[previous]||/^[ \t]*>/.test(lines[previous]))continue;
    for(let j=previous+1;j<i;j++)removed.add(j);
  }
  if(!removed.size)return migration??{text:source,doc:restoreMarkdownMetadata(source,title,record,options),spans:source?[{from:0,to:source.length,target:0}]:[]};
  let text='',offset=0;const spans:SourceSpan[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!removed.has(i)){
      if(migration){
        // Compose the marker-removal map with this exact deletion map.
        for(const span of migration.spans){const a=Math.max(span.target,offset),b=Math.min(span.target+span.to-span.from,offset+line.length);if(b>a)spans.push({from:span.from+a-span.target,to:span.from+b-span.target,target:text.length+a-offset});}
      }else spans.push({from:offset,to:offset+line.length,target:text.length});
      text+=line;
    }
    offset+=line.length;
  }
  const baseline=migration?{source:body,doc:migration.doc}:record;
  return {text,spans,doc:restoreMarkdownMetadata(text,title,baseline,options)};
}

/** Only a valid legacy envelope proves that recognized syntax was plugin metadata. */
export function migrateMarkdownMetadata(source:string,title=''): {text:string;doc:MindDoc;spans:SourceSpan[]}|null {
  const legacy=extension(source);if(!legacy.saved||!legacy.identities)return null;
  const original=parseMarkdownDoc(source,title);
  const markerLines=new Map<number,string>();
  for(const node of topics(original)){
    const meta=node.markdown as SourceNode&{sourceLine?:number};
    if(meta?.sourceLine===undefined||!meta.anchor||!legacy.identities[meta.anchor])continue;
    markerLines.set(meta.sourceLine,meta.anchor);
    if(meta.kind==='heading')markerLines.set(meta.sourceLine+1,meta.anchor);
  }
  const match=EXT.exec(source)!;const commentStart=match.index+match[0].indexOf('<!--');
  const body=source.slice(0,commentStart);let text='';const spans:SourceSpan[]=[];
  let offset=0,lineNo=0;
  for(const raw of body.match(/[^\n]*\n|[^\n]+$/g)??[]){
    const line=raw.replace(/\r?\n$/,'');const ending=raw.slice(line.length);
    const block=splitBlockId(line);const split=splitMarker(block.text);
    let next=raw;
    if(split.marker.anchor&&markerLines.get(lineNo)===split.marker.anchor){
      next=split.text.trim()?split.text+(block.blockId?' ^'+block.blockId:'')+ending:'';
    }
    spans.push(...copiedSpans(raw,next,offset,text.length));text+=next;offset+=raw.length;lineNo++;
  }
  const parsed=parseMarkdownDoc(text,title||original.root.text);
  const a=topics(parsed),b=topics(original);
  if(a.length!==b.length||a.some((n,i)=>n.text!==b[i].text||(n.note??'')!==(b[i].note??'')))throw Error('旧脑图标记不能安全迁移，已保留原文');
  const doc=copy(original);const dest=topics(doc);for(let i=0;i<a.length;i++)dest[i].markdown=a[i].markdown;
  doc.markdown=parsed.markdown;
  return {text,doc,spans};
}

/** Markdown content is authoritative; the sidecar supplies stable identities and graph-only fields. */
export function restoreMarkdownMetadata(source:string,title:string,record:{source:string;doc:MindDoc}|undefined,options:MarkdownFusionOptions={}):MindDoc {
  const fresh=parseMarkdownDoc(source,title,options);if(!record)return fresh;
  const prior=topics(record.doc),current=topics(fresh);
  if(record.source===source&&prior.length===current.length){
    const result=copy(record.doc),dest=topics(result);for(let i=0;i<dest.length;i++)dest[i].markdown=current[i].markdown;
    result.markdown=fresh.markdown;return result;
  }
  const a=record.source.split('\n'),b=source.split('\n');
  const pairs=matchLines(a,b);const lines=new Map<number,number>();let pa=0,pb=0;
  for(const [ai,bi]of [...pairs,[a.length,b.length] as [number,number]]){
    if(ai-pa===bi-pb)for(let i=0;i<ai-pa;i++)lines.set(pa+i,pb+i);
    if(ai<a.length)lines.set(ai,bi);pa=ai+1;pb=bi+1;
  }
  const used=new Set<string>();
  const signature=(n:Topic):string=>JSON.stringify([n.text,n.note??'',(n.children??[]).map(signature)]);
  for(const topic of current){
    const line=(topic.markdown as {sourceLine?:number})?.sourceLine;
    const unique=(test:(n:Topic)=>boolean)=>{const found=prior.filter(n=>!used.has(n.id)&&test(n));return found.length===1&&current.filter(test).length===1?found[0]:undefined;};
    let old=topic.blockId?unique(n=>n.blockId===topic.blockId):undefined;
    old??=unique(n=>signature(n)===signature(topic));
    old??=unique(n=>n.text===topic.text);
    if(topic===fresh.root)old=record.doc.root;
    if(!old&&!prior.some(n=>n.text===topic.text))old=prior.find(n=>!used.has(n.id)&&!current.some(c=>c.text===n.text)&&line!==undefined&&lines.get((n.markdown as {sourceLine:number})?.sourceLine)===line);
    if(!old)continue;
    used.add(old.id);
    const {text:_text,note:_note,children:_children,markdown:_markdown,blockId:_block,...extra}=old;
    Object.assign(topic,extra);
  }
  const {root:_root,floating:_floating,markdown:_markdown,...extra}=record.doc;
  Object.assign(fresh,extra);
  const floatingIds=new Set(record.doc.floating?.map(n=>n.id));
  const floating:Topic[]=[];
  const detachFloating=(parent:Topic)=>{
    parent.children=parent.children?.filter(child=>{if(floatingIds.has(child.id)&&used.has(child.id)){floating.push(child);return false;}detachFloating(child);return true;});
  };
  detachFloating(fresh.root);
  if(floating.length)fresh.floating=floating;
  const live=new Set(current.map(n=>n.id));
  fresh.relationships=fresh.relationships?.filter(r=>live.has(r.from)&&live.has(r.to));
  for(const n of current)for(const key of ['boundaries','summaries'] as const)n[key]=n[key]?.filter(r=>live.has(r.from)&&live.has(r.to));
  if(used.size<prior.length)fresh.fusionRecovery=record.doc.fusionRecovery??{...record.doc,fusionRecovery:undefined};
  return fresh;
}
export function mapSyncRange(spans: SourceSpan[], from: number, to: number): {from:number;to:number}|null {
  const sorted=spans.filter(s=>s.to>from&&s.from<to).sort((a,b)=>a.from-b.from);
  let cursor=from,delta:number|undefined;
  for(const span of sorted){
    if(span.from>cursor)return null;
    const shift=span.target-span.from;
    if(delta!==undefined&&delta!==shift)return null;
    delta=shift;cursor=Math.max(cursor,span.to);if(cursor>=to)return {from:from+delta,to:to+delta};
  }
  return null;
}

/** An exact deletion map can also preserve selections crossing removed whitespace. */
export function mapSyncRangeAfterWhitespaceDeletion(spans:SourceSpan[],before:string,after:string,from:number,to:number):{from:number;to:number}|null {
  if(from<0||to>before.length||from>=to)return null;
  let cursor=from,start:number|undefined,end:number|undefined;
  for(const span of spans.filter(s=>s.to>from&&s.from<to).sort((a,b)=>a.from-b.from)){
    const a=Math.max(cursor,span.from),b=Math.min(to,span.to);if(b<=a)continue;
    if(/\S/.test(before.slice(cursor,a)))return null;
    const target=span.target+a-span.from;
    if(end!==undefined&&target!==end)return null;
    if(before.slice(a,b)!==after.slice(target,target+b-a))return null;
    start??=target;end=target+b-a;cursor=b;
  }
  if(start===undefined||end===undefined||/\S/.test(before.slice(cursor,to))||!after.slice(start,end).trim())return null;
  return {from:start,to:end};
}
const topics=(doc:MindDoc):Topic[]=>{
  const walk=(n:Topic):Topic[]=>[n,...(n.children??[]).flatMap(walk)];
  return [doc.root,...(doc.floating??[])].flatMap(walk);
};
/** Copied ranges within a known node, including unchanged portions of an edited line. */
function copiedSpans(before:string,after:string,from:number,target:number):SourceSpan[]{
  const a=before.match(/[^\n]*\n|[^\n]+$/g)??[],b=after.match(/[^\n]*\n|[^\n]+$/g)??[];
  const starts=(lines:string[])=>{let n=0;return lines.map(s=>{const at=n;n+=s.length;return at;});};
  const aa=starts(a),bb=starts(b),spans:SourceSpan[]=[];
  let pa=0,pb=0;
  for(const [ai,bi]of [...matchLines(a,b),[a.length,b.length] as [number,number]]){
    if(ai-pa===bi-pb)for(let k=0;k<ai-pa;k++){
      const x=a[pa+k],y=b[pb+k];let head=0,tail=0;
      while(head<Math.min(x.length,y.length)&&x[head]===y[head])head++;
      while(tail<Math.min(x.length,y.length)-head&&x[x.length-1-tail]===y[y.length-1-tail])tail++;
      if(head)spans.push({from:from+aa[pa+k],to:from+aa[pa+k]+head,target:target+bb[pb+k]});
      if(tail)spans.push({from:from+aa[pa+k]+x.length-tail,to:from+aa[pa+k]+x.length,target:target+bb[pb+k]+y.length-tail});
    }
    if(ai<a.length)spans.push({from:from+aa[ai],to:from+aa[ai]+a[ai].length,target:target+bb[bi]});
    pa=ai+1;pb=bi+1;
  }
  return spans;
}

/** Write content using the original node-owned source slices, never graphical markers. */
export function syncMarkdownDoc(source:string,previous:MindDoc,doc:MindDoc,title:string,options:MarkdownFusionOptions={}):{text:string;doc:MindDoc;spans:SourceSpan[]} {
  const content=(n:Topic):unknown=>[n.id,n.text,n.note??'',n.blockId??'',(n.markdown as SourceNode|undefined)?.kind,(n.markdown as SourceNode|undefined)?.level,(n.children??[]).map(content)];
  const projection=(d:MindDoc)=>JSON.stringify([content(d.root),(d.floating??[]).map(content)]);
  if(projection(previous)===projection(doc)){
    const next=copy(doc),prior=new Map(topics(previous).map(n=>[n.id,n]));
    for(const n of topics(next))n.markdown=prior.get(n.id)?.markdown;
    next.markdown=previous.markdown;
    return {text:source,doc:next,spans:source?[{from:0,to:source.length,target:0}]:[]};
  }
  const nl=source.includes('\r\n')?'\r\n':'\n';
  const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];
  const offsets:number[]=[];let size=0;for(const line of lines){offsets.push(size);size+=line.length;}offsets.push(size);
  const old=topics(previous).filter(n=>typeof (n.markdown as {sourceLine?:number})?.sourceLine==='number')
    .sort((a,b)=>(a.markdown as {sourceLine:number}).sourceLine-(b.markdown as {sourceLine:number}).sourceLine);
  const slices=new Map(old.map((n,i)=>{const start=offsets[(n.markdown as {sourceLine:number}).sourceLine];const end=i+1<old.length?offsets[(old[i+1].markdown as {sourceLine:number}).sourceLine]:source.length;return [n.id,{node:n,start,raw:source.slice(start,end)}] as const;}));
  const prepared=copy(doc);
  const inferKinds=(parent:Topic)=>{
    for(const child of parent.children??[]){
      if(!(child.markdown as SourceNode|undefined)?.kind){
        const sibling=parent.children?.find(n=>n.id!==child.id&&(n.markdown as SourceNode|undefined)?.kind);
        child.markdown={...(child.markdown as SourceNode|undefined),kind:(sibling?.markdown as SourceNode|undefined)?.kind??(options.headingsOnly?'heading':'list')};
      }
      inferKinds(child);
    }
  };
  inferKinds(prepared.root);
  const tree=toMarkdownTree(prepared,title,options);
  const nodes:MindNode[]=[];const visit=(n:MindNode)=>{nodes.push(n);n.children.forEach(visit);};visit(tree.root);
  const current=new Map(topics(doc).map(n=>[n.id,n]));
  const synthetic=!(previous.markdown as SourceDoc)?.rootFromHeading;
  let text=source.slice(0,old.length?slices.get(old[0].id)!.start:source.length);
  const originalPrefix=text;
  if(synthetic&&(previous.root.note??'')!==(doc.root.note??'')){
    const fm=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0].length??0;
    const oldNote=(previous.root.note??'').replace(/\r?\n/g,nl),note=(doc.root.note??'').replace(/\r?\n/g,nl);
    const at=oldNote?text.indexOf(oldNote,fm):fm;
    if(at<0)throw Error('无法安全定位引言段落，原文未改动。');
    text=text.slice(0,at)+note+text.slice(at+oldNote.length);
    if(!oldNote&&note&&old.length&&!text.endsWith('\n'))text+=nl;
  }
  const spans:SourceSpan[]=copiedSpans(originalPrefix,text,0,0);
  const rendered:Topic[]=[];
  for(const n of nodes){
    if(n===tree.root&&synthetic)continue;
    const topic=current.get(n.id)!;const saved=slices.get(n.id);
    const ws=n.kind==='list'?tree.style.indent.repeat((()=>{let depth=0,p=n.parent;while(p?.kind==='list'){depth++;p=p.parent;}return depth;})()):'';
    const prefix=n.kind==='heading'?'#'.repeat(n.level)+' ':ws+(n.bullet||tree.style.bullet)+' ';
    let raw:string;
    if(saved){
      const pieces=saved.raw.match(/[^\n]*\n|[^\n]+$/g)??[];
      const first=pieces[0]??'';const header=first.replace(/\r?\n$/,'');const ending=first.slice(header.length);
      const found=/^(?:#{1,6}[ \t]*|[ \t]*(?:[-*+]|\d+[.)])[ \t]+)/.exec(header);
      if(!found||!header.slice(found[0].length).startsWith(saved.node.text))throw new Error('无法安全同步此节点，原文未改动。');
      const oldKind=(saved.node.markdown as SourceNode).kind;
      const oldLevel=(saved.node.markdown as SourceNode).level;
      const samePrefix=n.kind===oldKind&&(n.kind==='heading'?n.level===oldLevel:found[0].match(/^[ \t]*/)![0]===ws);
      let suffix=header.slice(found[0].length+saved.node.text.length);
      if(topic.blockId!==saved.node.blockId){suffix=suffix.replace(/[ \t]+\^[A-Za-z0-9-]+/, '');if(topic.blockId)suffix+=' ^'+topic.blockId;}
      pieces[0]=(samePrefix?found[0]:prefix)+topic.text+suffix+ending;
      if((topic.note??'')!==(saved.node.note??'')){
        let a=1,b=pieces.length;
        while(a<b&&(!pieces[a].trim()||/^\s*%%.*%%\s*$/.test(pieces[a])))a++;
        while(b>a&&!pieces[b-1].trim())b--;
        // A tail/lead belongs to the surrounding structure, not the edited note.
        const assets=hasMarkdownAssets(topic.note);
        const noteIndent=n.kind==='list'?ws+(assets?' '.repeat((samePrefix?found[0]:prefix).trimStart().length):tree.style.indent):'';
        if(assets&&!saved.node.note){
          // Insert directly after the node marker, leaving any unrelated continuation untouched.
          const afterMarker=n.kind==='heading'&&pieces[1]?.trim()&&splitMarker(pieces[1].trim()).text===''?2:1;
          if(!pieces[afterMarker-1].endsWith('\n'))pieces[afterMarker-1]+=nl;
          const lines=topic.note!.split(/\r?\n/).map(line=>(line?noteIndent+line:'')+nl);
          if(pieces[afterMarker]?.trim())lines.push(nl);
          pieces.splice(afterMarker,0,nl,...lines);
        }else{
          const meta=saved.node.markdown as SourceNode;
          if(meta.tail||meta.lead)throw new Error('此节点含交错段落，请在 Markdown 中编辑备注；原文已保留。');
          const existingIndent=a<b?pieces[a].match(/^[ \t]*/)![0]:noteIndent;
          const indent=assets&&n.kind==='list'&&existingIndent.length<noteIndent.length?noteIndent:existingIndent;
          const noteLines=topic.note?topic.note.split(/\r?\n/).map(line=>(line?indent+line:'')+nl):[];
          if(assets&&a===1)noteLines.unshift(nl);
          pieces.splice(a,b-a,...noteLines);
          if(topic.note&&!pieces[0].endsWith('\n'))pieces[0]+=nl;
        }
      }else if(n.kind==='list'&&oldKind==='list'){
        const oldWs=found[0].match(/^[ \t]*/)![0];
        if(oldWs!==ws)for(let i=1;i<pieces.length;i++)if(pieces[i].trim()&&pieces[i].startsWith(oldWs))pieces[i]=ws+pieces[i].slice(oldWs.length);
      }
      raw=pieces.join('');
    }else{
      const assets=hasMarkdownAssets(topic.note);
      const indent=n.kind==='list'?ws+(assets?' '.repeat(prefix.trimStart().length):tree.style.indent):'';
      const note=topic.note?.split(/\r?\n/).map(line=>(line?indent+line:'')+nl).join('')??'';
      raw=prefix+topic.text+(topic.blockId?' ^'+topic.blockId:'')+nl+(assets?nl:'')+note;
    }
    if(text&&!text.endsWith('\n'))text+=nl;
    if(saved)spans.push(...copiedSpans(saved.raw,raw,saved.start,text.length));
    text+=raw;rendered.push(topic);
  }
  const parsed=parseMarkdownDoc(text,title,options);
  const actual=topics(parsed).filter(n=>typeof(n.markdown as {sourceLine?:number})?.sourceLine==='number');
  const shape=(n:Topic):unknown=>[n.text,(n.note??'').replace(/\r\n/g,'\n'),(n.children??[]).map(shape)];
  if(JSON.stringify(shape(parsed.root))!==JSON.stringify(shape({...doc.root,children:[...(doc.root.children??[]),...(doc.floating??[])]})))throw new Error('无法在保留原文格式的同时表达此结构，请先在 Markdown 中调整；原文未改动。');
  const next=copy(doc);
  const output=topics(next);
  for(let i=0;i<actual.length;i++){const target=output.find(n=>n.id===rendered[i]?.id);if(target)target.markdown=actual[i].markdown;}
  next.markdown=parsed.markdown;
  return {text,doc:next,spans};
}
