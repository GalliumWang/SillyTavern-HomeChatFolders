export const SETTINGS_KEY = 'home_chat_folders';
export const ALL = '@all';
export const UNFILED = '@unfiled';
export const MAX_FOLDERS = 1000;
export const MAX_ASSIGNMENTS = 50000;
export const MAX_DEPTH = 12;
export const SORTS = ['recent', 'oldest', 'name', 'character'];
const COLORS = ['#b7a4ff', '#7dcfb6', '#f2bd76', '#e795b1', '#7db9ec', '#b9bdc9'];
export { COLORS };

const COLLATOR = new Intl.Collator('zh-CN', { numeric: true });
const UTF8_ENCODER = new TextEncoder();

export function uid() {
    return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Strip at most one terminal .jsonl extension so chats named "xxx.jsonl" (stored as "xxx.jsonl.jsonl") stay distinct.
export function normalizeName(name) {
    return String(name ?? '').replace(/\.jsonl$/i, '');
}

// Mirrors SillyTavern server's sanitize-filename + path.parse(...).name on `${newName.trim()}.jsonl`.
export function sanitizeChatName(input, { isFileName = /\.jsonl$/i.test(String(input ?? '')) } = {}) {
    const base = (isFileName ? normalizeName(input) : String(input ?? '')).trim();
    if (!base) return '';
    let cleaned = base.replace(/[/?<>\\:*|"\x00-\x1f\x80-\x9f]/g, '');
    if (!cleaned) return '';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(`${cleaned}.jsonl`)) return '';
    const maxBaseBytes = 255 - 6; // reserve 6 bytes for ".jsonl"
    if (UTF8_ENCODER.encode(cleaned).length > maxBaseBytes) {
        let out = '';
        for (const ch of cleaned) {
            if (UTF8_ENCODER.encode(out + ch).length > maxBaseBytes) break;
            out += ch;
        }
        cleaned = out;
    }
    return cleaned;
}

export function encodeKey(kind, owner, logicalName) {
    return JSON.stringify([kind, String(owner), String(logicalName ?? '')]);
}

export function chatKey(kind, owner, fileOrName) {
    return encodeKey(kind, owner, normalizeName(fileOrName));
}

export function parseKey(key) {
    if (typeof key !== 'string') return null;
    try {
        const parts = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 3 || !['character', 'group'].includes(parts[0]) ||
            parts.slice(1).some(x => typeof x !== 'string' || !x || x.length > 2000)) return null;
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
        preferences: { folderId: ALL, sort: 'recent', previews: false, collapsed: [], autoCleanOnDelete: false },
    };
}

export function copy(state) {
    return typeof globalThis.structuredClone === 'function' ? globalThis.structuredClone(state) : JSON.parse(JSON.stringify(state));
}

function normalizePreferences(pref = {}, validIds) {
    return {
        folderId: [ALL, UNFILED].includes(pref.folderId) || validIds.has(pref.folderId) ? pref.folderId : ALL,
        sort: SORTS.includes(pref.sort) ? pref.sort : 'recent',
        previews: pref.previews === true,
        collapsed: Array.isArray(pref.collapsed) ? [...new Set(pref.collapsed.filter(id => validIds.has(id)))] : [],
        autoCleanOnDelete: pref.autoCleanOnDelete === true,
    };
}

function checkFolderGraph(folders, ids) {
    const byId = new Map(folders.map(f => [f.id, f]));
    const siblingNames = new Set();
    for (const f of folders) {
        const siblingKey = `${f.parentId ?? ''}\0${f.name}`;
        if (siblingNames.has(siblingKey)) throw new Error('同一层级下已存在同名文件夹。');
        siblingNames.add(siblingKey);
        const visited = new Set([f.id]);
        let parent = f.parentId;
        while (parent !== null) {
            if (!ids.has(parent) || visited.has(parent)) throw new Error('文件夹包含循环关系或缺失的父级。');
            visited.add(parent);
            if (visited.size > MAX_DEPTH) throw new Error(`文件夹嵌套最多 ${MAX_DEPTH} 层。`);
            parent = byId.get(parent).parentId;
        }
    }
}

// Strict validator for imports and explicit invariants.
export function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('无效的分类备份或设置数据。');
    if (raw.schemaVersion !== 1) throw new Error('不支持的分类文件版本。');
    if (!Array.isArray(raw.folders) || raw.folders.length > MAX_FOLDERS) throw new Error(`文件夹数据无效或超过 ${MAX_FOLDERS} 个。`);
    const ids = new Set();
    const folders = raw.folders.map((f, i) => {
        if (!f || typeof f.id !== 'string' || !/^[-\w]{1,100}$/.test(f.id) || ids.has(f.id)) throw new Error('文件夹 ID 无效或重复。');
        ids.add(f.id);
        if (typeof f.name !== 'string' || !f.name.trim() || f.name.trim().length > 80) throw new Error('文件夹名称须为 1—80 个字符。');
        if (f.parentId !== null && typeof f.parentId !== 'string') throw new Error('父文件夹无效。');
        return {
            id: f.id,
            parentId: f.parentId,
            name: f.name.trim(),
            color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : COLORS[i % COLORS.length],
            order: Number.isFinite(f.order) ? f.order : i,
        };
    });
    checkFolderGraph(folders, ids);
    if (!raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)) throw new Error('会话归属数据无效。');
    const entries = Object.entries(raw.assignments);
    if (entries.length > MAX_ASSIGNMENTS) throw new Error(`分类记录超过 ${MAX_ASSIGNMENTS} 条。`);
    const assignments = {};
    for (const [key, folder] of entries) {
        if (!parseKey(key) || !ids.has(folder)) throw new Error('分类记录包含无效会话或不存在的文件夹。');
        assignments[key] = folder;
    }
    return {
        schemaVersion: 1,
        revision: typeof raw.revision === 'string' && raw.revision ? raw.revision : uid(),
        enabled: raw.enabled !== false,
        folders,
        assignments,
        preferences: normalizePreferences(raw.preferences ?? {}, ids),
    };
}

