import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeFolders } from '../src/controller.js';
import { SETTINGS_KEY, defaults, copy, chatKey, encodeKey, assignChats } from '../src/model.js';
import { loadViewState, CORRUPT_BACKUP_KEY, PINNED_CHATS_KEY, readPinnedKeys, setPinnedChat } from '../src/storage.js';

function createStorage() {
    const map = new Map();
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
    };
}

function fixture() {
    const state = defaults(); let saves = 0;
    const accountStorage = createStorage();
    const context = {
        accountStorage,
        characters: [{ avatar: 'lin.png', name: '林间旅人', chat: '当前档' }],
        groups: [{ id: '42', name: '测试群组', chats: ['旧名'] }],
        extensionSettings: { [SETTINGS_KEY]: copy(state) },
        saveSettingsDebounced: () => { saves++; },
    };
    const repository = { chats: [], complete: false };
    const app = new HomeFolders(() => context, { repository });
    app.state = state;
    app.viewState = loadViewState(context, state);
    app.render = () => {};
    app.renderTree = () => {};
    app.renderList = () => {};
    app.renderStatus = () => {};
    app.showError = error => { app.error = error.message; };
    return { app, context, accountStorage, repository, saves: () => saves };
}

test('a stale dialog cannot overwrite newer account classification', () => {
    const { app, context, saves } = fixture();
    const newer = copy(app.state); newer.revision = 'newer-account-update'; newer.folders[0].name = '另一处的修改';
    context.extensionSettings[SETTINGS_KEY] = newer;
    assert.throws(() => app.commit(s => { s.folders[0].name = '旧对话框覆盖'; return s; }), /已在其他操作/);
    assert.equal(context.extensionSettings[SETTINGS_KEY].folders[0].name, '另一处的修改');
    assert.equal(saves(), 0);
});

test('missing classification stays visible even when error banner is active, and never prunes data', () => {
    const { app, context, repository, saves } = fixture();
    const key = chatKey('character', '早期角色.png', '三年前的会话');
    app.state = assignChats(app.state, [key], 'f-active');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    assert.deepEqual(app.missing(), []);
    repository.complete = true;
    assert.deepEqual(app.missing(), [key]);
    app.loading = true; assert.deepEqual(app.missing(), []); app.loading = false;
    app.error = '重命名后的分类存在冲突，请在“待关联”中手动处理。';
    assert.deepEqual(app.missing(), [key], 'error state must NOT hide missing button');
    app.error = '';
    app.invalidate(); assert.deepEqual(app.missing(), []);
    assert.equal(app.state.assignments[key], 'f-active'); assert.equal(saves(), 0);
});

test('transient viewState folder switching and collapsing write only to accountStorage without triggering saveSettingsDebounced', () => {
    const { app, accountStorage, saves } = fixture();
    const revBefore = app.state.revision;
    app.setFolder('f-active');
    app.toggleCollapse('f-active');
    assert.equal(saves(), 0);
    assert.equal(app.state.revision, revBefore);
    const persisted = JSON.parse(accountStorage.getItem('hcf_view_state'));
    assert.equal(persisted.folderId, 'f-active');
    assert.deepEqual(persisted.collapsed, ['f-active']);
});

test('native group and character CHAT_RENAMED handles unsanitized newFileName and .jsonl.jsonl without losing classification', () => {
    const { app, context } = fixture();
    const groupKey = chatKey('group', '42', '旧名');
    const charKey = chatKey('character', 'lin.png', '存档.jsonl.jsonl');
    app.state = assignChats(assignChats(app.state, [groupKey], 'f-active'), [charKey], 'f-finished');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);

    // Simulate ST 1.19.0 updating group.chats with sanitized name while emitting unsanitized renamed_file
    context.groups[0].chats = ['Chapter 1 Rain'];
    app.renamedChat({ groupId: '42', oldFileName: '旧名.jsonl', newFileName: 'Chapter 1: Rain.jsonl' });
    assert.equal(app.state.assignments[encodeKey('group', '42', 'Chapter 1 Rain')], 'f-active');
    assert.equal(app.state.assignments[groupKey], undefined);
    assert.equal(app.dirty, true);

    // Simulate renaming TO and FROM a name ending in .jsonl ("存档.jsonl.jsonl") while pinned
    setPinnedChat(context, { kind: 'character', owner: 'lin.png', name: '存档.jsonl' }, true);
    assert.equal(readPinnedKeys(context).has(charKey), true);
    app.renamedChat({ avatarId: 'lin.png', oldFileName: '存档.jsonl.jsonl', newFileName: '路线A/B.jsonl.jsonl' });
    const renamedDoubleExtKey = encodeKey('character', 'lin.png', '路线AB.jsonl');
    assert.equal(app.state.assignments[renamedDoubleExtKey], 'f-finished');
    assert.equal(app.state.assignments[charKey], undefined);
    assert.equal(readPinnedKeys(context).has(renamedDoubleExtKey), true);
    assert.equal(readPinnedKeys(context).has(charKey), false);
});

