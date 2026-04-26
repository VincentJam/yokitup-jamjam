const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOKITUP_API_KEY;
const BASE = 'https://api.yokitup.com';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || 'upload-secret';

// ── CACHE ──────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}
function cacheSet(key, data) { cache[key] = { ts: Date.now(), data }; }

// ── LIGHTSPEED CSV STORE (en mémoire) ──────────────────
let lsData = null; // données parsées du dernier CSV Lightspeed

function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/"/g, '').split(',');
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || [];
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/"/g, '').trim(); });
    return obj;
  }).filter(r => r.Type === 'SALE' || r.Type === 'SPLIT');
}

function aggregateLS(rows) {
  const byItem = {}, byCat = {}, byHour = {}, byDay = {};

  rows.forEach(r => {
    const price = parseFloat(r.FinalPrice) || 0;
    if (price <= 0) return;

    // Top items
    const key = r.Item;
    if (!byItem[key]) byItem[key] = { name: r.Item, group: r.GroupeStatistique, qty: 0, ca: 0 };
    byItem[key].qty += parseFloat(r.Qty) || 0;
    byItem[key].ca += price;

    // By category
    const cat = r.GroupeStatistique || 'Autre';
    byCat[cat] = (byCat[cat] || 0) + price;

    // By hour
    const dateStr = r.Date; // "25/04/26 12:27"
    if (dateStr) {
      const parts = dateStr.split(' ');
      if (parts[1]) {
        const h = parts[1].split(':')[0];
        byHour[h] = (byHour[h] || 0) + price;
      }
      // By day
      if (parts[0]) {
        byDay[parts[0]] = (byDay[parts[0]] || 0) + price;
      }
    }
  });

  const topItems = Object.values(byItem).sort((a, b) => b.ca - a.ca).slice(0, 15);
  const totalCA = Object.values(byCat).reduce((s, v) => s + v, 0);

  return { topItems, byCat, byHour, byDay, totalCA, nbRows: rows.length, updatedAt: new Date().toISOString() };
}

// ── AUTH ───────────────────────────────────────────────
function checkAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Accès refusé');
  }
  const [, password] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (password !== DASHBOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Mot de passe incorrect');
  }
  next();
}

// ── YOKITUP HELPERS ────────────────────────────────────
const YK_HEADERS = {
  'Authorization': 'Bearer ' + API_KEY,
  'Yokitup-Version': '2025-01-01',
  'Content-Type': 'application/json'
};

async function ykFetch(url) {
  const r = await fetch(url, { headers: YK_HEADERS });
  if (!r.ok) throw new Error('Yokitup HTTP ' + r.status + ' — ' + url);
  return r.json();
}

async function ykAll(path, params = '') {
  const cached = cacheGet(path + params);
  if (cached) return cached;
  let results = [];
  let url = BASE + path + (params ? '?' + params : '');
  while (url) {
    const data = await ykFetch(url);
    results = results.concat(data.data || []);
    const next = data.links?.next;
    url = (next && next !== url) ? next : null;
  }
  cacheSet(path + params, results);
  return results;
}

