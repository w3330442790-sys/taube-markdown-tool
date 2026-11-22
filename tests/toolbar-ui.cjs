const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'toolbar-ui-entry.ts')],
  bundle: true,
  outfile: path.join(root, 'artifacts/toolbar-ui.bundle.js'),
  platform: 'browser',
  alias: { obsidian: path.join(__dirname, 'obsidian-mock.ts') },
  logLevel: 'warning',
});
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><style>:root{--background-primary:#fff;--background-secondary:#f4f4f4;--text-normal:#222;--text-muted:#666;--text-faint:#888;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--interactive-accent:#5865f2;--font-ui:Arial;--font-monospace:Consolas,monospace}body{margin:0;font-family:Arial}#host{height:100vh;width:100vw;display:flex;overflow:hidden}.view-container{display:flex;flex-direction:column;flex:1;min-width:0}.view-content{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}.cm-editor{flex:1;min-height:0}.cm-scroller{overflow:auto}</style><style>${css}</style><div id="host"></div><script>${fs.readFileSync(path.join(root, 'artifacts/toolbar-ui.bundle.js'), 'utf8')}</script>`);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.setup);

    await check('tablet toolbar stays on one row with reachable search and cloze after scrolling', async () => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.evaluate(() => { document.body.classList.add('is-mobile'); window.setup(); });
      const layout = await page.locator('.mt-md-toolbar-btn').evaluateAll(buttons => buttons.map(b => ({ y: b.getBoundingClientRect().y, h: b.getBoundingClientRect().height })));
      assert.ok(layout.every(b => b.y === layout[0].y && b.h >= 40), JSON.stringify(layout));
      const scroll = page.locator('.mt-md-toolbar-scroll');
      await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      for (const command of ['find-replace', 'cloze-toggle', 'go-to-start']) {
        const button = page.locator(`[data-command="${command}"]`);
        const b = await button.boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 768);
        assert.ok((await button.innerText()).length > 0);
      }
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.evaluate(() => document.body.classList.remove('is-mobile'));
    });

    await check('document search lists context and jumps directly to a chosen match', async () => {
      await page.evaluate(() => window.setup());
      await page.getByRole('button', { name: '查找替换', exact: true }).click();
      await page.getByLabel('查找本文', { exact: true }).fill('o');
      await page.locator('.mt-search-result').nth(1).click();
      assert.deepEqual(await page.evaluate(() => window.selection()), { from: 7, to: 8 });
      assert.equal(await page.locator('.mt-search-count').innerText(), '2 / 2');
      await page.getByRole('button', { name: '下一处', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.selection()), { from: 4, to: 5 });
      await page.getByLabel('查找本文', { exact: true }).fill('missing');
      await page.waitForFunction(() => document.querySelector('.mt-search-count')?.textContent === '无匹配');
      assert.equal(await page.getByRole('button', { name: '下一处', exact: true }).isEnabled(), false);
      await page.getByRole('button', { name: '关闭查找', exact: true }).click();
      assert.equal(await page.locator('.mt-document-search').count(), 0);
    });

    await check('toolbar mounts at the top of the view content with grouped buttons', async () => {
      await page.evaluate(() => window.setup());
      const toolbar = page.locator('.mt-md-toolbar');
      assert.equal(await toolbar.count(), 1);
      assert.equal(await page.locator('.mt-md-toolbar-btn').count(), 22);
      assert.equal(await page.locator('.mt-md-toolbar-sep').count(), 3);
      const first = await page.evaluate(() => document.querySelector('.view-content')?.firstElementChild?.className);
      assert.equal(first, 'mt-md-toolbar');
      const commands = await page.evaluate(() => [...document.querySelectorAll('.mt-md-toolbar-btn')].map(button => button.getAttribute('data-command')));
      assert.deepEqual(commands.slice(0, 5), ['find-replace', 'cloze-toggle', 'go-to-start', 'undo', 'redo']);
    });

    await check('return to start scrolls long notes and works in reading mode', async () => {
      const text=Array.from({length:400},(_,i)=>'Line '+i).join('\n');
      await page.evaluate(text=>{window.setup();window.setText(text);window.select(text.length,text.length);},text);
      const scroller=page.locator('.cm-scroller');
      await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight;});
      assert.ok(await scroller.evaluate(el=>el.scrollTop>0));
      const button=page.getByRole('button',{name:'返回开头',exact:true});
      await button.click();
      await page.waitForFunction(()=>document.querySelector('.cm-scroller').scrollTop===0);
      assert.deepEqual(await page.evaluate(()=>window.selection()),{from:0,to:0});
      assert.equal(await page.evaluate(()=>window.doc()),text);
      await page.evaluate(text=>{window.virtualPreview(text);window.previewLine=399;},text);
      await button.click();
      assert.equal(await page.evaluate(()=>window.previewLine),0);
    });

    await check('undo and redo buttons use the native editor history', async () => {
      await page.evaluate(() => window.setup());
      await page.getByRole('button', { name: '撤销' }).click();
      await page.getByRole('button', { name: '重做' }).click();
      assert.deepEqual(await page.evaluate(() => window.calls), ['undo', 'redo']);
    });

    await check('find opens a dedicated result list without depending on the native panel', async () => {
      await page.evaluate(() => window.setup());
      await page.getByRole('button', { name: '查找替换' }).click();
      assert.equal(await page.getByLabel('查找本文', {exact:true}).isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.calls), []);
    });

    await check('cloze button toggles the Markdown mask and its label', async () => {
      await page.evaluate(() => {
        window.setup();
        const sample = document.createElement('div');
        sample.className = 'markdown-rendered';
        sample.innerHTML = '<mark>answer</mark>';
        document.querySelector('.view-content')?.appendChild(sample);
      });
      const cloze = page.locator('[data-command="cloze-toggle"]');
      assert.equal(await cloze.getAttribute('aria-label'), '隐藏挖孔内容');
      await cloze.click();
      assert.equal(await page.evaluate(() => window.clozeHidden()), true);
      assert.equal(await cloze.getAttribute('aria-label'), '显示挖孔内容');
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('.markdown-rendered mark')).color),
        'rgba(0, 0, 0, 0)',
      );
      await cloze.click();
      assert.equal(await page.evaluate(() => window.clozeHidden()), false);
      assert.equal(await cloze.innerText(), '挖孔');
      assert.equal(await cloze.getAttribute('aria-label'), '隐藏挖孔内容');
      assert.notEqual(
        await page.evaluate(() => getComputedStyle(document.querySelector('.markdown-rendered mark')).color),
        'rgba(0, 0, 0, 0)',
      );
    });

    await check('reading mode blocks edit actions but keeps cloze available', async () => {
      await page.evaluate(() => { window.setup(); window.setMode('preview'); });
      await page.getByRole('button', { name: '撤销' }).click();
      await page.getByRole('button', { name: '重做' }).click();
      await page.getByRole('button', { name: '查找替换' }).click();
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      assert.deepEqual(await page.evaluate(() => window.notices), [
        '请先切换到编辑模式再使用工具栏',
        '请先切换到编辑模式再使用工具栏',
      ]);
      await page.locator('[data-command="cloze-toggle"]').click();
      assert.equal(await page.evaluate(() => window.clozeHidden()), true);
      assert.equal(await page.evaluate(() => window.notices.length), 2);
    });

    await check('preview search supports rendered context, direct jumps and disables replacement', async () => {
      await page.evaluate(() => {
        window.setup(); window.setMode('preview');
        const root=document.createElement('div');root.className='markdown-preview-view';root.innerHTML='<p>安卓 <strong>平板</strong>使用</p><p>平板第二处</p>';
        document.querySelector('.view-content').append(root);
      });
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('平板');
      await page.locator('.mt-search-result').nth(1).click();
      assert.equal(await page.locator('.mt-search-preview-current').innerText(),'平板第二处');
      assert.equal(await page.getByRole('button',{name:'展开替换',exact:true}).isEnabled(),false);
      assert.equal(await page.evaluate(()=>window.doc()),'hello world');
    });

    await check('literal Chinese search, case filter and replace-all remain one undo step',async()=>{
      await page.evaluate(()=>{window.setup();window.setText('平板 a.b A.B 平板');});
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('a.b');
      await page.waitForFunction(()=>document.querySelectorAll('.mt-search-result').length===2);
      await page.getByRole('button',{name:'区分大小写',exact:true}).click();
      assert.equal(await page.locator('.mt-search-result').count(),1);
      await page.getByLabel('查找本文',{exact:true}).fill('平板');
      await page.waitForFunction(()=>document.querySelectorAll('.mt-search-result').length===2);
      await page.getByRole('button',{name:'展开替换',exact:true}).click();
      await page.getByLabel('替换为',{exact:true}).fill('安卓');
      await page.getByRole('button',{name:'替换全部',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.doc()),'安卓 a.b A.B 安卓');
      await page.getByRole('button',{name:'撤销',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.doc()),'平板 a.b A.B 平板');
      await page.waitForFunction(()=>document.querySelectorAll('.mt-search-result').length===2);
      await page.getByRole('button',{name:'关闭查找',exact:true}).click();
      assert.equal(await page.locator('.mt-search-hit').count(),0);
    });

    await check('search refreshes stale offsets before navigation and rebinds replacement editor instances',async()=>{
      await page.evaluate(()=>window.setup());
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('world');
      await page.locator('.mt-search-result').first().waitFor();
      await page.evaluate(()=>{window.setText('a');document.querySelector('.mt-search-result').click();});
      assert.equal(await page.locator('.mt-search-result').count(),0);
      await page.evaluate(()=>window.swapEditor('安卓 平板 安卓'));
      await page.getByLabel('查找本文',{exact:true}).fill('安卓');
      await page.locator('.mt-search-result').nth(1).click();
      assert.deepEqual(await page.evaluate(()=>window.selection()),{from:6,to:8});
    });

    await check('reading view searches virtualized full source and does not invent cross-paragraph matches',async()=>{
      await page.evaluate(()=>{window.setup();window.virtualPreview('第一行\n未渲染部分\n安卓平板');});
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('安卓');
      await page.locator('.mt-search-result').first().click();
      assert.equal(await page.evaluate(()=>window.previewLine),2);
      await page.evaluate(()=>{window.setup();window.setMode('preview');const root=document.createElement('div');root.className='markdown-preview-view';root.innerHTML='<p>foo</p><p>bar</p>';document.querySelector('.view-content').append(root);});
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('foobar');
      await page.waitForFunction(()=>document.querySelector('.mt-search-count')?.textContent==='无匹配');
      assert.equal(await page.locator('.mt-search-result').count(),0);
    });

    await check('narrow split-screen and keyboard preserve primary tools and search result panel',async()=>{
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(()=>{document.body.classList.add('is-mobile');window.setup();window.setText(Array.from({length:130},(_,i)=>`第${i+1}行 安卓平板使用说明`).join('\n'));});
      await page.getByRole('button',{name:'查找替换',exact:true}).click();
      await page.getByLabel('查找本文',{exact:true}).fill('平板');
      await page.locator('.mt-search-result').nth(99).waitFor();
      await page.getByRole('button',{name:'显示更多结果',exact:true}).click();
      assert.equal(await page.locator('.mt-search-result').count(),130);
      await page.setViewportSize({width:768,height:1024});
      await page.screenshot({path:path.join(root,'artifacts/tablet-search.png'),fullPage:false});
      await page.setViewportSize({width:390,height:360});
      const box=await page.locator('.mt-document-search').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y+box.height<=360,JSON.stringify({box,layout:await page.evaluate(()=>({width:document.documentElement.scrollWidth,scrollX:window.scrollX,heights:[...document.querySelectorAll('#host,.view-container,.view-content,.cm-editor')].map(el=>[el.className,el.clientHeight,el.scrollHeight]),buttons:[...document.querySelectorAll('.mt-md-toolbar-primary button')].map(el=>({text:el.textContent,rect:el.getBoundingClientRect().toJSON()}))}))}));
      await page.getByRole('button',{name:'关闭查找',exact:true}).click();
      await page.evaluate(()=>document.body.classList.remove('is-mobile'));
      await page.setViewportSize({width:1100,height:800});
    });

    await check('bold button wraps the selection and keeps it selected', async () => {
      await page.evaluate(() => { window.setup(); window.select(0, 5); });
      await page.getByRole('button', { name: '加粗' }).click();
      assert.equal(await page.evaluate(() => window.doc()), '**hello** world');
      const selection = await page.evaluate(() => window.getSelection()?.toString());
      assert.equal(selection === '' || selection === 'hello', true);
    });

    await check('heading button replaces the marker instead of stacking', async () => {
      await page.evaluate(() => { window.setup(); window.select(0, 5); });
      await page.getByRole('button', { name: 'H2' }).click();
      await page.getByRole('button', { name: 'H3' }).click();
      assert.equal((await page.evaluate(() => window.doc())).split('\n')[0], '### hello world');
    });

    await check('list button prefixes the current line and toggles off', async () => {
      await page.evaluate(() => { window.setup(); window.select(0, 0); });
      await page.getByRole('button', { name: '无序列表' }).click();
      assert.equal(await page.evaluate(() => window.doc()), '- hello world');
      await page.getByRole('button', { name: '无序列表' }).click();
      assert.equal(await page.evaluate(() => window.doc()), 'hello world');
    });

    await check('reading mode reports a notice and does not edit', async () => {
      await page.evaluate(() => { window.setup(); window.setMode('preview'); window.select(0, 5); });
      await page.getByRole('button', { name: '加粗' }).click();
      assert.equal(await page.evaluate(() => window.doc()), 'hello world');
      assert.deepEqual(await page.evaluate(() => window.notices), ['请先切换到编辑模式再使用工具栏']);
    });

    await check('toolbar buttons keep the editor selection when pressed', async () => {
      await page.evaluate(() => { window.setup(); window.select(0, 5); });
      await page.getByRole('button', { name: '加粗' }).click();
      const selection = await page.evaluate(() => window.selection());
      assert.deepEqual(selection, { from: 2, to: 7 });
      await page.getByRole('button', { name: '加粗' }).click();
      assert.equal(await page.evaluate(() => window.doc()), 'hello world');
      assert.deepEqual(await page.evaluate(() => window.selection()), { from: 0, to: 5 });
    });

    assert.deepEqual(pageErrors, []);
    console.log(`TOOLBAR UI PASS ${results.length}`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