test('character rename migrates non-conflicting chats, preserves conflicting entry for relink, and still invalidates catalog', () => {
    const { app, context } = fixture();
    const a = chatKey('character', 'old.png', '无冲突');
    const b = chatKey('character', 'old.png', '同名档');
    const existingNew = chatKey('character', 'new.png', '同名档');
    app.state = assignChats(assignChats(assignChats(app.state, [a, b], 'f-active'), [existingNew], 'f-finished'), [], 'f-active');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    app.dirty = false;

    app.renamedCharacter('old.png', 'new.png');
    assert.equal(app.state.assignments[chatKey('character', 'new.png', '无冲突')], 'f-active', 'non-colliding chat migrated');
    assert.equal(app.state.assignments[existingNew], 'f-finished', 'target kept intact');
    assert.equal(app.state.assignments[b], 'f-active', 'colliding source preserved for missingDialog');
    assert.equal(app.dirty, true, 'invalidate executed in finally despite conflict warning');
    assert.match(app.error, /待关联/);
});

test('manual refresh syncs in-memory characters and groups via context.getCharacters()', async () => {
    const { app, context, repository } = fixture();
    let charSynced = false;
    context.getCharacters = async () => { charSynced = true; };
    repository.load = async () => { repository.complete = true; repository.lastLoaded = Date.now(); };
    await app.refresh({ manual: true });
    assert.equal(charSynced, true);
    assert.equal(app.loading, false);
});

test('autoCleanOnDelete cleans assignments and pinnedChats when native deletion events fire', () => {
    const { app, context, accountStorage } = fixture();
    app.state.preferences.autoCleanOnDelete = true;
    const cKey = chatKey('character', 'lin.png', '当前档');
    const gKey = chatKey('group', '42', '旧名');
    app.state = assignChats(app.state, [cKey, gKey], 'f-active');
    context.extensionSettings[SETTINGS_KEY] = copy(app.state);
    setPinnedChat(context, { kind: 'character', owner: 'lin.png', name: '当前档' }, true);

    context.characterId = 0;
    app.handleNativeChatDeleted('当前档');
    assert.equal(app.state.assignments[cKey], undefined);
    assert.equal(JSON.parse(accountStorage.getItem(PINNED_CHATS_KEY) ?? '{}')['char_lin.png_当前档.jsonl'], undefined);

    context.groups[0].chats = [];
    app.handleNativeGroupChatDeleted('旧名');
    assert.equal(app.state.assignments[gKey], undefined);
});

test('parseBackupJson strips UTF-8 BOM and translates invalid JSON SyntaxError into clear Chinese message', () => {
    const { app } = fixture();
    assert.throws(() => app.parseBackupJson('{bad json'), /无法解析 JSON/);
    const bomJson = '\uFEFF' + JSON.stringify({ ...defaults(), schemaVersion: 1 });
    const { imported } = app.parseBackupJson(bomJson);
    assert.equal(imported.schemaVersion, 1);
});

