import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, chatKey, parseKey, upsertFolder, assignChats, deleteFolder, remapKeys, visibleChats, exportState } from '../src/model.js';

test('same chat names on different characters/groups remain independent; only terminal suffix is removed', () => {
    const a = chatKey('character', '甲.png', '长篇.jsonl.续篇.jsonl');
    const b = chatKey('character', '乙.png', '长篇.jsonl.续篇');
    const c = chatKey('group', '甲.png', '长篇.jsonl.续篇');
    assert.equal(parseKey(a).name, '长篇.jsonl.续篇');
    assert.notEqual(a, b); assert.notEqual(a, c);
    let state = assignChats(defaults(), [a], 'f-active');
    state = assignChats(state, [b], 'f-finished');
    assert.equal(state.assignments[a], 'f-active'); assert.equal(state.assignments[b], 'f-finished');
});
test('deleting a folder promotes children and keeps all chat records recoverable', () => {
    let state = upsertFolder(defaults(), { id: 'child', parentId: 'f-active', name: '长篇' });
    const parentChat = chatKey('character', '甲.png', 'parent');
    const childChat = chatKey('character', '甲.png', 'child');
    state = assignChats(assignChats(state, [parentChat], 'f-active'), [childChat], 'child');
    const next = deleteFolder(state, 'f-active');
    assert.equal(next.assignments[parentChat], undefined);
    assert.equal(next.assignments[childChat], 'child');
    assert.equal(next.folders.find(f => f.id === 'child').parentId, null);
    assert.equal(state.folders.length, 4, 'input snapshot is unchanged');
});
test('cyclic parent moves, invalid imports, foreign folder references and unsupported schemas cannot corrupt settings', () => {
    const state = upsertFolder(defaults(), { id: 'child', parentId: 'f-active', name: '支线' });
    assert.throws(() => upsertFolder(state, { id: 'f-active', parentId: 'child', name: '循环' }), /循环/);
    const broken = structuredClone(state); broken.folders[0].parentId = 'missing';
    assert.throws(() => validate(broken), /父级/);
    assert.throws(() => validate({ ...state, schemaVersion: 22 }), /版本/);
    assert.throws(() => validate({ ...state, assignments: { [chatKey('group', 'g', 'a')]: 'absent' } }), /不存在/);
    assert.throws(() => validate({ ...state, assignments: JSON.parse('{"__proto__":"f-active"}') }), /无效/);
    assert.equal(state.folders[0].parentId, null);
});
test('renaming a chat remaps its classification without touching a namesake', () => {
    const a = chatKey('character', '甲.png', '旧'); const b = chatKey('character', '乙.png', '旧');
    const dest = chatKey('character', '甲.png', '新');
    const state = assignChats(assignChats(defaults(), [a], 'f-active'), [b], 'f-finished');
    const next = remapKeys(state, p => p.owner === '甲.png' ? dest : null);
    assert.equal(next.assignments[a], undefined); assert.equal(next.assignments[dest], 'f-active'); assert.equal(next.assignments[b], 'f-finished');
    const collision = assignChats(state, [dest], 'f-paused');
    assert.throws(() => remapKeys(collision, p => p.owner === '甲.png' && p.name === '旧' ? dest : null), /冲突/);
});
test('incomplete catalogs never prune older assignments during export/import', () => {
    const old = chatKey('character', '旧卡.png', '三年前');
    const state = assignChats(defaults(), [old], 'f-finished');
    const imported = validate(JSON.parse(exportState(state)));
    assert.deepEqual(imported, state);
    assert.equal(imported.assignments[old], 'f-finished');
});
test('folder filters and multi-fragment name search do not search private preview text', () => {
    const one = { key: chatKey('character', '甲.png', '夏日 10'), name: '夏日 10', character: '甲', timestamp: 200, preview: 'secret' };
    const two = { key: chatKey('character', '甲.png', '夏日 2'), name: '夏日 2', character: '甲', timestamp: 100 };
    const state = assignChats(defaults(), [one.key], 'f-active');
    assert.deepEqual(visibleChats([one, two], state, '甲 夏日').map(c => c.key), [one.key, two.key]);
    assert.equal(visibleChats([one, two], state, 'secret').length, 0);
    state.preferences.folderId = '@unfiled';
    assert.deepEqual(visibleChats([one, two], state).map(c => c.key), [two.key]);
    state.preferences.folderId = '@all'; state.preferences.sort = 'name';
    assert.deepEqual(visibleChats([one, two], state).map(c => c.name), ['夏日 2', '夏日 10']);
});
