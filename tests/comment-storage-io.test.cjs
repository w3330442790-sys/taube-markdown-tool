const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const source = path.join(__dirname, '../src/comment-storage-io.ts');
const io = (() => {
    if (!fs.existsSync(source)) return {};
    const code = esbuild.buildSync({ entryPoints: [source], bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    return module.exports;
})();
const folder = 'data/comments';
const pending = folder + '/.taube-comments-pending.json';
const committed = folder + '/.taube-comments-committed.json';
function fixture(initial = {}, fail = () => false) {
    const files = new Map(Object.entries(initial));
    const calls = [];
    const adapter = {};
    for (const kind of ['exists', 'read', 'write', 'remove', 'rename']) adapter[kind] = async (...args) => {
        calls.push([kind, ...args]);
        if (fail(kind, ...args)) throw new Error('injected ' + kind);
        const [name, value] = args;
        if (kind === 'exists') return files.has(name);
        if (kind === 'write') { files.set(name, value); return; }
        if (!files.has(name)) throw new Error('missing ' + name);
        if (kind === 'read') return files.get(name);
        if (kind === 'rename') {
            if (files.has(value)) throw new Error('destination exists ' + value);
            files.set(value, files.get(name));
        }
        files.delete(name);
    };
    return { files, adapter, calls };
}
function sorted(files) { return [...files].sort(([a], [b]) => a.localeCompare(b)); }
function changes() { return new Map([[folder + '/new.json', '["new"]'], [folder + '/old.json', '["updated"]'], [folder + '/shared.json', null]]); }
const originals = { [folder + '/old.json']: '["old"]', [folder + '/shared.json']: '["a","b"]', [folder + '/unknown.txt']: 'keep' };

test('stages every JSON before moving originals, then adds, overwrites and deletes atomically', async () => {
    assert.equal(typeof io.commitCommentFiles, 'function');
    const f = fixture(originals);
    await io.commitCommentFiles(f.adapter, changes(), folder);
    assert.deepEqual(sorted(f.files), sorted(new Map([[folder + '/new.json', '["new"]'], [folder + '/old.json', '["updated"]'], [folder + '/unknown.txt', 'keep']])));
    const firstBackup = f.calls.findIndex(([kind, , to]) => kind === 'rename' && to.endsWith('.backup'));
    const stageWrites = f.calls.map((call, index) => ({call,index})).filter(({call}) => call[0] === 'write' && call[1].endsWith('.stage'));
    assert.equal(stageWrites.length, 2);
    assert.ok(stageWrites.every(({index}) => index < firstBackup));
});

test('a second stage write failure leaves every original untouched', async () => {
    let count = 0;
    const f = fixture(originals, (kind, name) => kind === 'write' && name.endsWith('.stage') && ++count === 2);
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false);
    assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
});

test('an install rename failure rolls back prior installs and shared legacy removal', async () => {
    let fired = false;
    const f = fixture(originals, (kind, from, to) => kind === 'rename' && to === folder + '/old.json' && !fired && (fired = true));
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false);
    assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
});

test('committed cleanup removal failure reports saved data and retries on recovery', async () => {
    let fired = false;
    const f = fixture(originals, (kind, name) => kind === 'remove' && name.endsWith('.backup') && !fired && (fired = true));
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === true);
    assert.equal(f.files.get(folder + '/old.json'), '["updated"]');
    assert.equal(f.files.has(folder + '/shared.json'), false);
    assert.equal(f.files.has(committed), true);
    await io.recoverCommentFiles(f.adapter, folder);
    assert.equal(f.files.has(pending), false);
    assert.equal(f.files.has(committed), false);
    assert.equal([...f.files.keys()].some(name => name.endsWith('.backup')), false);
});

test('restarting after a pending interruption restores originals, including shared legacy JSON', async () => {
    let crashed = false;
    const f = fixture(originals, (kind, from, to) => {
        if (kind === 'rename' && to === folder + '/old.json') crashed = true;
        return crashed;
    });
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder));
    assert.equal(f.files.has(pending), true);
    const fresh = fixture(Object.fromEntries(f.files));
    await io.recoverCommentFiles(fresh.adapter, folder);
    assert.deepEqual(sorted(fresh.files), sorted(new Map(Object.entries(originals))));
    await io.recoverCommentFiles(fresh.adapter, folder);
});