// Fault-tolerant soft recovery for persisted settings so a single bad entry never bricks initialization or #hcf-settings.
export function sanitizeAndRecover(raw) {
    const issues = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) {
        return { state: defaults(), recovered: true, issues: ['分类配置结构或版本异常，已使用默认文件夹启动'] };
    }
    const ids = new Set();
    const folders = [];
    if (Array.isArray(raw.folders)) {
        for (let i = 0; i < raw.folders.length && folders.length < MAX_FOLDERS; i++) {
            const f = raw.folders[i];
            if (!f || typeof f !== 'object') { issues.push('已跳过损坏的文件夹记录'); continue; }
            const id = typeof f.id === 'string' && /^[-\w]{1,100}$/.test(f.id) && !ids.has(f.id) ? f.id : null;
            const trimmed = typeof f.name === 'string' ? f.name.trim().slice(0, 80) : '';
            if (!id || !trimmed) { issues.push('已隔离无效的文件夹项'); continue; }
            if (f.name.trim().length > 80) issues.push(`文件夹「${trimmed}」名称超长已截断`);
            ids.add(id);
            folders.push({
                id,
                parentId: typeof f.parentId === 'string' && f.parentId ? f.parentId : null,
                name: trimmed,
                color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : COLORS[folders.length % COLORS.length],
                order: Number.isFinite(f.order) ? f.order : folders.length,
            });
        }
        if (raw.folders.length > MAX_FOLDERS) issues.push(`超出上限的文件夹已截断至 ${MAX_FOLDERS} 个`);
    } else {
        issues.push('文件夹列表损坏，已恢复默认文件夹');
        folders.push(...defaults().folders);
        for (const f of folders) ids.add(f.id);
    }

    const byId = new Map(folders.map(f => [f.id, f]));
    for (const f of folders) {
        if (f.parentId !== null && !byId.has(f.parentId)) {
            f.parentId = null;
            issues.push(`文件夹「${f.name}」的父级缺失，已提升为顶层`);
        }
    }
    for (const f of folders) {
        const visited = new Set([f.id]);
        let parent = f.parentId;
        while (parent !== null) {
            if (!byId.has(parent) || visited.has(parent) || visited.size >= MAX_DEPTH) {
                f.parentId = null;
                issues.push(`文件夹「${f.name}」存在循环或超深嵌套，已提升为顶层`);
                break;
            }
            visited.add(parent);
            parent = byId.get(parent).parentId;
        }
    }
    const siblingNames = new Set();
    for (const f of folders) {
        let candidate = f.name;
        let suffix = 2;
        while (siblingNames.has(`${f.parentId ?? ''}\0${candidate}`)) {
            const tag = ` (${suffix++})`;
            candidate = `${f.name.slice(0, Math.max(1, 80 - tag.length))}${tag}`;
        }
        if (candidate !== f.name) {
            issues.push(`同级重名文件夹已重命名为「${candidate}」`);
            f.name = candidate;
        }
        siblingNames.add(`${f.parentId ?? ''}\0${f.name}`);
    }

    const assignments = {};
    let droppedAssignments = 0;
    if (raw.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)) {
        const entries = Object.entries(raw.assignments);
        for (const [key, folder] of entries) {
            if (Object.keys(assignments).length >= MAX_ASSIGNMENTS) { droppedAssignments++; continue; }
            if (!parseKey(key) || !ids.has(folder)) { droppedAssignments++; continue; }
            assignments[key] = folder;
        }
    } else if (raw.assignments !== undefined) {
        issues.push('会话归属结构异常，已重置无效部分');
    }
    if (droppedAssignments > 0) issues.push(`已隔离 ${droppedAssignments} 条损坏或指向缺失文件夹的归属记录`);

    const state = {
        schemaVersion: 1,
        revision: typeof raw.revision === 'string' && raw.revision ? raw.revision : uid(),
        enabled: raw.enabled !== false,
        folders,
        assignments,
        preferences: normalizePreferences(raw.preferences ?? {}, ids),
    };
    return { state, recovered: issues.length > 0, issues };
}

