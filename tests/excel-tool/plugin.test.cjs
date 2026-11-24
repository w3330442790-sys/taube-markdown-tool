const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const cache={},notices=[],document={querySelectorAll:()=>[]};
 const api={Plugin:class{},MarkdownView:class{},Notice:class{constructor(t){notices.push(t)}},setIcon(){},Modal:class{},Menu:class{}};
 const load=name=>{const file=path.resolve(__dirname,'../../vendor/excel-tool/src',name);if(cache[file])return cache[file].exports;
  const module={exports:{}};cache[file]=module;
  const require=id=>id==='obsidian'?api:id.startsWith('./')?load(id.slice(2)):id==='@codemirror/state'?{StateEffect:{define:()=>({of:x=>x})}}:id==='@codemirror/commands'?{invertedEffects:{of:x=>x}}:id==='@codemirror/view'?{EditorView:{updateListener:{of:x=>x}}}:null;
  vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{console,document,requestAnimationFrame:f=>f(),setTimeout:()=>0,clearTimeout,Map,Set})(require,module,module.exports);return module.exports;};
 let P;try{P=load('plugin.cjs')}catch(e){if(e.code!=='ENOENT')throw e;P=class{};}
 const p=new P();for(const name of ['widths','rowHeights','merges','tableDims','alignments','cellStyles','tableOptions'])p[name]={};
 p._savedData={customFuture:{keep:true}};p.saveData=data=>{p.saved=data};p.currentPath=()=> 'note.md';p.activeEditor=()=>null;p.registerEditorExtension=()=>{};
 return {p,notices};
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('table mapping reuses the same long document and refreshes after a source edit',()=>{
 const {p}=fixture();let reads=0;
 const lines=Array.from({length:20661},()=> '复习内容');
 for(let i=0;i<58;i++)lines.splice(i*300,3,'| 名称 | 要点 |','| --- | --- |','| 项目 | 说明 |');
 const makeDoc=()=>({lines:lines.length,line:n=>{reads++;return{text:lines[n-1]};}});
 const editor={getDoc:()=>editor,cm:{state:{doc:makeDoc()},posAtDOM:()=>0}};
 const cells=['名称','要点'].map(textContent=>({textContent}));
 const table={rows:[{},{}],querySelector:()=>cells[0],querySelectorAll:()=>cells};
 p.tablePeers=()=>[table];
 a.equal(p.tableSourceInfo(editor,table).startLine,0);
 const firstReads=reads;
 for(let i=0;i<15;i++)a.equal(p.tableSourceInfo(editor,table).startLine,0);
 a.ok(reads-firstReads<100, `unchanged source read ${reads-firstReads} lines`);
 lines[2]='| 新条目 | 说明 |';editor.cm.state.doc=makeDoc();
 a.equal(p.tableSourceInfo(editor,table).grid[1][0],'新条目');
});
test('a first resize never overwrites another table sharing its legacy width key',()=>{
 const {p}=fixture(),table={dataset:{},isConnected:true};
 p.app={workspace:{}};
 const editor={replaceRange(){}};
 p.activeEditor=()=>editor;p.tableId=()=> 'legacy';
 p.tableSourceInfo=()=>({uid:null,markerLine:-1,header:'| A | B |',from:0,toPos:i=>i});
 p.widths={'note.md':{legacy:['100px','120px']}};
 const tid=p.commitColumnWidths(table,'note.md',['150px','120px']);
 a.deepEqual(plain(p.widths['note.md'].legacy),['100px','120px']);
 a.deepEqual(plain(p.widths['note.md'][tid]),['150px','120px']);
});
test('resizing a copy gives it its own source identity and keeps the original widths',()=>{
 const {p}=fixture(),table={dataset:{},isConnected:true};
 const marker=p.encodeInvisibleUid('shared');
 let change;
 p.app={workspace:{}};
 p.activeEditor=()=>({replaceRange:(text,from,to)=>{change={text,from,to};}});
 p.tableId=()=> 'ushared';
 p.tableSourceInfo=()=>({uid:'shared',sharedUid:true,header:'| '+marker+'标题 |',from:10,toPos:i=>i});
 p.widths={'note.md':{ushared:['100px']}};
 const tid=p.commitColumnWidths(table,'note.md',['150px']);
 a.notEqual(tid,'ushared');
 a.deepEqual(plain(p.widths['note.md']),{ushared:['100px'],[tid]:['150px']});
 a.deepEqual(change,{text:p.encodeInvisibleUid(tid.slice(1)),from:12,to:12+marker.length});
});
test('split panes resolve table settings to their owning note',()=>{
 const {p}=fixture(),table={dataset:{}};
 p.app={workspace:{getActiveFile:()=>({path:'active.md'}),getLeavesOfType:()=>[
  {view:{file:{path:'active.md'},contentEl:{contains:()=>false}}},
  {view:{file:{path:'other.md'},contentEl:{contains:node=>node===table}}}
 ]}};
 a.equal(p.tableNotePath(table),'other.md');
});
test('persist preserves unknown data and legacy table layout',async()=>{
 const {p}=fixture();p.widths={'note.md':{t:['100px','200px']}};p.merges={'note.md':{t:[{r:1,c:0,rowspan:1,colspan:2}]}};
 a.equal(typeof p.persist,'function');await p.persist();a.deepEqual(plain(p.saved.customFuture),{keep:true});a.deepEqual(plain(p.saved.widths),p.widths);a.deepEqual(plain(p.saved.merges),p.merges);
});
test('stable ID adoption retains styles and fixed options',()=>{
 const {p}=fixture(),table={rows:[{cells:[{textContent:'x'}]}]};p.cellStyles={'note.md':{old:{'0,0':{bg:'blue'}}}};p.tableOptions={'note.md':{old:{freezeFirst:true}}};
 a.equal(typeof p.adoptStableTableId,'function');p.adoptStableTableId(table,'note.md','old','unew');
 a.deepEqual(plain(p.cellStyles['note.md'].unew),{'0,0':{bg:'blue'}});a.deepEqual(plain(p.tableOptions['note.md'].unew),{freezeFirst:true});
});
test('native history snapshots include both new stores',()=>{
 const {p}=fixture();a.equal(typeof p.historySnapshot,'function');p._historyApi={invertedEffects:{}};p._historyInverse=()=>{};
 const editor={cm:{state:{facet:()=>[p._historyInverse]}}};p.activeEditor=()=>editor;p.cellStyles={'note.md':{t:{'0,0':{marked:true}}}};
 const snap=p.historySnapshot();a.deepEqual(plain(snap.data.cellStyles),p.cellStyles['note.md']);a.deepEqual(plain(snap.data.tableOptions),{});
});
test('frozen-boundary merge cancels before source rewrite',()=>{
 const {p,notices}=fixture();p.tableOptions={'note.md':{t:{freezeFirst:true}}};p._sel={path:'note.md',tid:'t',r1:1,r2:1,c1:0,c2:1};
 a.equal(typeof p.mergeSelectedCells,'function');p.mergeSelectedCells();a.ok(notices.some(t=>/固定/.test(t)));
});
test('new options default empty and do not change old table settings',()=>{
 const {p}=fixture();a.equal(typeof p.optionsFor,'function');a.deepEqual(plain(p.optionsFor('note.md','t')),{});a.deepEqual(p.tableOptions,{});
});
test('native dimension changes move styles without changing options',()=>{
 const {p}=fixture();p.tableDims={'note.md':{t:{rows:2,cols:2}}};p.cellStyles={'note.md':{t:{'1,1':{bg:'blue'}}}};p.tableOptions={'note.md':{t:{freezeFirst:true}}};
 p.dimensionChangeIndex=()=>1;a.equal(typeof p.reconcileTableDimensions,'function');
 p.reconcileTableDimensions({rows:[{}, {}, {}]},'note.md','t',2);
 a.deepEqual(plain(p.cellStyles['note.md'].t),{'2,1':{bg:'blue'}});a.equal(p.tableOptions['note.md'].t.freezeFirst,true);
});
module.exports={fixture};
test('merging styles changes only the actual table ID',()=>{
 const {p}=fixture();p.cellStyles={'note.md':{a:{'0,0':{bg:'blue'},'0,1':{bg:'pink'}},b:{'0,1':{bg:'yellow'}}}};
 a.equal(p.setMerge('note.md','a',{r:0,c:0,rowspan:1,colspan:2}),true);
 a.deepEqual(plain(p.cellStyles['note.md'].a),{'0,0':{bg:'blue'}});a.deepEqual(plain(p.cellStyles['note.md'].b),{'0,1':{bg:'yellow'}});
});
test('first option on legacy table uses final UID during batched source insertion',()=>{
 const {p}=fixture(),table={dataset:{},isConnected:true,closest:()=>({})},editor={};
 p.app={workspace:{}};p.activeEditor=()=>editor;p.tableId=()=> 'legacy';p.tableSourceInfo=()=>({uid:null,header:'| a | b |',from:0,toPos:i=>i});
 p.replaceTableRange=()=>{};p.currentWidths=()=>['100px','200px'];p.targetSelection=()=>({table,path:'note.md',tid:'legacy',r1:0,c1:0,r2:0,c2:0});p.effectiveMerges=()=>[];p.runTableHistory=run=>run();p.reflowTable=()=>{};p.refreshMergeToolbar=()=>{};
 p.toggleFreeze('freezeFirst');const keys=Object.keys(p.tableOptions['note.md']);a.equal(keys.length,1);a.match(keys[0],/^um/);a.equal(p.tableOptions['note.md'][keys[0]].freezeFirst,true);
});
