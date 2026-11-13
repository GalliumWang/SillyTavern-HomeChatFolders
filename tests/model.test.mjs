import test from 'node:test';
import assert from 'node:assert/strict';
import {
    defaults, validate, sanitizeAndRecover, chatKey, encodeKey, parseKey, sanitizeChatName,
    upsertFolder, assignChats, deleteFolder, remapKeys, mergeStates, visibleChats, exportState,
} from '../src/model.js';

test('same chat names on different characters/groups remain independent; only single terminal suffix is removed', () => {
    const a = chatKey('character', '甲.png', '长篇.jsonl.续篇.jsonl');
    const b = chatKey('character', '乙.png', '长篇.jsonl.续篇');
    const c = chatKey('group', '甲.png', '长篇.jsonl.续篇');
    const doubleExt = chatKey('character', '甲.png', '备份.jsonl.jsonl');
    const singleExt = chatKey('character', '甲.png', '备份.jsonl');
    assert.equal(parseKey(a).name, '长篇.jsonl.续篇');
    assert.equal(parseKey(doubleExt).name, '备份.jsonl');
    assert.equal(parseKey(singleExt).name, '备份');
    assert.notEqual(doubleExt, singleExt);
    assert.equal(encodeKey('character', '甲.png', '备份.jsonl'), doubleExt);
    assert.notEqual(a, b); assert.notEqual(a, c);
    let state = assignChats(defaults(), [a], 'f-active');
    state = assignChats(state, [b], 'f-finished');
    assert.equal(state.assignments[a], 'f-active'); assert.equal(state.assignments[b], 'f-finished');
});

test('sanitizeChatName aligns with SillyTavern sanitize-filename behavior', () => {
    assert.equal(sanitizeChatName('Chapter 1: Rain.jsonl'), 'Chapter 1 Rain');
    assert.equal(sanitizeChatName('未完待续....jsonl'), '未完待续...');
    assert.equal(sanitizeChatName('路线A/B? *结局*'), '路线AB 结局');
    assert.equal(sanitizeChatName('备份.jsonl.jsonl'), '备份.jsonl');
    assert.equal(sanitizeChatName('路线A/B.jsonl', { isFileName: false }), '路线AB.jsonl');
    assert.equal(sanitizeChatName('???***'), '');
    assert.equal(sanitizeChatName('CON'), '');
    const veryLong = '甲'.repeat(120);
    assert.ok(new TextEncoder().encode(`${sanitizeChatName(veryLong)}.jsonl`).length <= 255);
});

test('deleting a folder promotes children, deduplicates colliding sibling names, and keeps chat records recoverable', () => {
    let state = upsertFolder(defaults(), { id: 'child', parentId: 'f-active', name: '长篇' });
    state = upsertFolder(state, { id: 'dup-child', parentId: 'f-active', name: '已完结' });
    const parentChat = chatKey('character', '甲.png', 'parent');
    const childChat = chatKey('character', '甲.png', 'child');
    state = assignChats(assignChats(state, [parentChat], 'f-active'), [childChat], 'child');
    const next = deleteFolder(state, 'f-active');
    assert.equal(next.assignments[parentChat], undefined);
    assert.equal(next.assignments[childChat], 'child');
    assert.equal(next.folders.find(f => f.id === 'child').parentId, null);
    assert.equal(next.folders.find(f => f.id === 'dup-child').name, '已完结 (2)');
    assert.equal(state.folders.length, 5, 'input snapshot is unchanged');
});

test('cyclic parent moves, sibling duplicate names, invalid imports, foreign folder references and unsupported schemas throw in strict validate', () => {
    const state = upsertFolder(defaults(), { id: 'child', parentId: 'f-active', name: '支线' });
    assert.throws(() => upsertFolder(state, { id: 'f-active', parentId: 'child', name: '循环' }), /循环/);
    assert.throws(() => upsertFolder(state, { name: '进行中', parentId: null }), /同名/);
    const broken = structuredClone(state); broken.folders[0].parentId = 'missing';
    assert.throws(() => validate(broken), /父级/);
    assert.throws(() => validate({ ...state, schemaVersion: 22 }), /版本/);
    assert.throws(() => validate({ ...state, assignments: { [chatKey('group', 'g', 'a')]: 'absent' } }), /不存在/);
    assert.throws(() => validate({ ...state, assignments: JSON.parse('{"__proto__":"f-active"}') }), /无效/);
    assert.equal(state.folders[0].parentId, null);
});

test('sanitizeAndRecover isolates dirty entries without crashing or losing valid folders and assignments', () => {
    const validKey = chatKey('character', 'lin.png', '有效会话');
    const raw = {
        schemaVersion: 1,
        enabled: true,
        folders: [
            { id: 'f-1', parentId: 'missing-parent', name: '孤儿父级', color: '#112233', order: 0 },
            { id: 'f-2', parentId: null, name: '孤儿父级', color: 'bad', order: 1 },
            { id: 'bad id!', parentId: null, name: '坏ID', order: 2 },
            { id: 'cyc-a', parentId: 'cyc-b', name: '环A', order: 3 },
            { id: 'cyc-b', parentId: 'cyc-a', name: '环B', order: 4 },
        ],
        assignments: {
            [validKey]: 'f-1',
            [chatKey('character', 'lin.png', '悬空文件夹')]: 'non-existent',
            'not-a-json-key': 'f-1',
        },
        preferences: { sort: 'invalid', collapsed: ['f-1', 'non-existent'], autoCleanOnDelete: true },
    };
    const { state, recovered, issues } = sanitizeAndRecover(raw);
    assert.equal(recovered, true);
    assert.ok(issues.length >= 3);
    assert.equal(state.assignments[validKey], 'f-1');
    assert.equal(Object.keys(state.assignments).length, 1);
    assert.equal(state.folders.find(f => f.id === 'f-1').parentId, null);
    assert.equal(state.folders.find(f => f.id === 'f-2').name, '孤儿父级 (2)');
    assert.equal(state.preferences.autoCleanOnDelete, true);
    assert.doesNotThrow(() => validate(state));
});

