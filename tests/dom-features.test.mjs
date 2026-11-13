import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HomeFolders } from '../src/controller.js';
import { SETTINGS_KEY, defaults, copy, chatKey, assignChats, upsertFolder } from '../src/model.js';
import { PINNED_CHATS_KEY, loadSnapshots } from '../src/storage.js';

// Minimal zero-dependency DOM test double covering element tree, events, classList, dataset, and selectors.
class FakeClassList {
    constructor(owner) { this.owner = owner; this.set = new Set(); }
    syncFrom(str) { this.set = new Set(String(str || '').split(/\s+/).filter(Boolean)); }
    toString() { return [...this.set].join(' '); }
    add(...names) { for (const n of names) if (n) this.set.add(n); this.owner._className = this.toString(); }
    remove(...names) { for (const n of names) this.set.delete(n); this.owner._className = this.toString(); }
    contains(n) { return this.set.has(n); }
    toggle(n, force) {
        const should = force === undefined ? !this.set.has(n) : Boolean(force);
        if (should) this.set.add(n); else this.set.delete(n);
        this.owner._className = this.toString();
        return should;
    }
}

class FakeElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.style = { props: new Map(), setProperty(k, v) { this.props.set(k, String(v)); } };
        this._className = '';
        this.classList = new FakeClassList(this);
        this._text = '';
        this.value = '';
        this.checked = false;
        this.indeterminate = false;
        this.disabled = false;
        this.hidden = false;
        this.id = '';
    }
    get className() { return this._className; }
    set className(v) { this._className = String(v || ''); this.classList.syncFrom(this._className); }
    get firstElementChild() { return this.children[0] ?? null; }
    get isConnected() {
        let cur = this;
        while (cur) { if (cur.isRootDoc) return true; cur = cur.parentNode; }
        return false;
    }
    get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(v) { this.children = []; this._text = String(v ?? ''); }
    setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === 'id') this.id = String(v);
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    append(...nodes) {
        for (const n of nodes) {
            if (!n) continue;
            n.remove?.();
            n.parentNode = this;
            this.children.push(n);
            if (this.tagName === 'SELECT' && n.tagName === 'OPTION' && !this.value) this.value = n.value;
        }
    }
    prepend(...nodes) {
        for (const n of [...nodes].reverse()) {
            if (!n) continue;
            n.remove?.();
            n.parentNode = this;
            this.children.unshift(n);
        }
    }
    before(node) {
        if (!this.parentNode) return;
        node.remove?.();
        const idx = this.parentNode.children.indexOf(this);
        node.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 0, node);
    }
    replaceChildren(...nodes) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }
    remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
    }
    contains(other) {
        let cur = other;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
    }
    matches(sel) {
        const s = sel.trim();
        if (s === '[hidden]') return Boolean(this.hidden);
        if (s === '[tabindex]:not([tabindex="-1"])') return this.tabIndex !== undefined && this.tabIndex !== -1;
        if (s.startsWith('#')) return this.id === s.slice(1);
        if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.classList.contains(c));
        return this.tagName === s.toUpperCase();
    }
    closest(sel) {
        const parts = sel.split(',').map(x => x.trim());
        let cur = this;
        while (cur && cur.nodeType === 1) {
            if (parts.some(p => cur.matches(p))) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    querySelectorAll(sel) {
        const groups = sel.split(',').map(s => s.trim());
        const out = [];
        const matchChain = (el, chain) => {
            const parts = chain.split(/\s+/);
            if (!el.matches(parts.at(-1))) return false;
            let cur = el.parentNode;
            for (let i = parts.length - 2; i >= 0; i--) {
                while (cur && cur.nodeType === 1 && !cur.matches(parts[i])) cur = cur.parentNode;
                if (!cur || cur.nodeType !== 1) return false;
                cur = cur.parentNode;
            }
            return true;
        };
        const walk = node => {
            for (const c of node.children) {
                if (groups.some(g => matchChain(c, g))) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    addEventListener(type, fn) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter(x => x !== fn));
    }
    dispatchEvent(event) {
        event.target ??= this;
        event.preventDefault ??= () => { event.defaultPrevented = true; };
        event.stopPropagation ??= () => {};
        for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    }
    click(extra = {}) {
        if (this.disabled) return;
        if (this.tagName === 'INPUT' && this.type === 'checkbox') this.checked = !this.checked;
        this.dispatchEvent({ type: 'click', ...extra });
        if (this.tagName === 'INPUT' && this.type === 'checkbox') this.dispatchEvent({ type: 'change', ...extra });
    }
    focus() { if (this.ownerDoc) this.ownerDoc.activeElement = this; }
    select() { this.focus(); }
}

function createFakeDom() {
    const doc = new FakeElement('document');
    doc.isRootDoc = true;
    const body = new FakeElement('body');
    const settingsContainer = new FakeElement('div'); settingsContainer.id = 'extensions_settings2';
    const chatContainer = new FakeElement('div'); chatContainer.id = 'chat';
    const welcomePanel = new FakeElement('div'); welcomePanel.className = 'welcomePanel';
    const welcomeRecent = new FakeElement('div'); welcomeRecent.className = 'welcomeRecent';
    welcomePanel.append(welcomeRecent);
    chatContainer.append(welcomePanel);
    body.append(settingsContainer, chatContainer);
    doc.append(body);
    doc.body = body;
    doc.activeElement = body;
    doc.createElement = tag => { const el = new FakeElement(tag); el.ownerDoc = doc; return el; };
    doc.getElementById = id => doc.querySelector(`#${id}`);
    return { doc, body, settingsContainer, chatContainer, welcomePanel, welcomeRecent };
}

function setupMountedApp() {
    const dom = createFakeDom();
    globalThis.document = dom.doc;
    const storeMap = new Map();
    const accountStorage = {
        getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
        setItem: (k, v) => storeMap.set(k, String(v)),
        removeItem: k => storeMap.delete(k),
    };
    const handlers = new Map();
    let state = upsertFolder(defaults(), { id: 'f-sub', parentId: 'f-active', name: '子章节' });
    const chats = [
        { key: chatKey('character', 'lin.png', '第一章'), kind: 'character', owner: 'lin.png', name: '第一章', character: '林间旅人', timestamp: 1000, dateText: '2026/10/01', searchText: '林间旅人\n第一章', messageCount: 10 },
        { key: chatKey('character', 'lin.png', '第二章'), kind: 'character', owner: 'lin.png', name: '第二章', character: '林间旅人', timestamp: 2000, dateText: '2026/10/02', searchText: '林间旅人\n第二章', messageCount: 20 },
        { key: chatKey('character', 'lin.png', '第三章'), kind: 'character', owner: 'lin.png', name: '第三章', character: '林间旅人', timestamp: 3000, dateText: '2026/10/03', searchText: '林间旅人\n第三章', messageCount: 30 },
        { key: chatKey('group', 'g1', '营火夜谈'), kind: 'group', owner: 'g1', name: '营火夜谈', character: '冒险小队', timestamp: 4000, dateText: '2026/10/04', searchText: '冒险小队\n营火夜谈', messageCount: 40 },
    ];
    state = assignChats(assignChats(state, [chats[0].key], 'f-active'), [chats[1].key], 'f-sub');
    let currentChatId;
    const context = {
        accountStorage,
        characters: [{ avatar: 'lin.png', name: '林间旅人', chat: '第一章' }],
        groups: [{ id: 'g1', name: '冒险小队', chats: ['营火夜谈'] }],
        extensionSettings: { [SETTINGS_KEY]: copy(state) },
        eventTypes: { CHAT_CHANGED: 'chat_changed', APP_READY: 'app_ready' },
        eventSource: {
            on: (t, f) => handlers.set(t, [...(handlers.get(t) ?? []), f]),
            removeListener: () => {},
        },
        saveSettingsDebounced: () => {},
        getCurrentChatId: () => currentChatId,
        setChatId: v => { currentChatId = v; },
    };
    const repository = {
        chats,
        complete: true,
        skipped: 0,
        lastLoaded: Date.now(),
        load: async () => chats,
        dispose: () => {},
    };
    const app = new HomeFolders(() => context, {
        repository,
        renamer: async (chat, rawNew) => ({
            oldName: chat.name,
            newName: rawNew.replace(/[:?]/g, ''),
            oldKey: chat.key,
            newKey: chatKey(chat.kind, chat.owner, rawNew.replace(/[:?]/g, '')),
        }),
    });
    app.initialize();
    app.mount();
    return { dom, app, context, accountStorage, chats };
}

test('manifest.json declares activate, enable, disable, delete, and clean lifecycle hooks at version 0.3.0', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.3.0');
    assert.equal(pkg.version, '0.3.0');
    assert.equal(manifest.hooks.activate, 'onActivate');
    assert.equal(manifest.hooks.enable, 'onActivate');
    assert.equal(manifest.hooks.disable, 'onDisable');
    assert.equal(manifest.hooks.delete, 'onDisable');
    assert.equal(manifest.hooks.clean, 'onClean');
});

test('card rows render flat [置顶][移入][改名][删除] buttons, sync native pinnedChats, and support inline rename', async () => {
    const { app, accountStorage, chats } = setupMountedApp();
    try {
        const firstCard = app.list.children[0];
        const actionLabels = firstCard.querySelector('.hcf-row-actions').children.map(b => b.textContent);
        assert.deepEqual(actionLabels, ['☆ 置顶', '移入', '改名', '删除']);

        // Pin oldest chat ("第一章") and verify it floats to top + writes exact SillyTavern pinnedChats format
        const lastCard = app.list.children.at(-1);
        const pinBtn = lastCard.querySelector('.hcf-row-pin');
        pinBtn.click();
        assert.equal(app.list.children[0].dataset.key, chats[0].key);
        assert.equal(app.list.children[0].querySelector('.hcf-row-pin').textContent, '★ 置顶');
        const rawPinned = JSON.parse(accountStorage.getItem(PINNED_CHATS_KEY));
        assert.deepEqual(rawPinned['char_lin.png_第一章.jsonl'], {
            group: '',
            avatar: 'lin.png',
            file_name: '第一章.jsonl',
        });

        // Inline rename updates card title, assignment key, and pinnedChats entry seamlessly
        await app.performInlineRename(chats[0], '第一章: 雨夜');
        assert.equal(chats[0].name, '第一章 雨夜');
        assert.equal(app.state.assignments[chatKey('character', 'lin.png', '第一章 雨夜')], 'f-active');
        const updatedPinned = JSON.parse(accountStorage.getItem(PINNED_CHATS_KEY));
        assert.ok(updatedPinned['char_lin.png_第一章 雨夜.jsonl']);
        assert.equal(updatedPinned['char_lin.png_第一章.jsonl'], undefined);
    } finally {
        app.dispose();
    }
});

test('parent folder shows direct chats by default, toggles includeSubfolders, and updates sidebar counts during search', () => {
    const { app } = setupMountedApp();
    try {
        app.setFolder('f-active');
        assert.equal(app.includeSubfolders, false);
        assert.equal(app.currentRows.length, 1);
        assert.equal(app.currentRows[0].name, '第一章');

        // Toggle "[☑ 包含子文件夹]" in breadcrumb bar
        app.subfolderToggle.click();
        assert.equal(app.includeSubfolders, true);
        assert.equal(app.currentRows.length, 2);

        // Search updates sidebar counts dynamically
        app.search.value = '第二章';
        app.search.dispatchEvent({ type: 'input', isComposing: false });
        app.query = '第二章'; app.renderTree(); app.renderList();
        assert.equal(app.currentRows.length, 1);
        assert.equal(app.currentRows[0].name, '第二章');
        const matchBadges = app.tree.querySelectorAll('.hcf-count-match');
        assert.ok(matchBadges.length >= 2, 'matching folders highlight counts in sidebar');
    } finally {
        app.dispose();
    }
});

test('Shift+Click range selection updates checkboxes in-place without rebuilding DOM nodes', () => {
    const { app } = setupMountedApp();
    try {
        const originalNodes = [...app.list.children];
        assert.equal(originalNodes.length, 4);
        originalNodes[0].firstElementChild.click({ shiftKey: false });
        originalNodes[2].firstElementChild.click({ shiftKey: true });
        assert.equal(app.selected.size, 3);
        assert.equal(app.list.children[0], originalNodes[0], 'DOM article node preserved without replaceChildren');
        assert.equal(app.list.children[1].firstElementChild.checked, true);
        assert.equal(app.list.children[2].firstElementChild.checked, true);
    } finally {
        app.dispose();
    }
});

test('unmount preserves global #hcf-settings dialogs, backdrop drag-select does not close dialog, and dragleave ignores child transitions', () => {
    const { dom, app, context } = setupMountedApp();
    try {
        const settingsDlg = app.dialog('导入分类备份', { scope: 'settings' });
        const homeDlg = app.dialog('新建文件夹', { scope: 'home' });
        assert.equal(app.dialogs.size, 2);

        // Simulate pointerdown inside dialog box + click on overlay (text drag-select release outside)
        const box = settingsDlg.box;
        settingsDlg.overlay.dispatchEvent({ type: 'pointerdown', target: box });
        settingsDlg.overlay.dispatchEvent({ type: 'click', target: settingsDlg.overlay });
        assert.equal(settingsDlg.overlay.isConnected, true, 'drag-select release must NOT close modal');

        // Navigate into a chat -> unmount() closes homepage dialog but keeps settings dialog alive!
        context.setChatId('active-chat');
        app.mount();
        assert.equal(homeDlg.overlay.isConnected, false);
        assert.equal(settingsDlg.overlay.isConnected, true);

        // Both pointerdown and click on overlay closes dialog cleanly
        settingsDlg.overlay.dispatchEvent({ type: 'pointerdown', target: settingsDlg.overlay });
        settingsDlg.overlay.dispatchEvent({ type: 'click', target: settingsDlg.overlay });
        assert.equal(settingsDlg.overlay.isConnected, false);

        // Re-mount homepage and verify dragleave over child element keeps .hcf-drop
        context.setChatId(undefined);
        app.mount();
        const folderRow = app.tree.children[2];
        const childSpan = folderRow.querySelector('.hcf-folder-name');
        folderRow.classList.add('hcf-drop');
        folderRow.dispatchEvent({ type: 'dragleave', relatedTarget: childSpan });
        assert.equal(folderRow.classList.contains('hcf-drop'), true, 'moving over child keeps drop highlight');
        folderRow.dispatchEvent({ type: 'dragleave', relatedTarget: dom.body });
        assert.equal(folderRow.classList.contains('hcf-drop'), false);
    } finally {
        app.dispose();
    }
});

test('merge import, full replace import, folder deletion, and 3-slot snapshot undo work end-to-end', async () => {
    const { app, context } = setupMountedApp();
    try {
        let imported = upsertFolder(defaults(), { id: 'imp-1', parentId: 'f-active', name: '子章节' });
        const newChatKey = chatKey('character', 'lin.png', '第三章');
        imported = assignChats(imported, [newChatKey], 'imp-1');

        // Open importDialog and click "合并导入（推荐）"
        app.importDialog(imported);
        const dlg = [...app.dialogs].at(-1);
        const mergeBtn = dlg.footer.children.find(b => b.textContent.includes('合并导入'));
        mergeBtn.click();
        await new Promise(r => setTimeout(r, 0));
        assert.equal(app.state.assignments[newChatKey], 'f-sub', 'merged into existing matching path f-active / 子章节');
        assert.equal(loadSnapshots(context).length, 1);

        // Undo restores pre-merge state
        app.confirm = async () => true;
        await app.undoSnapshot();
        assert.equal(app.state.assignments[newChatKey], undefined);
        assert.equal(loadSnapshots(context).length, 0);
    } finally {
        app.dispose();
    }
});

test('batch missingDialog cleans dead-owner orphans, prioritizes same-owner unfiled recommendations, and stays open', async () => {
    const { app, chats } = setupMountedApp();
    try {
        const deadOwnerKey = chatKey('character', 'deleted.png', '遗留档');
        const renamedOldKey = chatKey('character', 'lin.png', '第三章旧名');
        app.state = assignChats(app.state, [deadOwnerKey, renamedOldKey], 'f-active');
        app.confirm = async () => true;

        app.missingDialog();
        const dlg = [...app.dialogs].at(-1);
        assert.equal(dlg.overlay.isConnected, true);

        // Click "一键清理角色/群组已不存在记录 (1)"
        const cleanBtn = dlg.body.querySelectorAll('button').find(b => b.textContent.includes('一键清理'));
        cleanBtn.click();
        await new Promise(r => setTimeout(r, 10));
        assert.equal(app.state.assignments[deadOwnerKey], undefined);
        assert.equal(dlg.overlay.isConnected, true, 'missingDialog stays open after batch orphan cleanup');
        assert.deepEqual(app.missing(), [renamedOldKey]);

        // Verify top recommended target is unfiled chat of same owner ("lin.png" -> "第三章")
        const select = dlg.body.querySelector('.hcf-relink-box select');
        assert.equal(select.value, chats[2].key);
        const linkBtn = dlg.footer.children.find(b => b.textContent.includes('关联'));
        linkBtn.click();
        await new Promise(r => setTimeout(r, 10));
        assert.equal(app.state.assignments[chats[2].key], 'f-active');
        assert.equal(app.missing().length, 0);
        assert.equal(dlg.overlay.isConnected, true, 'shows completion message without abruptly closing');
    } finally {
        app.dispose();
    }
});