test('restarting after committed interruption finishes cleanup without reverting saved JSON', async () => {
    let crashed = false;
    const f = fixture(originals, (kind, name) => {
        if (kind === 'remove' && name.endsWith('.backup')) crashed = true;
        return crashed;
    });
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === true);
    const fresh = fixture(Object.fromEntries(f.files));
    await io.recoverCommentFiles(fresh.adapter, folder);
    assert.deepEqual(sorted(fresh.files), sorted(new Map([[folder + '/new.json', '["new"]'], [folder + '/old.json', '["updated"]'], [folder + '/unknown.txt', 'keep']])));
});

test('malicious journal paths and transaction identities fail before any mutation', async () => {
    for (const patch of [
        { operations: [{ name: '../outside.json', hadOriginal: true, hasContent: false }] },
        { operations: [{ name: 'nested/x.json', hadOriginal: true, hasContent: false }] },
        { operations: [{ name: 'C:\\outside.json', hadOriginal: true, hasContent: false }] },
        { id: '../outside' }, { folder: 'other' },
        { operations: [{ name: '.taube-comments-pending.json', hadOriginal: true, hasContent: false }] },
    ]) {
        const journal = { version: 1, id: 'a'.repeat(32), folder, operations: [{ name: 'old.json', hadOriginal: true, hasContent: true }], ...patch };
        const f = fixture({ ...originals, [pending]: JSON.stringify(journal) });
        await assert.rejects(() => io.recoverCommentFiles(f.adapter, folder));
        assert.equal(f.calls.some(([kind]) => ['write', 'rename', 'remove'].includes(kind)), false);
    }
});

test('invalid commit paths are rejected before writes and unknown files remain untouched', async () => {
    for (const name of ['other/a.json', folder + '/../a.json', folder + '/nested/a.json', pending, folder + '/a.txt']) {
        const f = fixture(originals);
        await assert.rejects(() => io.commitCommentFiles(f.adapter, new Map([[name, '[]']]), folder));
        assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
    }
});

test('rollback failure preserves pending journal for a later recovery', async () => {
    let failed = false;
    const f = fixture(originals, (kind, from, to) => {
        if (kind === 'rename' && to === folder + '/old.json') failed = true;
        return failed && kind === 'rename';
    });
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false);
    assert.equal(f.files.has(pending), true);
    const fresh = fixture(Object.fromEntries(f.files));
    await io.recoverCommentFiles(fresh.adapter, folder);
    assert.deepEqual(sorted(fresh.files), sorted(new Map(Object.entries(originals))));
});

test('missing original backups block pending recovery and preserve its journal', async () => {
    let crashed = false;
    const f = fixture(originals, (kind, from) => {
        if (kind === 'rename' && from === folder + '/shared.json') crashed = true;
        return crashed;
    });
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder));
    assert.equal(f.files.get(folder + '/old.json'), '["updated"]');
    const backup = [...f.files.keys()].find(name => name.endsWith('-1.backup'));
    assert.ok(backup);
    f.files.delete(backup);
    const fresh = fixture(Object.fromEntries(f.files));
    await assert.rejects(() => io.recoverCommentFiles(fresh.adapter, folder));
    assert.equal(fresh.files.has(pending), true);
});

test('reserved journal filenames containing foreign data block saves without overwrites', async () => {
    for (const reserved of [pending, committed]) {
        const initial = { ...originals, [reserved]: '[{"filePath":"my-note.md"}]' };
        const f = fixture(initial);
        await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false);
        assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(initial))));
    }
});

test('commit-marker staging failure rolls back every target and deleted legacy file', async () => {
    const f = fixture(originals, (kind, name) => kind === 'write' && name.endsWith('-commit'));
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false);
    assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
});

test('failed cleanup of the final committed journal is retryable', async () => {
    let once = false;
    const f = fixture(originals, (kind, name) => kind === 'remove' && name === committed && !once && (once = true));
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === true);
    assert.equal(f.files.has(pending), false);
    assert.equal(f.files.has(committed), true);
    await io.recoverCommentFiles(f.adapter, folder);
    assert.equal(f.files.has(committed), false);
    assert.equal(f.files.get(folder + '/old.json'), '["updated"]');
});

