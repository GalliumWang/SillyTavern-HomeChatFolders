import { encodeKey, normalizeName, sanitizeChatName } from './model.js';
import { readPinnedPayload } from './storage.js';

export const RECENT_CHATS_ENDPOINT = 'api/chats/recent';

export function resolveCoreModuleUrls(baseUrl = import.meta.url) {
    return {
        script: new URL('../../../../../script.js', baseUrl).href,
        groupChats: new URL('../../../../group-chats.js', baseUrl).href,
    };
}

export const CORE_MODULES = resolveCoreModuleUrls();

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
});

export function formatChatDate(timestamp) {
    return timestamp > 0 ? DATE_FORMATTER.format(new Date(timestamp)) : '时间未知';
}

export function buildSearchText(character, name) {
    return `${character}\n${name}`.toLocaleLowerCase();
}

const UTF8_ENCODER = new TextEncoder();

export function resolveActualRenamedName(context, kind, owner, oldName, rawNewFileName) {
    const rawCandidate = normalizeName(rawNewFileName).trim();
    const sanitizedCandidate = sanitizeChatName(rawNewFileName, { isFileName: true });
    if (kind === 'group') {
        const group = context?.groups?.find(g => String(g.id) === String(owner));
        if (Array.isArray(group?.chats)) {
            if (sanitizedCandidate && group.chats.includes(sanitizedCandidate)) return sanitizedCandidate;
            if (rawCandidate && group.chats.includes(rawCandidate)) return rawCandidate;
            if (!group.chats.includes(oldName)) {
                const match = group.chats.find(c => sanitizeChatName(c, { isFileName: false }) === sanitizedCandidate);
                if (match) return match;
            }
        }
    } else {
        const character = context?.characters?.find(c => c.avatar === String(owner));
        if (character && typeof character.chat === 'string' && character.chat !== oldName) {
            if (character.chat === sanitizedCandidate || character.chat === rawCandidate) return character.chat;
        }
    }
    return sanitizedCandidate || rawCandidate;
}

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
        if (!Number.isFinite(timestamp) || timestamp < 0) timestamp = 0;
        const character = String(entity.name ?? owner);
        // Use encodeKey directly so logical names ending in ".jsonl" (from "xxx.jsonl.jsonl") are not stripped twice.
        const key = encodeKey(kind, owner, name);
        chats.set(key, {
            key,
            kind,
            owner,
            name,
            character,
            timestamp,
            dateText: formatChatDate(timestamp),
            searchText: buildSearchText(character, name),
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
        this.inflightFull = false;
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
            const ctx = this.getContext();
            const body = { pinned: readPinnedPayload(ctx) };
            // Omitting max uses the core's full-catalog default; max: 0 returns no rows.
            if (!full) body.max = this.initialMax;
            const response = await this.fetcher(RECENT_CHATS_ENDPOINT, {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body),
                cache: 'no-cache',
                signal: controller.signal,
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
        } finally {
            clearTimeout(timer);
            if (this.controller === controller) this.controller = null;
        }
    }
    dispose() { this.disposed = true; this.controller?.abort(); }
}

