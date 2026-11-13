import { HomeFolders } from './src/controller.js';
import { SETTINGS_KEY } from './src/model.js';
import { clearExtensionStorage } from './src/storage.js';

let instance;
function start() {
    if (instance) return;
    try {
        const next = new HomeFolders(() => SillyTavern.getContext());
        next.initialize();
        instance = next;
    } catch (error) {
        console.error('[HomeChatFolders] 初始化失败，保留原生首页。', error);
        globalThis.toastr?.error?.(`首页文件夹未启用：${error.message}。原生列表保留。`);
    }
}
export function onActivate() { start(); }
export function onDisable() { instance?.dispose(); instance = undefined; }
export function onClean() {
    try {
        if (instance) instance.cleanData();
        else if (globalThis.SillyTavern?.getContext) {
            const context = SillyTavern.getContext();
            if (context?.extensionSettings && SETTINGS_KEY in context.extensionSettings) {
                delete context.extensionSettings[SETTINGS_KEY];
                context.saveSettingsDebounced?.();
            }
            clearExtensionStorage(context);
        }
    } finally {
        onDisable();
    }
}
// The activate/enable hooks are preferred; this also supports normal module loading after core setup.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
