export const SETTINGS_KEY = 'home_chat_folders';
export const ALL = '@all';
export const UNFILED = '@unfiled';
export const MAX_FOLDERS = 1000;
export const MAX_ASSIGNMENTS = 50000;
export const SORTS = ['recent', 'oldest', 'name', 'character'];
const COLORS = ['#b7a4ff', '#7dcfb6', '#f2bd76', '#e795b1', '#7db9ec', '#b9bdc9'];
export { COLORS };

export function uid() {
    return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function normalizeName(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
}
export function chatKey(kind, owner, name) {
    return JSON.stringify([kind, String(owner), normalizeName(name)]);
}
export function parseKey(key) {
    try {
        const parts = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 3 || !['character', 'group'].includes(parts[0]) ||
            parts.slice(1).some(x => typeof x !== 'string' || !x || x.length > 2000) ||
            normalizeName(parts[2]) !== parts[2]) return null;
        return { kind: parts[0], owner: parts[1], name: parts[2] };
    } catch { return null; }
}
export function defaults() {
    return {
        schemaVersion: 1, revision: uid(), enabled: true,
        folders: [
            { id: 'f-active', parentId: null, name: '进行中', color: COLORS[0], order: 0 },
            { id: 'f-finished', parentId: null, name: '已完结', color: COLORS[1], order: 1 },
            { id: 'f-paused', parentId: null, name: '暂时搁置', color: COLORS[2], order: 2 },
        ],
        assignments: {},
        preferences: { folderId: ALL, sort: 'recent', previews: false, collapsed: [] },
    };
}
export function copy(state) { return JSON.parse(JSON.stringify(state)); }