export async function openChat(chat, getContext, imports = url => import(url)) {
    let context = getContext();
    if (context.getCurrentChatId?.() !== undefined) throw new Error('当前已进入其他会话，请返回首页后重试。');
    const script = await imports(CORE_MODULES.script);
    if (getContext().getCurrentChatId?.() !== undefined) throw new Error('页面已切换到其他会话，请返回首页后重试。');
    if (chat.kind === 'group') {
        const groupModule = await imports(CORE_MODULES.groupChats);
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

// Core's delete helpers update the character's default chat / group's chat list,
// but return undefined even on HTTP errors. Only their native success event
// confirms deletion; a resolved promise alone must never remove a catalog row.
export async function deleteChat(chat, getContext, imports = url => import(url)) {
    const assertHome = () => {
        const context = getContext();
        if (context.getCurrentChatId?.() !== undefined) throw new Error('页面已进入其他会话，请返回首页后重试。');
        return context;
    };
    assertHome();
    if (!['character', 'group'].includes(chat.kind) || !chat.owner || !chat.name) throw new Error('无效的会话。');
    const module = await imports(chat.kind === 'group' ? CORE_MODULES.groupChats : CORE_MODULES.script);
    const context = assertHome();
    const group = chat.kind === 'group' ? context.groups.find(g => String(g.id) === chat.owner) : null;
    const characterId = chat.kind === 'character' ? context.characters.findIndex(c => c.avatar === chat.owner) : -1;
    if (chat.kind === 'group' ? !group?.chats?.includes(chat.name) : characterId < 0) throw new Error('角色或群聊已改变，请刷新目录。');
    const event = context.eventTypes[chat.kind === 'group' ? 'GROUP_CHAT_DELETED' : 'CHAT_DELETED'];
    const remove = chat.kind === 'group' ? module.deleteGroupChatByName : module.deleteCharacterChatByName;
    if (!event || typeof remove !== 'function') throw new Error('酒馆删除 API 不可用；本版面向 SillyTavern 1.19.0。');
    const index = group?.chats.indexOf(chat.name);
    const previousChatId = group?.chat_id;
    let deleted = false;
    const onDeleted = name => { if (normalizeName(name) === chat.name) deleted = true; };
    context.eventSource.on(event, onDeleted);
    try {
        await remove(chat.kind === 'group' ? group.id : String(characterId), chat.name);
        if (!deleted) throw new Error('酒馆未确认删除成功，请检查服务器连接并刷新目录后重试。');
    } catch (error) {
        if (!deleted) throw error;
    } finally {
        context.eventSource.removeListener(event, onDeleted);
        // 1.19.0 removes membership before sending the group DELETE request.
        // Restore that optimistic change when deletion was not confirmed.
        if (group && !deleted && !group.chats.includes(chat.name)) {
            group.chats.splice(index, 0, chat.name);
            group.chat_id = previousChatId;
        }
    }
}

// Inline chat rename on the homepage using SillyTavern 1.19.0 renameGroupOrCharacterChat,
// confirming success via CHAT_RENAMED and resolving the server-sanitized filename.
export async function renameChat(chat, newNameInput, getContext, imports = url => import(url)) {
    const assertHome = () => {
        const context = getContext();
        if (context.getCurrentChatId?.() !== undefined) throw new Error('页面已进入其他会话，请返回首页后重试。');
        return context;
    };
    assertHome();
    if (!['character', 'group'].includes(chat.kind) || !chat.owner || !chat.name) throw new Error('无效的会话。');
    const trimmed = String(newNameInput ?? '').trim();
    if (!trimmed) throw new Error('请输入新的会话名称。');
    if (UTF8_ENCODER.encode(`${trimmed}.jsonl`).length > 255) {
        throw new Error('新会话名称过长（含扩展名不能超过 255 字节）。');
    }
    const sanitizedPreview = sanitizeChatName(trimmed, { isFileName: false });
    if (!sanitizedPreview) throw new Error('新名称仅包含系统保留字符，请输入有效名称。');
    if (trimmed === chat.name || sanitizedPreview === chat.name) throw new Error('新名称与当前会话名称相同。');

    const script = await imports(CORE_MODULES.script);
    const context = assertHome();
    const group = chat.kind === 'group' ? context.groups?.find(g => String(g.id) === chat.owner) : null;
    const characterId = chat.kind === 'character' ? (context.characters ?? []).findIndex(c => c.avatar === chat.owner) : -1;
    if (chat.kind === 'group' ? !group?.chats?.includes(chat.name) : characterId < 0) {
        throw new Error('角色或群聊已改变，请刷新目录。');
    }
    const event = context.eventTypes?.CHAT_RENAMED;
    if (!event || typeof script.renameGroupOrCharacterChat !== 'function') {
        throw new Error('酒馆重命名 API 不可用；本版面向 SillyTavern 1.19.0。');
    }

    const wasCharacterDefault = chat.kind === 'character' && context.characters[characterId]?.chat === chat.name;
    let confirmed = null;
    const onRenamed = payload => {
        if (!payload) return;
        const isGroup = payload.groupId != null && payload.groupId !== '';
        if ((chat.kind === 'group') !== isGroup) return;
        const owner = isGroup ? String(payload.groupId) : String(payload.avatarId ?? '');
        if (owner === chat.owner && normalizeName(payload.oldFileName) === chat.name) {
            confirmed = payload;
        }
    };
    context.eventSource.on(event, onRenamed);
    try {
        await script.renameGroupOrCharacterChat(chat.kind === 'group'
            ? { groupId: group.id, oldFileName: chat.name, newFileName: trimmed, loader: false }
            : { characterId: String(characterId), oldFileName: chat.name, newFileName: trimmed, loader: false });
        if (!confirmed) throw new Error('酒馆未确认重命名成功（可能已存在同名会话），请检查名称后重试。');
    } finally {
        context.eventSource.removeListener(event, onRenamed);
    }

    const latestContext = getContext();
    const actualNewName = resolveActualRenamedName(latestContext, chat.kind, chat.owner, chat.name, confirmed.newFileName ?? `${trimmed}.jsonl`);
    if (!actualNewName) throw new Error('重命名后的文件名无效，请刷新目录检查。');
    if (wasCharacterDefault && latestContext.characters?.[characterId]) {
        latestContext.characters[characterId].chat = actualNewName;
        try { await script.updateRemoteChatName?.(characterId, actualNewName); } catch { /* ignore non-critical pointer sync failure */ }
    }
    return {
        oldName: chat.name,
        newName: actualNewName,
        oldKey: chat.key,
        newKey: encodeKey(chat.kind, chat.owner, actualNewName),
    };
}
