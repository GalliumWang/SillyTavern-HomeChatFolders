import {
    SETTINGS_KEY, ALL, UNFILED, COLORS, uid, defaults, validate, sanitizeAndRecover, copy, exportState,
    buildFolderIndex, folderPath, descendants, upsertFolder, deleteFolder, assignChats, visibleChats,
    parseKey, encodeKey, normalizeName, sanitizeChatName, remapKeys, mergeStates, queryFragments, matchesFragments,
} from './model.js';
import {
    ChatRepository, openChat, deleteChat, renameChat, resolveActualRenamedName, buildSearchText, formatChatDate,
} from './repository.js';
import {
    loadViewState, saveViewState, saveCorruptBackup, loadSnapshots, saveSnapshot, popSnapshot,
    readPinnedKeys, setPinnedChat, remapPinnedChat, removePinnedByPredicate, clearExtensionStorage,
} from './storage.js';

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
}
function button(text, title, handler, className = '') {
    const b = element('button', `hcf-button ${className}`.trim(), text);
    b.type = 'button'; b.title = title || text;
    if (handler) b.addEventListener('click', handler);
    return b;
}
function option(value, text) {
    const el = element('option', '', text); el.value = value; return el;
}
function labeled(text, input, className = 'hcf-field') {
    const label = element('label', className); label.append(element('span', '', text), input); return label;
}
function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = element('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function similarityScore(a, b) {
    const sa = a.toLocaleLowerCase(); const sb = b.toLocaleLowerCase();
    if (sa === sb) return 100;
    if (sa.includes(sb) || sb.includes(sa)) return 60;
    let common = 0;
    for (const ch of new Set(sa)) if (sb.includes(ch)) common++;
    return common;
}

export class HomeFolders {
    constructor(getContext, { repository, opener = openChat, deleter = deleteChat, renamer = renameChat } = {}) {
        this.getContext = getContext;
        this.repository = repository ?? new ChatRepository(getContext);
        this.opener = opener;
        this.deleter = deleter;
        this.renamer = renamer;
        this.state = null;
        this.viewState = null;
        this.folderIndex = null;
        this.includeSubfolders = false;
        this.panel = null;
        this.root = null;
        this.selected = new Set();
        this.lastAnchorKey = null;
        this.currentRows = [];
        this.query = '';
        this.page = 1;
        this.pageSize = 50;
        this.loading = false;
        this.revalidating = false;
        this.error = '';
        this.notice = '';
        this.dirty = false;
        this.catalogRevision = 0;
        this.started = false;
        this.stopped = false;
        this.opening = false;
        this.deleting = false;
        this.renaming = false;
        this.listeners = [];
        this.dialogs = new Set();
        this.scanTimer = null;
        this.searchTimer = null;
        this.pendingAutoCleanChatNames = new Set();
    }

