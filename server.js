'use strict';

/**
 * Offor Law PLLC — tiny zero-dependency static server (for Hyperlift / Docker)
 * + a password-protected /admin content editor.
 *
 * Public site: serves files from ./public on process.env.PORT (default 8080).
 * Admin: /admin lets an authenticated editor update ./public/content.json, which the
 * homepage renders over its built-in defaults. Saves are written to local disk
 * (instant for the running container) AND committed back to the GitHub repo via the
 * Contents API (so edits survive the next redeploy on Hyperlift's ephemeral disk).
 *
 * Required env to enable login + persistence (see ADMIN.md):
 *   ADMIN_EMAIL           e.g. perryernest@offorlaw.com
 *   ADMIN_PASSWORD_HASH   "salt:hash" from `node tools/hash-password.js`
 *   SESSION_SECRET        long random string (cookie signing)
 *   GITHUB_TOKEN          PAT with contents:write on the repo (persistence)
 * Optional: GIT_REPO (default Nubridgemd1/offorlaw), GIT_BRANCH (main),
 *           CONTENT_PATH (public/content.json), SESSION_HOURS (12).
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, 'public');
const CONTENT_FILE = path.join(ROOT, 'content.json');
const COOKIE = 'offorlaw_admin';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
// ASCII control chars to strip from saved content (keeps tab/newline/cr)
const CTRL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

const CONTENT_KEYS = [
  'announcement', 'hero_sub',
  'pa_immigration', 'pa_family', 'pa_injury', 'pa_business',
  'cta_title', 'cta_sub',
  'phone', 'email', 'address_line1', 'address_line2',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

/* ---------- auth helpers ---------- */
function verifyPassword(password) {
  const stored = process.env.ADMIN_PASSWORD_HASH || '';
  const idx = stored.indexOf(':');
  if (idx < 0) return false;
  const salt = stored.slice(0, idx);
  const hash = stored.slice(idx + 1);
  let calc;
  try { calc = crypto.scryptSync(String(password), salt, 32).toString('hex'); } catch (e) { return false; }
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(payload) {
  const secret = process.env.SESSION_SECRET || '';
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  const secret = process.env.SESSION_SECRET || '';
  if (!token || !secret) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sb = Buffer.from(sig);
  const eb = Buffer.from(expect);
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function currentUser(req) { return verifyToken(getCookie(req, COOKIE)); }

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // non-browser or same-origin navigation
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}

/* ---------- content helpers ---------- */
function defaultContent() {
  try { return JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')); } catch (e) { return {}; }
}

function sanitizeContent(input) {
  const cur = defaultContent();
  const out = {};
  for (const k of CONTENT_KEYS) {
    let v = (input && typeof input[k] === 'string') ? input[k] : (typeof cur[k] === 'string' ? cur[k] : '');
    v = v.replace(CTRL, '').slice(0, 2000);
    out[k] = v;
  }
  return out;
}

function githubApi(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.github.com', path: urlPath, method,
      headers: Object.assign({
        'User-Agent': 'offorlaw-admin', 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function commitContent(jsonStr, editorEmail) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { committed: false, reason: 'no_token' };
  const repo = process.env.GIT_REPO || 'Nubridgemd1/offorlaw';
  const branch = process.env.GIT_BRANCH || 'main';
  const cpath = process.env.CONTENT_PATH || 'public/content.json';
  let sha;
  try {
    const get = await githubApi('GET', `/repos/${repo}/contents/${encodeURIComponent(cpath)}?ref=${branch}`, null, token);
    if (get.status === 200) { try { sha = JSON.parse(get.body).sha; } catch (e) { /* new file */ } }
  } catch (e) { return { committed: false, reason: 'github_unreachable' }; }
  try {
    const put = await githubApi('PUT', `/repos/${repo}/contents/${encodeURIComponent(cpath)}`, {
      message: `admin: update site content (${editorEmail || 'editor'})`,
      content: Buffer.from(jsonStr).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }, token);
    if (put.status === 200 || put.status === 201) return { committed: true };
    return { committed: false, reason: 'github_status_' + put.status };
  } catch (e) { return { committed: false, reason: 'github_unreachable' }; }
}

/* ---------- login throttle (per-IP, in-memory) ---------- */
const attempts = new Map(); // ip -> { n, until }
function throttled(ip) { const a = attempts.get(ip); return a && a.until > Date.now(); }
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
  attempts.set(ip, a);
}
function clearFail(ip) { attempts.delete(ip); }

/* ---------- admin routing ---------- */
async function handleAdmin(req, res, pathname) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (pathname === '/admin' || pathname === '/admin/') {
    return serveStatic(req, res, '/admin.html');
  }

  if (pathname === '/admin/api/session') {
    const u = currentUser(req);
    const configured = !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH && process.env.SESSION_SECRET);
    return sendJson(res, 200, { authed: !!u, email: u ? u.email : null, configured, persists: !!process.env.GITHUB_TOKEN });
  }

  if (pathname === '/admin/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'bad_origin' });
    if (throttled(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
    const body = await readJsonBody(req);
    const email = (body && String(body.email || '')).trim().toLowerCase();
    const password = body && String(body.password || '');
    const okEmail = email && email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!okEmail || !verifyPassword(password)) { noteFail(ip); return sendJson(res, 401, { error: 'invalid_credentials' }); }
    clearFail(ip);
    const token = signToken({ email, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    const cookie = `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
    return sendJson(res, 200, { authed: true, email }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/admin/api/logout' && req.method === 'POST') {
    const cookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
    return sendJson(res, 200, { authed: false }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/admin/api/content' && req.method === 'GET') {
    if (!currentUser(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { content: sanitizeContent(defaultContent()), keys: CONTENT_KEYS });
  }

  if (pathname === '/admin/api/save' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'unauthorized' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'bad_origin' });
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_body' });
    const clean = sanitizeContent(body.content || body);
    const jsonStr = JSON.stringify(clean, null, 2) + '\n';
    try { fs.writeFileSync(CONTENT_FILE, jsonStr); } catch (e) { return sendJson(res, 500, { error: 'write_failed' }); }
    const result = await commitContent(jsonStr, u.email);
    return sendJson(res, 200, {
      saved: true,
      committed: result.committed,
      note: result.committed
        ? 'Saved and published.'
        : 'Saved on this server; it will revert on the next redeploy until GitHub persistence is configured.',
      reason: result.reason,
    });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

/* ---------- static serving (public site) ---------- */
function serveStatic(req, res, rawPath) {
  let p = decodeURIComponent(rawPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const cache = file === CONTENT_FILE ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  const pathname = req.url.split('?')[0];
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    handleAdmin(req, res, pathname).catch(() => { try { sendJson(res, 500, { error: 'server_error' }); } catch (e) {} });
    return;
  }
  serveStatic(req, res, req.url);
}).listen(PORT, () => console.log(`Offor Law PLLC site running on http://localhost:${PORT}`));
