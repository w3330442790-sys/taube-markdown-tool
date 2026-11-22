import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownDoc, writeMarkdownDoc, markdownFusionLosses, syncMarkdownDoc } from '../../vendor/personal-mindmap/src/fusion/markdown';
import { applyInlineFormat } from '../../vendor/personal-mindmap/src/core/inline-format';
import { projectTextMarks } from '../../vendor/personal-mindmap/src/fusion/text-marks';
import { markedTopicText, parseRich } from '../../vendor/personal-mindmap/webview/src/rich';

test('Markdown marks project onto exact topic text and stay out of the saved source', () => {
 const source='---\r\nname: test\r\n---\r\n# Root\r\n- **重点** 和普通文本\r\n- 重点\r\n';
 const before=parseMarkdownDoc(source,'Root');
 const node=before.root.children![0];
 const start=source.indexOf('重点');
 const end=source.indexOf('普通文本');
 const marks=projectTextMarks(source,before,[
  {from:start,to:start+2,text:'重点',format:'text-color',color:'#dc2626'},
  {from:end,to:end+2,text:'普通',format:'bold'},
  {from:end,to:end+2,text:'过期',format:'underline'},
 ]);
 assert.equal(marks.length,1);
 const shown=markedTopicText(node.text,marks[0]);
 const rich=parseRich(shown);
 assert.equal(rich[0].children?.[0].kind,'color');
 assert.equal(rich[2].kind,'bold');
 assert.equal(syncMarkdownDoc(source,before,before,'Root').text,source);
 assert.equal(markedTopicText('已改写',marks[0]),'已改写');
});

test('a topic selection can be bold and red and survive Markdown round-trip',()=>{
 const source='# 笔记\n\n- 前文重点后文\n';
 const before=parseMarkdownDoc(source,'笔记');
 const edited=structuredClone(before);
 const topic=edited.root.children![0];
 const bold=applyInlineFormat(topic.text,2,4,'bold');
 topic.text=applyInlineFormat(bold.text,bold.start,bold.end,'red').text;
 const result=syncMarkdownDoc(source,before,edited,'笔记');
 assert.equal(result.text,'# 笔记\n\n- 前文**<span style="color:#dc2626">重点</span>**后文\n');
 assert.equal(parseMarkdownDoc(result.text,'笔记').root.children![0].text,topic.text);
});

test('canvas italic, underline, strike and highlight remain inline Markdown on reopen',()=>{
 const source='# 笔记\n\n- 前文重点后文\n';
 const before=parseMarkdownDoc(source,'笔记');
 const edited=structuredClone(before);
 const topic=edited.root.children![0];
 let selection={text:topic.text,start:2,end:4};
 for (const format of ['italic','underline','strike','highlight'] as const) {
  selection=applyInlineFormat(selection.text,selection.start,selection.end,format,true);
 }
 topic.text=selection.text;
 const {text}=syncMarkdownDoc(source,before,edited,'笔记');
 assert.match(text,/<em><u>~~==重点==~~<\/u><\/em>/);
 assert.equal(parseMarkdownDoc(text,'笔记').root.children![0].text,topic.text);
});
import {addRange, moveMany, summaryToBranch} from '../../vendor/personal-mindmap/src/core/ops';
import * as sync from '../../vendor/personal-mindmap/src/fusion/markdown';

test('serializing quote notes and deleting a quote-adjacent child adds no blank separator',async()=>{
 const {parseMarkdown,serializeMarkdown}=await import('../../vendor/personal-mindmap/vendor/gogoga/src/markdown');
 const {preserveFormat}=await import('../../vendor/personal-mindmap/vendor/gogoga/src/merge');
 for(const source of ['# Root\n> 引用\n','# Root\n- Item\n  - 正文\n  > 引用\n- End\n']){
  const doc=parseMarkdown(source);
  if(doc.root.children.length)doc.root.children[0].children=[];
  else doc.root.note='> 修改引用';
  const next=serializeMarkdown(doc);
  const result=preserveFormat(source,next,t=>serializeMarkdown(parseMarkdown(t)));
  assert.equal(result,source.includes('- 正文')?source.replace('  - 正文\n',''):source.replace('> 引用','> 修改引用'));
 }
});

