import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.mjs': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json;charset=utf-8' };
http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let route = decodeURIComponent(url.pathname);
        if (route === '/') route = '/tests/preview.html';
        if (route === '/script.js' || route === '/scripts/group-chats.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript;charset=utf-8' });
            res.end('export * from "/tests/mock-core.js";'); return;
        }
        const file = path.resolve(root, `.${route}`);
        if (!file.startsWith(root + path.sep) || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'text/plain', 'Cache-Control': 'no-store' }); res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
}).listen(18791, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:18791/ (development fixtures only)'));
