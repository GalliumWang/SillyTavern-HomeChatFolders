import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeFolders } from '../src/controller.js';
import { SETTINGS_KEY, defaults, copy, chatKey, assignChats } from '../src/model.js';

function fixture() {
    const state = defaults(); let saves = 0;
    const context = { extensionSettings: { [SETTINGS_KEY]: copy(state) }, saveSettingsDebounced: () => { saves++; } };
    const repository = { chats: [], complete: false };
    const app = new HomeFolders(() => context, { repository });
    app.state = state; app.render = () => {}; app.showError = error => { app.error = error.message; };
    return { app, context, repository, saves: () => saves };
}
test('a stale dialog cannot overwrite newer account classification', () => {
    const { app, context, saves } = fixture();
    const newer = copy(app.state); newer.revision = 'newer-account-update'; newer.folders[0].name = '另一处的修改';
    context.extensionSettings[SETTINGS_KEY] = newer;
    assert.throws(() => app.commit(s => { s.folders[0].name = '旧对话框覆盖'; return s; }), /已在其他操作/);
    assert.equal(context.extensionSettings[SETTINGS_KEY].folders[0].name, '另一处的修改');
    assert.equal(saves(), 0);
});
test('missing classification appears only after complete successful scanning, and never prunes data', () => {
    const { app, context, repository, saves } = fixture();
    const key = chatKey('character', '早期角色.png', '三年前的会话');
    app.state = assignChats(app.state, [key], 'f-active');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    assert.deepEqual(app.missing(), []);
    repository.complete = true; assert.deepEqual(app.missing(), [key]);
    app.loading = true; assert.deepEqual(app.missing(), []); app.loading = false;
    app.error = '扫描失败'; assert.deepEqual(app.missing(), []); app.error = '';
    app.invalidate(); assert.deepEqual(app.missing(), []);
    assert.equal(app.state.assignments[key], 'f-active'); assert.equal(saves(), 0);
});
test('native group rename migrates classification without matching a character namesake', () => {
    const { app, context } = fixture();
    const group = chatKey('group', '42', '旧名'); const character = chatKey('character', '42', '旧名');
    app.state = assignChats(assignChats(app.state, [group], 'f-active'), [character], 'f-finished');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    app.renamedChat({ groupId: '42', oldFileName: '旧名.jsonl', newFileName: '新名.jsonl' });
    assert.equal(app.state.assignments[chatKey('group', '42', '新名')], 'f-active');
    assert.equal(app.state.assignments[character], 'f-finished');
    assert.equal(app.state.assignments[group], undefined); assert.equal(app.dirty, true);
});
test('character rename carries all historical assignments including currently unloaded chats', () => {
    const { app, context } = fixture();
    const a = chatKey('character', 'old.png', '较新的'); const b = chatKey('character', 'old.png', '很久以前');
    app.state = assignChats(assignChats(app.state, [a], 'f-active'), [b], 'f-finished');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    app.renamedCharacter('old.png', 'new.png');
    assert.equal(app.state.assignments[chatKey('character', 'new.png', '较新的')], 'f-active');
    assert.equal(app.state.assignments[chatKey('character', 'new.png', '很久以前')], 'f-finished');
    assert.equal(Object.keys(app.state.assignments).length, 2);
});
test('incoming chat events during a scan keep the catalog marked dirty', async () => {
    const { app, repository } = fixture();
    repository.lastLoaded = Date.now(); repository.load = async () => { app.invalidate(); repository.complete = true; };
    app.renderStatus = () => {};
    await app.refresh(); assert.equal(app.dirty, true); assert.equal(app.loading, false);
});

function deletionFixture() {
    const f = fixture();
    f.repository.chats = ['甲.png', '乙.png', '丙.png'].map(owner => ({ key: chatKey('character', owner, '同名存档'), kind: 'character', owner, name: '同名存档', character: owner }));
    f.app.state = assignChats(f.app.state, f.repository.chats.map(c => c.key), 'f-active');
    f.context.extensionSettings[SETTINGS_KEY] = copy(f.app.state);
    f.context.getCurrentChatId = () => undefined;
    f.app.confirm = async () => true;
    return f;
}