// Validate imports and stored data before they can alter account settings.
export function validate(raw) {
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) throw new Error('不支持的分类文件版本。');
    if (!Array.isArray(raw.folders) || raw.folders.length > MAX_FOLDERS) throw new Error('文件夹数据无效或超过 1000 个。');
    const ids = new Set();
    const folders = raw.folders.map((f, i) => {
        if (!f || typeof f.id !== 'string' || !/^[-\w]{1,100}$/.test(f.id) || ids.has(f.id)) throw new Error('文件夹 ID 无效或重复。');
        ids.add(f.id);
        if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 80) throw new Error('文件夹名称须为 1—80 个字符。');
        if (f.parentId !== null && typeof f.parentId !== 'string') throw new Error('父文件夹无效。');
        return { id: f.id, parentId: f.parentId, name: f.name.trim(), color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : COLORS[i % COLORS.length], order: Number.isFinite(f.order) ? f.order : i };
    });
    const byId = new Map(folders.map(f => [f.id, f]));
    for (const f of folders) {
        const visited = new Set([f.id]);
        let parent = f.parentId;
        while (parent !== null) {
            if (!ids.has(parent) || visited.has(parent)) throw new Error('文件夹包含循环关系或缺失的父级。');
            visited.add(parent);
            if (visited.size > 12) throw new Error('文件夹嵌套最多 12 层。');
            parent = byId.get(parent).parentId;
        }
    }
    if (!raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)) throw new Error('会话归属数据无效。');
    const entries = Object.entries(raw.assignments);
    if (entries.length > MAX_ASSIGNMENTS) throw new Error('分类记录超过 50000 条。');
    const assignments = {};
    for (const [key, folder] of entries) {
        if (!parseKey(key) || !ids.has(folder)) throw new Error('分类记录包含无效会话或不存在的文件夹。');
        assignments[key] = folder;
    }
    const pref = raw.preferences ?? {};
    return {
        schemaVersion: 1,
        revision: typeof raw.revision === 'string' ? raw.revision : uid(),
        enabled: raw.enabled !== false,
        folders, assignments,
        preferences: {
            folderId: [ALL, UNFILED].includes(pref.folderId) || ids.has(pref.folderId) ? pref.folderId : ALL,
            sort: SORTS.includes(pref.sort) ? pref.sort : 'recent', previews: pref.previews === true,
            collapsed: Array.isArray(pref.collapsed) ? [...new Set(pref.collapsed.filter(id => ids.has(id)))] : [],
        },
    };
}
export function exportState(state) {
    return JSON.stringify({ ...validate(state), exportedAt: new Date().toISOString(), application: 'SillyTavern-HomeChatFolders' }, null, 2);
}
export function folderPath(state, id) {
    if (id === ALL) return '全部会话';
    if (id === UNFILED) return '未分类';
    const parts = [];
    let current = state.folders.find(f => f.id === id);
    while (current) {
        parts.unshift(current.name);
        current = state.folders.find(f => f.id === current.parentId);
    }
    return parts.join(' / ');
}
export function descendants(state, id) {
    const result = new Set([id]);
    for (let changed = true; changed;) {
        changed = false;
        for (const f of state.folders) {
            if (result.has(f.parentId) && !result.has(f.id)) { result.add(f.id); changed = true; }
        }
    }
    return result;
}
export function upsertFolder(state, { id = uid(), parentId = null, name, color = COLORS[0] }) {
    const next = copy(state);
    const old = next.folders.find(f => f.id === id);
    if (old) Object.assign(old, { parentId, name, color });
    else next.folders.push({ id, parentId, name, color, order: Math.max(0, ...next.folders.map(f => f.order)) + 1 });
    return validate(next);
}
export function deleteFolder(state, id) {
    if (!state.folders.some(f => f.id === id)) throw new Error('文件夹不存在。');
    const next = copy(state);
    // Promote subfolders; only chats directly in the deleted folder become unfiled.
    const parentId = next.folders.find(f => f.id === id).parentId;
    next.folders = next.folders.filter(f => f.id !== id).map(f => f.parentId === id ? { ...f, parentId } : f);
    for (const key of Object.keys(next.assignments)) if (next.assignments[key] === id) delete next.assignments[key];
    if (next.preferences.folderId === id) next.preferences.folderId = UNFILED;
    return validate(next);
}
export function assignChats(state, keys, folderId) {
    if (folderId !== UNFILED && !state.folders.some(f => f.id === folderId)) throw new Error('目标文件夹不存在。');
    const next = copy(state);
    for (const key of keys) {
        if (!parseKey(key)) throw new Error('会话标识无效。');
        if (folderId === UNFILED) delete next.assignments[key];
        else next.assignments[key] = folderId;
    }
    return validate(next);
}
export function remapKeys(state, mapper) {
    const next = copy(state);
    const original = next.assignments;
    const result = { ...original };
    for (const [key, folder] of Object.entries(original)) {
        const parsed = parseKey(key);
        const target = mapper(parsed);
        if (!target || target === key) continue;
        if (!parseKey(target)) throw new Error('新会话标识无效。');
        if (result[target] && result[target] !== folder) throw new Error('重命名后的分类存在冲突，请在“待关联”中手动处理。');
        delete result[key]; result[target] = folder;
    }
    next.assignments = result;
    return validate(next);
}
export function visibleChats(chats, state, query = '') {
    const fragments = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const folderId = state.preferences.folderId;
    const filtered = chats.filter(c => {
        const assigned = state.assignments[c.key];
        if (folderId === UNFILED && assigned) return false;
        if (![ALL, UNFILED].includes(folderId) && assigned !== folderId) return false;
        const hay = `${c.character}\n${c.name}`.toLocaleLowerCase();
        return fragments.every(fragment => hay.includes(fragment));
    });
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    return filtered.sort((a, b) => {
        switch (state.preferences.sort) {
            case 'oldest': return a.timestamp - b.timestamp || collator.compare(a.key, b.key);
            case 'name': return collator.compare(a.name, b.name) || collator.compare(a.key, b.key);
            case 'character': return collator.compare(a.character, b.character) || b.timestamp - a.timestamp || collator.compare(a.key, b.key);
            default: return b.timestamp - a.timestamp || collator.compare(a.key, b.key);
        }
    });
}