    initialize() {
        if (this.started) return;
        const context = this.getContext();
        if (!context.extensionSettings || !context.eventSource || !context.eventTypes) {
            throw new Error('酒馆扩展 API 不可用；本版面向 SillyTavern 1.19.0。');
        }
        const stored = context.extensionSettings[SETTINGS_KEY];
        if (stored !== undefined) {
            const { state, recovered, issues } = sanitizeAndRecover(stored);
            this.state = state;
            if (recovered) {
                saveCorruptBackup(context, stored, issues);
                context.extensionSettings[SETTINGS_KEY] = copy(this.state);
                context.saveSettingsDebounced();
                this.notice = `已隔离修复异常配置（原数据已备份至本地存储）：${issues[0]}`;
                console.warn('[HomeChatFolders] 已软恢复异常分类配置：', issues);
            }
        } else {
            this.state = defaults();
            context.extensionSettings[SETTINGS_KEY] = copy(this.state);
            context.saveSettingsDebounced();
        }
        this.folderIndex = buildFolderIndex(this.state);
        this.viewState = loadViewState(context, this.state);
        this.started = true;
        this.settingsUI();

        const subscribe = (name, fn) => {
            const type = context.eventTypes[name];
            if (!type) return;
            context.eventSource.on(type, fn);
            this.listeners.push([type, fn]);
        };
        subscribe('APP_READY', () => this.scheduleMount());
        subscribe('CHAT_CHANGED', () => this.scheduleMount());
        for (const event of [
            'CHAT_CREATED', 'GROUP_CHAT_CREATED',
            'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
        ]) {
            subscribe(event, () => this.invalidate());
        }
        subscribe('CHARACTER_EDITED', () => { this.invalidate(); if (this.root) this.scheduleRevalidate(); });
        subscribe('GROUP_UPDATED', () => this.handleGroupUpdated());
        subscribe('CHAT_DELETED', fileName => this.handleNativeChatDeleted(fileName));
        subscribe('GROUP_CHAT_DELETED', chatName => this.handleNativeGroupChatDeleted(chatName));
        subscribe('CHARACTER_DELETED', data => this.handleNativeCharacterDeleted(data));
        subscribe('CHAT_RENAMED', data => this.renamedChat(data));
        subscribe('CHARACTER_RENAMED', (oldAvatar, newAvatar) => this.renamedCharacter(oldAvatar, newAvatar));
        subscribe('SETTINGS_UPDATED', () => this.adoptSettings());

        // Homepage panels are rebuilt by core. Observe structural changes only, never message text/tokens.
        const chat = document.getElementById('chat');
        if (chat && globalThis.MutationObserver) {
            this.observer = new MutationObserver(records => {
                if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 &&
                    (n.matches?.('.welcomePanel') || n.querySelector?.('.welcomePanel'))))) this.scheduleMount();
            });
            this.observer.observe(chat, { childList: true });
        }
        this.scheduleMount();
    }

    cleanData() {
        const context = this.getContext();
        if (context?.extensionSettings && SETTINGS_KEY in context.extensionSettings) {
            delete context.extensionSettings[SETTINGS_KEY];
            context.saveSettingsDebounced?.();
        }
        clearExtensionStorage(context);
    }

    activeFolderId() {
        const raw = this.viewState ? this.viewState.folderId : (this.state?.preferences?.folderId ?? ALL);
        if (raw === ALL || raw === UNFILED) return raw;
        const index = this.getFolderIndex();
        return index.byId.has(raw) ? raw : ALL;
    }

    collapsedSet() {
        const list = this.viewState ? this.viewState.collapsed : (this.state?.preferences?.collapsed ?? []);
        return new Set(list);
    }

    getFolderIndex() {
        if (!this.folderIndex && this.state) this.folderIndex = buildFolderIndex(this.state);
        return this.folderIndex ?? { byId: new Map(), childrenByParent: new Map(), pathById: new Map(), descendantsById: new Map() };
    }

    syncViewStateWithFolders() {
        if (!this.state) return;
        this.folderIndex = buildFolderIndex(this.state);
        if (!this.viewState) {
            this.viewState = loadViewState(this.getContext(), this.state);
            return;
        }
        const validIds = this.folderIndex.byId;
        const nextFolder = [ALL, UNFILED].includes(this.viewState.folderId) || validIds.has(this.viewState.folderId)
            ? this.viewState.folderId
            : ALL;
        const nextCollapsed = this.viewState.collapsed.filter(id => validIds.has(id));
        if (nextFolder !== this.viewState.folderId || nextCollapsed.length !== this.viewState.collapsed.length) {
            this.viewState = { folderId: nextFolder, collapsed: nextCollapsed };
            saveViewState(this.getContext(), this.viewState);
        }
    }

    invalidate() { this.dirty = true; this.catalogRevision++; }

    settingsUI() {
        document.getElementById('hcf-settings')?.remove();
        const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!target) return;
        const section = element('details', 'hcf-settings'); section.id = 'hcf-settings';
        section.append(element('summary', '', '首页会话文件夹'));

        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = this.state.enabled;
        toggle.addEventListener('change', () => this.guard(() => {
            this.commit(s => ({ ...s, enabled: toggle.checked }));
            if (this.state.enabled) this.scheduleMount(); else this.unmount();
        }));
        this.enabledToggle = toggle;

        const autoClean = element('input'); autoClean.type = 'checkbox'; autoClean.checked = this.state.preferences.autoCleanOnDelete === true;
        autoClean.addEventListener('change', () => this.guard(() => {
            this.commit(s => ({ ...s, preferences: { ...s.preferences, autoCleanOnDelete: autoClean.checked } }));
        }));
        this.autoCleanToggle = autoClean;

        section.append(
            labeled('启用首页文件夹', toggle),
            labeled('在酒馆内删除会话或角色时自动移除对应文件夹归属', autoClean),
            element('p', '', '分类随酒馆账户设置保存。删除文件夹不会删除聊天。'),
        );
        const actions = element('div', 'hcf-settings-actions');
        actions.append(button('导出分类', '', () => this.guard(() => this.exportBackup())));
        const importing = this.importButton({ scope: 'settings' });
        this.settingsUndoButton = button('撤销上次导入/删除', '恢复最近一次导入或删除文件夹前的自动快照', () => this.guard(() => this.undoSnapshot({ scope: 'settings' })));
        actions.append(importing.button, importing.input, this.settingsUndoButton);
        section.append(actions);
        target.append(section);
        this.syncUndoButtons();
    }

    syncUndoButtons() {
        const snapshots = loadSnapshots(this.getContext());
        const hasAny = snapshots.length > 0;
        const tip = hasAny ? `可恢复快照：${snapshots[0].reason}（共 ${snapshots.length} 份）` : '暂无可恢复的导入或删除快照';
        for (const btn of [this.settingsUndoButton, this.undoButton]) {
            if (!btn) continue;
            btn.disabled = !hasAny || this.deleting || this.renaming;
            btn.title = tip;
        }
    }

    commit(mutator, { strict = false } = {}) {
        const context = this.getContext();
        const stored = context.extensionSettings[SETTINGS_KEY];
        if (stored && stored.revision && stored.revision !== this.state.revision) {
            this.state = sanitizeAndRecover(stored).state;
            this.syncViewStateWithFolders();
            this.render();
            throw new Error('分类设置已在其他操作中改变，已重新载入，请重试。');
        }
        const draft = mutator(copy(this.state));
        const next = strict ? validate(draft) : sanitizeAndRecover(draft).state;
        next.revision = uid();
        context.extensionSettings[SETTINGS_KEY] = copy(next);
        this.state = next;
        this.syncViewStateWithFolders();
        context.saveSettingsDebounced();
        if (this.enabledToggle) this.enabledToggle.checked = next.enabled;
        if (this.autoCleanToggle) this.autoCleanToggle.checked = next.preferences.autoCleanOnDelete === true;
        this.syncUndoButtons();
        return next;
    }

    adoptSettings() {
        if (this.stopped) return;
        const stored = this.getContext().extensionSettings[SETTINGS_KEY];
        if (!stored || stored.revision === this.state.revision) return;
        this.guard(() => {
            this.state = sanitizeAndRecover(stored).state;
            this.syncViewStateWithFolders();
            this.selected.clear(); this.lastAnchorKey = null; this.page = 1;
            if (this.enabledToggle) this.enabledToggle.checked = this.state.enabled;
            if (this.autoCleanToggle) this.autoCleanToggle.checked = this.state.preferences.autoCleanOnDelete === true;
            if (this.state.enabled) { this.scheduleMount(); this.render(); } else this.unmount();
        });
    }

    async guard(action) {
        try { return await action(); }
        catch (error) { this.showError(error); }
    }

    showError(error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error = message; this.renderStatus();
        if (globalThis.toastr?.error) globalThis.toastr.error(message, '首页会话文件夹');
        console.error('[HomeChatFolders]', error);
    }

    scheduleMount() {
        if (this.stopped || this.mountPending) return;
        this.mountPending = true;
        queueMicrotask(() => {
            this.mountPending = false;
            if (!this.stopped) this.guard(() => this.mount());
        });
    }

    scheduleRevalidate(delayMs = 80) {
        if (this.stopped || !this.root?.isConnected) return;
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => {
            if (this.root?.isConnected && !this.stopped) void this.refresh({ background: true });
        }, delayMs);
    }

    mount() {
        const current = this.getContext().getCurrentChatId?.();
        if (this.stopped || !this.state.enabled || current !== undefined) { this.unmount(); return; }
        const panel = document.querySelector('#chat .welcomePanel');
        if (!panel?.querySelector('.welcomeRecent')) { this.unmount(); return; }
        if (this.panel === panel && this.root?.isConnected) return;
        this.unmount(); this.panel = panel;
        this.root = element('section', 'hcf-root'); this.root.setAttribute('aria-label', '我的会话');
        this.build();
        panel.querySelector('.welcomeRecent').before(this.root);
        this.render();
        // The native list is hidden only after a working replacement has been mounted.
        panel.classList.add('hcf-replaced');
        if (!this.repository.lastLoaded) {
            this.scanTimer = setTimeout(() => this.refresh({ initial: true }), 0);
        } else if (this.dirty || Date.now() - this.repository.lastLoaded > 1200) {
            // Stale-While-Revalidate: show cached catalog instantly and coalesce background revalidation
            // (also catches native chat imports/bookmarks that emit no event).
            this.scheduleRevalidate(this.dirty ? 0 : 120);
        }
    }

    unmount() {
        clearTimeout(this.scanTimer);
        clearTimeout(this.searchTimer);
        this.panel?.classList.remove('hcf-replaced');
        this.root?.remove(); this.root = null; this.panel = null;
        this.selected.clear(); this.lastAnchorKey = null;
        // Close only homepage-scoped dialogs; never close global #hcf-settings dialogs!
        for (const dialog of [...this.dialogs]) {
            if (dialog.scope !== 'settings') dialog.close();
        }
    }

    dispose() {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.scanTimer);
        clearTimeout(this.searchTimer);
        this.observer?.disconnect();
        const events = this.getContext().eventSource;
        for (const [type, fn] of this.listeners) events.removeListener(type, fn);
        this.listeners = [];
        this.repository.dispose();
        for (const dialog of [...this.dialogs]) dialog.close();
        this.unmount();
        document.getElementById('hcf-settings')?.remove();
    }

    build() {
        const header = element('div', 'hcf-header');
        const title = element('div');
        title.append(element('h2', '', '我的会话'), element('p', 'hcf-subtitle', '把故事收进文件夹，随时接着聊。'));
        const actions = element('div', 'hcf-actions');
        this.refreshButton = button('刷新目录', '同步角色群组并重新读取历史会话，保留所有分类', () => this.refresh({ manual: true }));
        const importing = this.importButton({ scope: 'home' });
        this.undoButton = button('撤销上次导入/删除', '恢复最近一次导入或删除文件夹前的自动快照', () => this.guard(() => this.undoSnapshot({ scope: 'home' })));
        actions.append(
            button('＋ 新建文件夹', '', () => this.folderDialog()),
            this.refreshButton,
            button('导出', '导出文件夹与分类，不含聊天正文', () => this.guard(() => this.exportBackup())),
            importing.button, importing.input,
            this.undoButton,
            button('恢复原列表', '关闭首页替换，可在扩展设置中重新启用', () => this.guard(() => {
                this.commit(s => ({ ...s, enabled: false }));
                this.unmount();
            })),
        );
        header.append(title, actions);

        this.status = element('div', 'hcf-status');
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        this.statusMessage = element('span', 'hcf-status-text');
        this.missingButton = button('', '批量管理或重新关联改名、缺失的会话记录', () => this.missingDialog());
        this.status.append(this.statusMessage, this.missingButton);

        const layout = element('div', 'hcf-layout');
        const sidebar = element('aside', 'hcf-sidebar'); sidebar.setAttribute('aria-label', '会话文件夹');
        const sideHeader = element('div', 'hcf-sidebar-title', '文件夹');
        this.tree = element('div', 'hcf-tree');
        sidebar.append(sideHeader, this.tree);

        const main = element('div', 'hcf-main');
        const bar = element('div', 'hcf-searchbar');
        this.search = element('input', 'hcf-search');
        this.search.type = 'search';
        this.search.placeholder = '搜索角色或会话名称';
        this.search.setAttribute('aria-label', '搜索角色或会话名称');
        this.search.value = this.query;
        const scheduleSearch = immediate => {
            clearTimeout(this.searchTimer);
            const run = () => {
                if (this.query === this.search.value) return;
                this.query = this.search.value;
                this.page = 1;
                this.selected.clear();
                this.lastAnchorKey = null;
                this.renderTree();
                this.renderList();
            };
            if (immediate || !this.search.value) run();
            else this.searchTimer = setTimeout(run, 120);
        };
        this.search.addEventListener('input', event => {
            if (event.isComposing) return;
            scheduleSearch(false);
        });
        this.search.addEventListener('compositionend', () => scheduleSearch(false));

        this.sort = element('select');
        this.sort.setAttribute('aria-label', '会话排序');
        for (const [value, name] of [['recent', '最近消息优先'], ['oldest', '最早消息优先'], ['name', '会话名称'], ['character', '角色名称']]) {
            this.sort.append(option(value, name));
        }
        this.sort.addEventListener('change', () => this.guard(() => {
            this.commit(s => ({ ...s, preferences: { ...s.preferences, sort: this.sort.value } }));
            this.page = 1; this.lastAnchorKey = null; this.renderList();
        }));

        this.previewToggle = element('input'); this.previewToggle.type = 'checkbox';
        this.previewToggle.addEventListener('change', () => this.guard(() => {
            this.commit(s => ({ ...s, preferences: { ...s.preferences, previews: this.previewToggle.checked } }));
            this.renderList();
        }));
        bar.append(this.search, this.sort, labeled('显示预览', this.previewToggle));

        const breadcrumbBar = element('div', 'hcf-breadcrumb-bar');
        this.breadcrumb = element('div', 'hcf-breadcrumb');
        this.subfolderToggle = element('input');
        this.subfolderToggle.type = 'checkbox';
        this.subfolderToggle.checked = this.includeSubfolders;
        this.subfolderToggle.addEventListener('change', () => {
            this.includeSubfolders = this.subfolderToggle.checked;
            this.page = 1; this.selected.clear(); this.lastAnchorKey = null;
            this.renderTree(); this.renderList();
        });
        this.subfolderField = labeled('包含子文件夹', this.subfolderToggle, 'hcf-field hcf-subfolder-toggle');
        breadcrumbBar.append(this.breadcrumb, this.subfolderField);

        this.selectionBar = element('div', 'hcf-selection');
        this.list = element('div', 'hcf-list');
        this.pagination = element('div', 'hcf-pagination');
        main.append(bar, breadcrumbBar, this.selectionBar, this.list, this.pagination);
        layout.append(sidebar, main);
        this.root.append(header, this.status, layout);
        this.syncUndoButtons();
    }

    async refresh({ manual = false, background = false, initial = false } = {}) {
        if (this.loading || this.revalidating || this.deleting || this.renaming || this.stopped) return;
        const isBackground = background && Boolean(this.repository.lastLoaded);
        if (isBackground) {
            this.revalidating = true;
            this.renderStatus();
        } else {
            this.loading = true;
            this.error = '';
            this.notice = '';
            this.renderList();
            this.renderStatus();
        }
        const revision = this.catalogRevision;
        try {
            const ctx = this.getContext();
            if ((manual || this.dirty) && typeof ctx.getCharacters === 'function') {
                await ctx.getCharacters();
                if (this.stopped) return;
            }
            if (!this.repository.lastLoaded && initial && !manual) {
                await this.repository.load();
                if (this.stopped) return;
                this.render();
                this.notice = '已显示最近会话，正在补全历史目录…';
                this.renderStatus();
            }
            await this.repository.load({ full: true });
            if (this.stopped) return;
            this.dirty = this.catalogRevision !== revision;
            const valid = new Set(this.repository.chats.map(c => c.key));
            this.selected = new Set([...this.selected].filter(k => valid.has(k)));
            if (this.pendingAutoCleanChatNames.size && this.repository.complete && this.state.preferences.autoCleanOnDelete) {
                this.flushPendingAutoClean(valid);
            }
            if (!isBackground) this.notice = '';
        } catch (error) {
            if (!this.stopped) this.showError(error);
        } finally {
            this.loading = false;
            this.revalidating = false;
            if (!this.stopped) this.render();
        }
    }

    flushPendingAutoClean(validKeys) {
        const names = new Set(this.pendingAutoCleanChatNames);
        this.pendingAutoCleanChatNames.clear();
        const toDelete = Object.keys(this.state.assignments).filter(k => {
            const p = parseKey(k);
            return p && p.kind === 'character' && names.has(p.name) && !validKeys.has(k);
        });
        if (toDelete.length) {
            this.guard(() => {
                this.commit(s => {
                    const assignments = { ...s.assignments };
                    for (const k of toDelete) delete assignments[k];
                    return { ...s, assignments };
                });
            });
        }
    }

    // Never hide "待关联" when this.error is non-empty! Users explicitly need "待关联" to resolve rename conflicts.
    missing() {
        if (!this.repository.complete || this.loading || (this.dirty && !this.revalidating)) return [];
        const found = new Set(this.repository.chats.map(c => c.key));
        return Object.keys(this.state.assignments).filter(key => !found.has(key));
    }

    renderStatus() {
        if (!this.root) return;
        const repo = this.repository;
        this.status.classList.toggle('hcf-error', Boolean(this.error));
        const busy = this.loading || this.revalidating;
        this.statusMessage.textContent = this.error || (this.loading
            ? (this.notice || '正在读取会话目录，长聊天较多时可能需要一些时间…')
            : `已载入 ${repo.chats.length} 个会话${repo.complete ? '' : '（历史目录尚未完整载入）'}${repo.skipped ? ` · ${repo.skipped} 个无关联角色或特殊会话未显示` : ''}${this.revalidating ? ' · 正在后台同步…' : ''}${this.notice ? ` · ${this.notice}` : ''}`);
        this.refreshButton.disabled = busy || this.deleting || this.renaming;
        this.refreshButton.textContent = this.loading ? '读取中…' : (this.revalidating ? '同步中…' : '刷新目录');
        const missing = this.missing();
        this.missingButton.hidden = !missing.length;
        this.missingButton.textContent = `待关联 ${missing.length}`;
        this.syncUndoButtons();
    }

    render() {
        if (!this.root) return;
        this.sort.value = this.state.preferences.sort;
        this.previewToggle.checked = this.state.preferences.previews;
        this.subfolderToggle.checked = this.includeSubfolders;
        this.renderTree();
        this.renderList();
        this.renderStatus();
    }

    setFolder(id) {
        if (this.viewState) {
            this.viewState = { ...this.viewState, folderId: id };
            saveViewState(this.getContext(), this.viewState);
        } else if (this.state) {
            this.state.preferences.folderId = id;
        }
        this.page = 1;
        this.selected.clear();
        this.lastAnchorKey = null;
        this.render();
    }

    toggleCollapse(id) {
        const set = this.collapsedSet();
        if (set.has(id)) set.delete(id); else set.add(id);
        const collapsed = [...set];
        if (this.viewState) {
            this.viewState = { ...this.viewState, collapsed };
            saveViewState(this.getContext(), this.viewState);
        } else if (this.state) {
            this.state.preferences.collapsed = collapsed;
        }
        this.renderTree();
    }

    renderTree() {
        if (!this.root) return;
        this.tree.replaceChildren();
        const folderIndex = this.getFolderIndex();
        const activeId = this.activeFolderId();
        const collapsed = this.collapsedSet();
        const fragments = queryFragments(this.query);
        const isSearching = fragments.length > 0;

        const directCounts = new Map();
        let matchedTotal = 0;
        for (const chat of this.repository.chats) {
            if (isSearching && !matchesFragments(chat, fragments)) continue;
            matchedTotal++;
            const folder = this.state.assignments[chat.key] ?? UNFILED;
            directCounts.set(folder, (directCounts.get(folder) ?? 0) + 1);
        }

        const subtreeCounts = new Map();
        for (const [id, desc] of folderIndex.descendantsById.entries()) {
            let sum = 0;
            for (const subId of desc) sum += directCounts.get(subId) ?? 0;
            subtreeCounts.set(id, sum);
        }

        const row = (id, name, countText, countTip, hasSearchHit, depth, folder) => {
            const line = element('div', `hcf-folder-row${activeId === id ? ' hcf-current' : ''}`);
            line.style.setProperty('--hcf-depth', String(depth));
            if (folder) {
                line.style.setProperty('--hcf-folder-color', folder.color);
                const children = (folderIndex.childrenByParent.get(id)?.length ?? 0) > 0;
                const folded = collapsed.has(id);
                const toggle = button(
                    children ? (folded ? '▸' : '▾') : '·',
                    children ? '展开或收起子文件夹' : '没有子文件夹',
                    () => this.toggleCollapse(id),
                    'hcf-fold-toggle',
                );
                toggle.disabled = !children;
                toggle.setAttribute('aria-expanded', String(!folded));
                line.append(toggle);
            }
            const choose = button('', countTip ? `${name}（${countTip}）` : name, () => this.setFolder(id), 'hcf-folder-choose');
            const countBadge = element('span', `hcf-count${hasSearchHit ? ' hcf-count-match' : ''}`, countText);
            if (countTip) countBadge.title = countTip;
            choose.append(
                element('span', 'hcf-folder-dot', folder ? '●' : (id === ALL ? '◈' : '◇')),
                element('span', 'hcf-folder-name', name),
                countBadge,
            );
            if (activeId === id) choose.setAttribute('aria-current', 'page');
            line.append(choose);
            if (folder) line.append(button('⋯', `编辑文件夹 ${name}`, () => this.folderDialog(folder), 'hcf-folder-edit'));
            if (id !== ALL) {
                line.addEventListener('dragover', event => {
                    if (this.deleting || this.renaming) return;
                    if (event.dataTransfer?.types.includes('application/x-hcf-chats')) {
                        event.preventDefault();
                        line.classList.add('hcf-drop');
                    }
                });
                line.addEventListener('dragleave', event => {
                    if (!line.contains(event.relatedTarget)) line.classList.remove('hcf-drop');
                });
                line.addEventListener('drop', event => {
                    event.preventDefault();
                    line.classList.remove('hcf-drop');
                    if (this.deleting || this.renaming) return;
                    this.guard(() => {
                        const keys = JSON.parse(event.dataTransfer.getData('application/x-hcf-chats'));
                        const known = new Set(this.repository.chats.map(c => c.key));
                        if (!Array.isArray(keys) || keys.some(k => !known.has(k))) throw new Error('请拖入当前酒馆中已载入的会话。');
                        this.move(keys, id);
                    });
                });
            }
            this.tree.append(line);
        };

        row(ALL, '全部会话', String(matchedTotal), isSearching ? `搜索命中 ${matchedTotal} 个会话` : '', isSearching && matchedTotal > 0, 0);
        const unfiledCount = directCounts.get(UNFILED) ?? 0;
        row(UNFILED, '未分类', String(unfiledCount), isSearching ? `未分类命中 ${unfiledCount} 个` : '', isSearching && unfiledCount > 0, 0);

        const walk = (parentId, depth) => {
            const children = folderIndex.childrenByParent.get(parentId) ?? [];
            for (const f of children) {
                const direct = directCounts.get(f.id) ?? 0;
                const total = subtreeCounts.get(f.id) ?? direct;
                const subOnly = total - direct;
                const folded = collapsed.has(f.id);
                let countText = String(direct);
                let countTip = '';
                if (this.includeSubfolders && subOnly > 0) {
                    countText = String(total);
                    countTip = `直属 ${direct} 个，子文件夹 ${subOnly} 个`;
                } else if ((folded || isSearching) && subOnly > 0) {
                    countText = `${direct} (+${subOnly})`;
                    countTip = `直属 ${direct} 个，子文件夹 ${subOnly} 个`;
                }
                const hasHit = isSearching && (folded ? total > 0 : direct > 0);
                row(f.id, f.name, countText, countTip, hasHit, depth, f);
                if (!folded) walk(f.id, depth + 1);
            }
        };
        walk(null, 0);
    }

    syncSelectionUI() {
        if (!this.root) return;
        const rows = this.currentRows ?? [];
        const locked = this.deleting || this.renaming;
        this.selectionBar.replaceChildren();
        const selectAll = element('input');
        selectAll.type = 'checkbox';
        selectAll.setAttribute('aria-label', '选择本页会话');
        selectAll.checked = rows.length > 0 && rows.every(c => this.selected.has(c.key));
        selectAll.indeterminate = !selectAll.checked && rows.some(c => this.selected.has(c.key));
        selectAll.disabled = !rows.length || locked;
        selectAll.addEventListener('change', () => {
            for (const c of rows) {
                if (selectAll.checked) this.selected.add(c.key);
                else this.selected.delete(c.key);
            }
            this.syncSelectionUI();
        });
        this.selectionBar.append(labeled('选本页', selectAll), element('span', '', `已选 ${this.selected.size}`));

        const move = button('移动到…', '将选中的会话放入文件夹', () => this.moveDialog([...this.selected]));
        move.disabled = !this.selected.size || locked;
        const remove = button('删除所选', '永久删除选中的聊天记录', () => this.deleteChats([...this.selected]), 'hcf-danger');
        remove.disabled = !this.selected.size || this.loading || this.opening || locked;
        const clear = button('清空选择', '', () => { this.selected.clear(); this.lastAnchorKey = null; this.syncSelectionUI(); });
        clear.disabled = !this.selected.size || locked;
        this.selectionBar.append(move, remove, clear);

        for (const item of this.list.children) {
            const key = item.dataset?.key;
            if (!key) continue;
            const isSelected = this.selected.has(key);
            item.classList.toggle('hcf-selected', isSelected);
            const checkbox = item.firstElementChild;
            if (checkbox?.tagName === 'INPUT') checkbox.checked = isSelected;
        }
    }

    renderList() {
        if (!this.root) return;
        const folderIndex = this.getFolderIndex();
        const activeId = this.activeFolderId();
        const isUserFolder = ![ALL, UNFILED].includes(activeId);
        const pinnedKeys = readPinnedKeys(this.getContext());
        const chats = visibleChats(this.repository.chats, this.state, this.query, {
            folderId: activeId,
            includeSubfolders: isUserFolder && this.includeSubfolders,
            pinnedKeys,
            folderIndex,
        });
        this.page = Math.min(this.page, Math.max(1, Math.ceil(chats.length / this.pageSize)));
        const rows = chats.slice((this.page - 1) * this.pageSize, this.page * this.pageSize);
        this.currentRows = rows;

        this.subfolderToggle.disabled = !isUserFolder;
        this.subfolderField.classList.toggle('hcf-disabled-field', !isUserFolder);
        this.breadcrumb.textContent = `${folderPath(this.state, activeId, folderIndex)} · ${chats.length} 个会话${isUserFolder && this.includeSubfolders ? '（含子文件夹）' : ''}${this.query.trim() ? '（名称搜索）' : ''}`;

        const locked = this.deleting || this.renaming;
        this.list.replaceChildren();
        if (!rows.length) {
            const empty = element('div', 'hcf-empty');
            const hasChildren = (folderIndex.childrenByParent.get(activeId)?.length ?? 0) > 0;
            empty.append(
                element('strong', '', this.loading ? '正在读取会话…' : this.query.trim() ? '没有找到匹配的会话' : '这里还没有直属会话'),
                element('p', '', this.loading
                    ? '历史目录正在补全，已有分类会保留。'
                    : this.query.trim()
                        ? '左侧文件夹数字已实时标注命中分布，可切换文件夹或清空关键词重试。'
                        : hasChildren
                            ? '可勾选右上角“包含子文件夹”汇总查看，或从左侧进入具体子文件夹。'
                            : '到“全部会话”选择会话，再点击“移动到…”。'),
            );
            this.list.append(empty);
        }

        for (const chat of rows) {
            const isPinned = pinnedKeys.has(chat.key);
            const item = element('article', `hcf-chat${this.selected.has(chat.key) ? ' hcf-selected' : ''}${isPinned ? ' hcf-chat-pinned' : ''}`);
            item.dataset.key = chat.key;
            item.draggable = !locked;

            const check = element('input', 'hcf-chat-check');
            check.type = 'checkbox';
            check.checked = this.selected.has(chat.key);
            check.setAttribute('aria-label', `选择 ${chat.character}：${chat.name}`);
            check.disabled = locked;
            check.addEventListener('click', event => {
                const targetState = check.checked;
                if (event.shiftKey && this.lastAnchorKey && this.lastAnchorKey !== chat.key) {
                    const a = this.currentRows.findIndex(r => r.key === this.lastAnchorKey);
                    const b = this.currentRows.findIndex(r => r.key === chat.key);
                    if (a >= 0 && b >= 0) {
                        const [start, end] = a < b ? [a, b] : [b, a];
                        for (let i = start; i <= end; i++) {
                            if (targetState) this.selected.add(this.currentRows[i].key);
                            else this.selected.delete(this.currentRows[i].key);
                        }
                    } else if (targetState) this.selected.add(chat.key);
                    else this.selected.delete(chat.key);
                } else {
                    if (targetState) this.selected.add(chat.key);
                    else this.selected.delete(chat.key);
                }
                this.lastAnchorKey = chat.key;
                this.syncSelectionUI();
            });

            const avatar = element('div', 'hcf-avatar');
            if (typeof chat.avatar === 'string' && chat.avatar) {
                const img = element('img');
                img.src = chat.avatar; img.alt = ''; img.loading = 'lazy';
                img.addEventListener('error', () => { avatar.textContent = chat.character.slice(0, 1); }, { once: true });
                avatar.append(img);
            } else {
                avatar.textContent = chat.kind === 'group' ? '群' : chat.character.slice(0, 1);
            }

            const open = button('', `继续会话：${chat.name}`, () => this.open(chat), 'hcf-open');
            open.disabled = this.opening || locked;
            const charLine = element('span', 'hcf-character', isPinned ? `★ ${chat.character}` : chat.character);
            open.append(charLine, element('strong', 'hcf-chat-name', chat.name));
            const date = chat.dateText ?? formatChatDate(chat.timestamp);
            const folder = this.state.assignments[chat.key];
            const details = `${date} · ${chat.messageCount} 条${chat.fileSize ? ` · ${chat.fileSize}` : ''} · ${folder ? folderPath(this.state, folder, folderIndex) : '未分类'}`;
            open.append(element('span', 'hcf-chat-meta', details));
            if (this.state.preferences.previews && chat.preview) open.append(element('span', 'hcf-preview', chat.preview));

            const actions = element('div', 'hcf-row-actions');
            const pinOne = button(
                isPinned ? '★ 置顶' : '☆ 置顶',
                isPinned ? '取消置顶会话（与酒馆原生置顶同步）' : '置顶会话（在当前视图优先显示，与酒馆原生置顶同步）',
                () => this.togglePin(chat, !isPinned),
                `hcf-row-pin${isPinned ? ' hcf-pinned' : ''}`,
            );
            pinOne.setAttribute('aria-pressed', String(isPinned));
            pinOne.disabled = locked;
            const moveOne = button('移入', '移动此会话到文件夹', () => this.moveDialog([chat.key]), 'hcf-row-move');
            moveOne.disabled = locked;
            const renameOne = button('改名', `重命名会话：${chat.name}`, () => this.renameDialog(chat), 'hcf-row-rename');
            renameOne.disabled = this.loading || this.opening || locked;
            const deleteOne = button('删除', `永久删除：${chat.character} / ${chat.name}`, () => this.deleteChats([chat.key]), 'hcf-danger hcf-row-delete');
            deleteOne.disabled = this.loading || this.opening || locked;
            actions.append(pinOne, moveOne, renameOne, deleteOne);

            item.append(check, avatar, open, actions);
            item.addEventListener('dragstart', event => {
                if (locked || event.target.closest?.('input, .hcf-row-actions')) { event.preventDefault(); return; }
                const keys = this.selected.has(chat.key) ? [...this.selected] : [chat.key];
                event.dataTransfer.setData('application/x-hcf-chats', JSON.stringify(keys));
                event.dataTransfer.effectAllowed = 'move';
            });
            this.list.append(item);
        }

        this.syncSelectionUI();

        this.pagination.replaceChildren();
        const pages = Math.max(1, Math.ceil(chats.length / this.pageSize));
        const previous = button('上一页', '', () => { this.page--; this.lastAnchorKey = null; this.renderList(); });
        previous.disabled = this.page <= 1;
        const next = button('下一页', '', () => { this.page++; this.lastAnchorKey = null; this.renderList(); });
        next.disabled = this.page >= pages;
        this.pagination.append(previous, element('span', '', `${this.page} / ${pages}`), next);
    }

    togglePin(chat, pinned) {
        if (this.deleting || this.renaming) return;
        setPinnedChat(this.getContext(), chat, pinned);
        this.notice = pinned ? `已置顶「${chat.name}」` : `已取消置顶「${chat.name}」`;
        this.renderList();
        this.renderStatus();
    }

    async open(chat) {
        if (this.opening || this.deleting || this.renaming || this.stopped) return;
        this.opening = true; this.renderList();
        try {
            await this.opener(chat, () => {
                if (this.stopped || !this.state.enabled) throw new Error('首页文件夹已关闭，已取消打开会话。');
                return this.getContext();
            });
        } catch (error) {
            this.showError(error);
        } finally {
            this.opening = false;
            this.renderList();
        }
    }

    move(keys, folder) {
        if (this.deleting || this.renaming) return;
        this.commit(s => assignChats(s, keys, folder));
        this.selected.clear();
        this.lastAnchorKey = null;
        this.notice = `已移动 ${keys.length} 个会话`;
        this.render();
    }

    renameDialog(chat) {
        if (this.deleting || this.renaming || this.opening || this.loading) return;
        const dialog = this.dialog('重命名会话');
        const input = element('input');
        input.type = 'text';
        input.maxLength = 220;
        input.value = chat.name;
        const hint = element('p', 'hcf-dialog-hint', `所属：${chat.character}。重命名后文件夹归属与置顶状态会自动跟随。`);
        dialog.body.append(labeled('新会话名称', input), hint);

        const submit = this.dialogAction(dialog, async () => {
            await this.performInlineRename(chat, input.value);
            dialog.close();
        });
        dialog.footer.append(button('保存名称', '', submit, 'hcf-primary'));
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); }
        });
        queueMicrotask(() => { if (input.isConnected) input.select?.(); });
    }

    async performInlineRename(chat, rawNewName) {
        if (this.renaming || this.deleting || this.opening || this.stopped || !this.state.enabled) return;
        this.renaming = true;
        this.renderList();
        this.renderStatus();
        try {
            const res = await this.renamer(chat, rawNewName, () => {
                if (this.stopped || !this.state.enabled) throw new Error('首页文件夹已关闭，已取消重命名。');
                return this.getContext();
            });
            const ctx = this.getContext();
            remapPinnedChat(ctx, chat.kind, chat.owner, [res.oldName, String(rawNewName ?? '').trim()], res.newName);
            if (res.oldKey !== res.newKey && this.state.assignments[res.oldKey]) {
                this.commit(s => {
                    const out = remapKeys(s, p => encodeKey(p.kind, p.owner, p.name) === res.oldKey ? res.newKey : null, { keepConflicts: true });
                    return out.state;
                });
            }
            const target = this.repository.chats.find(c => c.key === res.oldKey);
            if (target) {
                target.name = res.newName;
                target.key = res.newKey;
                target.searchText = buildSearchText(target.character, res.newName);
            }
            if (this.selected.has(res.oldKey)) {
                this.selected.delete(res.oldKey);
                this.selected.add(res.newKey);
            }
            this.error = '';
            this.notice = `已将会话重命名为「${res.newName}」`;
        } finally {
            this.renaming = false;
            if (!this.stopped) this.render();
        }
    }

    async deleteChats(keys) {
        if (this.deleting || this.renaming || this.opening || this.loading || this.stopped || !this.state.enabled) return;
        const unique = [...new Set(keys)];
        if (!unique.length) return;
        const catalog = new Map(this.repository.chats.map(chat => [chat.key, chat]));
        const chats = unique.map(key => catalog.get(key));
        if (chats.some(chat => !chat)) { this.showError(new Error('部分会话已改变，请刷新目录后重新选择。')); return; }
        this.deleting = true; this.renderList(); this.renderStatus();
        const deleted = [];
        let failure;
        try {
            const names = chats.slice(0, 10).map(chat => `${chat.character} / ${chat.name}`).join('\n');
            const ok = await this.confirm(
                `永久删除 ${chats.length} 个会话`,
                `将永久删除以下聊天记录，无法通过分类备份恢复。请先在酒馆备份需要保留的聊天。\n\n${names}${chats.length > 10 ? `\n……另有 ${chats.length - 10} 个会话（包含跨页选择）` : ''}`,
                '永久删除',
            );
            if (!ok) return;
            this.error = ''; this.notice = `正在删除 0 / ${chats.length} 个会话…`; this.renderStatus();
            for (const chat of chats) {
                const getContext = () => {
                    if (this.stopped || !this.state.enabled) throw new Error('首页文件夹已关闭，已停止删除。');
                    const context = this.getContext();
                    if (context.getCurrentChatId?.() !== undefined) throw new Error('页面已切换到其他会话，已停止删除。');
                    if (!this.repository.chats.includes(chat)) throw new Error('会话目录已改变，请刷新后重新选择。');
                    return context;
                };
                getContext();
                await this.deleter(chat, getContext);
                deleted.push(chat.key);
                this.repository.chats = this.repository.chats.filter(c => c.key !== chat.key);
                this.selected.delete(chat.key);
                this.notice = `正在删除 ${deleted.length} / ${chats.length} 个会话…`;
                this.render();
            }
        } catch (error) { failure = error; }
        finally {
            if (deleted.length) {
                const deletedSet = new Set(deleted);
                removePinnedByPredicate(this.getContext(), coords => deletedSet.has(coords.key));
                // Apply cleanup to the newest settings, preserving unrelated edits.
                try {
                    const stored = this.getContext().extensionSettings[SETTINGS_KEY];
                    if (stored && stored.revision && stored.revision !== this.state.revision) {
                        this.state = sanitizeAndRecover(stored).state;
                    }
                    this.commit(s => {
                        const assignments = { ...s.assignments };
                        for (const key of deleted) delete assignments[key];
                        return { ...s, assignments };
                    });
                } catch (error) { failure = new Error(`聊天已删除，但分类清理未完成：${error.message}`); }
                // this.repository.chats was already updated in-place for confirmed deletions;
                // only mark dirty on partial failure so "待关联" remains immediately accessible!
                if (failure) this.invalidate();
                this.notice = `已永久删除 ${deleted.length} 个会话`;
            }
            this.deleting = false;
            if (failure) this.showError(new Error(`已删除 ${deleted.length} 个，${chats.length - deleted.length} 个未确认删除。${failure.message}`));
            if (!this.stopped) this.render();
        }
    }

    dialog(title, { scope = 'home', wide = false } = {}) {
        const overlay = element('div', 'hcf-overlay');
        const box = element('section', `hcf-dialog${wide ? ' hcf-dialog-wide' : ''}`);
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.tabIndex = -1;
        const titleId = `hcf-dialog-${uid()}`;
        const heading = element('h3', '', title); heading.id = titleId;
        box.setAttribute('aria-labelledby', titleId);
        const body = element('div', 'hcf-dialog-body');
        const error = element('div', 'hcf-dialog-error'); error.setAttribute('role', 'alert');
        const footer = element('div', 'hcf-dialog-footer');
        const previousFocus = document.activeElement;
        const result = {
            overlay, box, body, footer, error, scope,
            close: () => {
                document.removeEventListener('keydown', keydown, true);
                overlay.remove();
                this.dialogs.delete(result);
                if (previousFocus?.isConnected) previousFocus.focus();
            },
        };
        const keydown = event => {
            if ([...this.dialogs].at(-1) !== result) return;
            if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); result.close(); }
            if (event.key === 'Tab') {
                const focusable = [...box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
                    .filter(el => !el.disabled && !el.hidden && !el.closest?.('[hidden]'));
                const first = focusable[0], last = focusable.at(-1);
                if (!first) { event.preventDefault(); box.focus(); return; }
                if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || document.activeElement === box)) { event.preventDefault(); first.focus(); }
            }
        };
        footer.append(button('取消', '', result.close));
        box.append(heading, body, error, footer);
        overlay.append(box);
        document.body.append(overlay);
        // Require BOTH pointerdown and click on backdrop to prevent text drag-selection from accidentally closing dialog.
        let pointerDownOutside = false;
        overlay.addEventListener('pointerdown', event => { pointerDownOutside = event.target === overlay; });
        overlay.addEventListener('click', event => {
            if (pointerDownOutside && event.target === overlay) result.close();
            pointerDownOutside = false;
        });
        document.addEventListener('keydown', keydown, true);
        this.dialogs.add(result);
        queueMicrotask(() => { if (overlay.isConnected) (body.querySelector('input, select, button') ?? box).focus(); });
        return result;
    }

    dialogAction(dialog, action) {
        return () => this.guard(async () => {
            dialog.error.textContent = '';
            try { await action(); }
            catch (error) { dialog.error.textContent = error.message; }
        });
    }

    async confirm(title, message, label = '确定', { scope = 'home', danger = false } = {}) {
        return new Promise(resolve => {
            const dialog = this.dialog(title, { scope });
            dialog.body.classList.add('hcf-confirm-message');
            dialog.body.append(element('p', '', message));
            const close = dialog.close;
            dialog.close = () => { close(); resolve(false); };
            dialog.footer.replaceChildren(
                button('取消', '', dialog.close),
                button(label, '', () => { close(); resolve(true); }, danger ? 'hcf-danger' : 'hcf-primary'),
            );
        });
    }

    folderOptions(select, { system = false, excluded = new Set() } = {}) {
        const folderIndex = this.getFolderIndex();
        if (system) select.append(option(UNFILED, '未分类（移出文件夹）'));
        const visit = parentId => {
            for (const f of folderIndex.childrenByParent.get(parentId) ?? []) {
                if (!excluded.has(f.id)) select.append(option(f.id, folderPath(this.state, f.id, folderIndex)));
                visit(f.id);
            }
        };
        visit(null);
    }

    folderDialog(folder = null) {
        this.guard(() => {
            const folderIndex = this.getFolderIndex();
            const activeId = this.activeFolderId();
            const dialog = this.dialog(folder ? '编辑文件夹' : '新建文件夹');
            const name = element('input'); name.type = 'text'; name.maxLength = 80; name.value = folder?.name ?? '';
            const parent = element('select'); parent.append(option('', '顶层文件夹'));
            this.folderOptions(parent, { excluded: folder ? descendants(this.state, folder.id, folderIndex) : new Set() });
            parent.value = folder ? (folder.parentId ?? '') : (folderIndex.byId.has(activeId) ? activeId : '');
            if (folder && parent.value === folder.id) parent.value = '';
            const color = element('input'); color.type = 'color'; color.value = folder?.color ?? COLORS[this.state.folders.length % COLORS.length];
            dialog.body.append(labeled('名称', name), labeled('放在', parent), labeled('颜色', color));

            let draftIndex = null;
            if (folder) {
                const getOtherSiblings = parentVal => {
                    const pid = parentVal || null;
                    return this.state.folders.filter(f => f.parentId === pid && f.id !== folder.id).sort((a, b) => a.order - b.order);
                };
                const initialSiblings = this.state.folders.filter(f => f.parentId === folder.parentId).sort((a, b) => a.order - b.order);
                draftIndex = Math.max(0, initialSiblings.findIndex(f => f.id === folder.id));

                const ordering = element('div', 'hcf-actions');
                const posInfo = element('span', 'hcf-order-hint');
                const upBtn = button('上移', '在所选父文件夹下前移一位（点击保存生效）', () => {
                    if (draftIndex > 0) { draftIndex--; syncOrderUI(); }
                });
                const downBtn = button('下移', '在所选父文件夹下后移一位（点击保存生效）', () => {
                    const max = getOtherSiblings(parent.value).length;
                    if (draftIndex < max) { draftIndex++; syncOrderUI(); }
                });
                const syncOrderUI = () => {
                    const total = getOtherSiblings(parent.value).length + 1;
                    draftIndex = Math.max(0, Math.min(total - 1, draftIndex));
                    posInfo.textContent = `同级位置：第 ${draftIndex + 1} / ${total} 位`;
                    upBtn.disabled = draftIndex <= 0;
                    downBtn.disabled = draftIndex >= total - 1;
                };
                parent.addEventListener('change', () => {
                    const targetParent = parent.value || null;
                    if (targetParent === folder.parentId) {
                        draftIndex = Math.max(0, initialSiblings.findIndex(f => f.id === folder.id));
                    } else {
                        draftIndex = getOtherSiblings(parent.value).length;
                    }
                    syncOrderUI();
                });
                syncOrderUI();
                ordering.append(upBtn, downBtn, posInfo);
                dialog.body.append(ordering);

                dialog.footer.prepend(button('删除文件夹', '会话转入未分类，子文件夹提升一级（自动保存快照可撤销）', this.dialogAction(dialog, async () => {
                    const ok = await this.confirm('删除文件夹', `此文件夹的直属会话将回到“未分类”，子文件夹提升一级。聊天记录不会删除。\n删除前会自动保存快照，可通过“撤销上次导入/删除”恢复。`, '删除文件夹');
                    if (!ok) return;
                    saveSnapshot(this.getContext(), this.state, `删除文件夹「${folder.name}」前`);
                    if (this.activeFolderId() === folder.id) {
                        if (this.viewState) {
                            this.viewState = { ...this.viewState, folderId: UNFILED };
                            saveViewState(this.getContext(), this.viewState);
                        }
                    }
                    this.commit(s => deleteFolder(s, folder.id));
                    dialog.close();
                    this.selected.clear(); this.lastAnchorKey = null;
                    this.notice = `已删除文件夹「${folder.name}」（可点击“撤销上次导入/删除”恢复）`;
                    this.render();
                }), 'hcf-danger'));
            }

            const save = this.dialogAction(dialog, () => {
                this.commit(s => upsertFolder(s, {
                    ...(folder ? { id: folder.id, targetIndex: draftIndex } : {}),
                    name: name.value,
                    parentId: parent.value || null,
                    color: color.value,
                }), { strict: true });
                dialog.close();
                this.render();
            });
            dialog.footer.append(button('保存', '', save, 'hcf-primary'));
            name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(); } });
        });
    }

    moveDialog(keys) {
        if (!keys.length) return;
        const dialog = this.dialog(`移动 ${keys.length} 个会话`);
        const select = element('select'); this.folderOptions(select, { system: true });
        const current = this.state.assignments[keys[0]]; if (current) select.value = current;
        dialog.body.append(labeled('目标文件夹', select), element('p', '', '仅更改分类，不移动或改写聊天文件。'));
        dialog.footer.append(button('移动', '', this.dialogAction(dialog, () => { this.move(keys, select.value); dialog.close(); }), 'hcf-primary'));
    }

    exportBackup() {
        download(exportState(this.state, this.viewState), `首页会话分类-${new Date().toISOString().slice(0, 10)}.json`);
    }

    parseBackupJson(rawText) {
        const cleanText = String(rawText ?? '').replace(/^\uFEFF/, '');
        let parsed;
        try {
            parsed = JSON.parse(cleanText);
        } catch {
            throw new Error('无法解析 JSON 文件，请确认选择了有效的分类备份文件。');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('备份文件结构无效，请选择由“首页会话文件夹”导出的 JSON 文件。');
        }
        if (parsed.schemaVersion !== 1) {
            throw new Error('不支持的分类文件版本。');
        }
        if (!Array.isArray(parsed.folders) || !parsed.assignments || typeof parsed.assignments !== 'object' || Array.isArray(parsed.assignments)) {
            throw new Error('备份文件缺少文件夹或归属数据。');
        }
        const { state, issues } = sanitizeAndRecover(parsed);
        return { imported: state, issues };
    }

    importButton({ scope = 'home' } = {}) {
        const input = element('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.hidden = true;
        input.addEventListener('change', () => this.guard(async () => {
            const file = input.files?.[0];
            input.value = '';
            if (!file) return;
            if (file.size > 8 * 1024 * 1024) throw new Error('分类文件超过 8 MB，请检查是否选择了正确的导出文件。');
            const { imported, issues } = this.parseBackupJson(await file.text());
            this.importDialog(imported, { scope, issues });
        }));
        return { input, button: button('导入', '从备份合并或恢复文件夹与分类', () => input.click()) };
    }

    importDialog(imported, { scope = 'home', issues = [] } = {}) {
        const dialog = this.dialog('导入分类备份', { scope });
        const folderCount = imported.folders.length;
        const assignCount = Object.keys(imported.assignments).length;
        dialog.body.append(
            element('p', '', `备份包含 ${folderCount} 个文件夹、${assignCount} 条会话分类（聊天正文不受影响）。导入前会自动保存当前分类快照。`),
            element('p', 'hcf-dialog-hint', '• 合并导入（推荐）：保留现有全部文件夹和归属，按同名路径合并文件夹并仅补充未分类会话的归属。\n• 全量替换：用备份完全替换当前文件夹和归属（保持当前启用状态）。'),
        );
        if (issues.length) {
            dialog.body.append(element('p', 'hcf-dialog-hint', `提示：备份中有 ${issues.length} 处旧格式或异常项已在读取时自动规范化。`));
        }

        const applyMerge = this.dialogAction(dialog, () => {
            if (this.stopped) return;
            saveSnapshot(this.getContext(), this.state, '合并导入分类前');
            let summary = { addedFolders: 0, addedAssignments: 0, skippedConflicts: 0 };
            this.commit(current => {
                const res = mergeStates(current, imported);
                summary = res;
                return res.state;
            });
            dialog.close();
            this.error = '';
            this.notice = `已合并导入：新增 ${summary.addedFolders} 个文件夹、补充 ${summary.addedAssignments} 条归属${summary.skippedConflicts ? `（保留本地已有归属 ${summary.skippedConflicts} 条）` : ''}`;
            this.render();
        });

        const applyReplace = this.dialogAction(dialog, async () => {
            const ok = await this.confirm(
                '确认全量替换分类',
                `将用备份完全替换现有的 ${this.state.folders.length} 个文件夹与 ${Object.keys(this.state.assignments).length} 条分类。系统会自动保存快照供撤销恢复。是否继续？`,
                '确认全量替换',
                { scope, danger: true },
            );
            if (!ok || this.stopped) return;
            saveSnapshot(this.getContext(), this.state, '全量替换导入前');
            this.commit(current => ({ ...imported, enabled: current.enabled }));
            if (this.viewState) {
                this.viewState = {
                    folderId: imported.preferences.folderId,
                    collapsed: [...imported.preferences.collapsed],
                };
                saveViewState(this.getContext(), this.viewState);
            }
            dialog.close();
            this.selected.clear(); this.lastAnchorKey = null; this.page = 1;
            this.error = '';
            this.notice = '已全量替换分类（可通过“撤销上次导入/删除”恢复）';
            this.render();
        });

        dialog.footer.append(
            button('全量替换', '备份当前快照后完全替换现有分类', applyReplace, 'hcf-danger'),
            button('合并导入（推荐）', '保留现有分类，按同名路径合并文件夹并补充新归属', applyMerge, 'hcf-primary'),
        );
    }

    async undoSnapshot({ scope = 'home' } = {}) {
        const ctx = this.getContext();
        const snapshots = loadSnapshots(ctx);
        if (!snapshots.length) throw new Error('暂无可恢复的导入或删除快照。');
        const latest = snapshots[0];
        const when = formatChatDate(Date.parse(latest.createdAt));
        const ok = await this.confirm(
            '撤销上次导入/删除',
            `将恢复至快照「${latest.reason}」（保存时间：${when}，含 ${latest.folderCount} 个文件夹、${latest.assignmentCount} 条分类）。当前启用状态保持不变。`,
            '恢复此快照',
            { scope },
        );
        if (!ok || this.stopped) return;
        const popped = popSnapshot(ctx, latest.id);
        if (!popped) throw new Error('快照已被清理或不可用。');
        this.commit(current => ({ ...popped.state, enabled: current.enabled }));
        if (this.viewState) {
            this.viewState = {
                folderId: popped.state.preferences.folderId,
                collapsed: [...popped.state.preferences.collapsed],
            };
            saveViewState(ctx, this.viewState);
        }
        this.selected.clear(); this.lastAnchorKey = null; this.page = 1;
        this.error = '';
        this.notice = `已恢复快照：${popped.reason}`;
        this.render();
    }

    missingDialog() {
        if (!this.missing().length) return;
        const dialog = this.dialog('失联分类批量治理与重关联', { wide: true });
        const checked = new Set();
        let activeKey = null;
        let queryText = '';

        const renderBody = () => {
            const keys = this.missing();
            dialog.body.replaceChildren();
            dialog.error.textContent = '';

            if (!keys.length) {
                dialog.body.append(element('p', '', '当前所有失联分类记录已处理完毕！'));
                dialog.footer.replaceChildren(button('关闭', '', dialog.close, 'hcf-primary'));
                return;
            }

            for (const k of [...checked]) if (!keys.includes(k)) checked.delete(k);
            if (!activeKey || !keys.includes(activeKey)) activeKey = keys[0];

            const ctx = this.getContext();
            const charMap = new Map((ctx.characters ?? []).map(c => [c.avatar, c.name || c.avatar]));
            const groupMap = new Map((ctx.groups ?? []).map(g => [String(g.id), g.name || String(g.id)]));
            const folderIndex = this.getFolderIndex();

            const parsedItems = keys.map(key => {
                const parsed = parseKey(key);
                const ownerExists = parsed.kind === 'group' ? groupMap.has(parsed.owner) : charMap.has(parsed.owner);
                const ownerLabel = parsed.kind === 'group'
                    ? (groupMap.get(parsed.owner) ?? `${parsed.owner} [群组已不存在]`)
                    : (charMap.get(parsed.owner) ?? `${parsed.owner} [角色已不存在]`);
                const folderLabel = folderPath(this.state, this.state.assignments[key], folderIndex);
                return { key, parsed, ownerExists, ownerLabel, folderLabel };
            });
            const deadOwnerKeys = parsedItems.filter(x => !x.ownerExists).map(x => x.key);

            dialog.body.append(element('p', '', `共 ${keys.length} 条分类记录暂未匹配到会话文件（不会影响任何真实聊天文件）。可勾选批量移除、一键清理已删角色/群组孤儿，或在下方关联到改名后的会话。`));

            const toolbar = element('div', 'hcf-missing-toolbar');
            const checkAll = element('input');
            checkAll.type = 'checkbox';
            checkAll.checked = keys.length > 0 && keys.every(k => checked.has(k));
            checkAll.indeterminate = !checkAll.checked && keys.some(k => checked.has(k));
            checkAll.addEventListener('change', () => {
                for (const k of keys) { if (checkAll.checked) checked.add(k); else checked.delete(k); }
                renderBody();
            });
            const removeCheckedBtn = button(
                `移除所选 (${checked.size})`,
                '仅移除勾选的分类记录，不删除聊天文件',
                this.dialogAction(dialog, async () => {
                    if (!checked.size) return;
                    const count = checked.size;
                    if (!await this.confirm('批量移除失联记录', `将移除已勾选的 ${count} 条失联分类记录，不会删除任何聊天文件。`, '确认移除')) return;
                    const targets = [...checked];
                    this.commit(s => {
                        const assignments = { ...s.assignments };
                        for (const k of targets) delete assignments[k];
                        return { ...s, assignments };
                    });
                    checked.clear();
                    this.notice = `已批量移除 ${count} 条失联分类记录`;
                    this.render();
                    renderBody();
                }),
                'hcf-danger',
            );
            removeCheckedBtn.disabled = !checked.size;

            const cleanOrphansBtn = button(
                `一键清理角色/群组已不存在记录 (${deadOwnerKeys.length})`,
                '自动清理所属角色卡或群组已被删除的孤儿分类记录',
                this.dialogAction(dialog, async () => {
                    if (!deadOwnerKeys.length) return;
                    if (!await this.confirm('清理无主孤儿记录', `将一键移除角色或群组已不存在的 ${deadOwnerKeys.length} 条孤儿分类记录，保留其余记录。`, '一键清理')) return;
                    this.commit(s => {
                        const assignments = { ...s.assignments };
                        for (const k of deadOwnerKeys) delete assignments[k];
                        return { ...s, assignments };
                    });
                    for (const k of deadOwnerKeys) checked.delete(k);
                    this.notice = `已清理 ${deadOwnerKeys.length} 条无主孤儿记录`;
                    this.render();
                    renderBody();
                }),
                'hcf-danger',
            );
            cleanOrphansBtn.disabled = !deadOwnerKeys.length;
            toolbar.append(labeled('全选', checkAll), removeCheckedBtn, cleanOrphansBtn);
            dialog.body.append(toolbar);

            const listBox = element('div', 'hcf-missing-list');
            for (const item of parsedItems) {
                const row = element('div', `hcf-missing-row${item.key === activeKey ? ' hcf-missing-active' : ''}`);
                const cb = element('input');
                cb.type = 'checkbox';
                cb.checked = checked.has(item.key);
                cb.setAttribute('aria-label', `勾选失联记录 ${item.ownerLabel} / ${item.parsed.name}`);
                cb.addEventListener('change', () => {
                    if (cb.checked) checked.add(item.key); else checked.delete(item.key);
                    renderBody();
                });
                const pickBtn = button(
                    '',
                    '点击选中此条记录并在下方关联到目标会话',
                    () => { activeKey = item.key; renderBody(); },
                    'hcf-missing-pick',
                );
                pickBtn.append(
                    element('span', 'hcf-missing-owner', `${item.parsed.kind === 'group' ? '[群聊]' : '[角色]'} ${item.ownerLabel} / ${item.parsed.name}`),
                    element('span', 'hcf-missing-folder', `→ ${item.folderLabel}`),
                );
                row.append(cb, pickBtn);
                listBox.append(row);
            }
            dialog.body.append(listBox);

            const activeItem = parsedItems.find(x => x.key === activeKey) ?? parsedItems[0];
            const relinkBox = element('div', 'hcf-relink-box');
            relinkBox.append(element('strong', 'hcf-relink-title', `当前待关联：${activeItem.ownerLabel} / ${activeItem.parsed.name} → ${activeItem.folderLabel}`));
            const search = element('input');
            search.type = 'search';
            search.placeholder = '搜索目标角色或会话名称';
            search.value = queryText;
            const target = element('select');

            const populate = () => {
                target.replaceChildren(option('', '请选择要关联的目标会话'));
                const q = search.value.trim().toLocaleLowerCase();
                const allMatches = this.repository.chats.filter(c => !q || `${c.character} ${c.name}`.toLocaleLowerCase().includes(q));
                const recommended = allMatches
                    .filter(c => c.kind === activeItem.parsed.kind && c.owner === activeItem.parsed.owner && !this.state.assignments[c.key])
                    .sort((a, b) => similarityScore(b.name, activeItem.parsed.name) - similarityScore(a.name, activeItem.parsed.name) || b.timestamp - a.timestamp);
                const recKeys = new Set(recommended.map(c => c.key));
                const others = allMatches.filter(c => !recKeys.has(c.key)).slice(0, 200);

                if (recommended.length) {
                    const group = document.createElement('optgroup');
                    group.label = `★ 同${activeItem.parsed.kind === 'group' ? '群组' : '角色'}未分类推荐 (${recommended.length})`;
                    for (const c of recommended.slice(0, 50)) group.append(option(c.key, `★ ${c.character} / ${c.name}`));
                    target.append(group);
                    target.value = recommended[0].key;
                }
                if (others.length) {
                    const group = document.createElement('optgroup');
                    group.label = '其他会话（最多显示 200 项）';
                    for (const c of others) {
                        const existingFolder = this.state.assignments[c.key];
                        const suffix = existingFolder ? ` [已在：${folderPath(this.state, existingFolder, folderIndex)}]` : '';
                        group.append(option(c.key, `${c.character} / ${c.name}${suffix}`));
                    }
                    target.append(group);
                }
            };
            search.addEventListener('input', () => { queryText = search.value; populate(); });
            populate();

            const linkBtn = button('关联此条到目标会话', '', this.dialogAction(dialog, () => {
                if (!target.value) throw new Error('请选择目标会话。');
                this.commit(s => {
                    const folder = s.assignments[activeItem.key];
                    if (!folder) throw new Error('原分类记录已改变，请重试。');
                    if (s.assignments[target.value] && s.assignments[target.value] !== folder) {
                        throw new Error('目标会话已有其他分类，请先调整目标会话的文件夹。');
                    }
                    const assignments = { ...s.assignments };
                    delete assignments[activeItem.key];
                    assignments[target.value] = folder;
                    return { ...s, assignments };
                });
                checked.delete(activeItem.key);
                this.notice = `已将分类重新关联至目标会话`;
                this.render();
                renderBody();
            }), 'hcf-primary');

            relinkBox.append(labeled('筛选目标会话', search), labeled('关联到', target));
            dialog.body.append(relinkBox);
            dialog.footer.replaceChildren(button('关闭', '', dialog.close), linkBtn);
        };

        renderBody();
    }

    handleGroupUpdated() {
        this.invalidate();
        if (this.root) this.scheduleRevalidate();
    }

    handleNativeChatDeleted(fileName) {
        if (this.deleting) return;
        this.invalidate();
        const deletedName = normalizeName(fileName);
        if (deletedName && this.state?.preferences.autoCleanOnDelete) {
            const ctx = this.getContext();
            const activeAvatar = ctx.characterId != null ? ctx.characters?.[ctx.characterId]?.avatar : null;
            if (activeAvatar) {
                const targetKey = encodeKey('character', activeAvatar, deletedName);
                removePinnedByPredicate(ctx, c => c.key === targetKey);
                if (this.state.assignments[targetKey]) {
                    this.guard(() => this.commit(s => {
                        const assignments = { ...s.assignments };
                        delete assignments[targetKey];
                        return { ...s, assignments };
                    }));
                }
            } else {
                this.pendingAutoCleanChatNames.add(deletedName);
            }
        }
        if (this.root) this.scheduleRevalidate();
    }

    handleNativeGroupChatDeleted(chatName) {
        if (this.deleting) return;
        this.invalidate();
        const deletedName = normalizeName(chatName);
        if (deletedName && this.state?.preferences.autoCleanOnDelete) {
            const ctx = this.getContext();
            const ownersWithChat = (ctx.groups ?? []).filter(x => x.chats?.includes(deletedName)).map(x => String(x.id));
            const matches = Object.keys(this.state.assignments).filter(k => {
                const p = parseKey(k);
                if (!p || p.kind !== 'group' || p.name !== deletedName) return false;
                if (ctx.groupId != null && String(ctx.groupId) === p.owner) return true;
                const g = ctx.groups?.find(x => String(x.id) === p.owner);
                if (!g || !g.chats?.includes(deletedName)) return true;
                return ownersWithChat.length === 1 && ownersWithChat[0] === p.owner;
            });
            if (matches.length) {
                const matchSet = new Set(matches);
                removePinnedByPredicate(ctx, c => matchSet.has(c.key));
                this.guard(() => this.commit(s => {
                    const assignments = { ...s.assignments };
                    for (const k of matches) delete assignments[k];
                    return { ...s, assignments };
                }));
            }
        }
        if (this.root) this.scheduleRevalidate();
    }

    handleNativeCharacterDeleted(data) {
        this.invalidate();
        const avatar = typeof data === 'string' ? data : data?.character?.avatar;
        if (avatar && this.state?.preferences.autoCleanOnDelete) {
            const ctx = this.getContext();
            removePinnedByPredicate(ctx, c => c.kind === 'character' && c.owner === avatar);
            const matches = Object.keys(this.state.assignments).filter(k => {
                const p = parseKey(k);
                return p?.kind === 'character' && p.owner === avatar;
            });
            if (matches.length) {
                this.guard(() => this.commit(s => {
                    const assignments = { ...s.assignments };
                    for (const k of matches) delete assignments[k];
                    return { ...s, assignments };
                }));
            }
        }
        if (this.root) this.scheduleRevalidate();
    }

    renamedChat(data) {
        if (!data || (!data.avatarId && data.groupId == null) || !data.oldFileName || !data.newFileName) {
            this.invalidate();
            return;
        }
        this.guard(() => {
            try {
                const ctx = this.getContext();
                const kind = data.groupId != null && data.groupId !== '' ? 'group' : 'character';
                const owner = String(kind === 'group' ? data.groupId : data.avatarId);
                const oldName = normalizeName(data.oldFileName);
                const rawNewName = normalizeName(data.newFileName);
                const actualNewName = resolveActualRenamedName(ctx, kind, owner, oldName, data.newFileName);
                if (!oldName || !actualNewName) return;
                const oldKey = encodeKey(kind, owner, oldName);
                const newKey = encodeKey(kind, owner, actualNewName);
                remapPinnedChat(ctx, kind, owner, [oldName, rawNewName], actualNewName);
                if (oldKey !== newKey && this.state.assignments[oldKey]) {
                    let conflicts = [];
                    this.commit(s => {
                        const res = remapKeys(s, parsed => encodeKey(parsed.kind, parsed.owner, parsed.name) === oldKey ? newKey : null, { keepConflicts: true });
                        conflicts = res.conflicts;
                        return res.state;
                    });
                    if (conflicts.length) {
                        throw new Error('重命名后的分类存在冲突，原记录已保留，请在“待关联”中手动处理。');
                    }
                }
            } finally {
                if (!this.renaming) {
                    this.invalidate();
                    if (this.root) this.scheduleRevalidate();
                }
            }
        });
    }

    renamedCharacter(oldAvatar, newAvatar) {
        if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string' || !oldAvatar || !newAvatar) {
            this.invalidate();
            return;
        }
        this.guard(() => {
            try {
                const ctx = this.getContext();
                // Migrate pinned chats belonging to the renamed character as well
                const pinned = readPinnedKeys(ctx);
                for (const key of pinned) {
                    const p = parseKey(key);
                    if (p?.kind === 'character' && p.owner === oldAvatar) {
                        setPinnedChat(ctx, { kind: 'character', owner: oldAvatar, name: p.name }, false);
                        setPinnedChat(ctx, { kind: 'character', owner: newAvatar, name: p.name }, true);
                    }
                }
                const hasAssignments = Object.keys(this.state.assignments).some(k => {
                    const p = parseKey(k);
                    return p?.kind === 'character' && p.owner === oldAvatar;
                });
                if (hasAssignments) {
                    let conflicts = [];
                    let migrated = 0;
                    this.commit(s => {
                        const res = remapKeys(
                            s,
                            p => p.kind === 'character' && p.owner === oldAvatar ? encodeKey('character', newAvatar, p.name) : null,
                            { keepConflicts: true },
                        );
                        conflicts = res.conflicts;
                        migrated = res.migrated;
                        return res.state;
                    });
                    if (conflicts.length) {
                        throw new Error(`角色已改名：已迁移 ${migrated} 条分类，另有 ${conflicts.length} 条存在同名冲突已保留，请在“待关联”中手动处理。`);
                    }
                }
            } finally {
                this.invalidate();
                if (this.root) this.scheduleRevalidate();
            }
        });
    }
}
