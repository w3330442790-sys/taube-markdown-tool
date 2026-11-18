const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
let source = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8').replace(/from (["'])\.\//g, 'from $1../src/').replace(/from (["'])\.\.\/vendor\/personal-mindmap\/src\/obsidian\/main\1/g, "from '../tests/mindmap-base-stub'");
fs.writeFileSync(path.join(root, 'artifacts/main-test.ts'), source + '\nexport { SideNoteView, CommentModal };\n');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'ui-entry.ts')], bundle: true, outfile: path.join(root, 'artifacts/ui.bundle.js'), platform: 'browser', external: ['buffer'], alias: { obsidian: path.join(__dirname, 'obsidian-mock.ts') }, logLevel: 'warning' });
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><meta charset="utf-8"><style>:root {--background-primary:#fff;--background-secondary:#f4f4f4;--text-normal:#222;--text-muted:#666;--text-faint:#888;--background-modifier-border:#ddd;--interactive-accent:#5865f2;--text-on-accent:#fff;--font-ui:Arial}*{box-sizing:border-box}body{margin:0;font-family:Arial}button,select{padding:6px;border:1px solid #ccc;border-radius:6px}button:disabled{opacity:.4}.sidenote-view-container{width:320px;height:100vh}.modal-container{position:fixed;inset:10%;background:white;z-index:20000;padding:20px;border:1px solid #aaa;overflow:auto}</style><style>' + css + '</style><script>' + fs.readFileSync(path.join(root, 'artifacts/ui.bundle.js'), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };
  const reset = async (mobile = false) => { await page.evaluate(mobile => { window.failWrite = false; localStorage.clear(); return window.setup(mobile); }, mobile); await page.locator('.sidenote-comment-item').first().waitFor(); };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.setup); await reset();
    await check('bidirectional source sync keeps duplicate annotations through moves, rename, style and legacy cleanup',async()=>{
      const result=await page.evaluate(async()=>{
        const api=window.markdownSync,plugin=window.plugin;
        let source='# Root\n\n- Same\n  note A\n- Same\n  note B\n';
        plugin.getEditorTextForFile=()=>source;
        const first=source.indexOf('Same'),second=source.lastIndexOf('Same');
        plugin.comments=[{...plugin.comments[0],selectedText:'Same',absoluteFrom:first,absoluteTo:first+4,isOrphaned:false},{...plugin.comments[1],selectedText:'Same',absoluteFrom:second,absoluteTo:second+4,isOrphaned:false}];
        plugin.commentManager.updateComments(plugin.comments);
        let doc=api.parseMarkdownDoc(source,'note'),changed=structuredClone(doc);changed.root.children.reverse();
        let next=api.syncMarkdownDoc(source,doc,changed,'note');
        await plugin.commitMarkdownSync('note.md',source,next.text,next.spans,async()=>{source=next.text;});
        const moved=plugin.comments.map(c=>({from:c.absoluteFrom,body:c.comment,orphaned:c.isOrphaned}));
        const expectedMoved=[source.lastIndexOf('Same'),source.indexOf('Same')];
        doc=next.doc;changed=structuredClone(doc);changed.root.children[0].text='Renamed';
        next=api.syncMarkdownDoc(source,doc,changed,'note');
        await plugin.commitMarkdownSync('note.md',source,next.text,next.spans,async()=>{source=next.text;});
        const body=plugin.comments[1].comment;
        const legacy=api.writeMarkdownDoc(source,{...next.doc,look:'hand'},'note');
        const cleanup=api.migrateMarkdownMetadata(legacy);
        source=legacy;plugin.comments=[{...plugin.comments[0],selectedText:'note A',absoluteFrom:legacy.indexOf('note A'),absoluteTo:legacy.indexOf('note A')+6,isOrphaned:false}];plugin.commentManager.updateComments(plugin.comments);
        await plugin.commitMarkdownSync('note.md',legacy,cleanup.text,cleanup.spans,async()=>{source=cleanup.text;});
        const comment=plugin.comments[0];
        await plugin.commentManager.updateCommentCoordinatesForFile(source,'note.md');
        return {moved,expectedMoved,body,clean:!source.includes('%%')&&!source.includes('wmind-fusion'),from:comment.absoluteFrom,expectedFrom:source.indexOf('note A'),orphaned:comment.isOrphaned};
      });
      assert.deepEqual(result.moved.map(c=>c.from),result.expectedMoved);
      assert.equal(result.moved.every(c=>c.orphaned===false),true);
      assert.equal(result.moved[0].body,'批注1');assert.equal(result.body,'批注2');
      assert.equal(result.clean,true);assert.equal(result.from,result.expectedFrom);assert.equal(result.orphaned,false);await reset();
    });
    await check('revalidation uses unsaved editor text rather than stale disk coordinates',async()=>{
      const result=await page.evaluate(async()=>{
        const plugin=window.plugin;
        const current='prefix\n'+window.noteText;
        plugin.getEditorTextForFile=()=>current;
        await plugin.revalidateCommentsForFile('note.md');
        return {from:plugin.comments[0].absoluteFrom,expected:current.indexOf('甲方证'),orphaned:plugin.comments[0].isOrphaned};
      });
      assert.equal(result.from,result.expected);assert.equal(result.orphaned,false);await reset();
    });
    await check('delayed disk reads cannot overwrite newer proven duplicate-quote anchors',async()=>{
      const result=await page.evaluate(async()=>{
        const plugin=window.plugin,before='# A\n- same\n# B\n- same\n';let source=before;
        plugin.getEditorTextForFile=()=>source;
        const from=before.indexOf('same');
        plugin.comments=[{...plugin.comments[0],selectedText:'same',absoluteFrom:from,absoluteTo:from+4,headingPath:['A'],contextBefore:undefined,contextAfter:undefined,isOrphaned:false}];plugin.commentManager.updateComments(plugin.comments);
        let release,started;const gate=new Promise(r=>release=r),reading=new Promise(r=>started=r);
        plugin.app.vault.read=async()=>{started();await gate;return before;};
        const task=plugin.revalidateCommentsForFile('note.md');await reading;
        const changes=window.ChangeSet.of([{from:2,to:3,insert:'B'},{from:13,to:14,insert:'A'}],before.length);
        source='# B\n- same\n# A\n- same\n';
        window.mapCommentChange(plugin.comments[0],before,source,changes);plugin.comments[0].headingPath=['B'];
        release();await task;return {from:plugin.comments[0].absoluteFrom,orphaned:plugin.comments[0].isOrphaned};
      });
      assert.equal(result.from,6);assert.equal(result.orphaned,false);await reset();
    });
    await check('failed validation persistence cannot roll back a newer live editor anchor',async()=>{
      const result=await page.evaluate(async()=>{
        const plugin=window.plugin,before='# A\n- same\n# B\n- same\n';let source=before;
        plugin.getEditorTextForFile=()=>source;
        const from=before.indexOf('same');plugin.comments=[{...plugin.comments[0],selectedText:'same',absoluteFrom:from,absoluteTo:from+4,headingPath:['A'],contextBefore:undefined,contextAfter:undefined,isOrphaned:false}];plugin.commentManager.updateComments(plugin.comments);
        plugin.pendingAnchorSaves.add('note.md');
        let release,started;const gate=new Promise(r=>release=r),saving=new Promise(r=>started=r);
        plugin.saveCommentsForSingleFile=async()=>{started();await gate;throw Error('disk');};
        const task=plugin.revalidateCommentsForFile('note.md').catch(()=>{});await saving;
        const changes=window.ChangeSet.of([{from:2,to:3,insert:'B'},{from:13,to:14,insert:'A'}],before.length);
        source='# B\n- same\n# A\n- same\n';window.mapCommentChange(plugin.comments[0],before,source,changes);plugin.comments[0].headingPath=['B'];
        release();await task;
        plugin.saveCommentsForSingleFile=async()=>{};await plugin.revalidateCommentsForFile('note.md');
        return {from:plugin.comments[0].absoluteFrom,heading:plugin.comments[0].headingPath,orphaned:plugin.comments[0].isOrphaned};
      });
      assert.equal(result.from,6);assert.deepEqual(result.heading,['B']);assert.equal(result.orphaned,false);await reset();
    });
    await check('orphan warnings are transient and deduplicated while annotation content stays available', async () => {
      await page.evaluate(() => {
        const orphan=window.plugin.comments[2];
        window.plugin.showOrphanNotice([orphan,orphan]);
        window.plugin.showOrphanNotice([orphan]);
      });
      const notices=await page.evaluate(()=>window.noticeRecords);
      assert.equal(notices.length,1);
      assert.equal(notices[0].timeout,5000);
      assert.match(notices[0].text,/内容已保留/);
      assert.equal(await page.locator('.sidenote-orphan-label').count(),0);
      assert.equal(await page.locator('.sidenote-orphan-indicator').count(),1);
      assert.equal(await page.locator('.sidenote-comment-item').count(),4);
      assert.equal(await page.evaluate(()=>window.plugin.comments[2].isOrphaned),true);
      await reset();
    });
    await check('failed deletion restores the exact annotation and can be retried', async () => {
      const result=await page.evaluate(async()=>{
        const before=JSON.stringify(window.plugin.comments);window.failWrite=true;let rejected=false;
        try{await window.plugin.deleteComment(1);}catch{rejected=true;}
        const unchanged=JSON.stringify(window.plugin.comments)===before;
        window.failWrite=false;await window.plugin.deleteComment(1);
        return {rejected,unchanged,remaining:window.plugin.comments.map(c=>c.timestamp)};
      });
      assert.equal(result.rejected,true);assert.equal(result.unchanged,true);assert.deepEqual(result.remaining,[2,3,4]);await reset();
    });
    await check('failed orphan repair restores anchors and reports no false success',async()=>{
      const result=await page.evaluate(async()=>{
        const target=window.plugin.comments[2];target.selectedText='新选原文';target.absoluteFrom=0;target.absoluteTo=0;
        const before=JSON.stringify(target);window.failWrite=true;
        await window.plugin.repairOrphanedComments();
        const unchanged=JSON.stringify(target)===before;
        const failedNotice=window.noticeRecords.at(-1).text;
        window.failWrite=false;await window.plugin.repairOrphanedComments();
        return {unchanged,failedNotice,repaired:!target.isOrphaned};
      });
      assert.equal(result.unchanged,true);assert.match(result.failedNotice,/保存失败/);assert.equal(result.repaired,true);await reset();
    });
    await check('folder moves migrate annotation paths without changing similarly prefixed folders',async()=>{
      const result=await page.evaluate(async()=>{
        window.plugin.comments[0].filePath='A/note.md';window.plugin.comments[1].filePath='A/sub/note.md';window.plugin.comments[2].filePath='AB/note.md';
        await window.plugin.handleNoteRename('A','B');
        return window.plugin.comments.map(c=>c.filePath);
      });
      assert.deepEqual(result,['B/note.md','B/sub/note.md','AB/note.md','note.md']);await reset();
    });
    await check('automatic revalidation restores unique text during a settings save and retries transient failures',async()=>{
      await page.evaluate(async()=>{
        const target=window.plugin.comments[2];target.selectedText='新选原文';target.absoluteFrom=0;target.absoluteTo=0;
        window.plugin.isSaving=true;window.failWrite=true;window.plugin.scheduleAnchorCheck('note.md');
        await window.plugin.flushAnchorChecks();
      });
      assert.equal(await page.evaluate(()=>window.plugin.comments[2].isOrphaned),true);
      await page.evaluate(()=>{window.failWrite=false;window.plugin.isSaving=false;});
      await page.waitForFunction(()=>window.plugin.comments[2].isOrphaned===false);
      assert.equal(await page.evaluate(()=>window.plugin.comments[2].absoluteFrom),await page.evaluate(()=>window.noteText.indexOf('新选原文')));
      await reset();
    });
    await check('shared legacy filenames migrate into independent recoverable files',async()=>{
      const result=await page.evaluate(async()=>{
        const a={...window.plugin.comments[0],filePath:'A/B.md',comment:'first'};
        const b={...window.plugin.comments[1],filePath:'A__B.md',comment:'second'};
        window.files.set('side-note-data/A__B.json',JSON.stringify([a,b]));
        window.plugin.comments=await window.plugin.loadAllCommentsFromFiles();window.plugin.commentManager.updateComments(window.plugin.comments);
        await window.plugin.saveAllCommentFiles();
        const paths=[window.plugin.getCommentsJsonPath(a.filePath),window.plugin.getCommentsJsonPath(b.filePath)];
        return {paths,values:paths.map(p=>JSON.parse(window.files.get(p)).map(c=>c.comment)),legacy:window.files.has('side-note-data/A__B.json')};
      });
      assert.notEqual(result.paths[0],result.paths[1]);assert.deepEqual(result.values,[['first'],['second']]);assert.equal(result.legacy,false);await reset();
    });
    await check('external annotation updates cannot be overwritten by a stale edit',async()=>{
      const result=await page.evaluate(async()=>{
        await window.plugin.saveAllCommentFiles();const path=window.plugin.getCommentsJsonPath('note.md');
        const remote=JSON.parse(window.files.get(path));remote[0].comment='另一设备的新内容';window.files.set(path,JSON.stringify(remote));
        let rejected=false;try{await window.plugin.editComment(1,'过期内容');}catch{rejected=true;}
        const preserved=JSON.parse(window.files.get(path))[0].comment;
        await window.plugin.refreshCommentData();
        if(window.plugin.anchorCheckTimer!==null){clearTimeout(window.plugin.anchorCheckTimer);window.plugin.anchorCheckTimer=null;window.plugin.pendingAnchorChecks.clear();}
        if(window.plugin.commentDataReloadTimer!==null){clearTimeout(window.plugin.commentDataReloadTimer);window.plugin.commentDataReloadTimer=null;}
        return {rejected,preserved,current:window.plugin.comments[0].comment};
      });
      assert.deepEqual(result,{rejected:true,preserved:'另一设备的新内容',current:'另一设备的新内容'});await reset();
    });
    await check('resolved or removed pending orphans are never warned about later',async()=>{
      await page.evaluate(()=>{
        const target=window.plugin.comments[2];window.plugin.queueOrphanNotice([target]);target.isOrphaned=false;
      });
      await page.waitForTimeout(2150);
      assert.equal(await page.evaluate(()=>window.noticeRecords.length),0);
      assert.equal(await page.evaluate(()=>window.plugin.orphanNoticeTimer),null);await reset();
    });
    await check('an old edit window cannot overwrite a synchronized newer annotation',async()=>{
      await page.evaluate(async()=>{await window.plugin.saveAllCommentFiles();window.openEdit();});
      await page.locator('.sidenote-modal-textarea').fill('本地未保存草稿');
      await page.evaluate(async()=>{
        const path=window.plugin.getCommentsJsonPath('note.md'),remote=JSON.parse(window.files.get(path));
        remote[0].comment='已同步的新版本';window.files.set(path,JSON.stringify(remote));await window.plugin.refreshCommentData();
      });
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.sidenote-save-status')?.textContent.includes('已有新版本'));
      assert.equal(await page.locator('.sidenote-modal-textarea').inputValue(),'本地未保存草稿');
      assert.equal(await page.evaluate(()=>window.plugin.comments[0].comment),'已同步的新版本');
      assert.equal(await page.evaluate(()=>window.plugin.drafts.list()[0].commentText),'本地未保存草稿');
      await page.getByLabel('关闭批注窗口',{exact:true}).click();await reset();
    });
    await check('temporarily unreadable owned storage never removes in-memory annotations',async()=>{
      const result=await page.evaluate(async()=>{
        await window.plugin.saveAllCommentFiles();const path=window.plugin.getCommentsJsonPath('note.md');
        const before=JSON.stringify(window.plugin.comments),valid=window.files.get(path);window.files.set(path,'{');
        let rejected=false;try{await window.plugin.refreshCommentData();}catch{rejected=true;}
        const preserved=JSON.stringify(window.plugin.comments)===before;
        window.files.set(path,valid);await window.plugin.refreshCommentData();
        return {rejected,preserved,total:window.plugin.comments.length};
      });
      assert.deepEqual(result,{rejected:true,preserved:true,total:4});await reset();
    });
    await check('failed note rename retries automatically after the vault has already moved it',async()=>{
      await page.evaluate(async()=>{
        const note=window.plugin.app.vault.getAbstractFileByPath('note.md');note.path='renamed.md';
        window.plugin.app.vault.getAbstractFileByPath=path=>path==='renamed.md'?note:null;
        window.failWrite=true;try{await window.plugin.handleNoteRename('note.md','renamed.md');}catch{}
      });
      assert.equal(await page.evaluate(()=>window.plugin.comments[0].filePath),'note.md');
      await page.evaluate(()=>window.failWrite=false);
      await page.waitForFunction(()=>window.plugin.comments.every(c=>c.filePath==='renamed.md'));
      assert.equal(await page.evaluate(()=>window.plugin.pendingNoteRenames.size),0);await reset();
    });
    await check('a partial multi-file refresh never advances any disk baseline',async()=>{
      const result=await page.evaluate(async()=>{
        window.plugin.comments[0].filePath='first.md';window.plugin.comments[1].filePath='second.md';
        await window.plugin.saveAllCommentFiles();
        const a=window.plugin.getCommentsJsonPath('first.md'),b=window.plugin.getCommentsJsonPath('second.md');
        const remote=JSON.parse(window.files.get(a));remote[0].comment='远端新版本';window.files.set(a,JSON.stringify(remote));window.files.set(b,'{');
        let refreshRejected=false,editRejected=false;
        try{await window.plugin.refreshCommentData();}catch{refreshRejected=true;}
        try{await window.plugin.editComment(1,'旧基线覆盖');}catch{editRejected=true;}
        return {refreshRejected,editRejected,preserved:JSON.parse(window.files.get(a))[0].comment};
      });
      assert.deepEqual(result,{refreshRejected:true,editRejected:true,preserved:'远端新版本'});await reset();
    });
    await check('moving an old parent folder never captures a note already moved by a pending rename',async()=>{
      const paths=await page.evaluate(async()=>{
        window.plugin.comments[0].filePath='A/note.md';window.plugin.comments[1].filePath='A/other.md';
        window.failWrite=true;try{await window.plugin.handleNoteRename('A/note.md','B/note.md');}catch{}
        window.failWrite=false;await window.plugin.handleNoteRename('A','C');await window.plugin.retryPendingNoteRenames();
        return window.plugin.comments.slice(0,2).map(c=>c.filePath);
      });
      assert.deepEqual(paths,['B/note.md','C/other.md']);await reset();
    });
    await check('batch orphan deletion restores content on storage failure',async()=>{
      const result=await page.evaluate(async()=>{
        const before=JSON.stringify(window.plugin.comments);window.failWrite=true;let rejected=false;
        try{await window.plugin.deleteOrphanedComments();}catch{rejected=true;}
        window.failWrite=false;return {rejected,preserved:JSON.stringify(window.plugin.comments)===before};
      });
      assert.deepEqual(result,{rejected:true,preserved:true});await reset();
    });
    await check('persisted rename intents survive an initially unavailable annotation library',async()=>{
      await page.evaluate(async()=>{
        await window.plugin.saveAllCommentFiles();window.failWrite=true;
        try{await window.plugin.handleNoteRename('note.md','renamed.md');}catch{}
        window.failWrite=false;window.plugin.comments.splice(0);window.plugin.commentDataLoaded=false;
        window.plugin.loadedCommentPaths.clear();window.plugin.loadedCommentContents.clear();
        window.plugin.pendingNoteRenames.clear();window.plugin.loadPendingNoteRenames();
        await window.plugin.saveToolData();
        await window.plugin.retryPendingNoteRenames();
      });
      assert.equal(await page.evaluate(()=>window.plugin.pendingNoteRenames.size),1);
      await page.evaluate(()=>window.plugin.refreshCommentData());
      await page.waitForFunction(()=>window.plugin.comments.length===4&&window.plugin.comments.every(c=>c.filePath==='renamed.md'));
      await reset();
    });
    await check('queued rename retries use the latest pending destination',async()=>{
      const path=await page.evaluate(async()=>{
        window.plugin.comments[0].filePath='A/note.md';window.failWrite=true;
        try{await window.plugin.handleNoteRename('A/note.md','B/note.md');}catch{}
        window.failWrite=false;
        let release;await new Promise(entered=>{void window.plugin.enqueueMutation(()=>new Promise(done=>{release=done;entered();}));});
        const save=window.plugin.saveToolData.bind(window.plugin);let calls=0;
        window.plugin.saveToolData=async()=>{if(calls++===0)throw Error('transient move failure');await save();};
        const move=window.plugin.handleNoteRename('B','C'),retry=window.plugin.retryPendingNoteRenames();release();
        await Promise.allSettled([move,retry]);return window.plugin.comments[0].filePath;
      });
      assert.equal(path,'C/note.md');await reset();
    });
    await check('Android annotation header keeps search visible while secondary tools are collapsed', async () => {
      await reset(true);
      await page.evaluate(() => { window.view.containerEl.style.width = '320px'; });
      assert.equal(await page.getByLabel('搜索批注', {exact:true}).isVisible(), true);
      assert.equal(await page.getByLabel('导出为 Markdown', {exact:true}).isVisible(), false);
      const header=await page.locator('.sidenote-options-header').boundingBox();assert.ok(header.height<=48);
      const navigation=await page.locator('.sidenote-navigation').boundingBox();assert.ok(navigation.height<=48);
      await page.getByLabel('搜索批注', {exact:true}).fill('not-found');
      await page.waitForFunction(()=>document.querySelectorAll('.sidenote-comment-item').length===0);
      await page.getByLabel('搜索批注', {exact:true}).fill('');
      await page.locator('.sidenote-comment-item').first().waitFor();
      await page.locator('.sidenote-view-container').screenshot({path:path.join(root,'artifacts/android-annotations-compact.png')});
      await page.getByRole('button',{name:'展开选项',exact:true}).click();
      assert.equal(await page.getByLabel('导出为 Markdown', {exact:true}).isVisible(), true);
      await reset();
    });
    await check('one-click mobile options free list space and persist without changing filters', async () => {
      await reset(true);
      await page.evaluate(() => { window.view.containerEl.style.height = '850px'; });
      const toggle = page.getByRole('button', { name: '展开选项', exact: true });
      assert.equal(await toggle.count(), 1);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), false);
      assert.equal(await page.locator('.sidenote-navigation').isVisible(), true);
      const collapsedHeight = (await page.locator('.sidenote-comments-list-wrapper').boundingBox()).height;
      await toggle.click();
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), true);
      const expandedHeight = (await page.locator('.sidenote-comments-list-wrapper').boundingBox()).height;
      assert.ok(collapsedHeight > expandedHeight + 80, JSON.stringify({collapsedHeight, expandedHeight, layout: await page.locator('.sidenote-options').evaluate(el => ({height:el.clientHeight, scroll:el.scrollHeight, parent:el.parentElement.clientHeight}))}));
      await page.getByLabel('筛选标记样式').selectOption('underline');
      assert.equal(await page.getByRole('button', { name: '收起选项', exact: true }).getAttribute('aria-expanded'), 'true');
      await page.getByRole('button', { name: '收起选项', exact: true }).click();
      assert.match(await page.locator('.sidenote-options-status').innerText(), /筛选中/);
      assert.equal(await page.locator('.sidenote-comment-item').count(), 2);
      await page.getByRole('button', { name: '下一条', exact: true }).click();
      assert.equal(await page.evaluate(() => window.lastJump), 1);
      await page.evaluate(() => { window.plugin.pendingRebind = { filePath: 'note.md' }; window.view.renderView(); });
      assert.equal(await page.getByRole('button', { name: '绑定所选文字', exact: true }).isVisible(), true);
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), false);
      await page.getByRole('button', { name: '展开选项', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.evaluate(() => window.setup(true));
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), true);
      await page.getByRole('button', { name: '收起选项', exact: true }).click();
      await page.evaluate(() => window.setup(true));
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), false);
      await page.evaluate(() => { window.view.app.saveLocalStorage = () => { throw Error('storage unavailable'); }; });
      await page.getByRole('button', { name: '展开选项', exact: true }).click();
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), true);
      await page.getByLabel('搜索批注', { exact: true }).fill('批注1');
      await page.getByRole('button', { name: '收起选项', exact: true }).click();
      assert.match(await page.locator('.sidenote-options-status').innerText(), /搜索中/);
      await page.screenshot({ path: path.join(root, 'artifacts/options-collapsed.png') });
      await reset();
      assert.equal(await page.getByLabel('筛选标记样式').isVisible(), true);
    });
    await check('combined filter affects list only and does not write annotation files', async () => {
      await page.getByLabel('筛选标记样式').selectOption('underline'); await page.getByLabel('筛选标记颜色').selectOption('#ec4899');
      assert.equal(await page.locator('.sidenote-comment-item').count(), 2);
      assert.equal(await page.evaluate(() => window.plugin.comments.length), 4);
      assert.equal(await page.evaluate(() => window.writes.some(x => x.startsWith('side-note-data'))), false);
    });
    await check('navigation uses filtered order, counter and endpoint states', async () => {
      await page.getByRole('button', { name: '下一条', exact: true }).click();
      assert.equal(await page.evaluate(() => window.lastJump), 1); assert.match(await page.locator('.sidenote-navigation').innerText(), /第 1／2 条/);
      assert.equal(await page.getByRole('button', { name: '上一条', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '下一条', exact: true }).click(); assert.equal(await page.evaluate(() => window.lastJump), 2);
      assert.equal(await page.getByRole('button', { name: '下一条', exact: true }).isDisabled(), true);
    });
    await check('named filter persists and restores after reload', async () => {
      await page.getByRole('button', { name: '筛选与草稿操作', exact: true }).click();
      await page.getByRole('button', { name: '保存当前筛选…', exact: true }).click();
      await page.getByLabel('筛选名称').fill('粉色下划线');
      await page.locator('.modal-container').getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '显示全部', exact: true }).click();
      await page.getByLabel('常用筛选', { exact: true }).selectOption('0'); assert.equal(await page.locator('.sidenote-comment-item').count(), 2);
      await page.evaluate(async () => { window.plugin.preferences = { filter: {}, presets: [] }; await window.plugin.loadPreferences(); window.view.renderView(); });
      assert.equal(await page.getByLabel('筛选标记样式').inputValue(), 'underline');
    });
    await reset();
    await check('highlighting an annotation pins it to the top of the sidebar', async () => {
      await page.evaluate(() => window.view.highlightComment(3));
      await page.waitForFunction(() => document.querySelector('.sidenote-comment-item')?.getAttribute('data-comment-timestamp') === '3');
      const order = await page.locator('.sidenote-comment-item').evaluateAll(items => items.map(item => item.getAttribute('data-comment-timestamp')));
      assert.equal(order[0], '3');
      assert.equal(order.includes('1'), true);
      assert.equal(await page.evaluate(() => document.querySelector('.sidenote-comments-list-wrapper').scrollTop), 0);
    });
    await check('compact controls keep filters in one row and move presets into the more menu', async () => {
      const layout = await page.evaluate(() => {
        const options = document.querySelector('.sidenote-options');
        const filters = document.querySelector('.sidenote-filters');
        return { optionsChildren: options ? options.children.length : -1, hasPresetsRow: !!document.querySelector('.sidenote-presets'), filterButtons: filters ? filters.querySelectorAll('button').length : -1 };
      });
      assert.equal(layout.optionsChildren, 2);
      assert.equal(layout.hasPresetsRow, false);
      assert.equal(await page.getByRole('button', { name: '保存筛选', exact: true }).count(), 0);
      await page.evaluate(() => { document.querySelector('.sidenote-view-container').style.width = '600px'; });
      const filterHeight = await page.evaluate(() => document.querySelector('.sidenote-filters').getBoundingClientRect().height);
      assert.ok(filterHeight < 50, `filters should stay on one row at 600px, got ${filterHeight}`);
      await page.evaluate(() => { document.querySelector('.sidenote-view-container').style.width = '320px'; });
      await page.getByRole('button', { name: '筛选与草稿操作', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '保存当前筛选…', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '恢复未保存草稿', exact: true }).count(), 1);
      await page.evaluate(() => document.querySelector('.menu')?.remove());
    });
    await reset();
    await check('draft survives close and restores text, color and style', async () => {
      await page.evaluate(() => window.openEdit()); await page.locator('.sidenote-modal-textarea').fill('草稿内容');
      await page.locator('.sidenote-modal-mark-button[data-mark-type="bold"]').click();
      assert.match(await page.locator('.sidenote-save-status').innerText(), /草稿已暂存/);
      await page.getByLabel('关闭批注窗口', { exact: true }).click(); await page.evaluate(() => window.openEdit());
      await page.locator('.sidenote-draft-recovery').getByRole('button', { name: '恢复草稿', exact: true }).click();
      assert.equal(await page.locator('.sidenote-modal-textarea').inputValue(), '草稿内容');
      assert.equal(await page.locator('[data-mark-type="bold"]').getAttribute('aria-pressed'), 'true');
    });
    await check('failed save retains input and original annotation; retry saves once', async () => {
      await page.evaluate(() => window.failWrite = true); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.sidenote-save-status')?.textContent.includes('保存失败'));
      assert.equal(await page.locator('.sidenote-modal-textarea').inputValue(), '草稿内容');
      assert.equal(await page.evaluate(() => window.plugin.comments[0].comment), '批注1');
      assert.equal(await page.evaluate(() => window.plugin.drafts.list().length), 1);
      await page.evaluate(() => window.failWrite = false); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.sidenote-modal-floating'));
      assert.equal(await page.evaluate(() => window.plugin.comments[0].comment), '草稿内容');
      assert.equal(await page.evaluate(() => window.plugin.drafts.list().length), 0);
    });
    await reset();
    await check('orphan-only list and confirmed rebind preserve body and identity', async () => {
      await page.getByRole('button', { name: '定位异常 1', exact: true }).click(); assert.equal(await page.locator('.sidenote-comment-item').count(), 1);
      await page.evaluate(async () => { await window.plugin.beginRebind(window.plugin.comments[2]); window.setSelection(window.noteText.lastIndexOf('新选原文'), window.noteText.length); });
      await page.getByRole('button', { name: '绑定所选文字', exact: true }).click();
      await page.locator('.modal-container').getByRole('button', { name: '确认绑定', exact: true }).click();
      await page.waitForFunction(() => window.plugin.pendingRebind === null);
      const comment = await page.evaluate(() => window.plugin.comments[2]);
      assert.equal(comment.comment, '批注3'); assert.equal(comment.timestamp, 3); assert.equal(comment.color, '#f59e0b'); assert.equal(comment.selectedText, '新选原文'); assert.equal(comment.isOrphaned, false);
    });
    await reset();
    await check('failed new annotation save rolls back and retry creates one annotation', async () => {
      await page.evaluate(() => window.openAdd()); await page.locator('.sidenote-modal-textarea').fill('新增草稿');
      await page.evaluate(() => window.failWrite = true); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.sidenote-save-status')?.textContent.includes('保存失败'));
      assert.equal(await page.evaluate(() => window.plugin.comments.length), 4);
      await page.evaluate(() => window.failWrite = false); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.sidenote-modal-floating'));
      assert.equal(await page.evaluate(() => window.plugin.comments.length), 5);
    });
    await reset();
    await check('closing and opening another editor cannot interrupt a pending save', async () => {
      await page.evaluate(() => { window.openEdit(); window.plugin.editComment = async () => new Promise(resolve => window.finishSave = resolve); });
      await page.locator('.sidenote-modal-textarea').fill('正在保存'); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.evaluate(() => { window.modal.close(); window.openEdit(1); });
      assert.equal(await page.locator('.sidenote-modal-textarea').inputValue(), '正在保存');
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.finishSave()); await page.waitForFunction(() => !document.querySelector('.sidenote-modal-floating'));
    });
    await reset();
    await check('draft list restores a new draft after plugin reconstruction', async () => {
      await page.evaluate(() => window.openAdd(window.noteText.indexOf('新选原文'), '新选原文')); await page.locator('.sidenote-modal-textarea').fill('新建未保存内容');
      await page.getByLabel('关闭批注窗口', { exact: true }).click();
      await page.evaluate(() => window.setup());
      await page.getByRole('button', { name: '筛选与草稿操作', exact: true }).click();
      await page.getByRole('button', { name: '恢复未保存草稿', exact: true }).click();
      await page.getByRole('button', { name: '恢复编辑', exact: true }).click();
      assert.equal(await page.locator('.sidenote-modal-textarea').inputValue(), '新建未保存内容');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.sidenote-modal-floating'));
      assert.equal(await page.evaluate(() => window.plugin.drafts.list().length), 0);
    });
    await reset();
    await check('unreadable and unrelated JSON files survive an ordinary save', async () => {
      const result = await page.evaluate(async () => {
        window.files.set('side-note-data/unrelated.json', '{bad');
        window.files.set('side-note-data/foreign.json', JSON.stringify({ other: true }));
        await window.plugin.loadAllCommentsFromFiles(); await window.plugin.saveToolData();
        return [window.files.get('side-note-data/unrelated.json'), window.files.get('side-note-data/foreign.json')];
      });
      assert.deepEqual(result, ['{bad', '{"other":true}']);
    });
    await reset();
    await check('failed legacy style edit removes newly introduced optional properties', async () => {
      const unchanged = await page.evaluate(async () => {
        const target = window.plugin.comments[3]; delete target.color; delete target.markType;
        const before = JSON.stringify(target); window.failWrite = true;
        try { await window.plugin.editComment(target.timestamp, 'failed', '#123456', 'bold'); } catch {}
        window.failWrite = false; return JSON.stringify(target) === before;
      }); assert.equal(unchanged, true);
    });
    await reset();
    await check('failed legacy rebind restores exact prior anchors', async () => {
      await page.evaluate(async () => {
        const target = window.plugin.comments[2]; window.priorBinding = JSON.stringify(target);
        await window.plugin.beginRebind(target); window.setSelection(window.noteText.lastIndexOf('新选原文'), window.noteText.length);
        window.failWrite = true;
      });
      await page.getByRole('button', { name: '绑定所选文字', exact: true }).click();
      await page.locator('.modal-container').getByRole('button', { name: '确认绑定', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.modal-container button').disabled);
      assert.equal(await page.evaluate(() => JSON.stringify(window.plugin.comments[2]) === window.priorBinding), true);
      await page.evaluate(() => { window.failWrite = false; document.querySelector('.modal-container').remove(); });
    });
    await reset();
    await check('reverting edits to original clears only the draft changed in this session', async () => {
      await page.evaluate(() => window.openEdit()); await page.locator('.sidenote-modal-textarea').fill('后来撤回的草稿');
      await page.locator('.sidenote-modal-textarea').fill('批注1');
      await page.getByLabel('关闭批注窗口', { exact: true }).click();
      assert.equal(await page.evaluate(() => window.plugin.drafts.list().length), 0);
      await page.evaluate(() => window.openAdd()); await page.locator('.sidenote-modal-textarea').fill('清空前');
      await page.locator('.sidenote-modal-textarea').fill('');
      assert.match(await page.locator('.sidenote-save-status').innerText(), /未保存/);
      await page.getByLabel('关闭批注窗口', { exact: true }).click();
      assert.equal(await page.evaluate(() => window.plugin.drafts.list().length), 0);
    });
    await reset(true);
    await check('deleting last annotation on a newly written note removes its JSON', async () => {
      const exists = await page.evaluate(async () => {
        await window.plugin.saveCommentsForSingleFile('note.md');
        window.plugin.comments.splice(0);
        await window.plugin.saveToolData();
        return window.files.has(window.plugin.getCommentsJsonPath('note.md'));
      });
      assert.equal(exists, false);
    });
    await reset(true);
    await check('tablet save remains visible when viewport shrinks for keyboard', async () => {
      await page.setViewportSize({ width: 768, height: 1024 }); await page.evaluate(() => window.openEdit());
      await page.locator('.sidenote-modal-textarea').fill('长批注\n'.repeat(200));
      await page.setViewportSize({ width: 768, height: 360 }); await page.waitForTimeout(120);
      const box = await page.getByRole('button', { name: '保存', exact: true }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 360 && box.height >= 44, JSON.stringify(box));
      await page.screenshot({ path: path.join(root, 'artifacts/tablet-keyboard.png') });
    });
    await page.evaluate(() => window.modal.close());
    await check('narrow sidebar and phone landscape keep all controls inside viewport', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { window.view.containerEl.style.width = '250px'; window.view.renderView(); });
      await page.getByRole('button', { name: '展开选项', exact: true }).click();
      const overflow = await page.evaluate(() => { const el = window.view.containerEl; return el.scrollWidth > el.clientWidth + 1; });
      const layout = await page.evaluate(() => { const el = window.view.containerEl, right = el.getBoundingClientRect().right; return Array.from(el.querySelectorAll('*')).filter(x => x.getBoundingClientRect().right > right + 1).map(x => ({ cls: x.className, tag: x.tagName, right: x.getBoundingClientRect().right, width: x.getBoundingClientRect().width })); });
      assert.equal(overflow, false, JSON.stringify(layout));
      await page.evaluate(() => window.openEdit()); await page.setViewportSize({ width: 844, height: 320 }); await page.waitForTimeout(120);
      const box = await page.getByRole('button', { name: '保存', exact: true }).boundingBox();
      const editorLayout = await page.evaluate(() => Array.from(document.querySelector('.sidenote-modal-floating').children).map(x => ({ cls: x.className, height: x.getBoundingClientRect().height, y: x.getBoundingClientRect().y, min: getComputedStyle(x).minHeight, shrink: getComputedStyle(x).flexShrink })));
      if (box.y + box.height > 320) await page.screenshot({ path: path.join(root, 'artifacts/landscape-failure.png') });
      assert.ok(box && box.y >= 0 && box.y + box.height <= 320, JSON.stringify({ box, editorLayout }));
      await page.screenshot({ path: path.join(root, 'artifacts/phone-landscape.png') });
    });
    fs.writeFileSync(path.join(root, 'artifacts/ui-results.json'), JSON.stringify({ passed: results.length, results }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