test('one-time repair removes existing quote gaps only from managed files and maps surviving text exactly',()=>{
 const repair=(sync as any).repairMindmapMarkdown;
 assert.equal(typeof repair,'function');
 for(const nl of ['\n','\r\n']){
  const source=['# Root','','正文','','','> 引用','','普通段落','','后续段落','','```md','例子','','> literal','```','','- Branch','  note','','  > nested quote',''].join(nl);
  const doc=parseMarkdownDoc(source,'Note');doc.root.style={fontSize:27};
  const record={source,doc};
  assert.equal(repair(source,'Note',undefined),null);
  const result=repair(source,'Note',record);
  const expected=source.replace('正文'+nl+nl+nl+'>','正文'+nl+'>').replace('  note'+nl+nl+'  >','  note'+nl+'  >');
  assert.equal(result.text,expected);
  assert.equal(result.doc.root.style.fontSize,27);
  for(const text of ['正文','引用','literal','nested quote']){
   const from=source.indexOf(text),mapped=sync.mapSyncRange(result.spans,from,from+text.length);
   assert.deepEqual(mapped,{from:expected.indexOf(text),to:expected.indexOf(text)+text.length});
  }
  assert.equal(repair(source,'Note',{...record,quoteGapRepair:1}),null);
  assert.equal(repair(expected,'Note',{source:expected,doc:result.doc}).text,expected);
  const pending={source:expected,doc:result.doc,quoteGapRepair:1,legacySource:'older backup',quoteGapRepairBefore:source};
  assert.equal(repair(source,'Note',pending).text,expected,'retry a source-write failure independently of the first historical backup');
 }
});

test('quote gap cleanup skips inline-started multiline comments and resumes after fenced examples',()=>{
 const source='# Root\ntext <!-- user comment\n\n> HTML literal\n-->\ntext %% user comment\n\n> Obsidian literal\n%%\n```md\n<!--\n\n> code literal\n```\n正文\n\n> 引用\n';
 const result=(sync as any).repairMindmapMarkdown(source,'Note',{source,doc:parseMarkdownDoc(source,'Note')});
 assert.equal(result.text,source.replace('正文\n\n> 引用','正文\n> 引用'));
});

test('legacy marker and quote-gap removal compose exact annotation maps without deleting literal comments',()=>{
 const source='# Root\n正文\n\n> 引用\n\n%%user comment%%\n';
 const doc=parseMarkdownDoc(source,'Note');doc.look='hand';
 const legacy=writeMarkdownDoc(source,doc,'Note');
 const result=sync.repairMindmapMarkdown(legacy,'Note')!;
 assert.equal(result.text,source.replace('正文\n\n>','正文\n>'));
 const from=legacy.indexOf('引用');
 assert.deepEqual(sync.mapSyncRange(result.spans,from,from+2),{from:result.text.indexOf('引用'),to:result.text.indexOf('引用')+2});
});

test('whitespace-only selection mapping rejects deleted words, inserted content and reordered source',()=>{
 const map=sync.mapSyncRangeAfterWhitespaceDeletion;
 assert.deepEqual(map([{from:0,to:2,target:0},{from:3,to:5,target:2}],'A\n\n>B','A\n>B',0,5),{from:0,to:4});
 assert.equal(map([{from:0,to:1,target:0},{from:2,to:3,target:1}],'AXB','AB',0,3),null);
 assert.equal(map([{from:0,to:1,target:0},{from:1,to:2,target:2}],'AB','AXB',0,2),null);
 assert.equal(map([{from:0,to:1,target:1},{from:1,to:2,target:0}],'AB','BA',0,2),null);
});