export function exportState(state, viewState = null) {
    const clean = copy(state);
    if (viewState) {
        if (viewState.folderId) clean.preferences.folderId = viewState.folderId;
        if (Array.isArray(viewState.collapsed)) clean.preferences.collapsed = [...viewState.collapsed];
    }
    const validated = sanitizeAndRecover(clean).state;
    return JSON.stringify({ ...validated, exportedAt: new Date().toISOString(), application: 'SillyTavern-HomeChatFolders' }, null, 2);
}

// Single O(F) pass building lookup maps for paths, sorted children, and descendant sets.
export function buildFolderIndex(state) {
    const byId = new Map();
    const childrenByParent = new Map();
    for (const f of state.folders) {
        byId.set(f.id, f);
        const key = f.parentId ?? null;
        let list = childrenByParent.get(key);
        if (!list) { list = []; childrenByParent.set(key, list); }
        list.push(f);
    }
    for (const list of childrenByParent.values()) list.sort((a, b) => a.order - b.order);

    const pathById = new Map([[ALL, '全部会话'], [UNFILED, '未分类']]);
    const computePath = id => {
        if (pathById.has(id)) return pathById.get(id);
        const node = byId.get(id);
        if (!node) return '未分类';
        const parts = [node.name];
        const seen = new Set([id]);
        let cur = node.parentId;
        while (cur !== null && byId.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            const p = byId.get(cur);
            parts.unshift(p.name);
            cur = p.parentId;
        }
        const full = parts.join(' / ');
        pathById.set(id, full);
        return full;
    };
    for (const f of state.folders) computePath(f.id);

    const descendantsById = new Map();
    const collectDescendants = id => {
        if (descendantsById.has(id)) return descendantsById.get(id);
        const set = new Set([id]);
        descendantsById.set(id, set);
        for (const child of childrenByParent.get(id) ?? []) {
            for (const sub of collectDescendants(child.id)) set.add(sub);
        }
        return set;
    };
    for (const f of state.folders) collectDescendants(f.id);

    return { byId, childrenByParent, pathById, descendantsById };
}