test('successful commit rename followed by rejection is recognized as committed', async () => {
    const f = fixture(originals);
    const rename = f.adapter.rename;
    f.adapter.rename = async (from, to) => {
        await rename(from, to);
        if (to === committed) throw new Error('interrupted after atomic commit rename');
    };
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === true);
    assert.equal(f.files.get(folder + '/old.json'), '["updated"]');
    await io.recoverCommentFiles(f.adapter, folder);
    assert.equal(f.files.has(committed), false);
});

test('a rollback remove failure retains originals and journal until recovery can retry', async () => {
    let failed = false;
    let blocked = false;
    const f = fixture(originals, (kind, from, to) => {
        if (kind === 'rename' && to === folder + '/old.json' && !failed) { failed = true; return true; }
        if (kind === 'remove' && from === folder + '/new.json' && !blocked) { blocked = true; return true; }
        return false;
    });
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === false && Boolean(error.recoveryError));
    assert.equal(f.files.has(pending), true);
    await io.recoverCommentFiles(f.adapter, folder);
    assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
});

test('a previous committed cleanup failure never marks a new unattempted save committed', async () => {
    const f = fixture(originals, (kind, name) => kind === 'remove' && name.endsWith('.backup'));
    await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder), error => error.committed === true);
    const next = new Map([[folder + '/next.json', '["next"]']]);
    await assert.rejects(() => io.commitCommentFiles(f.adapter, next, folder), error => error.committed === false);
    assert.equal(f.files.has(folder + '/next.json'), false);
    assert.equal(f.files.has(committed), true);
});


function caseInsensitiveFixture(initial = {}) {
    const f = fixture(Object.fromEntries(Object.entries(initial).map(([name, content]) => [name.toLowerCase(), content])));
    const adapter = {};
    for (const kind of ['exists', 'read', 'write', 'remove', 'rename']) {
        adapter[kind] = (name, value) => f.adapter[kind](name.toLowerCase(), kind === 'rename' ? value.toLowerCase() : value);
    }
    return { ...f, adapter };
}

test('Windows case-insensitive journal aliases are rejected as save targets before mutation', async () => {
    for (const name of ['.TAUBE-COMMENTS-COMMITTED.json', '.TAUBE-COMMENTS-PENDING.json', '.TaUbE-CoMmEnTs-other.json']) {
        const f = caseInsensitiveFixture(originals);
        await assert.rejects(() => io.commitCommentFiles(f.adapter, new Map([[folder + '/' + name, '[]']]), folder));
        assert.equal(f.calls.some(([kind]) => ['write', 'rename', 'remove'].includes(kind)), false);
        assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(originals))));
    }
});

test('Windows journal recovery rejects operations aliasing reserved filenames', async () => {
    for (const name of ['.TAUBE-COMMENTS-COMMITTED.json', '.TAUBE-COMMENTS-PENDING.json']) {
        const journal = { version: 1, id: 'a'.repeat(32), folder, operations: [{ name, hadOriginal: false, hasContent: true, originalHash: null }] };
        const initial = { ...originals, [pending]: JSON.stringify(journal) };
        const f = caseInsensitiveFixture(initial);
        await assert.rejects(() => io.recoverCommentFiles(f.adapter, folder));
        assert.equal(f.calls.some(([kind]) => ['write', 'rename', 'remove'].includes(kind)), false);
        assert.deepEqual(sorted(f.files), sorted(new Map(Object.entries(initial))));
    }
});

test('Windows existing foreign journals with differently cased names are never overwritten', async () => {
    for (const name of ['.TAUBE-COMMENTS-COMMITTED.json', '.TAUBE-COMMENTS-PENDING.json']) {
        const f = caseInsensitiveFixture({ ...originals, [folder + '/' + name]: 'foreign data' });
        const before = sorted(f.files);
        await assert.rejects(() => io.commitCommentFiles(f.adapter, changes(), folder));
        assert.equal(f.calls.some(([kind]) => ['write', 'rename', 'remove'].includes(kind)), false);
        assert.deepEqual(sorted(f.files), before);
    }
});