test('source sync preserves raw formatting for rename, style, move, indent and notes',()=>{
 const write=(sync as any).syncMarkdownDoc;assert.equal(typeof write,'function');
 const source='# Root\r\n\r\n* First  \r\n  note A\r\n* Second\r\n  note B\r\n';
 const doc=parseMarkdownDoc(source,'Note');
 doc.root.children![0].text='Changed';
 let result=write(source,parseMarkdownDoc(source,'Note'),doc,'Note');
 assert.equal(result.text,source.replace('First','Changed'));
 const styled=parseMarkdownDoc(source,'Note');styled.root.children![0].style={fill:'red'};
 assert.equal(write(source,parseMarkdownDoc(source,'Note'),styled,'Note').text,source);
 const moved=parseMarkdownDoc(source,'Note');moved.root.children!.reverse();
 result=write(source,parseMarkdownDoc(source,'Note'),moved,'Note');
 assert.equal(result.text,'# Root\r\n\r\n* Second\r\n  note B\r\n* First  \r\n  note A\r\n');
 const from=source.indexOf('note A');
 const mapped=(sync as any).mapSyncRange(result.spans,from,from+6);
 assert.equal(mapped.from,result.text.indexOf('note A'));
 const note=parseMarkdownDoc(source,'Note');note.root.children![0].note='new note';
 assert.equal(write(source,parseMarkdownDoc(source,'Note'),note,'Note').text,source.replace('note A','new note'));
});

test('legacy generated markers migrate outside Markdown without removing user comments or changing notes',()=>{
 const migrate=(sync as any).migrateMarkdownMetadata;assert.equal(typeof migrate,'function');
 const source='# Root\n\n- First\n  note A\n- Second\n  note B\n\n%%user comment%%\n';
 const doc=parseMarkdownDoc(source,'Note');doc.root.children![0].style={fill:'red',fontSize:28};
 const legacy=writeMarkdownDoc(source,doc,'Note');assert.match(legacy,/%%.*id=wf/);
 const result=migrate(legacy);assert.ok(result);
 assert.doesNotMatch(result.text,/wmind-fusion|%%.*id=wf|%%red/);
 assert.match(result.text,/%%user comment%%/);
 assert.deepEqual(result.doc.root.children[0].style,{fill:'red',fontSize:28});
 const old=legacy.indexOf('note A'),range=(sync as any).mapSyncRange(result.spans,old,old+6);
 assert.equal(range.from,result.text.indexOf('note A'));
 assert.equal(migrate(result.text),null);
 assert.equal(migrate('# Root\n%%red%%\nordinary %%comment%%\n'),null);
});

test('legacy migration leaves marker-like text inside fenced code and ordinary note lines intact',()=>{
 const doc=parseMarkdownDoc('# Root\n\n- A\n- B\n','Note');doc.look='hand';
 const legacy=writeMarkdownDoc('# Root\n\n- A\n- B\n',doc,'Note');
 const source=legacy.replace('- B','  ```\n  %%id=wf2%%\n  ```\n  literal %%id=wf2%%\n- B');
 const result=(sync as any).migrateMarkdownMetadata(source);
 assert.ok(result);assert.match(result.text,/  ```\n  %%id=wf2%%\n  ```\n  literal %%id=wf2%%/);
 assert.equal(parseMarkdownDoc(result.text,'Note').root.children![0].note,parseMarkdownDoc(source,'Note').root.children![0].note);
});

test('external node moves preserve unique node identity before considering positional renames',()=>{
 const source='# Root\n- Parent\n  - A\n- B\n';
 const doc=parseMarkdownDoc(source,'Note'),a=doc.root.children![0].children![0],b=doc.root.children![1];
 a.style={fill:'red'};b.style={fill:'blue'};
 const result=(sync as any).restoreMarkdownMetadata('# Root\n- Parent\n  - B\n- A\n','Note',{source,doc});
 assert.equal(result.root.children[0].children[0].id,b.id);assert.equal(result.root.children[0].children[0].style.fill,'blue');
 assert.equal(result.root.children[1].id,a.id);assert.equal(result.root.children[1].style.fill,'red');
});

