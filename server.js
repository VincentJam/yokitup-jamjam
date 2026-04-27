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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const STORE_PATH = path.join('/tmp', 'ls_store.json');
const SETTINGS_PATH = path.join('/tmp', 'settings.json');

// ── CACHE ──────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 60 * 60 * 1000;
function cacheGet(k){const e=cache[k];if(!e)return null;if(Date.now()-e.ts>CACHE_TTL){delete cache[k];return null;}return e.data;}
function cacheSet(k,d){cache[k]={ts:Date.now(),data:d};}
function cacheClearDashboard(){Object.keys(cache).filter(k=>k.startsWith('dashboard:')).forEach(k=>delete cache[k]);}

// ── SUPABASE STORE ─────────────────────────────────────
async function sbGet(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/store?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const data = await r.json();
    if (data && data[0]) return JSON.parse(data[0].value);
  } catch(e) { console.error('sbGet error:', e.message); }
  return null;
}

async function sbSet(key, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/store`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key, value: JSON.stringify(value) })
    });
  } catch(e) { console.error('sbSet error:', e.message); }
}

// ── LOCAL STORES (fallback) ────────────────────────────
let lsStore = {};
let settings = { monthlyTarget: 0 };

function loadLocal() {
  try { if(fs.existsSync(STORE_PATH)) lsStore=JSON.parse(fs.readFileSync(STORE_PATH,'utf-8')); } catch(e) { lsStore={}; }
  try { if(fs.existsSync(SETTINGS_PATH)) settings=JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf-8')); } catch(e) {}
}
function saveLocal() {
  try { fs.writeFileSync(STORE_PATH,JSON.stringify(lsStore),'utf-8'); } catch(e) {}
  try { fs.writeFileSync(SETTINGS_PATH,JSON.stringify(settings),'utf-8'); } catch(e) {}
}

async function loadStores() {
  loadLocal();
  const sbStore = await sbGet('ls_store');
  if (sbStore) { lsStore = sbStore; console.log('Store chargé depuis Supabase —', Object.keys(lsStore).length, 'jours'); }
  const sbSettings = await sbGet('settings');
  if (sbSettings) { settings = sbSettings; }
}

async function saveStores() {
  saveLocal();
  await Promise.all([sbSet('ls_store', lsStore), sbSet('settings', settings)]);
}

loadStores();

// ── SOFT COCKTAILS ─────────────────────────────────────
const SOFT_COCKTAILS = ["lover's leap", "lover leap", "cockpit country", "cockpit"];

// ── CSV PARSING ────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/"/g,'').split(',');
  return lines.slice(1).map(line => {
    const vals=[]; let cur='',inQ=false;
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){inQ=!inQ;continue;}if(c===','&&!inQ){vals.push(cur.trim());cur='';continue;}cur+=c;}
    vals.push(cur.trim());
    const obj={}; headers.forEach((h,i)=>{obj[h]=(vals[i]||'').trim();});
    return obj;
  }).filter(r=>(r.Type==='SALE'||r.Type==='SPLIT')&&parseFloat(r.PreTax)>0);
}

function getHour(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split(' ');
  if (parts[1]) return parseInt(parts[1].split(':')[0]);
  return null;
}

function aggregateLS(rows) {
  const byItem={}, byCat={}, byGroup={}, byDay={};
  let totalHT=0, caFoodHT=0, caBevHT=0;
  let caCocktailAlc=0, caCocktailSoft=0, caAlcool=0, caSoft=0, caLikkaz=0;
  // Ticket midi/soir
  let midiCA=0, midiCount=0, soirCA=0, soirCount=0;

  rows.forEach(r => {
    const ht = parseFloat(r.PreTax)||0;
    const qty = parseFloat(r.Qty)||1;
    const gs = (r.GroupeStatistique||'Autre').trim();
    const grp = (r.Group||'Autre').replace(/\(.*?\)/g,'').trim();
    const itemName = (r.Item||'').toLowerCase();
    const hour = getHour(r.Date);
    totalHT += ht;

    // Ticket midi/soir — on agrège par ticket (Type=SALE uniquement pour ne pas doubler)
    if (r.Type === 'SALE' && hour !== null) {
      if (hour < 16) { midiCA += ht; midiCount++; }
      else if (hour >= 19) { soirCA += ht; soirCount++; }
    }

    // By item
    if(!byItem[r.Item]) byItem[r.Item]={name:r.Item,group:gs,category:grp,qty:0,ht:0};
    byItem[r.Item].qty+=qty; byItem[r.Item].ht+=ht;

    // By GroupeStatistique
    byCat[gs]=(byCat[gs]||0)+ht;

    // By Group
    byGroup[grp]=(byGroup[grp]||0)+ht;

    // Food vs Bev
    const grpL=grp.toLowerCase(), gsL=gs.toLowerCase();
    if(grpL.includes('cuisine')||grpL.includes('food')) caFoodHT+=ht;
    else caBevHT+=ht;

    // Cocktail avec/sans alcool
    if(gsL.includes('cocktail')) {
      const isSoft=SOFT_COCKTAILS.some(s=>itemName.includes(s));
      if(isSoft) caCocktailSoft+=ht; else caCocktailAlc+=ht;
    }
    // Alcools / Likkaz / Softs
    if(gsL.includes('likkaz')) caLikkaz+=ht;
    else if(gsL.includes('alcool')||gsL.includes('spiritueux')) caAlcool+=ht;
    if(gsL.includes('soft')||gsL.includes('sans alcool')) caSoft+=ht;

    // By day
    const ds=r.Date;
    if(ds){const p=ds.split(' ');if(p[0]){const dp=p[0].split('/');if(dp.length===3){const dk=`20${dp[2]}-${dp[1]}-${dp[0]}`;byDay[dk]=(byDay[dk]||0)+ht;}}}
  });

  return {
    topItems: Object.values(byItem).sort((a,b)=>b.ht-a.ht).slice(0,15),
    byCat, byGroup, byDay, totalHT,
    split: { food:caFoodHT, bev:caBevHT, cocktailAlc:caCocktailAlc, cocktailSoft:caCocktailSoft, alcool:caAlcool, soft:caSoft, likkaz:caLikkaz },
    tickets: { midiCA, midiCount, soirCA, soirCount },
    nbRows:rows.length, updatedAt:new Date().toISOString()
  };
}

// ── AUTH ───────────────────────────────────────────────
function checkAuth(req,res,next){
  const auth=req.headers['authorization'];
  if(!auth||!auth.startsWith('Basic ')){res.set('WWW-Authenticate','Basic realm="Dashboard"');return res.status(401).send('Accès refusé');}
  const[,password]=Buffer.from(auth.slice(6),'base64').toString().split(':');
  if(password!==DASHBOARD_PASSWORD){res.set('WWW-Authenticate','Basic realm="Dashboard"');return res.status(401).send('Mot de passe incorrect');}
  next();
}

// ── YOKITUP ────────────────────────────────────────────
const YKH={'Authorization':'Bearer '+API_KEY,'Yokitup-Version':'2025-01-01','Content-Type':'application/json'};
async function ykFetch(url){const r=await fetch(url,{headers:YKH});if(!r.ok)throw new Error('YK '+r.status);return r.json();}
async function ykAll(p,params=''){
  const k='yk:'+p+params; const c=cacheGet(k); if(c)return c;
  let res=[],url=BASE+p+(params?'?'+params:'');
  while(url){const d=await ykFetch(url);res=res.concat(d.data||[]);const n=d.links?.next;url=(n&&n!==url)?n:null;}
  cacheSet(k,res); return res;
}

// ── UPLOAD CSV ─────────────────────────────────────────
app.post('/upload/lightspeed', upload.single('file'), async (req,res) => {
  const secret=req.headers['x-upload-secret']||req.query.secret;
  if(secret!==UPLOAD_SECRET) return res.status(401).json({error:'Secret invalide'});
  if(!req.file) return res.status(400).json({error:'Aucun fichier'});
  try {
    const rows=parseCSV(req.file.buffer.toString('utf-8'));
    const agg=aggregateLS(rows);
    const days=Object.keys(agg.byDay);
    if(days.length===0) lsStore[new Date().toISOString().split('T')[0]]=agg;
    else days.forEach(d=>{lsStore[d]=agg;});
    await saveStores();
    cacheClearDashboard();
    console.log('CSV LS —',rows.length,'lignes —',days.join(', '));
    res.json({ok:true,rows:rows.length,days,totalHT:agg.totalHT});
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});

// ── SETTINGS ───────────────────────────────────────────
app.get('/settings', checkAuth, (req,res) => res.json(settings));
app.post('/settings', checkAuth, express.json(), async (req,res) => {
  if(req.body.monthlyTarget!==undefined) settings.monthlyTarget=parseFloat(req.body.monthlyTarget)||0;
  await saveStores(); cacheClearDashboard();
  res.json({ok:true,settings});
});

// ── DASHBOARD ──────────────────────────────────────────
app.get('/dashboard', checkAuth, async (req,res) => {
  const {from,to}=req.query;
  if(!from||!to) return res.status(400).json({error:'from/to required'});
  const ck='dashboard:'+from+':'+to;
  const cached=cacheGet(ck); if(cached) return res.json({...cached,cached:true});

  try {
    const dp=`date_from=${from}&date_to=${to}`;

    // Mois en cours pour objectif
    const now=new Date();
    const monthFrom=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const monthTo=now.toISOString().split('T')[0];
    const monthDp=`date_from=${monthFrom}&date_to=${monthTo}`;

    const [locs,orders,delivNotes,prodTags,tags,products,monthOrders] = await Promise.all([
      ykAll('/locations'),
      ykAll('/pos_orders',dp),
      ykAll('/supplier_delivery_notes',dp).catch(()=>[]),
      ykAll('/product_tags').catch(()=>[]),
      ykAll('/tags').catch(()=>[]),
      ykAll('/products').catch(()=>[]),
      ykAll('/pos_orders',monthDp).catch(()=>[])
    ]);

    const locMap={}; locs.forEach(l=>locMap[l.id]=l.name);
    const tagMap={}; tags.forEach(t=>tagMap[t.id]=(t.name||'').toLowerCase());
    const ptMap={}; prodTags.forEach(pt=>{if(!ptMap[pt.product_id])ptMap[pt.product_id]=[];if(tagMap[pt.tag_id])ptMap[pt.product_id].push(tagMap[pt.tag_id]);});

    // Yokitup CA (en nano-unités → on divise par DIV pour avoir les euros)
    const DIV=1000000000;
    const totalCA_yk=orders.reduce((s,o)=>s+parseInt(o.amount_including_tax||0),0);
    const totalHT_yk=orders.reduce((s,o)=>s+parseInt(o.amount_excluding_tax||0),0);
    const nbOrders=orders.length;
    const ticketHT_yk=nbOrders>0?Math.round(totalHT_yk/nbOrders):0;
    const caMonthHT=monthOrders.reduce((s,o)=>s+parseInt(o.amount_excluding_tax||0),0);

    // Achats par tag
    const delivNoteIds=new Set(delivNotes.map(d=>d.id));
    const delivItems=await ykAll('/supplier_delivery_note_items').catch(()=>[]);
    const periodDelivItems=delivItems.filter(i=>delivNoteIds.has(i.supplier_delivery_note_id));
    const totalAchatsHT=delivNotes.reduce((s,d)=>s+parseInt(d.received_amount_excluding_tax||0),0);

    let achatFood=0, achatBev=0;
    periodDelivItems.forEach(i=>{
      const amt=parseInt(i.received_amount_excluding_tax||0);
      const ptags=ptMap[i.product_id]||[];
      const isFood=ptags.some(t=>['cuisine','food','entrée','plat','dessert','burger','recette'].some(s=>t.includes(s)));
      if(isFood) achatFood+=amt; else achatBev+=amt;
    });

    // Yokitup by day (HT)
    const byDay_yk={};
    orders.forEach(o=>{byDay_yk[o.date]=(byDay_yk[o.date]||0)+parseInt(o.amount_excluding_tax||0);});

    const recentOrders=[...orders].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30)
      .map(o=>({date:o.date,loc:locMap[o.location_id]||'',amount:parseInt(o.amount_excluding_tax||0)/DIV}));

    // Lightspeed data
    const lsDays=Object.keys(lsStore).filter(d=>d>=from&&d<=to);
    let lsAgg=null;
    if(lsDays.length>0){
      const m={topItems:{},byCat:{},byGroup:{},byDay:{},totalHT:0,
        split:{food:0,bev:0,cocktailAlc:0,cocktailSoft:0,alcool:0,soft:0,likkaz:0},
        tickets:{midiCA:0,midiCount:0,soirCA:0,soirCount:0}};
      lsDays.forEach(day=>{
        const ls=lsStore[day]; if(!ls)return;
        ls.topItems.forEach(item=>{
          if(!m.topItems[item.name])m.topItems[item.name]={...item,qty:0,ht:0};
          m.topItems[item.name].qty+=item.qty;
          m.topItems[item.name].ht+=item.ht;
        });
        Object.entries(ls.byCat).forEach(([k,v])=>{m.byCat[k]=(m.byCat[k]||0)+v;});
        Object.entries(ls.byGroup).forEach(([k,v])=>{m.byGroup[k]=(m.byGroup[k]||0)+v;});
        Object.entries(ls.byDay).forEach(([k,v])=>{m.byDay[k]=(m.byDay[k]||0)+v;});
        m.totalHT+=ls.totalHT;
        Object.keys(ls.split).forEach(k=>{m.split[k]=(m.split[k]||0)+(ls.split[k]||0);});
        if(ls.tickets){
          m.tickets.midiCA+=ls.tickets.midiCA||0;
          m.tickets.midiCount+=ls.tickets.midiCount||0;
          m.tickets.soirCA+=ls.tickets.soirCA||0;
          m.tickets.soirCount+=ls.tickets.soirCount||0;
        }
      });
      m.topItems=Object.values(m.topItems).sort((a,b)=>b.ht-a.ht).slice(0,12);
      lsAgg=m;
    }

    // Choisir la meilleure source
    const useLS=!!lsAgg;
    const totalHT_display=useLS?lsAgg.totalHT:totalHT_yk/DIV;
    const byDay=useLS&&Object.keys(lsAgg.byDay).length>0?lsAgg.byDay:Object.fromEntries(Object.entries(byDay_yk).map(([k,v])=>[k,v/DIV]));
    const byCat=useLS?lsAgg.byCat:{};
    const topProds=useLS?lsAgg.topItems.map(p=>({name:p.name,qty:Math.round(p.qty),ht:p.ht,group:p.group})):[];
    const split=useLS?lsAgg.split:null;
    const tickets=useLS?lsAgg.tickets:null;

    // Tickets
    const ticketMidiHT=tickets&&tickets.midiCount>0?tickets.midiCA/tickets.midiCount:null;
    const ticketSoirHT=tickets&&tickets.soirCount>0?tickets.soirCA/tickets.soirCount:null;
    const ticketGlobalHT=useLS&&lsAgg.totalHT>0&&nbOrders>0?lsAgg.totalHT/nbOrders:ticketHT_yk/DIV;

    // Ratios (tout en € réels, pas nano)
    const htDisplay=useLS?lsAgg.totalHT:totalHT_yk/DIV;
    const achatFoodEur=achatFood/DIV, achatBevEur=achatBev/DIV, totalAchatsEur=totalAchatsHT/DIV;
    const caFoodEur=split?split.food:0, caBevEur=split?split.bev:0;
    const fcGlobal=totalAchatsEur>0&&htDisplay>0?(totalAchatsEur/htDisplay*100):null;
    const fcFood=achatFoodEur>0&&caFoodEur>0?(achatFoodEur/caFoodEur*100):null;
    const fcBev=achatBevEur>0&&caBevEur>0?(achatBevEur/caBevEur*100):null;
    const margeGlobale=htDisplay>0&&totalAchatsEur>=0?((htDisplay-totalAchatsEur)/htDisplay*100):null;
    const caMonthEur=caMonthHT/DIV;

    const payload={
      meta:{locs:locs.map(l=>l.name),nbOrders,from,to,lsAvailable:useLS,lsDaysCount:lsDays.length},
      kpis:{totalHT:totalHT_display,ticketGlobal:ticketGlobalHT,ticketMidi:ticketMidiHT,ticketSoir:ticketSoirHT,
            totalAchats:totalAchatsEur,achatFood:achatFoodEur,achatBev:achatBevEur,nbOrders,caMonth:caMonthEur},
      ratios:{fcGlobal,fcFood,fcBev,margeGlobale},
      byDay,byCat,topProds,split,
      recentOrders,settings,div:DIV
    };
    cacheSet(ck,payload);
    res.json(payload);
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});

// ── CACHE CLEAR ────────────────────────────────────────
app.get('/cache/clear',checkAuth,(req,res)=>{Object.keys(cache).forEach(k=>delete cache[k]);res.json({ok:true});});

// ── STATIC + PROXY ─────────────────────────────────────
app.use(checkAuth);
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/*',async(req,res)=>{
  const endpoint=req.path.replace('/api','');
  const query=req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'';
  try{const r=await fetch(BASE+endpoint+query,{headers:YKH});res.json(await r.json());}
  catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT,()=>console.log('Dashboard running on port '+PORT));
