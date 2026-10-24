import { chatKey, normalizeName } from './model.js';

export function normalizeCatalog(rows, context) {
    if (!Array.isArray(rows)) throw new Error('酒馆返回了无效的会话目录。');
    const characters = new Map((context.characters ?? []).map(c => [c.avatar, c]));
    const groups = new Map((context.groups ?? []).map(g => [String(g.id), g]));
    const chats = new Map();
    let skipped = 0;
    for (const row of rows) {
        if (!row || typeof row.file_name !== 'string') { skipped++; continue; }
        const isGroup = row.group !== undefined && row.group !== null && row.group !== '';
        const kind = isGroup ? 'group' : 'character';
        const owner = isGroup ? String(row.group) : row.avatar;
        const entity = isGroup ? groups.get(owner) : characters.get(owner);
        const name = normalizeName(row.file_name);
        // Orphan/root assistant files need a different native opening path. Never guess an owner.
        if (!entity || typeof owner !== 'string' || !name) { skipped++; continue; }
        const rawTime = row.last_mes;
        let timestamp = typeof rawTime === 'number' ? rawTime : Number(rawTime);
        if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Date.parse(String(rawTime));
        if (!Number.isFinite(timestamp)) timestamp = 0;
        const key = chatKey(kind, owner, name);
        chats.set(key, {
            key, kind, owner, name, character: String(entity.name ?? owner), timestamp,
            messageCount: Number.isFinite(Number(row.chat_items)) ? Number(row.chat_items) : 0,
            fileSize: typeof row.file_size === 'string' ? row.file_size : '',
            preview: typeof row.mes === 'string' ? row.mes.slice(0, 600) : '',
            avatar: isGroup ? null : context.getThumbnailUrl?.('avatar', owner),
        });
    }
    return { chats: [...chats.values()], skipped };
}

export class ChatRepository {
    constructor(getContext, { fetcher = globalThis.fetch.bind(globalThis), timeoutMs = 180000, initialMax = 60 } = {}) {
        this.getContext = getContext;
        this.fetcher = fetcher;
        this.timeoutMs = timeoutMs;
        this.initialMax = initialMax;
        this.chats = [];
        this.complete = false;
        this.skipped = 0;
        this.lastLoaded = 0;
        this.inflight = null;
        this.controller = null;
        this.disposed = false;
    }
    async load({ full = false } = {}) {
        if (this.disposed) throw new Error('插件已停用。');
        if (this.inflight) {
            const pendingFull = this.inflightFull;
            await this.inflight;
            if (full && !pendingFull) return this.load({ full: true });
            return this.chats;
        }
        this.inflightFull = full;
        this.inflight = this.request(full);
        try { return await this.inflight; }
        finally { this.inflight = null; }
    }
    async request(full) {
        const controller = new AbortController();
        this.controller = controller;
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const body = { pinned: [] };
            // Omitting max uses the core's full-catalog default; max: 0 returns no rows.
            if (!full) body.max = this.initialMax;
            const response = await this.fetcher('/api/chats/recent', {
                method: 'POST', headers: this.getContext().getRequestHeaders(),
                body: JSON.stringify(body), cache: 'no-cache', signal: controller.signal,
            });
            if (!response.ok) throw new Error(`读取会话目录失败（HTTP ${response.status}）。`);
            const data = await response.json();
            if (controller.signal.aborted || this.disposed) throw new Error('目录读取已取消。');
            const catalog = normalizeCatalog(data, this.getContext());
            this.chats = catalog.chats;
            this.skipped = catalog.skipped;
            this.complete = full;
            this.lastLoaded = Date.now();
            return this.chats;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('目录读取已取消或超时；已有分类保留，可点击“刷新目录”重试。');
            throw error;
        } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
    }
    dispose() { this.disposed = true; this.controller?.abort(); }
}

export async function openChat(chat, getContext, imports = url => import(url)) {
    let context = getContext();
    if (context.getCurrentChatId?.() !== undefined) throw new Error('当前已进入其他会话，请返回首页后重试。');
    const script = await imports('/script.js');
    if (getContext().getCurrentChatId?.() !== undefined) throw new Error('页面已切换到其他会话，请返回首页后重试。');
    if (chat.kind === 'group') {
        const groupModule = await imports('/scripts/group-chats.js');
        if (getContext().getCurrentChatId?.() !== undefined) throw new Error('页面已切换到其他会话，请返回首页后重试。');
        const group = context.groups.find(g => String(g.id) === chat.owner);
        if (!group || !group.chats?.includes(chat.name)) throw new Error('群聊已改变，请刷新目录。');
        const opened = await groupModule.openGroupById(group.id);
        if (opened === false && String(getContext().groupId) !== chat.owner) throw new Error('酒馆暂时无法切换群组，请稍后重试。');
        script.setActiveGroup?.(group.id);
        if (getContext().getCurrentChatId() !== chat.name) await getContext().openGroupChat(group.id, chat.name);
    } else {
        const characterId = context.characters.findIndex(c => c.avatar === chat.owner);
        if (characterId < 0) throw new Error('角色已不存在，请刷新目录。');
        await context.selectCharacterById(characterId);
        context = getContext();
        if (String(context.characterId) !== String(characterId) || context.groupId != null) throw new Error('酒馆暂时无法切换角色，请稍后重试。');
        script.setActiveCharacter?.(chat.owner);
        if (context.getCurrentChatId() !== chat.name) await context.openCharacterChat(chat.name);
    }
    context = getContext();
    context.saveSettingsDebounced();
    if (context.getCurrentChatId() !== chat.name) throw new Error('会话未成功打开，请刷新目录后重试。');
}