// ── UPLOAD LIGHTSPEED CSV ──────────────────────────────
app.post('/upload/lightspeed', upload.single('file'), (req, res) => {
  const secret = req.headers['x-upload-secret'] || req.query.secret;
  if (secret !== UPLOAD_SECRET) return res.status(401).json({ error: 'Secret invalide' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  try {
    const csvText = req.file.buffer.toString('utf-8');
    const rows = parseCSV(csvText);
    lsData = aggregateLS(rows);
    // Vider le cache dashboard pour forcer un refresh
    Object.keys(cache).filter(k => k.startsWith('dashboard:')).forEach(k => delete cache[k]);
    console.log('CSV Lightspeed reçu —', rows.length, 'lignes');
    res.json({ ok: true, rows: rows.length, totalCA: lsData.totalCA });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── LIGHTSPEED DATA ENDPOINT ───────────────────────────
app.get('/lightspeed', checkAuth, (req, res) => {
  if (!lsData) return res.json({ available: false });
  res.json({ available: true, ...lsData });
});

// ── AGGREGATED YOKITUP ENDPOINT ────────────────────────
app.get('/dashboard', checkAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const dateParams = `date_from=${from}&date_to=${to}`;
  const cacheKey = 'dashboard:' + from + ':' + to;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const [locs, cats, products, prodTags, tags] = await Promise.all([
      ykAll('/locations'),
      ykAll('/pos_categories'),
      ykAll('/products'),
      ykAll('/product_tags'),
      ykAll('/tags')
    ]);

    const [orders, deliveries, losses] = await Promise.all([
      ykAll('/pos_orders', dateParams),
      ykAll('/supplier_delivery_notes', dateParams).catch(() => []),
      ykAll('/losses', dateParams).catch(() => [])
    ]);

    let orderItems = [];
    if (orders.length > 0) {
      orderItems = await ykAll('/pos_order_items', dateParams).catch(() => []);
    }

    const catMap  = {}; cats.forEach(c => catMap[c.id] = c.name);
    const locMap  = {}; locs.forEach(l => locMap[l.id] = l.name);
    const prodMap = {}; products.forEach(p => prodMap[p.id] = p.name);
    const tagMap  = {}; tags.forEach(t => tagMap[t.id] = (t.name || '').toLowerCase());
    const ptMap   = {};
    prodTags.forEach(pt => {
      if (!ptMap[pt.product_id]) ptMap[pt.product_id] = [];
      if (tagMap[pt.tag_id]) ptMap[pt.product_id].push(tagMap[pt.tag_id]);
    });

    const DIV = 1000000000;
    const totalCA     = orders.reduce((s, o) => s + parseInt(o.amount_including_tax || 0), 0);
    const nbOrders    = orders.length;
    const ticket      = nbOrders > 0 ? Math.round(totalCA / nbOrders) : 0;
    const totalAchats = deliveries.reduce((s, d) => s + parseInt(d.received_amount_excluding_tax || 0), 0);
    const totalLosses = losses.reduce((s, l) => s + parseInt(l.cost || 0), 0);

    const byDay = {};
    orders.forEach(o => { byDay[o.date] = (byDay[o.date] || 0) + parseInt(o.amount_including_tax || 0); });

    const byCat = {};
    orders.forEach(o => {
      const k = catMap[o.pos_category_id] || 'Autre';
      byCat[k] = (byCat[k] || 0) + parseInt(o.amount_including_tax || 0);
    });

    const prodSales = {};
    orderItems.forEach(i => {
      const ca = parseInt(i.amount_including_tax || 0);
      const qty = parseFloat(i.quantity || 0);
      if (!prodSales[i.product_id]) prodSales[i.product_id] = { name: prodMap[i.product_id] || null, qty: 0, ca: 0 };
      prodSales[i.product_id].qty += qty;
      prodSales[i.product_id].ca  += ca;
    });

    const totalItemCA = Object.values(prodSales).reduce((s, v) => s + v.ca, 0);
    const topProds = Object.entries(prodSales)
      .sort((a, b) => totalItemCA > 0 ? b[1].ca - a[1].ca : b[1].qty - a[1].qty)
      .slice(0, 10)
      .map(([pid, d]) => ({ pid, name: d.name || pid.slice(0, 8) + '…', qty: d.qty, ca: d.ca }));

    const FOOD_TAGS = ['entrée','entree','plat','dessert','food','cuisine','burger','sandwich','salade'];
    const BEV_TAGS  = ['cocktail','cocktails','soft','softs','boisson','boissons','beverage','bière','biere','vin','wine'];
    const SPR_TAGS  = ['likkaz','spiritueux','whisky','rhum','gin','vodka','alcool','spirit'];

    let caFood = 0, caBev = 0, caSpr = 0;
    orderItems.forEach(i => {
      const ts = ptMap[i.product_id] || [];
      const v  = parseInt(i.amount_including_tax || 0);
      const val = v > 0 ? v : parseFloat(i.quantity || 0);
      if (ts.some(t => SPR_TAGS.some(s => t.includes(s))))       caSpr  += val;
      else if (ts.some(t => BEV_TAGS.some(s => t.includes(s))))  caBev  += val;
      else if (ts.some(t => FOOD_TAGS.some(s => t.includes(s)))) caFood += val;
    });

    const recentOrders = [...orders]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30)
      .map(o => ({ date: o.date, cat: catMap[o.pos_category_id] || '—', loc: locMap[o.location_id] || '', amount: parseInt(o.amount_including_tax || 0) }));

    const payload = {
      meta: { locs: locs.map(l => l.name), nbOrders, from, to },
      kpis: { totalCA, ticket, totalAchats, totalLosses, nbOrders },
      byDay, byCat, topProds,
      caByTag: { food: caFood, bev: caBev, spr: caSpr, usingQty: totalItemCA === 0 },
      recentOrders,
      div: DIV
    };

    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── CACHE CLEAR ────────────────────────────────────────
app.get('/cache/clear', checkAuth, (req, res) => {
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// ── STATIC + PROXY ─────────────────────────────────────
app.use(checkAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/*', async (req, res) => {
  const endpoint = req.path.replace('/api', '');
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = BASE + endpoint + query;
  try {
    const r = await fetch(url, { headers: YK_HEADERS });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Dashboard running on port ' + PORT));
