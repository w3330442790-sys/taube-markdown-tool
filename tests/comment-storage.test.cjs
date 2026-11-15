const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const source = path.join(__dirname, '../src/comment-storage.ts');
function load() {
    if (!fs.existsSync(source)) return {};
    const code = esbuild.transformSync(fs.readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    return module.exports;
}
const storage = load();

test('comment filenames distinguish paths flattened by the legacy encoding', () => {
    assert.equal(typeof storage.commentStorageBasename, 'function');
    assert.notEqual(storage.commentStorageBasename('A/B.md'), storage.commentStorageBasename('A__B.md'));
});

test('comment filenames preserve case, extension and exact Unicode identity', () => {
    const inputs = ['A.md', 'a.md', 'A.MD', 'A', '笔记/批注😀.md', 'é.md', 'e\u0301.md', '\ud800.md', '\ufffd.md'];
    const names = inputs.map(storage.commentStorageBasename);
    assert.equal(new Set(names).size, inputs.length);
    for (let i = 0; i < inputs.length; i++) assert.equal(names[i], storage.commentStorageBasename(inputs[i]));
});

test('comment filenames are bounded and safe on Windows for every note path', () => {
    for (const input of ['', '.', '..', 'CON', 'NUL.md', 'COM1.md', 'a<>:"/\\|?*\u0000\u001f .md', '笔记/'.repeat(10000) + 'long.md']) {
        const basename = storage.commentStorageBasename(input);
        assert.match(basename, /^note-v2-[0-9a-f]{64}$/);
        assert.ok((basename + '-sidenote.md').length <= 100);
    }
});

test('comment filenames use SHA-256 of all UTF-16LE path code units', () => {
    // These lengths exercise both SHA-256 padding branches and multiple blocks.
    for (const input of ['abc.md', '笔记/😀.md', '\ud800.md', ...[27, 28, 31, 32, 60, 64, 1000].map(n => 'x'.repeat(n))]) {
        const digest = crypto.createHash('sha256').update(Buffer.from(input, 'utf16le')).digest('hex');
        assert.equal(storage.commentStorageBasename(input), 'note-v2-' + digest);
    }
});

test('legacy basenames exactly match existing JSON and sidenote discovery', () => {
    assert.equal(typeof storage.legacyCommentBasename, 'function');
    assert.equal(storage.legacyCommentBasename('A/B.md'), 'A__B');
    assert.equal(storage.legacyCommentBasename('A__B.md'), 'A__B');
    assert.equal(storage.legacyCommentBasename('笔记/a.MD'), '笔记__a');
    assert.equal(storage.legacyCommentBasename('a.md.backup'), 'a.md.backup');
});