export function folderPath(state, id, index = null) {
    if (id === ALL) return '全部会话';
    if (id === UNFILED) return '未分类';
    if (index?.pathById?.has(id)) return index.pathById.get(id);
    const byId = index?.byId ?? new Map(state.folders.map(f => [f.id, f]));
    const parts = [];
    const seen = new Set();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        parts.unshift(current.name);
        current = current.parentId !== null ? byId.get(current.parentId) : null;
    }
    return parts.join(' / ');
}

export function descendants(state, id, index = null) {
    if (index?.descendantsById?.has(id)) return new Set(index.descendantsById.get(id));
    const childrenByParent = new Map();
    for (const f of state.folders) {
        if (f.parentId === null) continue;
        let list = childrenByParent.get(f.parentId);
        if (!list) { list = []; childrenByParent.set(f.parentId, list); }
        list.push(f.id);
    }
    const result = new Set([id]);
    const stack = [id];
    while (stack.length) {
        const cur = stack.pop();
        for (const childId of childrenByParent.get(cur) ?? []) {
            if (!result.has(childId)) { result.add(childId); stack.push(childId); }
        }
    }
    return result;
}

export function upsertFolder(state, { id = uid(), parentId = null, name, color = COLORS[0], targetIndex = null }) {
    if (typeof id !== 'string' || !/^[-\w]{1,100}$/.test(id)) throw new Error('文件夹 ID 无效。');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 80) throw new Error('文件夹名称须为 1—80 个字符。');
    const normalizedParent = parentId || null;
    if (normalizedParent !== null && typeof normalizedParent !== 'string') throw new Error('父文件夹无效。');
    const folders = state.folders.map(f => ({ ...f }));
    const existing = folders.find(f => f.id === id);
    if (!existing && folders.length >= MAX_FOLDERS) throw new Error(`文件夹最多创建 ${MAX_FOLDERS} 个。`);
    const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : COLORS[folders.length % COLORS.length];
    if (existing) {
        const parentChanged = existing.parentId !== normalizedParent;
        Object.assign(existing, { parentId: normalizedParent, name: trimmed, color: safeColor });
        if (parentChanged && targetIndex === null) {
            const sibOrders = folders.filter(f => f.id !== id && f.parentId === normalizedParent).map(f => f.order);
            existing.order = (sibOrders.length ? Math.max(...sibOrders) : -1) + 1;
        }
    } else {
        const sibOrders = folders.filter(f => f.parentId === normalizedParent).map(f => f.order);
        folders.push({ id, parentId: normalizedParent, name: trimmed, color: safeColor, order: (sibOrders.length ? Math.max(...sibOrders) : -1) + 1 });
    }
    if (targetIndex !== null && Number.isInteger(targetIndex)) {
        const siblings = folders.filter(f => f.parentId === normalizedParent && f.id !== id).sort((a, b) => a.order - b.order);
        const me = folders.find(f => f.id === id);
        const clamped = Math.max(0, Math.min(siblings.length, targetIndex));
        siblings.splice(clamped, 0, me);
        siblings.forEach((f, idx) => { f.order = idx; });
    }
    const ids = new Set(folders.map(f => f.id));
    checkFolderGraph(folders, ids);
    return { ...state, folders, preferences: { ...state.preferences } };
}