test('external content edits preserve the membership of graph-only floating topics',()=>{
 const source='# Root\n- A\n- Free\n',doc=parseMarkdownDoc(source,'Note');
 const free=doc.root.children!.pop()!;free.position={x:30,y:40};doc.floating=[free];
 const result=(sync as any).restoreMarkdownMetadata(source+'- B\n','Note',{source,doc});
 assert.equal(result.floating?.[0].id,free.id);assert.deepEqual(result.floating?.[0].position,{x:30,y:40});
 assert.deepEqual(result.root.children.map((n:any)=>n.text),['A','B']);
});

test('legacy notes using filename as root migrate without inserting a heading',()=>{
 const source='- A\n- B\n',doc=parseMarkdownDoc(source,'Filename');doc.look='hand';
 const legacy=writeMarkdownDoc(source,doc,'Filename');
 const result=(sync as any).migrateMarkdownMetadata(legacy,'Filename');
 assert.ok(result);assert.equal(result.doc.root.text,'Filename');assert.doesNotMatch(result.text,/%%|wmind-fusion|^#/m);
});

test('filename-root notes synchronize their introductory paragraph while preserving frontmatter and spacing',()=>{
 for(const source of ['Intro text\n\n- A\n','---\ncustom: kept\n---\n\nIntro text\n\n- A\n']){
   const before=parseMarkdownDoc(source,'Filename'),doc=structuredClone(before);doc.root.note='Changed intro';
   const result=(sync as any).syncMarkdownDoc(source,before,doc,'Filename');
   assert.equal(result.text,source.replace('Intro text','Changed intro'));
 }
});

test('source sync supports insert, delete and indentation without adding blank lines',()=>{
 const write=(sync as any).syncMarkdownDoc;
 const source='# Root\n- A\n  - Child\n- B\n';
 const before=parseMarkdownDoc(source,'Note'),doc=structuredClone(before);
 const b=doc.root.children!.pop()!;doc.root.children![0].children!.push(b);
 assert.equal(write(source,before,doc,'Note').text,'# Root\n- A\n  - Child\n  - B\n');
 const removed=structuredClone(before);removed.root.children!.shift();
 assert.equal(write(source,before,removed,'Note').text,'# Root\n- B\n');
 const added=structuredClone(before);added.root.children!.push({id:'new',text:'New'});
 assert.equal(write(source,before,added,'Note').text,source+'- New\n');
});
test('moving list topics after heading siblings is represented in plain Markdown in the same order',()=>{
 const source='# Root\n\n- List\n\n## Heading\n';
 let doc=parseMarkdownDoc(source,'Note');const [list,heading]=doc.root.children!;
 doc=moveMany(doc,[list.id],doc.root.id,2);
 const plain=writeMarkdownDoc(source,doc,'Note').replace(/\n?<!-- wmind-fusion:v1 .* -->\s*$/,'');
 assert.deepEqual(parseMarkdownDoc(plain,'Note').root.children!.map(node=>node.text),['Heading','List']);
});
test('unmodified Markdown has stable node IDs for viewport and note-card state',()=>{
 const source='# Root\n\n- A\n  - Leaf\n- B\n';
 const a=parseMarkdownDoc(source,'Note'),b=parseMarkdownDoc(source,'Note');
 assert.equal(a.root.id,b.root.id);assert.equal(a.root.children![0].id,b.root.children![0].id);
 const c=parseMarkdownDoc(source+'- C\n','Note');assert.equal(a.root.children![0].children![0].id,c.root.children![0].children![0].id);
});
import { xmindSheetToMindDoc, parseXmindDocs } from '../../vendor/personal-mindmap/src/fusion/xmind';

test('preserves exact source and Markdown editing with notes and hidden metadata', () => {
 const source = '---\ntheme: classic\nstructure: tree\ncustom: kept\n---\n\n# Root\n\n* First %%red w=240 callout "hi"%%\n\n  details\n\n* Secret %%hide%%\n';
 const doc = parseMarkdownDoc(source, 'File');
 assert.equal(writeMarkdownDoc(source, doc, 'File'), source);
 assert.equal(doc.structure, 'tree');
 assert.equal(doc.root.children?.[0].style?.fill, 'red');
 assert.equal(doc.root.children?.[0].width, 240);
 assert.equal(doc.root.children?.[1].hidden, true);
 doc.root.children![0].text = 'Changed';
 const next = writeMarkdownDoc(source, doc, 'File');
 assert.match(next, /\* Changed/);
 assert.match(next, /custom: kept/);
 assert.match(next, /details/);
 assert.equal(parseMarkdownDoc(next, 'File').root.children![0].text, 'Changed');
});

test('maps sibling ranges, relationships and floating topics', () => {
 const doc = parseMarkdownDoc('# Root\n\n- A %%box=2 "group" summary=2 "sum" rel=b "edge"%%\n- B %%id=b%%\n- Free %%float x=40 y=-30%%\n', 'File');
 const [a,b] = doc.root.children!;
 assert.equal(doc.root.boundaries![0].from, a.id);
 assert.equal(doc.root.boundaries![0].to, b.id);
 assert.equal(doc.root.summaries![0].text, 'sum');
 assert.equal(doc.relationships![0].to, b.id);
 assert.deepEqual(doc.floating![0].position, {x:40,y:-30});
 const next = parseMarkdownDoc(writeMarkdownDoc('', doc, 'File'), 'File');
 assert.equal(next.root.boundaries![0].text, 'group');
 assert.equal(next.relationships![0].text, 'edge');
 assert.equal(next.floating![0].text, 'Free');
});

test('converted summary branches survive Markdown round trips', () => {
  const source = '# Root\n\n- A\n- B\n';
  const doc = parseMarkdownDoc(source, 'File');
  const [a, b] = doc.root.children!;
  const range = addRange(doc, 'summaries', [a.id, b.id], '总括');
  assert.ok(range);
  const result = summaryToBranch(range!.doc, range!.id);
  assert.ok(result);
  const written = writeMarkdownDoc(source, result!.doc, 'File');
  const reloaded = parseMarkdownDoc(written, 'File');
  assert.deepEqual(reloaded.root.children!.map((child: { text: string }) => child.text), ['总括']);
  const branch = reloaded.root.children![0];
  assert.equal(branch.text, '总括');
  assert.deepEqual(branch.children!.map((child: { text: string }) => child.text), ['A', 'B']);
  assert.equal(reloaded.root.summaries, undefined);
});

test('round trips primary styles, IDs and unsupported metadata through a portable extension', () => {
 const doc = parseMarkdownDoc('# Root\n\n- A\n', 'File');
 doc.root.children![0].style = {fill:'#aabbcc', fontSize:27, italic:true, shape:'ellipse'};
 doc.root.children![0].labels = ['tag'];
 doc.root.children![0].link = 'https://example.com';
 doc.root.children![0].custom = {kept:true};
 doc.look = 'hand';
 const next = writeMarkdownDoc('# Root\n\n- A\n', doc, 'File');
 const loaded = parseMarkdownDoc(next, 'File');
 assert.deepEqual(loaded.root.children![0].style, doc.root.children![0].style);
 assert.deepEqual(loaded.root.children![0].custom, {kept:true});
 assert.deepEqual(loaded.root.children![0].labels, ['tag']);
 assert.equal(loaded.root.children![0].id, doc.root.children![0].id);
 assert.equal(loaded.look, 'hand');
 assert.deepEqual(markdownFusionLosses(doc), []);
 assert.equal(writeMarkdownDoc(next, loaded, 'File'), next);
});

test('imports XMind sheet features and reports upstream losses', () => {
 const imported = xmindSheetToMindDoc({title:'Sheet', root:{id:'root',title:'Root',children:[{id:'a',title:'A',children:[]},{id:'b',title:'B',children:[]}]}, relationships:[{from:'a',to:'b',title:'edge'}],lost:{comments:2,detached:0,relationships:0,summaries:0,images:0}});
 assert.equal(imported.title, 'Sheet');
 assert.equal(imported.doc.root.id, 'root');
 assert.equal(imported.doc.root.children![0].id, 'a');
 assert.equal(imported.doc.root.children![0].text, 'A');
 assert.equal(imported.doc.relationships![0].text, 'edge');
 assert.match(imported.warnings.join(' '), /comments.*2|2.*comments/i);
});

test('writes a fresh primary document with its root as a heading', () => {
 const doc = {version:1,root:{id:'root',text:'New root',children:[{id:'child',text:'Child'}]}};
 const loaded = parseMarkdownDoc(writeMarkdownDoc('', doc, 'Filename'), 'Filename');
 assert.equal(loaded.root.text, 'New root');
 assert.equal(loaded.root.children![0].text, 'Child');
});

test('reflects manual Markdown edits after portable metadata was saved', () => {
 const doc = parseMarkdownDoc('# Root\n\n- A %%red%%\n', 'File');
 doc.root.children![0].style = {fill:'red',fontSize:22};
 const written = writeMarkdownDoc('', doc, 'File');
 const loaded = parseMarkdownDoc(written.replace('%%red', '%%blue'), 'File');
 assert.equal(loaded.root.children![0].style!.fill, 'blue');
 assert.equal(loaded.root.children![0].style!.fontSize, 22);
});

test('Markdown remains authoritative for edited markers, ranges, relationships and frontmatter', () => {
 const source = '---\ntheme: classic\nstructure: tree\n---\n# Root\n\n- A %%callout "old" w=200 box=2 "group" rel=b "edge"%%\n- B %%id=b%%\n';
 const doc = parseMarkdownDoc(source, 'File');
 doc.root.style = {fontSize:25};
 const saved = writeMarkdownDoc(source, doc, 'File');
 const edited = saved.replace('theme: classic', 'theme: dark').replace('structure: tree', 'structure: logic').replace('callout "old"', 'callout "new"').replace('w=200', 'w=300').replace('box=2 "group"', 'box=2 "changed"').replace(' rel=b "edge"', '');
 const loaded = parseMarkdownDoc(edited, 'File');
 assert.equal(loaded.theme, 'dark');
 assert.equal(loaded.structure, 'logic');
 assert.equal(loaded.root.children![0].callout, 'new');
 assert.equal(loaded.root.children![0].width, 300);
 assert.equal(loaded.root.boundaries![0].text, 'changed');
 assert.equal(loaded.root.boundaries![0].from, loaded.root.children![0].id);
 assert.equal(loaded.relationships?.length ?? 0, 0);
});

test('preserves malformed extension comments as document content', () => {
 const source = '# Root\n\n- A\n<!-- wmind-fusion:v1 %not-valid -->\n';
 const doc = parseMarkdownDoc(source, 'File');
 doc.root.text = 'Changed';
 assert.match(writeMarkdownDoc(source, doc, 'File'), /%not-valid/);
});

test('portable extension retains overlapping ranges and advanced relationship controls', () => {
 const doc = parseMarkdownDoc('# Root\n\n- A\n- B\n', 'File');
 const [a,b] = doc.root.children!;
 doc.root.boundaries = [{id:'one',from:a.id,to:b.id,text:'outer',style:{fill:'pink'}},{id:'two',from:a.id,to:a.id,text:'inner'}];
 doc.relationships = [{id:'relation',from:a.id,to:b.id,text:'Quoted "label" %%',controls:[{x:4,y:5},{x:6,y:7}],style:{lineStyle:'dashed'}}];
 const loaded = parseMarkdownDoc(writeMarkdownDoc('',doc,'File'),'File');
 assert.deepEqual(loaded.root.boundaries, doc.root.boundaries);
 assert.deepEqual(loaded.relationships, doc.relationships);
});


test('uses stable source anchors when Markdown siblings are reordered or inserted', () => {
 const doc = parseMarkdownDoc('# Root\n\n- A\n- B\n', 'File');
 doc.root.children![0].style = {fontSize:37};
 const written = writeMarkdownDoc('', doc, 'File');
 const lines = written.split('\n');
 const a = lines.findIndex(line => /^- A/.test(line)), b = lines.findIndex(line => /^- B/.test(line));
 [lines[a], lines[b]] = [lines[b], lines[a]];
 lines.splice(a, 0, '- New');
 const loaded = parseMarkdownDoc(lines.join('\n'), 'File');
 assert.equal(loaded.root.children!.find(n => n.text === 'A')?.style?.fontSize, 37);
 assert.equal(loaded.root.children!.find(n => n.text === 'B')?.style?.fontSize, undefined);
 assert.equal(loaded.root.children!.find(n => n.text === 'New')?.style?.fontSize, undefined);
});

test('maps and writes gogoga frontmatter conventions', () => {
 const source = '---\nmindmap-theme: ocean\nmindmap-structure: logic-right\n---\n# Root\n';
 const doc = parseMarkdownDoc(source, 'File');
 assert.equal(doc.theme, 'ocean');
 assert.equal(doc.structure, 'logic');
 doc.structure = 'org';
 assert.match(writeMarkdownDoc(source, doc, 'File'), /mindmap-structure: org-down/);
});



test('imports every sheet from an XMind ZIP and rejects malformed archives', async () => {
 const content = Buffer.from(JSON.stringify([{title:'First',rootTopic:{id:'r1',title:'One'}},{title:'Second',rootTopic:{id:'r2',title:'Two'}}]));
 const name = Buffer.from('content.json');
 let crc = 0xffffffff;
 for (const byte of content) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
 crc = (crc ^ 0xffffffff) >>> 0;
 const local = Buffer.alloc(30);
 local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt32LE(crc,14); local.writeUInt32LE(content.length,18); local.writeUInt32LE(content.length,22); local.writeUInt16LE(name.length,26);
 const central = Buffer.alloc(46);
 central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt32LE(crc,16); central.writeUInt32LE(content.length,20); central.writeUInt32LE(content.length,24); central.writeUInt16LE(name.length,28);
 const end = Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+name.length,12); end.writeUInt32LE(local.length+name.length+content.length,16);
 const zip = Buffer.concat([local,name,content,central,name,end]);
 const sheets = await parseXmindDocs(zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength) as ArrayBuffer);
 assert.deepEqual(sheets.map(s => s.title), ['First','Second']);
 assert.deepEqual(sheets.map(s => s.doc.root.text), ['One','Two']);
 await assert.rejects(parseXmindDocs(new ArrayBuffer(0)));
});

