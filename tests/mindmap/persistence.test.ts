import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotWriter, SaveConflict } from '../../vendor/personal-mindmap/src/fusion/persistence';
import * as persistence from '../../vendor/personal-mindmap/src/fusion/persistence';

test('independent map storage survives restart, serializes edits and moves folder paths without collisions',async()=>{
 const Store=(persistence as any).MarkdownMapStore;assert.equal(typeof Store,'function');
 const files=new Map<string,string>();
 const adapter={async exists(p:string){return files.has(p);},async read(p:string){return files.get(p)!;},async write(p:string,s:string){files.set(p,s);}};
 const store=new Store(adapter,'maps.json');await store.load();
 const record=(text:string)=>({source:'# Original\n',doc:{version:1,root:{id:'root',text}}});
 await Promise.all([store.set('A/B.md',record('one')),store.set('A__B.md',record('two'))]);
 await store.rename('A','Moved');
 const reopened=new Store(adapter,'maps.json');await reopened.load();
 assert.equal(reopened.get('Moved/B.md').doc.root.text,'one');
 assert.equal(reopened.get('A__B.md').doc.root.text,'two');assert.equal(reopened.get('A/B.md'),undefined);
 assert.ok(files.get('maps.json.bak'));
 const copy=reopened.get('Moved/B.md');copy.doc.root.text='mutated';
 assert.equal(reopened.get('Moved/B.md').doc.root.text,'one');
 const stale=JSON.stringify(reopened.get('Moved/B.md'));
 await reopened.set('Moved/B.md',record('newer'),stale);
 await assert.rejects(reopened.set('Moved/B.md',record('stale tab'),stale));
 assert.equal(reopened.get('Moved/B.md').doc.root.text,'newer');
});

test('independent map storage preserves unreadable, external and failed-write data',async()=>{
 const Store=(persistence as any).MarkdownMapStore;assert.equal(typeof Store,'function');
 const files=new Map<string,string>();let fail=false;
 const adapter={async exists(p:string){return files.has(p);},async read(p:string){return files.get(p)!;},async write(p:string,s:string){if(fail&&p==='maps.json')throw Error('disk');files.set(p,s);}};
 const record={source:'original',doc:{version:1,root:{id:'root',text:'map'}}};
 const store=new Store(adapter,'maps.json');await store.load();
 await store.set('note.md',record);fail=true;
 await assert.rejects(store.set('other.md',record),/disk/);assert.equal(store.get('other.md'),undefined);
 fail=false;await store.set('other.md',record);
 files.set('maps.json','broken');await assert.rejects(store.set('note.md',record));assert.equal(files.get('maps.json'),'broken');
 const broken=new Store(adapter,'maps.json');await assert.rejects(broken.load());
 await assert.rejects(broken.set('note.md',record));assert.equal(files.get('maps.json'),'broken');
});

test('queued edits serialize against last persisted snapshot', async () => {
  let disk = 'A';
  const writer = new SnapshotWriter('A', async transform => { disk = transform(disk); });
  await Promise.all([writer.write('B'), writer.write('C')]);
  assert.equal(disk, 'C');
});
test('external modification is never overwritten', async () => {
  let disk = 'external';
  const writer = new SnapshotWriter('original', async transform => { disk = transform(disk); });
  await assert.rejects(writer.write('local'), SaveConflict);
  assert.equal(disk, 'external');
  assert.equal(writer.pending, 'local');
});

test('freshness guard runs inside the actual delayed disk transform',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 let disk='A',editor='A';
 const writer=new SnapshotWriter('A',async transform=>{await gate;disk=transform(disk);});
 const task=writer.write('B',()=>{if(editor!=='A')throw Error('newer editor');});
 editor='unsaved new text';release();
 await assert.rejects(task,/newer editor/);assert.equal(disk,'A');assert.equal(editor,'unsaved new text');
});
test('failed write leaves expected snapshot unchanged and permits retry', async () => {
  let disk = 'A'; let fail = true;
  const writer = new SnapshotWriter('A', async transform => { if (fail) throw new Error('disk'); disk = transform(disk); });
  await assert.rejects(writer.write('B'), /disk/);
  fail = false;
  await writer.write('B');
  assert.equal(disk, 'B');
});

test('recognizes every queued own snapshot and stops recognizing obsolete completed snapshots', async () => {
 let release!:()=>void;
 const gate = new Promise<void>(resolve=>release=resolve);
 let disk='A';
 const writer = new SnapshotWriter('A', async transform => {await gate;disk=transform(disk);});
 const first=writer.write('B'), second=writer.write('C');
 assert.equal(writer.isOwnSnapshot('A'),true);
 assert.equal(writer.isOwnSnapshot('B'),true);
 assert.equal(writer.isOwnSnapshot('C'),true);
 assert.equal(writer.isOwnSnapshot('external'),false);
 release();await Promise.all([first,second]);
 assert.equal(writer.isOwnSnapshot('B'),false);
 assert.equal(writer.isOwnSnapshot('C'),true);
});
