const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const code = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/commentManager.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
const { CommentManager } = mod.exports;

test('verified repeated quotes remain located on repeated unchanged-file validation and restart', async () => {
  const source='- Same\n- Same\n';
  const comment=anchored(source,'Same',{contextBefore:undefined,contextAfter:undefined,anchorSourceFingerprint:mod.exports.sourceFingerprint?.(source)});
  await new CommentManager([comment]).updateCommentCoordinatesForFile(source,'note.md');
  assert.equal(comment.isOrphaned,false);
  const reloaded=JSON.parse(JSON.stringify(comment));
  await new CommentManager([reloaded]).updateCommentCoordinatesForFile(source,'note.md');
  assert.equal(reloaded.isOrphaned,false);assert.equal(reloaded.absoluteFrom,2);
});

test('live transaction mapping excludes boundary insertions and preserves repeated-quote identity', async () => {
  assert.equal(typeof mod.exports.mapCommentChange,'function');
  const {ChangeSet}=require('@codemirror/state');
  const before='- Same\n- Same\n';const comment=anchored(before,'Same');
  const changes=ChangeSet.of([{from:2,insert:'prefix '},{from:6,insert:' suffix'}],before.length);
  const after=changes.apply(require('@codemirror/state').Text.of(before.split('\n'))).toString();
  assert.equal(mod.exports.mapCommentChange(comment,before,after,changes),true);
  assert.equal(comment.absoluteFrom,after.indexOf('Same'));assert.equal(comment.absoluteTo,after.indexOf('Same')+4);
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after,'note.md');
  assert.equal(comment.isOrphaned,false);
});

test('live mapping cannot resurrect orphaned or stale anchors from an unrelated document', () => {
  assert.equal(typeof mod.exports.mapCommentChange,'function');
  const {ChangeSet}=require('@codemirror/state');const source='- Same\n- Same\n';
  const change=ChangeSet.of({from:0,insert:'prefix\n'},source.length);
  for(const patch of [{isOrphaned:true},{absoluteFrom:0,absoluteTo:4}]){
    const comment=anchored(source,'Same',patch);
    assert.equal(mod.exports.mapCommentChange(comment,source,'prefix\n'+source,change),false);
  }
});
function anchored(source, quote, overrides = {}) {
  const from = source.indexOf(quote), to = from + quote.length;
  const line = source.slice(0, from).split('\n');
  return { filePath: 'note.md', selectedText: quote, selectedTextHash: 'hash', comment: 'Keep body', timestamp: 123,
    startLine: line.length - 1, startChar: line.at(-1).length, endLine: line.length - 1, endChar: line.at(-1).length + quote.length,
    absoluteFrom: from, absoluteTo: to, occurrenceIndex: 0, contextBefore: source.slice(Math.max(0, from - 50), from), contextAfter: source.slice(to, to + 50), ...overrides };
}
test('swapping repeated-label branches moves annotation with its own following note', async () => {
  const before = '# T\n\n- Same\n  note A\n- Same\n  note B\n';
  const after = '# T\n\n- Same\n  note B\n- Same\n  note A\n';
  const comment = anchored(before, 'Same', { headingPath: ['T'] });
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, false);
  assert.equal(comment.absoluteFrom, after.lastIndexOf('Same'));
  assert.equal(comment.startLine, 4);
  assert.equal(comment.comment, 'Keep body'); assert.equal(comment.timestamp, 123);
});
test('legacy duplicate quotes cannot bind using old offset, line, occurrence or heading alone', async () => {
  const source = '# T\n\n- Same\n  note A\n- Same\n  note B\n';
  for (const coordinates of [{}, { absoluteFrom: undefined, absoluteTo: undefined }]) {
    const comment = anchored(source, 'Same', { contextBefore: undefined, contextAfter: undefined, headingPath: ['T'], ...coordinates });
    await new CommentManager([comment]).updateCommentCoordinatesForFile(source, 'note.md');
    assert.equal(comment.isOrphaned, true);
    assert.equal(comment.comment, 'Keep body');
  }
});
test('ambiguous equal contexts orphan instead of preferring the unchanged offset', async () => {
  const source = '- Same suffix\n- Same suffix\n';
  const comment = anchored(source, 'Same', { contextBefore: '- ', contextAfter: ' suffix' });
  await new CommentManager([comment]).updateCommentCoordinatesForFile(source, 'note.md');
  assert.equal(comment.isOrphaned, true);
});
test('lost duplicate context cannot fall back to the first occurrence', async () => {
  const before = '- Same\n  original note\n- Same\n  other note\n';
  const after = '- Same\n  changed note\n- Same\n  other note\n';
  const comment = anchored(before, 'Same');
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, true);
});
test('unique unchanged and relocated text retains existing anchoring behavior', async () => {
  const before = '# T\n\nUnique label\n';
  for (const after of [before, 'New paragraph\n' + before]) {
    const comment = anchored(before, 'Unique label', { contextBefore: undefined, contextAfter: undefined });
    await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
    assert.equal(comment.isOrphaned, false);
    assert.equal(comment.absoluteFrom, after.indexOf('Unique label'));
  }
});
test('a neighbouring sibling is not identity evidence after branch movement', async () => {
  const before = '- Same\n- Same\n- Same\n  note B\n';
  const after = '- Same\n- Same\n  note B\n- Same\n';
  const comment = anchored(before, 'Same');
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, true);
});

test('duplicate text unique inside its stored heading section rebinds after edits', async () => {
  const before = '# A\n\nSame line\n\n# B\n\nSame line\n';
  const after = '# A\n\nSame line changed\n\n# B\n\nSame line\n';
  const comment = anchored(before, 'Same line', { headingPath: ['B'], absoluteFrom: 0, absoluteTo: 0, startLine: 0, startChar: 0, endLine: 0, endChar: 0 });
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, false);
  assert.equal(comment.absoluteFrom, after.lastIndexOf('Same line'));
});