test('initialize soft-recovers corrupt stored settings and backs up raw payload to accountStorage without throwing', () => {
    const accountStorage = createStorage();
    const handlers = new Map();
    const validKey = chatKey('character', 'lin.png', '幸存会话');
    const corruptRaw = {
        schemaVersion: 1,
        folders: [{ id: 'f-ok', parentId: null, name: '幸存文件夹', color: '#b7a4ff', order: 0 }],
        assignments: { [validKey]: 'f-ok', 'corrupt-key': 'missing-folder' },
    };
    let saved = 0;
    const ctx = {
        accountStorage,
        extensionSettings: { [SETTINGS_KEY]: corruptRaw },
        eventTypes: {},
        eventSource: { on: (t, f) => handlers.set(t, f), removeListener: () => {} },
        saveSettingsDebounced: () => { saved++; },
        getCurrentChatId: () => 'in-chat',
    };
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: () => null, querySelector: () => null };
    try {
        const app = new HomeFolders(() => ctx, { repository: { chats: [], complete: false, dispose: () => {} } });
        assert.doesNotThrow(() => app.initialize());
        assert.equal(app.state.assignments[validKey], 'f-ok');
        assert.equal(Object.keys(app.state.assignments).length, 1);
        assert.equal(saved, 1);
        const backup = JSON.parse(accountStorage.getItem(CORRUPT_BACKUP_KEY));
        assert.equal(backup.raw.assignments['corrupt-key'], 'missing-folder');
        app.dispose();
    } finally {
        globalThis.document = prevDoc;
    }
});

test('incoming chat events during a scan keep the catalog marked dirty', async () => {
    const { app, repository } = fixture();
    repository.lastLoaded = Date.now(); repository.load = async () => { app.invalidate(); repository.complete = true; };
    await app.refresh(); assert.equal(app.dirty, true); assert.equal(app.loading, false);
});

function deletionFixture() {
    const f = fixture();
    f.repository.chats = ['甲.png', '乙.png', '丙.png'].map(owner => ({ key: chatKey('character', owner, '同名存档'), kind: 'character', owner, name: '同名存档', character: owner }));
    f.repository.complete = true;
    const orphanKey = chatKey('character', '失联.png', '旧档');
    f.app.state = assignChats(f.app.state, [...f.repository.chats.map(c => c.key), orphanKey], 'f-active');
    f.context.extensionSettings[SETTINGS_KEY] = copy(f.app.state);
    f.context.getCurrentChatId = () => undefined;
    f.app.confirm = async () => true;
    return { ...f, orphanKey };
}

test('cancelled deletion makes no native calls, settings writes or selection changes', async () => {
    const { app, repository, saves } = deletionFixture(); const keys = repository.chats.map(c => c.key);
    app.selected = new Set(keys); app.confirm = async () => false;
    app.deleter = () => assert.fail('cancel must not delete');
    await app.deleteChats(keys);
    assert.equal(repository.chats.length, 3); assert.deepEqual([...app.selected], keys);
    assert.equal(saves(), 0); assert.equal(app.deleting, false);
});

test('confirmed homepage deletion clears classifications, unpins deleted chats, and keeps missing() orphan visible', async () => {
    const { app, context, repository, saves, orphanKey } = deletionFixture();
    const keys = repository.chats.map(c => c.key);
    setPinnedChat(context, repository.chats[0], true);
    app.selected = new Set(keys); const calls = [];
    app.confirm = async (_, message) => { assert.match(message, /甲.png \/ 同名存档/); assert.match(message, /无法.*恢复/); return true; };
    app.deleter = async (chat, getContext) => { assert.equal(getContext(), context); calls.push(chat.key); assert.equal(app.deleting, true); };
    await app.deleteChats([keys[0], keys[0], keys[1]]);
    assert.deepEqual(calls, keys.slice(0, 2)); assert.deepEqual(repository.chats.map(c => c.key), [keys[2]]);
    assert.deepEqual([...app.selected], [keys[2]]);
    assert.deepEqual(Object.keys(app.state.assignments).sort(), [keys[2], orphanKey].sort());
    assert.deepEqual(app.missing(), [orphanKey], 'deleting on homepage must not hide existing missing orphan button');
    assert.equal(saves(), 1); assert.match(app.notice, /2/); assert.equal(app.deleting, false);
});

test('batch failure stops further deletion and retains failed and unattempted chats and classifications', async () => {
    const { app, repository, orphanKey } = deletionFixture(); const keys = repository.chats.map(c => c.key);
    app.selected = new Set(keys); let calls = 0;
    app.deleter = async () => { if (++calls === 2) throw new Error('服务器断开'); };
    await app.deleteChats(keys);
    assert.equal(calls, 2); assert.deepEqual(repository.chats.map(c => c.key), keys.slice(1));
    assert.deepEqual([...app.selected], keys.slice(1));
    assert.deepEqual(Object.keys(app.state.assignments).sort(), [...keys.slice(1), orphanKey].sort());
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
    assert.equal(Object.keys(app.state.assignments).length, 3);
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
