import { ALL, UNFILED, uid, copy, encodeKey, normalizeName, sanitizeAndRecover } from './model.js';

export const PINNED_CHATS_KEY = 'pinnedChats';
export const VIEW_STATE_KEY = 'hcf_view_state';
export const SNAPSHOTS_KEY = 'hcf_snapshots';
export const CORRUPT_BACKUP_KEY = 'hcf_corrupt_backup';
export const MAX_SNAPSHOTS = 3;

const fallbackStores = new WeakMap();
const globalFallback = new Map();

function createMemoryStore(map) {
    return {
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
    };
}

export function resolveStorage(context) {
    if (context?.accountStorage && typeof context.accountStorage.getItem === 'function') {
        return context.accountStorage;
    }
    if (globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function') {
        return globalThis.localStorage;
    }
    if (context && typeof context === 'object') {
        let map = fallbackStores.get(context);
        if (!map) { map = new Map(); fallbackStores.set(context, map); }
        return createMemoryStore(map);
    }
    return createMemoryStore(globalFallback);
}

export function clearExtensionStorage(context) {
    const store = resolveStorage(context);
    for (const key of [VIEW_STATE_KEY, SNAPSHOTS_KEY, CORRUPT_BACKUP_KEY]) {
        try { store.removeItem?.(key); } catch { /* ignore storage cleanup errors */ }
    }
}

export function loadViewState(context, state) {
    const store = resolveStorage(context);
    const validIds = new Set(state.folders.map(f => f.id));
    let raw = null;
    try {
        const text = store.getItem(VIEW_STATE_KEY);
        if (text) raw = JSON.parse(text);
    } catch { raw = null; }
    const source = raw && typeof raw === 'object' ? raw : (state.preferences ?? {});
    const folderId = [ALL, UNFILED].includes(source.folderId) || validIds.has(source.folderId) ? source.folderId : ALL;
    const collapsed = Array.isArray(source.collapsed) ? [...new Set(source.collapsed.filter(id => validIds.has(id)))] : [];
    return { folderId, collapsed };
}

export function saveViewState(context, viewState) {
    const store = resolveStorage(context);
    try {
        store.setItem(VIEW_STATE_KEY, JSON.stringify({
            folderId: viewState.folderId ?? ALL,
            collapsed: Array.isArray(viewState.collapsed) ? viewState.collapsed : [],
        }));
    } catch (error) {
        console.warn('[HomeChatFolders] 保存视图浏览状态失败。', error);
    }
}

export function saveCorruptBackup(context, raw, issues = []) {
    const store = resolveStorage(context);
    try {
        store.setItem(CORRUPT_BACKUP_KEY, JSON.stringify({
            backedUpAt: new Date().toISOString(),
            issues,
            raw,
        }));
    } catch (error) {
        console.warn('[HomeChatFolders] 备份异常原始分类数据失败。', error);
    }
}

export function loadSnapshots(context) {
    const store = resolveStorage(context);
    try {
        const text = store.getItem(SNAPSHOTS_KEY);
        if (!text) return [];
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(item => item && typeof item === 'object' && item.state && typeof item.state === 'object').slice(0, MAX_SNAPSHOTS);
    } catch {
        return [];
    }
}

export function saveSnapshot(context, state, reason) {
    const store = resolveStorage(context);
    const existing = loadSnapshots(context);
    const entry = {
        id: uid(),
        reason: String(reason || '分类变更前'),
        createdAt: new Date().toISOString(),
        folderCount: state.folders.length,
        assignmentCount: Object.keys(state.assignments).length,
        state: copy(state),
    };
    const next = [entry, ...existing].slice(0, MAX_SNAPSHOTS);
    try {
        store.setItem(SNAPSHOTS_KEY, JSON.stringify(next));
    } catch (error) {
        console.warn('[HomeChatFolders] 保存回滚快照失败。', error);
    }
    return entry;
}

export function popSnapshot(context, snapshotId = null) {
    const store = resolveStorage(context);
    const existing = loadSnapshots(context);
    if (!existing.length) return null;
    const index = snapshotId ? existing.findIndex(s => s.id === snapshotId) : 0;
    if (index < 0) return null;
    const [chosen] = existing.splice(index, 1);
    try {
        if (existing.length) store.setItem(SNAPSHOTS_KEY, JSON.stringify(existing));
        else store.removeItem?.(SNAPSHOTS_KEY);
    } catch { /* ignore */ }
    return {
        ...chosen,
        state: sanitizeAndRecover(chosen.state).state,
    };
}