test('rejects ambiguous source matching and reports recoverable metadata instead of applying wrong styles', () => {
 const doc = parseMarkdownDoc('# Root\n\n- Same\n- Same\n', 'File');
 doc.root.children![0].style = {fontSize:33};
 const written = writeMarkdownDoc('',doc,'File');
 const loaded = parseMarkdownDoc(written.replace(/ %%id=wf\d+%%/g,''),'File');
 assert.equal(loaded.root.children![0].style?.fontSize, undefined);
 assert.equal(loaded.root.children![1].style?.fontSize, undefined);
 assert.ok(loaded.fusionRecovery);
 assert.ok(markdownFusionLosses(loaded).length > 0);
});

test('bridges built-in gogoga theme names without colliding with primary themes',()=>{
 const source='---\nmindmap-theme: snow\n---\n# Root\n';
 const doc=parseMarkdownDoc(source,'File');
 assert.equal(doc.theme,'gogoga-snow');
 doc.theme='gogoga-forest';
 assert.match(writeMarkdownDoc(source,doc,'File'),/mindmap-theme: forest/);
});

test('embedded block writes reject stale source even when fence positions match',async()=>{
 const {locateBlock}=await import('../../vendor/personal-mindmap/vendor/gogoga/src/codeblock');
 assert.equal(locateBlock('```mindmap\n# External\n```\n',{lineStart:0,lineEnd:2},'# Original'),null);
 assert.deepEqual(locateBlock('intro\n```mindmap\n# Original\n```\n',{lineStart:0,lineEnd:2},'# Original'),{lineStart:1,lineEnd:3});
});

