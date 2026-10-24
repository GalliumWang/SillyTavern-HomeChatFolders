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
