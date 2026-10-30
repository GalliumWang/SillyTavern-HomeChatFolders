// Development-only fixture. This file is never included in the install ZIP.
const handlers = new Map();
const types = Object.fromEntries(['APP_READY', 'CHAT_CHANGED', 'SETTINGS_UPDATED', 'CHAT_RENAMED', 'CHARACTER_RENAMED', 'CHAT_CREATED', 'CHAT_DELETED',
    'GROUP_CHAT_CREATED', 'GROUP_CHAT_DELETED', 'CHARACTER_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED'].map(x => [x, x.toLowerCase()]));
const emitter = {
    on(type, handler) { const all = handlers.get(type) ?? []; all.push(handler); handlers.set(type, all); },
    removeListener(type, handler) { handlers.set(type, (handlers.get(type) ?? []).filter(x => x !== handler)); },
    async emit(type, ...args) { for (const fn of [...(handlers.get(type) ?? [])]) await fn(...args); },
};
const stored = localStorage.getItem('hcf-preview-settings');
export const context = {
    characters: [{ avatar: 'lin.png', name: '林间旅人' }, { avatar: 'city.png', name: '城市来信' }, { avatar: 'sea.png', name: '海边书店' }],
    groups: [{ id: 'g1', name: '冒险小队', chats: ['远行的第一天', '营火夜谈', '最后一封信'] }],
    extensionSettings: stored ? JSON.parse(stored) : {}, eventTypes: types, eventSource: emitter,
    characterId: undefined, groupId: null, chatId: undefined,
    getCurrentChatId() { return this.chatId; },
    getRequestHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }; },
    getThumbnailUrl() { return '/tests/avatar.svg'; },
    saveSettingsDebounced() { localStorage.setItem('hcf-preview-settings', JSON.stringify(context.extensionSettings)); },
    async selectCharacterById(id) { context.characterId = id; context.groupId = null; context.chatId = 'default'; },
    async openCharacterChat(name) { context.chatId = name; showChat(context.characters[context.characterId].name, name); await emitter.emit(types.CHAT_CHANGED); },
    async openGroupChat(id, name) { context.groupId = id; context.chatId = name; showChat(context.groups.find(g => g.id === id).name, name); await emitter.emit(types.CHAT_CHANGED); },
};
context.getCurrentChatId = context.getCurrentChatId.bind(context);
export function setActiveCharacter() {}
export function setActiveGroup() {}
export async function openGroupById(id) { context.groupId = id; context.characterId = undefined; context.chatId = 'default'; return true; }
export async function deleteCharacterChatByName(id, name) {
    const response = await fetch('/api/chats/delete', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: context.characters[id].avatar, chatfile: `${name}.jsonl` }) });
    if (response.ok) await emitter.emit(types.CHAT_DELETED, name);
}
export async function deleteGroupChatByName(id, name) {
    const group = context.groups.find(g => g.id === id);
    if (!group?.chats.includes(name)) return;
    group.chats.splice(group.chats.indexOf(name), 1);
    const response = await fetch('/api/chats/group/delete', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ id: name }) });
    if (response.ok) await emitter.emit(types.GROUP_CHAT_DELETED, name);
}
globalThis.SillyTavern = { getContext: () => context };
globalThis.toastr = { error: message => { document.getElementById('preview-log').textContent = `提示：${message}`; } };
const chapterNames = ['雨夜的重逢', '旧城漫游', '星河与灯火', '午后的来信', '旅行手记', '未完成的约定', '夏日散步', '另一种结局'];
const rows = Array.from({ length: 134 }, (_, i) => ({
    avatar: context.characters[i % 3].avatar,
    file_name: `${chapterNames[i % chapterNames.length]}-${Math.floor(i / 8) + 1}.jsonl`,
    last_mes: Date.now() - i * 1000000, chat_items: i * 13 + 2,
    file_size: `${(i * .12 + .1).toFixed(1)} MB`, mes: `这是第 ${i + 1} 个模拟会话的结尾。窗外的雨还没有停，故事仍在继续。`,
}));
rows[0].file_name = '<img src=x onerror=alert(1)>.jsonl'; rows[0].mes = '<script>window.__unsafe=true</script> 预览按纯文本展示。';
for (const name of context.groups[0].chats) rows.push({ group: 'g1', file_name: `${name}.jsonl`, last_mes: Date.now() - 2000000, chat_items: 88, file_size: '1.2 MB', mes: '大家围坐在营火旁，交换下一段旅程的计划。' });
const originalFetch = globalThis.fetch.bind(globalThis);
let failure = false; let requests = 0;
globalThis.fetch = async (url, init) => {
    if (url === '/api/chats/delete' || url === '/api/chats/group/delete') {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (failure) return new Response('{}', { status: 503 });
        const body = JSON.parse(init.body);
        const index = rows.findIndex(row => url === '/api/chats/delete' ? row.avatar === body.avatar_url && row.file_name === body.chatfile : row.group && row.file_name === `${body.id}.jsonl`);
        if (index < 0) return new Response('{}', { status: 404 });
        rows.splice(index, 1);
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (url !== '/api/chats/recent') return originalFetch(url, init);
    requests++;
    const request = JSON.parse(init.body);
    document.getElementById('preview-log').textContent = `目录请求 ${requests} 次；最近一次：${request.max ?? '完整目录'}；模拟 CSRF：${init.headers['X-CSRF-Token']}`;
    await new Promise(resolve => setTimeout(resolve, request.max ? 150 : 300));
    if (failure) return new Response('{}', { status: 503 });
    const data = rows.slice(0, request.max ?? rows.length);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
};
function showChat(character, name) {
    document.getElementById('chat').replaceChildren();
    const chat = document.createElement('div'); chat.className = 'preview-chat'; chat.textContent = `已打开：${character} / ${name}。这是模拟会话；点击页面顶部“返回首页”可继续测试。`;
    document.getElementById('chat').append(chat);
}
function home() {
    context.chatId = undefined; context.characterId = undefined; context.groupId = null;
    document.getElementById('chat').innerHTML = '<div class="welcomePanel"><div class="welcomeHeaderTitle">SillyTavern · 首页预览 <button class="showRecentChats">展开</button><button class="recentChatsSettings">设置</button><button class="hideRecentChats">隐藏</button></div><div class="welcomeHeader"><div class="recentChatsTitle">最近聊天（原生）</div><div class="welcomeShortcuts">文档 · GitHub · 临时聊天</div></div><div class="welcomeRecent"><div class="recentChatList">这是原生首页会话列表；启用插件后此区域应消失。</div></div></div>';
    void emitter.emit(types.CHAT_CHANGED);
}
document.getElementById('return-home').addEventListener('click', home);
document.getElementById('toggle-failure').addEventListener('click', event => { failure = !failure; event.target.textContent = `模拟接口失败：${failure ? '开' : '关'}`; });
document.getElementById('reset-demo').addEventListener('click', () => { localStorage.removeItem('hcf-preview-settings'); location.reload(); });
home();
await import('/index.js');
await emitter.emit(types.APP_READY);