test('renaming a chat remaps its classification without touching a namesake; keepConflicts preserves non-colliding entries', () => {
    const a = chatKey('character', '甲.png', '旧'); const b = chatKey('character', '乙.png', '旧');
    const dest = chatKey('character', '甲.png', '新');
    const state = assignChats(assignChats(defaults(), [a], 'f-active'), [b], 'f-finished');
    const next = remapKeys(state, p => p.owner === '甲.png' ? dest : null);
    assert.equal(next.assignments[a], undefined); assert.equal(next.assignments[dest], 'f-active'); assert.equal(next.assignments[b], 'f-finished');
    const collision = assignChats(state, [dest], 'f-paused');
    assert.throws(() => remapKeys(collision, p => p.owner === '甲.png' && p.name === '旧' ? dest : null), /冲突/);

    const safe = chatKey('character', '甲.png', '无冲突');
    const withSafe = assignChats(collision, [safe], 'f-active');
    const partial = remapKeys(
        withSafe,
        p => p.owner === '甲.png' && (p.name === '旧' || p.name === '无冲突')
            ? encodeKey('character', '甲.png', p.name === '旧' ? '新' : '无冲突改名')
            : null,
        { keepConflicts: true },
    );
    assert.equal(partial.migrated, 1);
    assert.deepEqual(partial.conflicts, [a]);
    assert.equal(partial.state.assignments[encodeKey('character', '甲.png', '无冲突改名')], 'f-active');
    assert.equal(partial.state.assignments[a], 'f-active', 'colliding old assignment preserved for manual relink');
    assert.equal(partial.state.assignments[dest], 'f-paused');
});

test('mergeStates merges matching folder paths and adds only non-conflicting assignments', () => {
    let local = upsertFolder(defaults(), { id: 'local-sub', parentId: 'f-active', name: '奇幻线' });
    const k1 = chatKey('character', 'a.png', '已有');
    const k2 = chatKey('character', 'a.png', '新增');
    local = assignChats(local, [k1], 'f-finished');

    let remote = upsertFolder(defaults(), { id: 'remote-sub', parentId: 'f-active', name: '奇幻线' });
    remote = upsertFolder(remote, { id: 'remote-new', parentId: 'remote-sub', name: '第二卷' });
    remote = assignChats(assignChats(remote, [k1], 'remote-sub'), [k2], 'remote-new');

    const merged = mergeStates(local, remote);
    assert.equal(merged.addedFolders, 1);
    assert.equal(merged.addedAssignments, 1);
    assert.equal(merged.skippedConflicts, 1);
    assert.equal(merged.state.assignments[k1], 'f-finished', 'local classification wins');
    const vol2 = merged.state.folders.find(f => f.name === '第二卷');
    assert.equal(vol2.parentId, 'local-sub', 'nested under matched existing path');
    assert.equal(merged.state.assignments[k2], vol2.id);
});

test('incomplete catalogs never prune older assignments during export/import', () => {
    const old = chatKey('character', '旧卡.png', '三年前');
    const state = assignChats(defaults(), [old], 'f-finished');
    const imported = validate(JSON.parse(exportState(state)));
    assert.deepEqual(imported, state);
    assert.equal(imported.assignments[old], 'f-finished');
});

test('folder filters, includeSubfolders, pinned priority, and multi-fragment name search work accurately', () => {
    const one = { key: chatKey('character', '甲.png', '夏日 10'), name: '夏日 10', character: '甲', timestamp: 200, preview: 'secret' };
    const two = { key: chatKey('character', '甲.png', '夏日 2'), name: '夏日 2', character: '甲', timestamp: 100 };
    let state = upsertFolder(defaults(), { id: 'sub', parentId: 'f-active', name: '子目录' });
    state = assignChats(assignChats(state, [one.key], 'f-active'), [two.key], 'sub');

    assert.deepEqual(visibleChats([one, two], state, '甲 夏日').map(c => c.key), [one.key, two.key]);
    assert.equal(visibleChats([one, two], state, 'secret').length, 0);
    assert.deepEqual(visibleChats([one, two], state, '', { folderId: 'f-active', includeSubfolders: false }).map(c => c.key), [one.key]);
    assert.deepEqual(visibleChats([one, two], state, '', { folderId: 'f-active', includeSubfolders: true }).map(c => c.key), [one.key, two.key]);
    assert.deepEqual(
        visibleChats([one, two], state, '', { folderId: '@all', pinnedKeys: new Set([two.key]) }).map(c => c.key),
        [two.key, one.key],
    );
    state.preferences.folderId = '@all'; state.preferences.sort = 'name';
    assert.deepEqual(visibleChats([one, two], state).map(c => c.name), ['夏日 2', '夏日 10']);
});
