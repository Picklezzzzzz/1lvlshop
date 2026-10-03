// Разбор прайса (CSV или уже распарсенный JSON с админки).
// Колонки (регистр не важен): название/name, цена/price, остаток/stock,
// категория/cat, фасовка/size, фото/photo, описание/desc, состав, аллергены

const CAT_IDS = new Set(['cakes', 'pastry', 'chocolate', 'candy', 'gifts']);

const CAT_ALIASES = {
  cakes: ['cakes', 'cake', 'торты', 'торт', 'пирожные', 'пирожное'],
  pastry: ['pastry', 'выпечка', 'печенье', 'круассан', 'булочки', 'кексы', 'маффин'],
  chocolate: ['chocolate', 'шоколад', 'шоколадки', 'какао'],
  candy: ['candy', 'конфеты', 'конфета', 'мармелад', 'леденцы', 'карамель'],
  gifts: ['gifts', 'gift', 'наборы', 'набор', 'подарки', 'подарок', 'другое', 'разное', 'other', 'прочее']
};

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function mapCat(raw) {
  const k = normKey(raw);
  if (CAT_IDS.has(k)) return k;
  for (const [id, aliases] of Object.entries(CAT_ALIASES)) {
    if (aliases.some((a) => k === a || k.includes(a))) return id;
  }
  return 'gifts';
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pick(row, keys) {
  const map = {};
  for (const [k, v] of Object.entries(row || {})) map[normKey(k)] = v;
  for (const key of keys) {
    const v = map[normKey(key)];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function normalizePhoto(photo) {
  const raw = String(photo || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  let p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p.toLowerCase().startsWith('photos/')) p = 'photos/' + p;
  return '/' + p;
}

function rowToProduct(row, index) {
  const name = String(pick(row, ['name', 'название', 'товар', 'наименование'])).trim();
  const price = toNumber(pick(row, ['price', 'цена', 'cost']));
  const stock = Math.max(0, Math.floor(toNumber(pick(row, ['stock', 'остаток', 'кол-во', 'количество', 'qty']))));
  const size = String(pick(row, ['size', 'фасовка', 'вес', 'объём', 'объем'])).trim();
  const photo = normalizePhoto(pick(row, ['photo', 'фото', 'image', 'img', 'картинка']));
  const desc = String(pick(row, ['desc', 'description', 'описание'])).trim();
  const composition = String(pick(row, ['composition', 'состав', 'ingredients'])).trim();
  const allergens = String(pick(row, ['allergens', 'аллергены', 'allergen'])).trim();
  const cat = mapCat(pick(row, ['cat', 'category', 'категория', 'раздел']));
  if (!name || price <= 0) return null;
  return {
    id: String(pick(row, ['id', 'артикул', 'sku', 'code']) || `p${index + 1}`),
    name,
    price,
    stock,
    size: size || undefined,
    cat,
    img: photo,
    desc: desc || undefined,
    composition: composition || undefined,
    allergens: allergens || undefined
  };
}

/** Простой CSV (UTF-8, разделитель ; или ,) */
function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (c === delim && !q) {
        out.push(cur); cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = split(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

function rowsToCatalog(rows) {
  const products = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const p = rowToProduct(row, i);
    if (!p) return;
    let id = p.id;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    products.push({ ...p, id });
  });
  products.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    updatedAt: new Date().toISOString(),
    count: products.length,
    products
  };
}

module.exports = { parseCsv, rowsToCatalog, rowToProduct, mapCat };