export function deleteFolder(state, id) {
    const target = state.folders.find(f => f.id === id);
    if (!target) throw new Error('文件夹不存在。');
    const parentId = target.parentId;
    const folders = state.folders
        .filter(f => f.id !== id)
        .map(f => f.parentId === id ? { ...f, parentId } : { ...f });
    // Deduplicate sibling names if promoting subfolders collides with an existing folder at parentId
    const siblingNames = new Set(folders.filter(f => f.parentId === parentId && !state.folders.some(orig => orig.id === f.id && orig.parentId === id)).map(f => f.name));
    for (const f of folders) {
        if (f.parentId === parentId && state.folders.find(orig => orig.id === f.id)?.parentId === id) {
            let candidate = f.name;
            let suffix = 2;
            while (siblingNames.has(candidate)) {
                const tag = ` (${suffix++})`;
                candidate = `${f.name.slice(0, Math.max(1, 80 - tag.length))}${tag}`;
            }
            f.name = candidate;
            siblingNames.add(candidate);
        }
    }
    const assignments = { ...state.assignments };
    for (const key of Object.keys(assignments)) {
        if (assignments[key] === id) delete assignments[key];
    }
    const preferences = {
        ...state.preferences,
        folderId: state.preferences.folderId === id ? UNFILED : state.preferences.folderId,
        collapsed: state.preferences.collapsed.filter(x => x !== id),
    };
    return { ...state, folders, assignments, preferences };
}

export function assignChats(state, keys, folderId) {
    if (folderId !== UNFILED && !state.folders.some(f => f.id === folderId)) throw new Error('目标文件夹不存在。');
    const assignments = { ...state.assignments };
    let count = Object.keys(assignments).length;
    for (const key of keys) {
        if (!parseKey(key)) throw new Error('会话标识无效。');
        if (folderId === UNFILED) {
            if (Object.hasOwn(assignments, key)) { delete assignments[key]; count--; }
        } else {
            if (!Object.hasOwn(assignments, key)) {
                if (count >= MAX_ASSIGNMENTS) throw new Error(`分类记录超过 ${MAX_ASSIGNMENTS} 条。`);
                count++;
            }
            assignments[key] = folderId;
        }
    }
    return { ...state, assignments };
}

export function remapKeys(state, mapper, { keepConflicts = false } = {}) {
    const original = state.assignments;
    const result = { ...original };
    const validIds = new Set(state.folders.map(f => f.id));
    const conflicts = [];
    let migrated = 0;
    for (const [key, folder] of Object.entries(original)) {
        if (!validIds.has(folder)) continue;
        const parsed = parseKey(key);
        if (!parsed) continue;
        const target = mapper(parsed);
        if (!target || target === key) continue;
        if (!parseKey(target)) {
            if (keepConflicts) { conflicts.push(key); continue; }
            throw new Error('新会话标识无效。');
        }
        if (result[target] && result[target] !== folder) {
            if (keepConflicts) { conflicts.push(key); continue; }
            throw new Error('重命名后的分类存在冲突，请在“待关联”中手动处理。');
        }
        delete result[key];
        result[target] = folder;
        migrated++;
    }
    const next = { ...state, assignments: result };
    return keepConflicts ? { state: next, migrated, conflicts } : next;
}

