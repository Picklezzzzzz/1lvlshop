// Локальный сервер 1lvlshop: витрина + админка загрузки прайса
const fs = require('fs');
const path = require('path');
const http = require('http');
const { parseCsv, rowsToCatalog } = require('./lib/catalog');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const PORT = process.env.PORT || 3010;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'catalog.json');
const PHOTOS = path.join(ROOT, 'photos');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    return { updatedAt: null, count: 0, products: [] };
  }
}

function saveCatalog(catalog) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(catalog, null, 2), 'utf8');
}

function checkAuth(req) {
  const hdr = req.headers['x-admin-password'] || '';
  return hdr && hdr === ADMIN_PASSWORD;
}

function safePhotoName(name) {
  const base = path.basename(String(name || '')).trim();
  const ext = path.extname(base).toLowerCase();
  if (!PHOTO_EXTS.has(ext)) return null;
  let stem = base.slice(0, -ext.length).normalize('NFC');
  stem = stem.replace(/[^\w.\-а-яёА-ЯЁ]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  if (!stem) stem = 'photo';
  return stem + ext;
}

function uniquePhotoName(name) {
  const photosDir = PHOTOS;
  fs.mkdirSync(photosDir, { recursive: true });
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(photosDir, candidate))) {
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    candidate = `${stem}_${i}${ext}`;
    i += 1;
  }
  return candidate;
}

function listPhotos() {
  fs.mkdirSync(PHOTOS, { recursive: true });
  return fs
    .readdirSync(PHOTOS)
    .filter((f) => PHOTO_EXTS.has(path.extname(f).toLowerCase()))
    .map((name) => {
      const st = fs.statSync(path.join(PHOTOS, name));
      return { name, url: '/photos/' + encodeURIComponent(name), size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const BLOCKED = /^\/(\.|server\.js|lib\/|package(-lock)?\.json|README|\.env)/i;

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    if (urlPath === '/api/products' && req.method === 'GET') {
      const cat = loadCatalog();
      return sendJson(res, 200, cat);
    }

    if (urlPath === '/api/catalog' && req.method === 'POST') {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Неверный пароль' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        let catalog;
        if (Array.isArray(body.rows)) {
          catalog = rowsToCatalog(body.rows);
        } else if (typeof body.csv === 'string') {
          catalog = rowsToCatalog(parseCsv(body.csv));
        } else if (Array.isArray(body.products)) {
          catalog = rowsToCatalog(body.products);
        } else {
          return sendJson(res, 400, { error: 'Нужны rows, csv или products' });
        }
        if (!catalog.products.length) {
          return sendJson(res, 400, { error: 'В файле нет валидных товаров (нужны название и цена > 0)' });
        }
        saveCatalog(catalog);
        return sendJson(res, 200, { ok: true, count: catalog.count, updatedAt: catalog.updatedAt });
      } catch (e) {
        console.error(e);
        return sendJson(res, 500, { error: 'Не удалось сохранить каталог' });
      }
    }

    if (urlPath === '/api/photos' && req.method === 'GET') {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Неверный пароль' });
      try {
        return sendJson(res, 200, { photos: listPhotos() });
      } catch (e) {
        console.error(e);
        return sendJson(res, 500, { error: 'Не удалось прочитать фото' });
      }
    }

    if (urlPath === '/api/photos' && req.method === 'POST') {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Неверный пароль' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return sendJson(res, 400, { error: 'Нет файлов' });
        if (files.length > 30) return sendJson(res, 400, { error: 'Максимум 30 файлов за раз' });

        const saved = [];
        for (const item of files) {
          const safe = safePhotoName(item && item.name);
          if (!safe) continue;
          const b64 = String((item && item.data) || '').replace(/^data:[^;]+;base64,/, '');
          if (!b64) continue;
          const buf = Buffer.from(b64, 'base64');
          if (!buf.length || buf.length > MAX_PHOTO_BYTES) continue;
          const finalName = uniquePhotoName(safe);
          fs.writeFileSync(path.join(PHOTOS, finalName), buf);
          saved.push({ name: finalName, url: '/photos/' + encodeURIComponent(finalName) });
        }
        if (!saved.length) return sendJson(res, 400, { error: 'Не удалось сохранить (нужны jpg/png/webp до 6 МБ)' });
        return sendJson(res, 200, { ok: true, saved, photos: listPhotos() });
      } catch (e) {
        console.error(e);
        return sendJson(res, 500, { error: 'Не удалось загрузить фото' });
      }
    }

    if (urlPath.startsWith('/api/photos/') && req.method === 'DELETE') {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Неверный пароль' });
      try {
        const name = safePhotoName(decodeURIComponent(urlPath.slice('/api/photos/'.length)));
        if (!name) return sendJson(res, 400, { error: 'Некорректное имя' });
        const target = path.join(PHOTOS, name);
        if (!target.startsWith(PHOTOS) || !fs.existsSync(target)) {
          return sendJson(res, 404, { error: 'Файл не найден' });
        }
        fs.unlinkSync(target);
        return sendJson(res, 200, { ok: true, photos: listPhotos() });
      } catch (e) {
        console.error(e);
        return sendJson(res, 500, { error: 'Не удалось удалить' });
      }
    }

    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(ROOT, rel);
    if (BLOCKED.test(rel) || !file.startsWith(ROOT)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.html' || ext === '.csv') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`1lvlshop: http://localhost:${PORT}`);
    console.log(`Админка:  http://localhost:${PORT}/admin.html`);
  });
