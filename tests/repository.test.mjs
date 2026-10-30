import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRepository, normalizeCatalog, openChat, deleteChat } from '../src/repository.js';
import { chatKey } from '../src/model.js';
const context = () => ({
    characters: [{ avatar: '甲.png', name: '甲' }], groups: [{ id: 'g1', name: '群聊', chats: ['旧档'] }],
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock' }),
    getThumbnailUrl: (_, name) => `/thumbnail?file=${encodeURIComponent(name)}`,
});
const rows = [
    { avatar: '甲.png', file_name: '旧档.jsonl', last_mes: 1000, chat_items: 200, file_size: '3 MB', mes: '<script>private</script>' },
    { group: 'g1', file_name: '旧档.jsonl', last_mes: '2025-01-02T00:00:00Z', chat_items: 2 },
    { avatar: '不存在.png', file_name: '孤立.jsonl' }, { file_name: '无角色.jsonl' },
];

function deletionContext() {
    const ctx = context(); const handlers = new Map();
    ctx.getCurrentChatId = () => undefined;
    ctx.eventTypes = { CHAT_DELETED: 'character', GROUP_CHAT_DELETED: 'group' };
    ctx.eventSource = {
        on: (event, fn) => handlers.set(event, fn),
        removeListener: (event, fn) => { assert.equal(handlers.get(event), fn); handlers.delete(event); },
        emit: (event, name) => handlers.get(event)?.(name),
    };
    return { ctx, handlers };
}

test('character deletion passes the exact owner index and filename to core and requires its success event', async () => {
    const { ctx, handlers } = deletionContext();
    const chat = { kind: 'character', owner: '甲.png', name: '旧档' };
    await deleteChat(chat, () => ctx, async url => {
        assert.equal(url, '/script.js');
        return { deleteCharacterChatByName: async (id, name) => {
            assert.equal(id, '0'); assert.equal(name, '旧档'); ctx.eventSource.emit('character', name);
        } };
    });
    assert.equal(handlers.size, 0);
    await assert.rejects(deleteChat(chat, () => ctx, async () => ({ deleteCharacterChatByName: async () => {} })), /未确认删除/);
    assert.equal(handlers.size, 0);
});

test('successful group deletion uses the native group ID, preserves the core update, and ignores character namesakes', async () => {
    const { ctx, handlers } = deletionContext(); ctx.groups[0].id = 42;
    const chat = { kind: 'group', owner: '42', name: '旧档' };
    await deleteChat(chat, () => ctx, async url => {
        assert.equal(url, '/scripts/group-chats.js');
        return { deleteGroupChatByName: async (id, name) => {
            assert.equal(id, 42); assert.equal(name, '旧档');
            ctx.groups[0].chats = []; ctx.eventSource.emit('group', name);
        } };
    });
    assert.deepEqual(ctx.groups[0].chats, []); assert.equal(handlers.size, 0);
});

test('failed native group deletion restores optimistic membership and active-chat pointer', async () => {
    for (const throws of [false, true]) {
        const { ctx, handlers } = deletionContext(); const group = ctx.groups[0];
        group.chats = ['前', '旧档', '后']; group.chat_id = '旧档';
        await assert.rejects(deleteChat({ kind: 'group', owner: 'g1', name: '旧档' }, () => ctx, async () => ({
            deleteGroupChatByName: async () => {
                group.chats.splice(1, 1); group.chat_id = '后';
                if (throws) throw new Error('网络断开');
            },
        })), /未确认删除|网络断开/);
        assert.deepEqual(group.chats, ['前', '旧档', '后']); assert.equal(group.chat_id, '旧档'); assert.equal(handlers.size, 0);
    }
});

test('deletion refuses missing owners, missing group membership, and a chat opened while imports load', async () => {
    const { ctx } = deletionContext();
    const never = async () => ({ deleteCharacterChatByName: () => assert.fail('must not delete'), deleteGroupChatByName: () => assert.fail('must not delete') });
    await assert.rejects(deleteChat({ kind: 'character', owner: '不存在.png', name: '旧档' }, () => ctx, never), /已改变/);
    await assert.rejects(deleteChat({ kind: 'group', owner: 'g1', name: '不存在' }, () => ctx, never), /已改变/);
    await assert.rejects(deleteChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async () => {
        ctx.getCurrentChatId = () => '刚打开的聊天'; return never();
    }), /其他会话/);
});

test('an unrelated native deletion event is not accepted as confirmation', async () => {
    const { ctx, handlers } = deletionContext();
    await assert.rejects(deleteChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async () => ({
        deleteCharacterChatByName: async () => ctx.eventSource.emit('character', '其他档'),
    })), /未确认删除/);
    assert.equal(handlers.size, 0);
});