test('batch repair prefers intact offsets, then unique text, and refreshes anchors', async () => {
  const source = '# S\n\n- Same\n  note A\n- Same\n  note B\n\nUnique phrase\n\nAnother unique\n';
  const second = source.lastIndexOf('Same');
  const keep = anchored(source, 'Same', { occurrenceIndex: 1, headingPath: ['S'], absoluteFrom: second, absoluteTo: second + 4, contextBefore: '- stale', contextAfter: '\n  stale' });
  keep.isOrphaned = true;
  const ambiguous = anchored(source, 'Same', { occurrenceIndex: 0, headingPath: ['S'], absoluteFrom: 0, absoluteTo: 0, contextBefore: '- stale', contextAfter: '\n  stale' });
  ambiguous.isOrphaned = true;
  const unique = anchored(source, 'Unique phrase', { absoluteFrom: 0, absoluteTo: 0, headingPath: [] });
  unique.isOrphaned = true;
  const manager = new CommentManager([keep, ambiguous, unique]);
  const result = await manager.repairOrphanedComments(source, 'note.md');
  assert.equal(result.byOffset, 1);
  assert.equal(result.repaired, 2);
  assert.equal(result.remaining, 1);
  assert.equal(keep.absoluteFrom, source.lastIndexOf('Same'));
  assert.equal(keep.contextAfter.startsWith('\n  note B'), true);
  assert.equal(keep.headingPath[0], 'S');
  assert.equal(unique.isOrphaned, false);
  assert.equal(unique.absoluteFrom, source.indexOf('Unique phrase'));
  assert.equal(ambiguous.isOrphaned, true);
});

test('batch repair leaves genuinely ambiguous duplicate text alone', async () => {
  const source = '- Same suffix\n- Same suffix\n';
  const comment = anchored(source, 'Same', { absoluteFrom: 0, absoluteTo: 0, startLine: 0, startChar: 0, endLine: 0, endChar: 0 });
  comment.isOrphaned = true;
  const result = await new CommentManager([comment]).repairOrphanedComments(source, 'note.md');
  assert.equal(result.repaired, 0);
  assert.equal(result.remaining, 1);
  assert.equal(comment.isOrphaned, true);
});

test('globally unique quote recovers after moving outside its old heading and far from its old offset', async () => {
  const before = '# A\nUnique quotation\n# B\nOther text\n';
  const after = '# A\nOther text\n# B\n' + 'padding\n'.repeat(400) + 'Unique quotation\n';
  const comment = anchored(before, 'Unique quotation', { headingPath: ['A'] });
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, false);
  assert.equal(comment.absoluteFrom, after.indexOf('Unique quotation'));
  assert.deepEqual(comment.headingPath, ['B']);
});

test('unique quote tolerates CRLF, indentation and Unicode whitespace while preserving actual offsets', async () => {
  const before = 'prefix\nA unique\n  quoted phrase\nsuffix';
  const after = 'inserted\r\nprefix\r\nA\u00a0unique\r\n\tquoted\u3000phrase\r\nsuffix';
  const comment = anchored(before, 'A unique\n  quoted phrase');
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, false);
  assert.equal(comment.absoluteFrom, after.indexOf('A\u00a0unique'));
  assert.equal(comment.selectedText, 'A\u00a0unique\r\n\tquoted\u3000phrase');
  assert.equal(comment.absoluteTo, after.indexOf('\r\nsuffix'));
  assert.equal(comment.startLine, 2);
  assert.equal(comment.endLine, 3);
  assert.equal(comment.endChar, '\tquoted\u3000phrase'.length);
  assert.notEqual(comment.selectedTextHash, 'hash');
});

test('whitespace-equivalent duplicates remain orphaned even when the old offset points to one', async () => {
  const before = 'Alpha beta';
  const after = 'Alpha\tbeta\nAlpha\u00a0beta';
  const comment = anchored(before, before);
  await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
  assert.equal(comment.isOrphaned, true);
});

test('overlapping whitespace-equivalent occurrences are still ambiguous', async () => {
  const comment = anchored('A A', 'A A');
  await new CommentManager([comment]).updateCommentCoordinatesForFile('A\tA\tA', 'note.md');
  assert.equal(comment.isOrphaned, true);
});

test('one exact occurrence cannot hide a second whitespace-equivalent occurrence', async () => {
  const comment = anchored('Alpha beta', 'Alpha beta');
  await new CommentManager([comment]).updateCommentCoordinatesForFile('Alpha beta\nAlpha\tbeta', 'note.md');
  assert.equal(comment.isOrphaned, true);
});

test('whitespace recovery never removes word boundaries or accepts changed letters', async () => {
  for (const after of ['Alphabeta', 'Alpha zeta']) {
    const comment = anchored('Alpha beta', 'Alpha beta');
    await new CommentManager([comment]).updateCommentCoordinatesForFile(after, 'note.md');
    assert.equal(comment.isOrphaned, true);
  }
});

test('folder rename migrates descendants on path boundaries and preserves unrelated paths', () => {
  const paths = ['folder/a.md', 'folder/nested/b.md', 'folder-other/c.md', 'other/folder/d.md'];
  const comments = paths.map(filePath => anchored('quote', 'quote', { filePath }));
  const manager = new CommentManager(comments);
  manager.renameFile('folder', 'renamed');
  assert.deepEqual(comments.map(comment => comment.filePath), ['renamed/a.md', 'renamed/nested/b.md', ...paths.slice(2)]);
  manager.renameFile('renamed/a.md', 'renamed/new.md');
  assert.equal(comments[0].filePath, 'renamed/new.md');
});