// Non-destructive Merge Import: merges folder trees by matching normalized (parentId, name) path and adds non-conflicting assignments.
export function mergeStates(current, imported) {
    const folders = current.folders.map(f => ({ ...f }));
    const usedIds = new Set(folders.map(f => f.id));
    const pathKey = (parentId, name) => `${parentId ?? ''}\0${name.trim()}`;
    const existingByParentAndName = new Map(folders.map(f => [pathKey(f.parentId, f.name), f.id]));
    const depthOf = id => {
        let d = 0;
        let cur = id;
        const byId = new Map(folders.map(f => [f.id, f]));
        while (cur !== null && byId.has(cur) && d <= MAX_DEPTH) { d++; cur = byId.get(cur).parentId; }
        return d;
    };

    const importedByParent = new Map();
    for (const f of imported.folders) {
        const k = f.parentId ?? null;
        let arr = importedByParent.get(k);
        if (!arr) { arr = []; importedByParent.set(k, arr); }
        arr.push(f);
    }
    for (const arr of importedByParent.values()) arr.sort((a, b) => a.order - b.order);

    const idMap = new Map();
    let addedFolders = 0;
    const visit = (impParentId, mappedParentId) => {
        for (const f of importedByParent.get(impParentId) ?? []) {
            const pk = pathKey(mappedParentId, f.name);
            let targetId = existingByParentAndName.get(pk);
            if (!targetId) {
                if (folders.length >= MAX_FOLDERS) continue;
                const parentDepth = mappedParentId === null ? 0 : depthOf(mappedParentId);
                const actualParent = parentDepth >= MAX_DEPTH ? null : mappedParentId;
                const fallbackPk = pathKey(actualParent, f.name);
                targetId = existingByParentAndName.get(fallbackPk);
                if (!targetId) {
                    targetId = !usedIds.has(f.id) && /^[-\w]{1,100}$/.test(f.id) ? f.id : uid();
                    usedIds.add(targetId);
                    const sibOrders = folders.filter(x => x.parentId === actualParent).map(x => x.order);
                    folders.push({
                        id: targetId,
                        parentId: actualParent,
                        name: f.name.trim(),
                        color: f.color,
                        order: (sibOrders.length ? Math.max(...sibOrders) : -1) + 1,
                    });
                    existingByParentAndName.set(fallbackPk, targetId);
                    addedFolders++;
                }
            }
            idMap.set(f.id, targetId);
            visit(f.id, targetId);
        }
    };
    visit(null, null);

    const assignments = { ...current.assignments };
    let count = Object.keys(assignments).length;
    let addedAssignments = 0;
    let skippedConflicts = 0;
    for (const [key, impFolderId] of Object.entries(imported.assignments)) {
        if (!parseKey(key)) continue;
        const mappedFolder = idMap.get(impFolderId);
        if (!mappedFolder) continue;
        if (Object.hasOwn(assignments, key)) {
            if (assignments[key] !== mappedFolder) skippedConflicts++;
            continue;
        }
        if (count >= MAX_ASSIGNMENTS) break;
        assignments[key] = mappedFolder;
        count++;
        addedAssignments++;
    }

    return {
        state: { ...current, folders, assignments },
        addedFolders,
        addedAssignments,
        skippedConflicts,
    };
}

export function queryFragments(query = '') {
    const trimmed = query.trim();
    return trimmed ? trimmed.toLocaleLowerCase().split(/\s+/).filter(Boolean) : [];
}

export function matchesFragments(chat, fragments) {
    if (!fragments.length) return true;
    const hay = chat.searchText ?? `${chat.character}\n${chat.name}`.toLocaleLowerCase();
    return fragments.every(fragment => hay.includes(fragment));
}

export function visibleChats(chats, state, query = '', options = {}) {
    const fragments = queryFragments(query);
    const folderId = options.folderId ?? state.preferences.folderId;
    const includeSubfolders = options.includeSubfolders === true;
    const pinnedKeys = options.pinnedKeys ?? null;
    const allowedFolders = ![ALL, UNFILED].includes(folderId) && includeSubfolders
        ? descendants(state, folderId, options.folderIndex)
        : null;

    const filtered = chats.filter(c => {
        const assigned = state.assignments[c.key];
        if (folderId === UNFILED && assigned) return false;
        if (![ALL, UNFILED].includes(folderId)) {
            if (allowedFolders ? !allowedFolders.has(assigned) : assigned !== folderId) return false;
        }
        return matchesFragments(c, fragments);
    });

    const sortMode = state.preferences.sort;
    return filtered.sort((a, b) => {
        if (pinnedKeys?.size) {
            const aPinned = pinnedKeys.has(a.key);
            const bPinned = pinnedKeys.has(b.key);
            if (aPinned !== bPinned) return aPinned ? -1 : 1;
        }
        switch (sortMode) {
            case 'oldest': return a.timestamp - b.timestamp || COLLATOR.compare(a.key, b.key);
            case 'name': return COLLATOR.compare(a.name, b.name) || COLLATOR.compare(a.key, b.key);
            case 'character': return COLLATOR.compare(a.character, b.character) || b.timestamp - a.timestamp || COLLATOR.compare(a.key, b.key);
            default: return b.timestamp - a.timestamp || COLLATOR.compare(a.key, b.key);
        }
    });
}
