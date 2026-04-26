const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOKITUP_API_KEY;
const BASE = 'https://api.yokitup.com';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || 'upload-secret';
const STORE_PATH = path.join('/tmp', 'ls_store.json');

// ── CACHE ──────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const e = cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { delete cache[key]; return null; }
  return e.data;
}
function cacheSet(key, data) { cache[key] = { ts: Date.now(), data }; }

// ── LIGHTSPEED STORE (disque) ──────────────────────────
let lsStore = {};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      lsStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      console.log('Store chargé depuis disque —', Object.keys(lsStore).length, 'jours');
    }
  } catch(e) { console.error('Erreur lecture store:', e.message); lsStore = {}; }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(lsStore), 'utf-8');
  } catch(e) { console.error('Erreur écriture store:', e.message); }
}

loadStore(); // Charger au démarrage

// ── CSV PARSING ────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/"/g, '').split(',');
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => (r.Type === 'SALE' || r.Type === 'SPLIT') && parseFloat(r.FinalPrice) > 0);
}

function aggregateLS(rows) {
  const byItem = {}, byCat = {}, byGroup = {}, byDay = {};
  let totalCA = 0, totalHT = 0, totalTVA10 = 0, totalTVA20 = 0;

  rows.forEach(r => {
    const price = parseFloat(r.FinalPrice) || 0;
    const ht = parseFloat(r.PreTax) || 0;
    const qty = parseFloat(r.Qty) || 1;
    const tva = r.TaxName || '';
    totalCA += price;
    totalHT += ht;
    if (tva.includes('20')) totalTVA20 += price;
    else totalTVA10 += price;

    const key = r.Item;
    if (!byItem[key]) byItem[key] = { name: r.Item, group: r.GroupeStatistique, category: r.Group, qty: 0, ca: 0, ht: 0 };
    byItem[key].qty += qty;
    byItem[key].ca += price;
    byItem[key].ht += ht;

    const gs = r.GroupeStatistique || 'Autre';
    byCat[gs] = (byCat[gs] || 0) + price;

    const grp = (r.Group || 'Autre').replace(/\(.*?\)/g, '').trim();
    byGroup[grp] = (byGroup[grp] || 0) + price;

    const dateStr = r.Date;
    if (dateStr) {
      const parts = dateStr.split(' ');
      if (parts[0]) {
        const dp = parts[0].split('/');
        if (dp.length === 3) {
          const dayKey = `20${dp[2]}-${dp[1]}-${dp[0]}`;
          byDay[dayKey] = (byDay[dayKey] || 0) + price;
        }
      }
    }
  });

  const topItems = Object.values(byItem).sort((a, b) => b.ca - a.ca).slice(0, 15);
  return { topItems, byCat, byGroup, byDay, totalCA, totalHT, totalTVA10, totalTVA20, nbRows: rows.length, updatedAt: new Date().toISOString() };
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

// ── YOKITUP ────────────────────────────────────────────
const YK_HEADERS = { 'Authorization': 'Bearer ' + API_KEY, 'Yokitup-Version': '2025-01-01', 'Content-Type': 'application/json' };

async function ykFetch(url) {
  const r = await fetch(url, { headers: YK_HEADERS });
  if (!r.ok) throw new Error('Yokitup HTTP ' + r.status);
  return r.json();
}

async function ykAll(path, params = '') {
  const key = path + params;
  const cached = cacheGet(key);
  if (cached) return cached;
  let results = [], url = BASE + path + (params ? '?' + params : '');
  while (url) {
    const data = await ykFetch(url);
    results = results.concat(data.data || []);
    const next = data.links?.next;
    url = (next && next !== url) ? next : null;
  }
  cacheSet(key, results);
  return results;
}

// ── UPLOAD CSV ─────────────────────────────────────────
app.post('/upload/lightspeed', upload.single('file'), (req, res) => {
  const secret = req.headers['x-upload-secret'] || req.query.secret;
  if (secret !== UPLOAD_SECRET) return res.status(401).json({ error: 'Secret invalide' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  try {
    const csvText = req.file.buffer.toString('utf-8');
    const rows = parseCSV(csvText);
    const agg = aggregateLS(rows);

    const days = Object.keys(agg.byDay);
    if (days.length === 0) {
      const today = new Date().toISOString().split('T')[0];
      lsStore[today] = agg;
    } else {
      days.forEach(day => { lsStore[day] = agg; });
    }

    saveStore(); // Persister sur disque
    Object.keys(cache).filter(k => k.startsWith('dashboard:')).forEach(k => delete cache[k]);
    console.log('CSV Lightspeed reçu —', rows.length, 'lignes —', days.join(', '));
    res.json({ ok: true, rows: rows.length, days, totalCA: agg.totalCA });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD ──────────────────────────────────────────
app.get('/dashboard', checkAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const cacheKey = 'dashboard:' + from + ':' + to;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const dateParams = `date_from=${from}&date_to=${to}`;
    const [locs, orders, deliveries, losses] = await Promise.all([
      ykAll('/locations'),
      ykAll('/pos_orders', dateParams),
      ykAll('/supplier_delivery_notes', dateParams).catch(() => []),
      ykAll('/losses', dateParams).catch(() => [])
    ]);

    const locMap = {}; locs.forEach(l => locMap[l.id] = l.name);
    const DIV = 1000000000;
    const totalCA_yk = orders.reduce((s, o) => s + parseInt(o.amount_including_tax || 0), 0);
    const nbOrders = orders.length;
    const ticket = nbOrders > 0 ? Math.round(totalCA_yk / nbOrders) : 0;
    const totalAchats = deliveries.reduce((s, d) => s + parseInt(d.received_amount_excluding_tax || 0), 0);
    const totalLosses = losses.reduce((s, l) => s + parseInt(l.cost || 0), 0);

    const byDay_yk = {};
    orders.forEach(o => { byDay_yk[o.date] = (byDay_yk[o.date] || 0) + parseInt(o.amount_including_tax || 0); });

    const recentOrders = [...orders]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30)
      .map(o => ({ date: o.date, cat: '—', loc: locMap[o.location_id] || '', amount: parseInt(o.amount_including_tax || 0) }));

    // Lightspeed data
    const lsDays = Object.keys(lsStore).filter(d => d >= from && d <= to);
    let lsAgg = null;

    if (lsDays.length > 0) {
      const merged = { topItems: {}, byCat: {}, byGroup: {}, byDay: {}, totalCA: 0, totalHT: 0, totalTVA10: 0, totalTVA20: 0 };
      lsDays.forEach(day => {
        const ls = lsStore[day];
        if (!ls) return;
        ls.topItems.forEach(item => {
          if (!merged.topItems[item.name]) merged.topItems[item.name] = { ...item, qty: 0, ca: 0, ht: 0 };
          merged.topItems[item.name].qty += item.qty;
          merged.topItems[item.name].ca += item.ca;
          merged.topItems[item.name].ht += item.ht;
        });
        Object.entries(ls.byCat).forEach(([k, v]) => { merged.byCat[k] = (merged.byCat[k] || 0) + v; });
        Object.entries(ls.byGroup).forEach(([k, v]) => { merged.byGroup[k] = (merged.byGroup[k] || 0) + v; });
        Object.entries(ls.byDay).forEach(([k, v]) => { merged.byDay[k] = (merged.byDay[k] || 0) + v; });
        merged.totalCA += ls.totalCA;
        merged.totalHT += ls.totalHT;
        merged.totalTVA10 += ls.totalTVA10;
        merged.totalTVA20 += ls.totalTVA20;
      });
      merged.topItems = Object.values(merged.topItems).sort((a, b) => b.ca - a.ca).slice(0, 12);
      lsAgg = merged;
    }

    const byDay = lsAgg && Object.keys(lsAgg.byDay).length > 0
      ? Object.fromEntries(Object.entries(lsAgg.byDay).map(([k, v]) => [k, Math.round(v * DIV)]))
      : byDay_yk;

    const byCat = lsAgg ? lsAgg.byCat : {};
    const topProds = lsAgg
      ? lsAgg.topItems.map(p => ({ name: p.name, qty: Math.round(p.qty), ca: Math.round(p.ca * DIV), group: p.group }))
      : [];

    let caFood = 0, caBev = 0;
    if (lsAgg) {
      Object.entries(lsAgg.byGroup).forEach(([grp, val]) => {
        const g = grp.toLowerCase();
        if (g.includes('alcool') || g.includes('spirit') || g.includes('likkaz') || g.includes('bar')) caBev += val;
        else if (g.includes('boisson')) caBev += val;
        else if (g.includes('cuisine') || g.includes('food')) caFood += val;
      });
    }

    const payload = {
      meta: { locs: locs.map(l => l.name), nbOrders, from, to, lsAvailable: !!lsAgg, lsDaysCount: lsDays.length },
      kpis: { totalCA: totalCA_yk, ticket, totalAchats, totalLosses, nbOrders },
      byDay,
      byCat,
      topProds,
      caByTag: { food: Math.round(caFood * DIV), bev: Math.round(caBev * DIV), usingQty: false, lsSource: !!lsAgg },
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
  try {
    const r = await fetch(BASE + endpoint + query, { headers: YK_HEADERS });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log('Dashboard running on port ' + PORT));