test('external topic rename preserves overlapping portable ranges and parallel relation identities',()=>{
 const doc=parseMarkdownDoc('# Root\n\n- A\n- B\n','File');
 const [a,b]=doc.root.children!;
 doc.root.boundaries=[{id:'outer',from:a.id,to:b.id,text:'outer',style:{fill:'pink'}},{id:'inner',from:a.id,to:a.id,text:'inner',style:{fill:'blue'}}];
 doc.relationships=[{id:'red',from:a.id,to:b.id,text:'edge1',style:{lineColor:'red'}},{id:'blue',from:a.id,to:b.id,text:'edge2',style:{lineColor:'blue'}}];
 const written=writeMarkdownDoc('',doc,'File');
 const loaded=parseMarkdownDoc(written.replace('# Root','# Renamed'),'File');
 assert.equal(loaded.root.text,'Renamed');
 assert.deepEqual(loaded.root.boundaries,doc.root.boundaries);
 assert.deepEqual(loaded.relationships,doc.relationships);
 assert.deepEqual(markdownFusionLosses(loaded),[]);
});

test('native relation and range edits remain authoritative without misassigning parallel styles',()=>{
 const doc=parseMarkdownDoc('# Root\n\n- A\n- B\n','File');const [a,b]=doc.root.children!;
 doc.root.boundaries=[{id:'outer',from:a.id,to:b.id,text:'outer'},{id:'inner',from:a.id,to:a.id,text:'inner'}];
 doc.relationships=[{id:'red',from:a.id,to:b.id,text:'edge1',style:{lineColor:'red'}},{id:'blue',from:a.id,to:b.id,text:'edge2',style:{lineColor:'blue'}}];
 const written=writeMarkdownDoc('',doc,'File');
 const loaded=parseMarkdownDoc(written.replace('"edge1"','"changed"').replace('box "inner"','box "edited"'),'File');
 assert.equal(loaded.root.boundaries![0].text,'edited');
 assert.equal(loaded.relationships!.find(r=>r.id==='red')?.text,'changed');
 assert.equal(loaded.relationships!.find(r=>r.id==='blue')?.style?.lineColor,'blue');
 assert.equal(new Set(loaded.relationships!.map(r=>r.id)).size,2);
 assert.ok(markdownFusionLosses(loaded).length>0);
 assert.ok(loaded.fusionRecovery);
});

test('converts every sibling at a primary Markdown level and preserves portable metadata',async()=>{
 const {convertPrimaryLevelKind}=await import('../../vendor/personal-mindmap/src/fusion/markdown');
 const source='# Root\n\n## A\n\n### Nested\n\n## B\n';
 const doc=parseMarkdownDoc(source,'File');doc.root.children![0].style={fontSize:30};
 const converted=convertPrimaryLevelKind(doc,doc.root.children![0].id,'list');
 assert.notEqual(converted,doc);
 assert.equal((doc.root.children![0].markdown as any).kind,'heading');
 assert.equal((converted.root.children![0].markdown as any).kind,'list');
 assert.equal((converted.root.children![1].markdown as any).kind,'list');
 assert.equal((converted.root.children![0].children![0].markdown as any).kind,'list');
 const written=writeMarkdownDoc(source,converted,'File');
 assert.match(written,/- A/);assert.match(written,/- B/);assert.doesNotMatch(written,/## A/);
 assert.equal(parseMarkdownDoc(written,'File').root.children![0].style?.fontSize,30);
 assert.equal(convertPrimaryLevelKind(doc,doc.root.id,'list'),doc);
});