// SillyTavern 1.19.0 welcome-screen.js PinnedChatsManager compatibility (`accountStorage` key `'pinnedChats'`).
// `logicalName` is already normalized (without the disk `.jsonl` extension, e.g. `"存档.jsonl"` for `"存档.jsonl.jsonl"`).
export function pinnedStorageKey(kind, owner, logicalName) {
    const fileName = `${String(logicalName ?? '')}.jsonl`;
    return kind === 'group' ? `group_${owner}_${fileName}` : `char_${owner}_${fileName}`;
}

function entryToChatCoords(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.file_name !== 'string') return null;
    const isGroup = entry.group !== undefined && entry.group !== null && entry.group !== '';
    const kind = isGroup ? 'group' : 'character';
    const owner = isGroup ? String(entry.group) : String(entry.avatar ?? '');
    const name = normalizeName(entry.file_name);
    if (!owner || !name) return null;
    return { kind, owner, name, key: encodeKey(kind, owner, name) };
}

export function loadPinnedMap(context) {
    const store = resolveStorage(context);
    try {
        const text = store.getItem(PINNED_CHATS_KEY);
        if (!text) return {};
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === 'object' && typeof v.file_name === 'string') result[k] = v;
        }
        return result;
    } catch {
        return {};
    }
}

function savePinnedMap(context, map) {
    const store = resolveStorage(context);
    try {
        store.setItem(PINNED_CHATS_KEY, JSON.stringify(map));
    } catch (error) {
        console.warn('[HomeChatFolders] 保存置顶会话状态失败。', error);
    }
}

export function readPinnedKeys(context) {
    const map = loadPinnedMap(context);
    const keys = new Set();
    for (const entry of Object.values(map)) {
        const coords = entryToChatCoords(entry);
        if (coords) keys.add(coords.key);
    }
    return keys;
}

export function readPinnedPayload(context) {
    return Object.values(loadPinnedMap(context));
}

export function setPinnedChat(context, chat, pinned) {
    const map = loadPinnedMap(context);
    const targetKey = encodeKey(chat.kind, chat.owner, chat.name);
    for (const [k, entry] of Object.entries(map)) {
        if (entryToChatCoords(entry)?.key === targetKey) delete map[k];
    }
    if (pinned) {
        const rawGroup = chat.kind === 'group'
            ? (context?.groups?.find(g => String(g.id) === chat.owner)?.id ?? chat.owner)
            : '';
        const pinKey = pinnedStorageKey(chat.kind, chat.owner, chat.name);
        map[pinKey] = {
            group: rawGroup,
            avatar: chat.kind === 'group' ? '' : chat.owner,
            file_name: `${chat.name}.jsonl`,
        };
    }
    savePinnedMap(context, map);
}

export function remapPinnedChat(context, kind, owner, candidateOldNames, newName) {
    const map = loadPinnedMap(context);
    const oldSet = new Set(candidateOldNames.map(n => String(n ?? '')).filter(Boolean));
    let matched = false;
    let rawGroup = kind === 'group' ? (context?.groups?.find(g => String(g.id) === String(owner))?.id ?? owner) : '';
    for (const [k, entry] of Object.entries(map)) {
        const coords = entryToChatCoords(entry);
        if (coords && coords.kind === kind && coords.owner === String(owner) && oldSet.has(coords.name)) {
            if (kind === 'group' && entry.group !== undefined && entry.group !== '') rawGroup = entry.group;
            delete map[k];
            matched = true;
        }
    }
    if (matched && newName) {
        const logicalNew = String(newName);
        const pinKey = pinnedStorageKey(kind, String(owner), logicalNew);
        map[pinKey] = {
            group: kind === 'group' ? rawGroup : '',
            avatar: kind === 'group' ? '' : String(owner),
            file_name: `${logicalNew}.jsonl`,
        };
        savePinnedMap(context, map);
    }
}

export function removePinnedByPredicate(context, predicate) {
    const map = loadPinnedMap(context);
    let changed = false;
    for (const [k, entry] of Object.entries(map)) {
        const coords = entryToChatCoords(entry);
        if (coords && predicate(coords)) {
            delete map[k];
            changed = true;
        }
    }
    if (changed) savePinnedMap(context, map);
}
