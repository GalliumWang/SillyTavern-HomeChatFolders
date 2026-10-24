import {
    SETTINGS_KEY, ALL, UNFILED, COLORS, uid, defaults, validate, copy, exportState,
    folderPath, descendants, upsertFolder, deleteFolder, assignChats, visibleChats, parseKey, chatKey, remapKeys,
} from './model.js';
import { ChatRepository, openChat } from './repository.js';

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
}
function button(text, title, handler, className = '') {
    const b = element('button', `hcf-button ${className}`, text);
    b.type = 'button'; b.title = title || text;
    if (handler) b.addEventListener('click', handler);
    return b;
}
function option(value, text) {
    const el = element('option', '', text); el.value = value; return el;
}
function labeled(text, input) {
    const label = element('label', 'hcf-field'); label.append(element('span', '', text), input); return label;
}
function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = element('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class HomeFolders {
    constructor(getContext, { repository, opener = openChat } = {}) {
        this.getContext = getContext;
        this.repository = repository ?? new ChatRepository(getContext);
        this.opener = opener;
        this.state = null;
        this.panel = null;
        this.root = null;
        this.selected = new Set();
        this.query = '';
        this.page = 1;
        this.pageSize = 50;
        this.loading = false;
        this.error = '';
        this.notice = '';
        this.dirty = false;
        this.catalogRevision = 0;
        this.started = false;
        this.stopped = false;
        this.opening = false;
        this.listeners = [];
        this.dialogs = new Set();
        this.scanTimer = null;
    }
    initialize() {
        if (this.started) return;
        const context = this.getContext();
        if (!context.extensionSettings || !context.eventSource || !context.eventTypes) throw new Error('酒馆扩展 API 不可用；本版面向 SillyTavern 1.19.0。');
        const stored = context.extensionSettings[SETTINGS_KEY];
        this.state = stored ? validate(stored) : defaults();
        if (!stored) {
            context.extensionSettings[SETTINGS_KEY] = copy(this.state);
            context.saveSettingsDebounced();
        }
        this.started = true;
        this.settingsUI();
        const subscribe = (name, fn) => {
            const type = context.eventTypes[name];
            if (!type) return;
            context.eventSource.on(type, fn); this.listeners.push([type, fn]);
        };
        subscribe('APP_READY', () => this.scheduleMount());
        subscribe('CHAT_CHANGED', () => this.scheduleMount());
        for (const event of ['CHAT_CREATED', 'CHAT_DELETED', 'GROUP_CHAT_CREATED', 'GROUP_CHAT_DELETED',
            'CHARACTER_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED']) {
            subscribe(event, () => this.invalidate());
        }
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
    invalidate() { this.dirty = true; this.catalogRevision++; }
    settingsUI() {
        document.getElementById('hcf-settings')?.remove();
        const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!target) return;
        const section = element('details', 'hcf-settings'); section.id = 'hcf-settings';
        section.append(element('summary', '', '首页会话文件夹'));
        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = this.state.enabled;
        toggle.addEventListener('change', () => this.guard(() => {
            this.commit(s => { s.enabled = toggle.checked; return s; });
            if (this.state.enabled) this.scheduleMount(); else this.unmount();
        }));
        this.enabledToggle = toggle;
        section.append(labeled('启用首页文件夹', toggle));
        section.append(element('p', '', '分类随酒馆账户设置保存。删除文件夹不会删除聊天。'));
        section.append(button('导出分类', '', () => this.guard(() => this.exportBackup())));
        const importing = this.importButton(); section.append(importing.button, importing.input);
        target.append(section);
    }
    commit(mutator) {
        const context = this.getContext();
        const stored = context.extensionSettings[SETTINGS_KEY];
        if (stored && stored.revision !== this.state.revision) {
            this.state = validate(stored); this.render();
            throw new Error('分类设置已在其他操作中改变，已重新载入，请重试。');
        }
        const next = validate(mutator(copy(this.state)));
        next.revision = uid();
        context.extensionSettings[SETTINGS_KEY] = copy(next);
        this.state = next;
        context.saveSettingsDebounced();
        if (this.enabledToggle) this.enabledToggle.checked = next.enabled;
        return next;
    }
    adoptSettings() {
        if (this.stopped) return;
        const stored = this.getContext().extensionSettings[SETTINGS_KEY];
        if (!stored || stored.revision === this.state.revision) return;
        this.guard(() => {
            this.state = validate(stored); this.selected.clear(); this.page = 1;
            if (this.enabledToggle) this.enabledToggle.checked = this.state.enabled;
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
        if (!this.repository.lastLoaded || this.dirty) this.scanTimer = setTimeout(() => this.refresh(), 0);
    }
    unmount() {
        clearTimeout(this.scanTimer);
        this.panel?.classList.remove('hcf-replaced');
        this.root?.remove(); this.root = null; this.panel = null;
        this.selected.clear();
        for (const dialog of [...this.dialogs]) dialog.close();
    }
    dispose() {
        if (this.stopped) return;
        this.stopped = true; this.observer?.disconnect();
        const events = this.getContext().eventSource;
        for (const [type, fn] of this.listeners) events.removeListener(type, fn);
        this.listeners = [];
        this.repository.dispose(); this.unmount();
        document.getElementById('hcf-settings')?.remove();
    }
    build() {
        const header = element('div', 'hcf-header');
        const title = element('div'); title.append(element('h2', '', '我的会话'), element('p', 'hcf-subtitle', '把故事收进文件夹，随时接着聊。'));
        const actions = element('div', 'hcf-actions');
        this.refreshButton = button('刷新目录', '重新读取历史会话，保留所有分类', () => this.refresh());
        const importing = this.importButton();
        actions.append(button('＋ 新建文件夹', '', () => this.folderDialog()), this.refreshButton,
            button('导出', '导出文件夹与分类，不含聊天正文', () => this.guard(() => this.exportBackup())),
            importing.button, importing.input,
            button('恢复原列表', '关闭首页替换，可在扩展设置中重新启用', () => this.guard(() => {
                this.commit(s => { s.enabled = false; return s; }); this.unmount();
            })));
        header.append(title, actions);
        this.status = element('div', 'hcf-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        this.statusMessage = element('span'); this.missingButton = button('', '手动重新关联改名或缺失的会话', () => this.missingDialog());
        this.status.append(this.statusMessage, this.missingButton);
        const layout = element('div', 'hcf-layout');
        const sidebar = element('aside', 'hcf-sidebar'); sidebar.setAttribute('aria-label', '会话文件夹');
        const sideHeader = element('div', 'hcf-sidebar-title', '文件夹');
        this.tree = element('div', 'hcf-tree'); sidebar.append(sideHeader, this.tree);
        const main = element('div', 'hcf-main');
        const bar = element('div', 'hcf-searchbar');
        this.search = element('input', 'hcf-search'); this.search.type = 'search'; this.search.placeholder = '搜索角色或会话名称';
        this.search.setAttribute('aria-label', '搜索角色或会话名称'); this.search.value = this.query;
        this.search.addEventListener('input', () => { this.query = this.search.value; this.page = 1; this.selected.clear(); this.renderList(); });
        this.sort = element('select'); this.sort.setAttribute('aria-label', '会话排序');
        for (const [value, name] of [['recent', '最近消息优先'], ['oldest', '最早消息优先'], ['name', '会话名称'], ['character', '角色名称']]) this.sort.append(option(value, name));
        this.sort.addEventListener('change', () => this.guard(() => {
            this.commit(s => { s.preferences.sort = this.sort.value; return s; }); this.page = 1; this.renderList();
        }));
        this.previewToggle = element('input'); this.previewToggle.type = 'checkbox';
        this.previewToggle.addEventListener('change', () => this.guard(() => {
            this.commit(s => { s.preferences.previews = this.previewToggle.checked; return s; }); this.renderList();
        }));
        bar.append(this.search, this.sort, labeled('显示预览', this.previewToggle));
        this.breadcrumb = element('div', 'hcf-breadcrumb');
        this.selectionBar = element('div', 'hcf-selection');
        this.list = element('div', 'hcf-list');
        this.pagination = element('div', 'hcf-pagination');
        main.append(bar, this.breadcrumb, this.selectionBar, this.list, this.pagination);
        layout.append(sidebar, main);
        this.root.append(header, this.status, layout);
    }
    async refresh() {
        if (this.loading || this.stopped) return;
        this.loading = true; this.error = ''; this.notice = ''; this.renderStatus();
        const revision = this.catalogRevision;
        try {
            if (!this.repository.lastLoaded) {
                await this.repository.load();
                if (this.stopped) return;
                this.render();
                this.notice = '已显示最近会话，正在补全历史目录…'; this.renderStatus();
            }
            await this.repository.load({ full: true });
            if (this.stopped) return;
            this.dirty = this.catalogRevision !== revision;
            const valid = new Set(this.repository.chats.map(c => c.key));
            this.selected = new Set([...this.selected].filter(k => valid.has(k)));
            this.notice = '';
        } catch (error) { if (!this.stopped) this.showError(error); }
        finally { this.loading = false; if (!this.stopped) this.render(); }
    }
    missing() {
        if (!this.repository.complete || this.loading || this.error || this.dirty) return [];
        const found = new Set(this.repository.chats.map(c => c.key));
        return Object.keys(this.state.assignments).filter(key => !found.has(key));
    }
    renderStatus() {
        if (!this.root) return;
        const repo = this.repository;
        this.status.classList.toggle('hcf-error', Boolean(this.error));
        this.statusMessage.textContent = this.error || (this.loading ? (this.notice || '正在读取会话目录，长聊天较多时可能需要一些时间…') :
            `已载入 ${repo.chats.length} 个会话${repo.complete ? '' : '（历史目录尚未完整载入）'}${repo.skipped ? ` · ${repo.skipped} 个无关联角色或特殊会话未显示` : ''}${this.notice ? ` · ${this.notice}` : ''}`);
        this.refreshButton.disabled = this.loading;
        this.refreshButton.textContent = this.loading ? '读取中…' : '刷新目录';
        const missing = this.missing();
        this.missingButton.hidden = !missing.length;
        this.missingButton.textContent = `待关联 ${missing.length}`;
    }
    render() {
        if (!this.root) return;
        this.sort.value = this.state.preferences.sort;
        this.previewToggle.checked = this.state.preferences.previews;
        this.renderTree(); this.renderList(); this.renderStatus();
    }
    setFolder(id) {
        this.guard(() => {
            this.commit(s => { s.preferences.folderId = id; return s; });
            this.page = 1; this.selected.clear(); this.render();
        });
    }
    renderTree() {
        this.tree.replaceChildren();
        const counts = new Map();
        for (const chat of this.repository.chats) {
            const folder = this.state.assignments[chat.key] ?? UNFILED;
            counts.set(folder, (counts.get(folder) ?? 0) + 1);
        }
        const row = (id, name, count, depth, folder) => {
            const line = element('div', `hcf-folder-row${this.state.preferences.folderId === id ? ' hcf-current' : ''}`);
            line.style.setProperty('--hcf-depth', depth);
            if (folder) {
                line.style.setProperty('--hcf-folder-color', folder.color);
                const children = this.state.folders.some(f => f.parentId === id);
                const folded = this.state.preferences.collapsed.includes(id);
                const toggle = button(children ? (folded ? '▸' : '▾') : '·', children ? '展开或收起子文件夹' : '没有子文件夹', () => this.guard(() => {
                    this.commit(s => { s.preferences.collapsed = folded ? s.preferences.collapsed.filter(x => x !== id) : [...s.preferences.collapsed, id]; return s; }); this.renderTree();
                }), 'hcf-fold-toggle');
                toggle.disabled = !children; toggle.setAttribute('aria-expanded', String(!folded)); line.append(toggle);
            }
            const choose = button('', name, () => this.setFolder(id), 'hcf-folder-choose');
            choose.append(element('span', 'hcf-folder-dot', folder ? '●' : (id === ALL ? '◈' : '◇')),
                element('span', 'hcf-folder-name', name), element('span', 'hcf-count', count));
            if (this.state.preferences.folderId === id) choose.setAttribute('aria-current', 'page');
            line.append(choose);
            if (folder) line.append(button('⋯', `编辑文件夹 ${name}`, () => this.folderDialog(folder), 'hcf-folder-edit'));
            if (id !== ALL) {
                line.addEventListener('dragover', event => {
                    if (event.dataTransfer?.types.includes('application/x-hcf-chats')) { event.preventDefault(); line.classList.add('hcf-drop'); }
                });
                line.addEventListener('dragleave', () => line.classList.remove('hcf-drop'));
                line.addEventListener('drop', event => {
                    event.preventDefault(); line.classList.remove('hcf-drop');
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
        row(ALL, '全部会话', this.repository.chats.length, 0);
        row(UNFILED, '未分类', counts.get(UNFILED) ?? 0, 0);
        const walk = (parentId, depth) => {
            const children = this.state.folders.filter(f => f.parentId === parentId).sort((a, b) => a.order - b.order);
            for (const f of children) {
                row(f.id, f.name, counts.get(f.id) ?? 0, depth, f);
                if (!this.state.preferences.collapsed.includes(f.id)) walk(f.id, depth + 1);
            }
        };
        walk(null, 0);
    }
    renderList() {
        if (!this.root) return;
        const chats = visibleChats(this.repository.chats, this.state, this.query);
        this.page = Math.min(this.page, Math.max(1, Math.ceil(chats.length / this.pageSize)));
        const rows = chats.slice((this.page - 1) * this.pageSize, this.page * this.pageSize);
        this.currentRows = rows;
        this.breadcrumb.textContent = `${folderPath(this.state, this.state.preferences.folderId)} · ${chats.length} 个会话${this.query ? '（名称搜索）' : ''}`;
        this.selectionBar.replaceChildren();
        const selectAll = element('input'); selectAll.type = 'checkbox'; selectAll.setAttribute('aria-label', '选择本页会话');
        selectAll.checked = rows.length > 0 && rows.every(c => this.selected.has(c.key));
        selectAll.indeterminate = !selectAll.checked && rows.some(c => this.selected.has(c.key));
        selectAll.disabled = !rows.length;
        selectAll.addEventListener('change', () => { for (const c of rows) { if (selectAll.checked) this.selected.add(c.key); else this.selected.delete(c.key); } this.renderList(); });
        this.selectionBar.append(labeled('选本页', selectAll), element('span', '', `已选 ${this.selected.size}`));
        const move = button('移动到…', '将选中的会话放入文件夹', () => this.moveDialog([...this.selected])); move.disabled = !this.selected.size;
        const clear = button('清空选择', '', () => { this.selected.clear(); this.renderList(); }); clear.disabled = !this.selected.size;
        this.selectionBar.append(move, clear);
        this.list.replaceChildren();
        if (!rows.length) {
            const empty = element('div', 'hcf-empty');
            const hasChildren = this.state.folders.some(f => f.parentId === this.state.preferences.folderId);
            empty.append(element('strong', '', this.loading ? '正在读取会话…' : this.query ? '没有找到匹配的会话' : '这里还没有会话'),
                element('p', '', this.loading ? '历史目录正在补全，已有分类会保留。' : this.query ? '试试角色名或会话名称中的其他关键词。' :
                    hasChildren ? '可以从左侧进入子文件夹，或在“全部会话”中选择会话移入。' : '到“全部会话”选择会话，再点击“移动到…”。'));
            this.list.append(empty);
        }
        for (const chat of rows) {
            const item = element('article', 'hcf-chat'); item.draggable = true;
            const check = element('input'); check.type = 'checkbox'; check.checked = this.selected.has(chat.key); check.setAttribute('aria-label', `选择 ${chat.character}：${chat.name}`);
            check.addEventListener('change', () => { if (check.checked) this.selected.add(chat.key); else this.selected.delete(chat.key); this.renderList(); });
            const avatar = element('div', 'hcf-avatar');
            if (typeof chat.avatar === 'string' && chat.avatar) {
                const img = element('img'); img.src = chat.avatar; img.alt = ''; img.loading = 'lazy';
                img.addEventListener('error', () => { avatar.textContent = chat.character.slice(0, 1); }, { once: true }); avatar.append(img);
            } else avatar.textContent = chat.kind === 'group' ? '群' : chat.character.slice(0, 1);
            const open = button('', `继续会话：${chat.name}`, () => this.open(chat), 'hcf-open'); open.disabled = this.opening;
            open.append(element('span', 'hcf-character', chat.character), element('strong', 'hcf-chat-name', chat.name));
            const date = chat.timestamp ? new Date(chat.timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知';
            const folder = this.state.assignments[chat.key];
            const details = `${date} · ${chat.messageCount} 条${chat.fileSize ? ` · ${chat.fileSize}` : ''} · ${folder ? folderPath(this.state, folder) : '未分类'}`;
            open.append(element('span', 'hcf-chat-meta', details));
            if (this.state.preferences.previews && chat.preview) open.append(element('span', 'hcf-preview', chat.preview));
            item.append(check, avatar, open, button('移入', '移动此会话到文件夹', () => this.moveDialog([chat.key]), 'hcf-row-move'));
            item.addEventListener('dragstart', event => {
                if (event.target.closest?.('input, .hcf-row-move')) { event.preventDefault(); return; }
                const keys = this.selected.has(chat.key) ? [...this.selected] : [chat.key];
                event.dataTransfer.setData('application/x-hcf-chats', JSON.stringify(keys)); event.dataTransfer.effectAllowed = 'move';
            });
            this.list.append(item);
        }
        this.pagination.replaceChildren();
        const pages = Math.max(1, Math.ceil(chats.length / this.pageSize));
        const previous = button('上一页', '', () => { this.page--; this.renderList(); }); previous.disabled = this.page <= 1;
        const next = button('下一页', '', () => { this.page++; this.renderList(); }); next.disabled = this.page >= pages;
        this.pagination.append(previous, element('span', '', `${this.page} / ${pages}`), next);
    }
    async open(chat) {
        if (this.opening || this.stopped) return;
        this.opening = true; this.renderList();
        try { await this.opener(chat, () => {
            if (this.stopped || !this.state.enabled) throw new Error('首页文件夹已关闭，已取消打开会话。');
            return this.getContext();
        }); }
        catch (error) { this.showError(error); }
        finally { this.opening = false; this.renderList(); }
    }
    move(keys, folder) {
        this.commit(s => assignChats(s, keys, folder));
        this.selected.clear(); this.notice = `已移动 ${keys.length} 个会话`; this.render();
    }
    dialog(title) {
        const overlay = element('div', 'hcf-overlay');
        const box = element('section', 'hcf-dialog'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
        const titleId = `hcf-dialog-${uid()}`; const heading = element('h3', '', title); heading.id = titleId; box.setAttribute('aria-labelledby', titleId);
        const body = element('div', 'hcf-dialog-body'); const error = element('div', 'hcf-dialog-error'); error.setAttribute('role', 'alert');
        const footer = element('div', 'hcf-dialog-footer');
        const previousFocus = document.activeElement;
        const result = { overlay, box, body, footer, error, close: () => {
            document.removeEventListener('keydown', keydown, true); overlay.remove(); this.dialogs.delete(result);
            if (previousFocus?.isConnected) previousFocus.focus();
        } };
        const keydown = event => {
            if ([...this.dialogs].at(-1) !== result) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); result.close(); }
            if (event.key === 'Tab') {
                const focusable = [...box.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && !el.hidden);
                const first = focusable[0], last = focusable.at(-1);
                if (!first) { event.preventDefault(); box.focus(); return; }
                if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || document.activeElement === box)) { event.preventDefault(); first.focus(); }
            }
        };
        footer.append(button('取消', '', result.close));
        box.append(heading, body, error, footer); overlay.append(box); document.body.append(overlay);
        overlay.addEventListener('mousedown', event => { if (event.target === overlay) result.close(); });
        document.addEventListener('keydown', keydown, true); this.dialogs.add(result);
        queueMicrotask(() => { if (overlay.isConnected) (body.querySelector('input, select, button') ?? box).focus(); });
        return result;
    }
    dialogAction(dialog, action) {
        return () => this.guard(async () => {
            try { await action(); }
            catch (error) { dialog.error.textContent = error.message; }
        });
    }
    async confirm(title, message, label = '确定') {
        return new Promise(resolve => {
            const dialog = this.dialog(title);
            dialog.body.append(element('p', '', message));
            const close = dialog.close; dialog.close = () => { close(); resolve(false); };
            dialog.footer.replaceChildren(button('取消', '', dialog.close), button(label, '', () => { close(); resolve(true); }, 'hcf-primary'));
        });
    }
    folderOptions(select, { system = false, excluded = new Set() } = {}) {
        if (system) select.append(option(UNFILED, '未分类（移出文件夹）'));
        const visit = parentId => {
            for (const f of this.state.folders.filter(x => x.parentId === parentId).sort((a, b) => a.order - b.order)) {
                if (!excluded.has(f.id)) select.append(option(f.id, folderPath(this.state, f.id)));
                visit(f.id);
            }
        }; visit(null);
    }
    folderDialog(folder = null) {
        this.guard(() => {
            const dialog = this.dialog(folder ? '编辑文件夹' : '新建文件夹');
            const name = element('input'); name.type = 'text'; name.maxLength = 80; name.value = folder?.name ?? '';
            const parent = element('select'); parent.append(option('', '顶层文件夹'));
            this.folderOptions(parent, { excluded: folder ? descendants(this.state, folder.id) : new Set() });
            parent.value = folder ? (folder.parentId ?? '') : (this.state.folders.some(f => f.id === this.state.preferences.folderId) ? this.state.preferences.folderId : '');
            if (folder && parent.value === folder.id) parent.value = '';
            const color = element('input'); color.type = 'color'; color.value = folder?.color ?? COLORS[this.state.folders.length % COLORS.length];
            dialog.body.append(labeled('名称', name), labeled('放在', parent), labeled('颜色', color));
            if (folder) {
                const ordering = element('div', 'hcf-actions');
                const reorder = delta => this.dialogAction(dialog, () => {
                    this.commit(s => {
                        const current = s.folders.find(f => f.id === folder.id);
                        if (!current) throw new Error('文件夹已不存在。');
                        const siblings = s.folders.filter(f => f.parentId === current.parentId).sort((a, b) => a.order - b.order);
                        const index = siblings.findIndex(f => f.id === folder.id); const target = index + delta;
                        if (target >= 0 && target < siblings.length) [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
                        siblings.forEach((f, i) => { f.order = i; }); return s;
                    }); this.renderTree();
                });
                ordering.append(button('上移', '调整同级文件夹顺序', reorder(-1)), button('下移', '调整同级文件夹顺序', reorder(1)));
                dialog.body.append(ordering);
                dialog.footer.prepend(button('删除文件夹', '会话转入未分类，子文件夹提升一级', this.dialogAction(dialog, async () => {
                    const ok = await this.confirm('删除文件夹', '此文件夹的会话将回到“未分类”，子文件夹提升一级。聊天记录不会删除。', '删除文件夹');
                    if (!ok) return;
                    this.commit(s => deleteFolder(s, folder.id)); dialog.close(); this.selected.clear(); this.render();
                }), 'hcf-danger'));
            }
            const save = this.dialogAction(dialog, () => {
                this.commit(s => upsertFolder(s, { ...(folder ? { id: folder.id } : {}), name: name.value, parentId: parent.value || null, color: color.value }));
                dialog.close(); this.render();
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
        download(exportState(this.state), `首页会话分类-${new Date().toISOString().slice(0, 10)}.json`);
    }
    importButton() {
        const input = element('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
        input.addEventListener('change', () => this.guard(async () => {
            const file = input.files?.[0]; input.value = ''; if (!file) return;
            if (file.size > 8 * 1024 * 1024) throw new Error('分类文件超过 8 MB，请检查是否选择了正确的导出文件。');
            const imported = validate(JSON.parse(await file.text()));
            const ok = await this.confirm('导入分类', `将替换当前文件夹和归属（${imported.folders.length} 个文件夹、${Object.keys(imported.assignments).length} 条分类）。聊天正文不受影响。建议先取消并导出当前分类。`, '替换分类');
            if (!ok || this.stopped) return;
            this.commit(current => ({ ...imported, enabled: current.enabled }));
            this.selected.clear(); this.page = 1; this.error = ''; this.notice = '分类已导入'; this.render();
        }));
        return { input, button: button('导入', '从备份恢复文件夹和分类', () => input.click()) };
    }
    missingDialog() {
        const keys = this.missing(); if (!keys.length) return;
        const dialog = this.dialog('重新关联会话');
        dialog.body.append(element('p', '', '以下分类记录暂时找不到对应会话。可以关联到改名后的会话，或仅移除这条分类记录。'));
        const oldSelect = element('select');
        for (const key of keys) {
            const old = parseKey(key); oldSelect.append(option(key, `${old.owner} / ${old.name} → ${folderPath(this.state, this.state.assignments[key])}`));
        }
        const search = element('input'); search.type = 'search'; search.placeholder = '搜索目标角色或会话名称';
        const target = element('select');
        const populate = () => {
            target.replaceChildren(option('', '请选择要关联的会话'));
            const q = search.value.toLocaleLowerCase();
            const matches = this.repository.chats.filter(c => `${c.character} ${c.name}`.toLocaleLowerCase().includes(q));
            for (const c of matches.slice(0, 200)) target.append(option(c.key, `${c.character} / ${c.name}`));
        }; search.addEventListener('input', populate); populate();
        dialog.body.append(labeled('待关联记录', oldSelect), labeled('查找目标（最多显示 200 项）', search), labeled('关联到', target));
        dialog.footer.prepend(button('移除分类记录', '不会删除聊天文件', this.dialogAction(dialog, async () => {
            if (!await this.confirm('移除分类记录', '仅移除选中的失联分类，不会删除任何聊天文件。', '移除')) return;
            this.commit(s => { delete s.assignments[oldSelect.value]; return s; }); dialog.close(); this.render();
        }), 'hcf-danger'));
        dialog.footer.append(button('关联', '', this.dialogAction(dialog, () => {
            if (!target.value) throw new Error('请选择目标会话。');
            this.commit(s => {
                const folder = s.assignments[oldSelect.value];
                if (!folder) throw new Error('原分类已改变，请刷新后重试。');
                if (s.assignments[target.value] && s.assignments[target.value] !== folder) throw new Error('目标会话已有其他分类，请先调整目标会话的文件夹。');
                delete s.assignments[oldSelect.value]; s.assignments[target.value] = folder; return s;
            }); dialog.close(); this.render();
        }), 'hcf-primary'));
    }
    renamedChat(data) {
        if (!data || (!data.avatarId && data.groupId == null) || !data.oldFileName || !data.newFileName) { this.invalidate(); return; }
        this.guard(() => {
            const kind = data.groupId != null && data.groupId !== '' ? 'group' : 'character';
            const owner = kind === 'group' ? data.groupId : data.avatarId;
            const oldKey = chatKey(kind, owner, data.oldFileName); const newKey = chatKey(kind, owner, data.newFileName);
            if (this.state.assignments[oldKey]) this.commit(s => remapKeys(s, parsed => chatKey(parsed.kind, parsed.owner, parsed.name) === oldKey ? newKey : null));
            this.invalidate();
        });
    }
    renamedCharacter(oldAvatar, newAvatar) {
        if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string') { this.invalidate(); return; }
        this.guard(() => {
            if (Object.keys(this.state.assignments).some(k => { const p = parseKey(k); return p.kind === 'character' && p.owner === oldAvatar; })) {
                this.commit(s => remapKeys(s, p => p.kind === 'character' && p.owner === oldAvatar ? chatKey(p.kind, newAvatar, p.name) : null));
            }
            this.invalidate();
        });
    }
}