test('a later event subscriber error cannot undo confirmed deletion', async () => {
    const { ctx } = deletionContext();
    await deleteChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async () => ({
        deleteCharacterChatByName: async (_, name) => { ctx.eventSource.emit('character', name); throw new Error('other extension'); },
    }));
});
test('normalizes native recent payload and skips unsupported orphans instead of opening a wrong character', () => {
    const data = normalizeCatalog(rows, context());
    assert.equal(data.chats.length, 2); assert.equal(data.skipped, 2);
    assert.equal(data.chats[0].name, '旧档');
    assert.equal(data.chats[0].preview, '<script>private</script>');
    assert.notEqual(data.chats[0].key, data.chats[1].key);
    assert.equal(data.chats[1].timestamp, Date.parse('2025-01-02T00:00:00Z'));
});
test('full scan omits max, includes CSRF headers and does not send chat bodies', async () => {
    const requests = [];
    const repo = new ChatRepository(context, { fetcher: async (url, init) => {
        requests.push({ url, init }); return { ok: true, json: async () => rows };
    } });
    await repo.load(); await repo.load({ full: true });
    assert.equal(JSON.parse(requests[0].init.body).max, 60);
    assert.equal(Object.hasOwn(JSON.parse(requests[1].init.body), 'max'), false);
    assert.equal(requests[1].url, '/api/chats/recent');
    assert.equal(requests[1].init.headers['X-CSRF-Token'], 'mock');
    assert.equal(repo.complete, true);
});
test('concurrent callers share one scan, including promotion of partial to full', async () => {
    let requests = 0;
    const repo = new ChatRepository(context, { fetcher: async () => {
        requests++; await new Promise(r => setTimeout(r, 8)); return { ok: true, json: async () => rows };
    } });
    await Promise.all([repo.load(), repo.load({ full: true }), repo.load({ full: true })]);
    assert.equal(requests, 2); assert.equal(repo.complete, true);
});
test('scan failure retains already available catalog and never claims full coverage', async () => {
    let fail = false;
    const repo = new ChatRepository(context, { fetcher: async () => fail ? { ok: false, status: 503 } : { ok: true, json: async () => rows } });
    await repo.load(); const snapshot = repo.chats; fail = true;
    await assert.rejects(repo.load({ full: true }), /503/);
    assert.equal(repo.chats, snapshot); assert.equal(repo.complete, false);
});
test('late responses after disposal cannot change catalog', async () => {
    let resolve;
    const repo = new ChatRepository(context, { fetcher: async () => new Promise(r => { resolve = r; }) });
    const pending = repo.load({ full: true }); repo.dispose();
    resolve({ ok: true, json: async () => rows });
    await assert.rejects(pending, /取消/);
    assert.equal(repo.chats.length, 0); assert.equal(repo.complete, false);
});
test('character opening selects correct owner before opening named file', async () => {
    const ctx = context(); let active; let current;
    ctx.getCurrentChatId = () => current;
    ctx.selectCharacterById = async id => { ctx.characterId = id; current = '其他档'; };
    ctx.openCharacterChat = async name => { assert.equal(active, '甲.png'); current = name; };
    ctx.saveSettingsDebounced = () => {};
    await openChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async url => {
        assert.equal(url, '/script.js'); return { setActiveCharacter: owner => { active = owner; } };
    });
    assert.equal(current, '旧档');
});
test('a refused character switch never opens a file in the wrong character', async () => {
    const ctx = context(); ctx.getCurrentChatId = () => undefined;
    ctx.selectCharacterById = async () => {}; ctx.characterId = 10;
    ctx.openCharacterChat = () => { throw new Error('must not be reached'); };
    await assert.rejects(openChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async () => ({})), /无法切换/);
});
test('a different conversation opened while modules load is never overwritten', async () => {
    const ctx = context(); let current;
    ctx.getCurrentChatId = () => current;
    ctx.selectCharacterById = () => { throw new Error('must not switch'); };
    await assert.rejects(openChat({ kind: 'character', owner: '甲.png', name: '旧档' }, () => ctx, async () => {
        current = '用户刚打开的另一个聊天'; return {};
    }), /页面已切换/);
    assert.equal(current, '用户刚打开的另一个聊天');
});
test('group opening validates membership and selects the actual group ID', async () => {
    const ctx = context(); let current;
    ctx.getCurrentChatId = () => current; ctx.saveSettingsDebounced = () => {};
    ctx.openGroupChat = async (id, name) => { assert.equal(id, 'g1'); assert.equal(ctx.groupId, 'g1'); current = name; };
    await openChat({ kind: 'group', owner: 'g1', name: '旧档' }, () => ctx, async url => url === '/script.js' ? {} : {
        openGroupById: async id => { ctx.groupId = id; current = '别的会话'; return true; },
    });
    assert.equal(current, '旧档');
    current = undefined;
    await assert.rejects(openChat({ kind: 'group', owner: 'g1', name: '不存在' }, () => ctx, async () => ({})), /群聊已改变/);
    assert.equal(chatKey('group', 'g1', current ?? 'x'), '["group","g1","x"]');
});
