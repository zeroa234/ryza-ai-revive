/* Ryza Chat — frameless desktop shell (Electron).

   The page is loaded as ryza://app/ (a privileged custom scheme), the usual
   Electron way to ship a web UI without file:// limitations and without a
   loopback HTTP port. fetch('/_proxy?u=https://…') stays same-origin.
   Debug in a browser still uses scripts/serve.py on 8765; this process
   never binds that port.

   Progress is %AppData%/RyzaChat/ryza-web-storage.json (injected into
   index.html before page scripts). Chromium localStorage is only a cache. */
'use strict';

const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const webStorage = require('./web-storage');

protocol.registerSchemesAsPrivileged([{
  scheme: 'ryza',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    bypassCSP: true
  }
}]);

function webRoot() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'web')]
    : [path.join(__dirname, '..', 'web'), path.join(app.getAppPath(), '..', 'web')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return path.resolve(c);
  }
  throw new Error('web/index.html not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
  '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};

function resolveUnder(root, pathname) {
  const rel = decodeURIComponent(pathname || '/').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel || rel.split('/').includes('..')) {
    return path.join(root, 'index.html');
  }
  const file = path.resolve(root, ...rel.split('/').filter(Boolean));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message: message } }), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}

async function proxyRequest(request, targetUrl) {
  if (!String(targetUrl || '').startsWith('https://')) {
    return jsonError(400, 'proxy target must be https');
  }
  const headers = { 'User-Agent': 'RyzaChat/1.2.13' };
  const ct = request.headers.get('content-type');
  const auth = request.headers.get('authorization');
  const apiKey = request.headers.get('api-key');
  if (ct) headers['Content-Type'] = ct;
  if (auth) headers.Authorization = auth;
  if (apiKey) headers['api-key'] = apiKey;
  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Buffer.from(await request.arrayBuffer());
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 180000);
  init.signal = ac.signal;
  try {
    return await net.fetch(targetUrl, init);
  } catch (e) {
    return jsonError(502, String(e && e.message || e));
  } finally {
    clearTimeout(t);
  }
}

async function handleRyza(root, request) {
  let u;
  try { u = new URL(request.url); } catch (e) { return jsonError(400, 'bad url'); }
  if (u.pathname === '/_proxy' || u.pathname.startsWith('/_proxy')) {
    return proxyRequest(request, u.searchParams.get('u') || '');
  }
  let pathname = u.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const file = resolveUnder(root, pathname);
  if (!file) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return new Response('not found', { status: 404 });
  }
  const ext = path.extname(file).toLowerCase();
  if (path.basename(file) === 'index.html') {
    let html = fs.readFileSync(file, 'utf8');
    html = webStorage.inject(html, webStorage.load(storeFile));
    return new Response(html, {
      headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' }
    });
  }
  const type = MIME[ext] || 'application/octet-stream';
  const resp = await net.fetch(pathToFileURL(file).href);
  const headers = new Headers(resp.headers);
  headers.set('content-type', type);
  if (ext === '.json') headers.set('cache-control', 'no-store');
  return new Response(resp.body, { status: resp.status, headers: headers });
}

let win = null;
let topmost = false;
let storeFile = '';

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 860,
    minWidth: 340,
    minHeight: 560,
    frame: false,
    transparent: false,
    backgroundColor: '#07050a',
    resizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadURL('ryza://app/');
  if (process.env.RYZA_SHOT) {
    const out = process.env.RYZA_SHOT;
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          console.log('captured ' + out);
        } catch (e) { console.error('capture failed: ' + e.message); }
        app.quit();
      }, 9000);
    });
  }
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  win.on('close', () => { webStorage.flush(); });
}

ipcMain.handle('shell:set-topmost', (_e, on) => {
  topmost = !!on;
  if (win) {
    win.setAlwaysOnTop(topmost, 'screen-saver');
    win.setFullScreenable(!topmost);
  }
  return topmost;
});
ipcMain.handle('shell:is-topmost', () => topmost);
ipcMain.on('shell:minimize', () => { if (win) win.minimize(); });
ipcMain.on('shell:close', () => { if (win) win.close(); });
ipcMain.on('shell:fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });
ipcMain.on('shell:quit', () => app.quit());
ipcMain.on('storage:save', (_e, obj) => { webStorage.queueSave(storeFile, obj); });
ipcMain.on('storage:save-sync', (e, obj) => {
  webStorage.save(storeFile, obj);
  e.returnValue = true;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    try {
      storeFile = webStorage.storePath(app.getPath('userData'));
      const root = webRoot();
      protocol.handle('ryza', (request) => handleRyza(root, request));
      createWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    } catch (e) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Ryza Chat', '启动失败：' + (e && e.message || e));
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { webStorage.flush(); });
}