test('cancelled deletion makes no native calls, settings writes or selection changes', async () => {
    const { app, repository, saves } = deletionFixture(); const keys = repository.chats.map(c => c.key);
    app.selected = new Set(keys); app.confirm = async () => false;
    app.deleter = () => assert.fail('cancel must not delete');
    await app.deleteChats(keys);
    assert.equal(repository.chats.length, 3); assert.deepEqual([...app.selected], keys);
    assert.equal(saves(), 0); assert.equal(app.deleting, false);
});

test('confirmed cross-owner batch deletion deduplicates, serializes and clears only successful classifications', async () => {
    const { app, context, repository, saves } = deletionFixture(); const keys = repository.chats.map(c => c.key);
    app.selected = new Set(keys); const calls = [];
    app.confirm = async (_, message) => { assert.match(message, /甲.png \/ 同名存档/); assert.match(message, /无法.*恢复/); return true; };
    app.deleter = async (chat, getContext) => { assert.equal(getContext(), context); calls.push(chat.key); assert.equal(app.deleting, true); };
    await app.deleteChats([keys[0], keys[0], keys[1]]);
    assert.deepEqual(calls, keys.slice(0, 2)); assert.deepEqual(repository.chats.map(c => c.key), [keys[2]]);
    assert.deepEqual([...app.selected], [keys[2]]); assert.deepEqual(Object.keys(app.state.assignments), [keys[2]]);
    assert.equal(saves(), 1); assert.match(app.notice, /2/); assert.equal(app.deleting, false);
});

test('batch failure stops further deletion and retains failed and unattempted chats and classifications', async () => {
    const { app, repository } = deletionFixture(); const keys = repository.chats.map(c => c.key);
    app.selected = new Set(keys); let calls = 0;
    app.deleter = async () => { if (++calls === 2) throw new Error('服务器断开'); };
    await app.deleteChats(keys);
    assert.equal(calls, 2); assert.deepEqual(repository.chats.map(c => c.key), keys.slice(1));
    assert.deepEqual([...app.selected], keys.slice(1)); assert.deepEqual(Object.keys(app.state.assignments), keys.slice(1));
    assert.match(app.error, /已删除 1 个，2 个未确认删除.*服务器断开/);
});

test('cleanup preserves newer settings received during native deletion', async () => {
    const { app, context, repository } = deletionFixture(); const key = repository.chats[0].key;
    app.deleter = async () => {
        const newer = copy(app.state); newer.revision = 'newer'; newer.folders[0].name = '新名称';
        context.extensionSettings[SETTINGS_KEY] = newer;
    };
    await app.deleteChats([key]);
    assert.equal(app.state.folders[0].name, '新名称'); assert.equal(app.state.assignments[key], undefined);
    assert.equal(Object.keys(app.state.assignments).length, 2);
});

test('a successful retry clears the previous deletion error', async () => {
    const { app, repository } = deletionFixture(); const key = repository.chats[0].key;
    app.deleter = async () => { throw new Error('连接中断'); };
    await app.deleteChats([key]); assert.match(app.error, /连接中断/);
    app.deleter = async () => {};
    await app.deleteChats([key]); assert.equal(app.error, ''); assert.match(app.notice, /已永久删除 1/);
});

test('confirmation does not authorize deletion after navigating into another chat or disabling the extension', async () => {
    for (const disable of [false, true]) {
        const { app, context, repository, saves } = deletionFixture();
        app.confirm = async () => { if (disable) app.stopped = true; else context.getCurrentChatId = () => '其他聊天'; return true; };
        app.deleter = () => assert.fail('must not delete');
        await app.deleteChats([repository.chats[0].key]);
        assert.equal(repository.chats.length, 3); assert.equal(saves(), 0); assert.equal(app.deleting, false);
    }
});

test('pending deletion blocks duplicate confirmation, chat opening, and directory refresh', async () => {
    const { app, repository } = deletionFixture(); let resolve; let confirmations = 0;
    app.confirm = () => { confirmations++; return new Promise(r => { resolve = r; }); };
    app.opener = () => assert.fail('must not open'); repository.load = () => assert.fail('must not scan');
    const pending = app.deleteChats([repository.chats[0].key]);
    await app.deleteChats([repository.chats[1].key]); await app.open(repository.chats[1]); await app.refresh();
    assert.equal(confirmations, 1); resolve(false); await pending; assert.equal(app.deleting, false);
});
