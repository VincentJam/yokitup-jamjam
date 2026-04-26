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
const SETTINGS_PATH = path.join('/tmp', 'settings.json');

// ── CACHE ──────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1h
function cacheGet(k) { const e=cache[k]; if(!e)return null; if(Date.now()-e.ts>CACHE_TTL){delete cache[k];return null;} return e.data; }
function cacheSet(k,d) { cache[k]={ts:Date.now(),data:d}; }
function cacheClearDashboard() { Object.keys(cache).filter(k=>k.startsWith('dashboard:')).forEach(k=>delete cache[k]); }

// ── STORES ─────────────────────────────────────────────
let lsStore = {};
let settings = { monthlyTarget: 0 };

function loadStore() {
  try { if(fs.existsSync(STORE_PATH)) lsStore=JSON.parse(fs.readFileSync(STORE_PATH,'utf-8')); } catch(e) { lsStore={}; }
  try { if(fs.existsSync(SETTINGS_PATH)) settings=JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf-8')); } catch(e) {}
  console.log('Store chargé —', Object.keys(lsStore).length, 'jours LS');
}
function saveStore() { try{fs.writeFileSync(STORE_PATH,JSON.stringify(lsStore),'utf-8');}catch(e){console.error(e.message);} }
function saveSettings() { try{fs.writeFileSync(SETTINGS_PATH,JSON.stringify(settings),'utf-8');}catch(e){console.error(e.message);} }
loadStore();

// ── SANS-ALCOOL COCKTAILS ──────────────────────────────
const SOFT_COCKTAILS = ["lover's leap","lover leap","cockpit country","cockpit"];

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
  }).filter(r=>(r.Type==='SALE'||r.Type==='SPLIT')&&parseFloat(r.FinalPrice)>0);
}

function aggregateLS(rows) {
  const byItem={}, byCat={}, byGroup={}, byDay={};
  let totalCA=0, totalHT=0, caFood=0, caBev=0, caCocktailAlc=0, caCocktailSoft=0, caAlcool=0, caSoft=0;

  rows.forEach(r => {
    const price=parseFloat(r.FinalPrice)||0;
    const ht=parseFloat(r.PreTax)||0;
    const qty=parseFloat(r.Qty)||1;
    const gs=(r.GroupeStatistique||'Autre').trim();
    const grp=(r.Group||'Autre').replace(/\(.*?\)/g,'').trim();
    const itemName=(r.Item||'').toLowerCase();
    totalCA+=price; totalHT+=ht;

    // By item
    const key=r.Item;
    if(!byItem[key]) byItem[key]={name:r.Item,group:gs,category:grp,qty:0,ca:0,ht:0};
    byItem[key].qty+=qty; byItem[key].ca+=price; byItem[key].ht+=ht;

    // By GroupeStatistique
    byCat[gs]=(byCat[gs]||0)+price;

    // By Group
    byGroup[grp]=(byGroup[grp]||0)+price;

    // Food vs Bev split
    const grpL=grp.toLowerCase(), gsL=gs.toLowerCase();
    if(grpL.includes('cuisine')||grpL.includes('food')) caFood+=price;
    else caBev+=price;

    // Cocktail avec/sans alcool
    if(gsL.includes('cocktail')) {
      const isSoft=SOFT_COCKTAILS.some(s=>itemName.includes(s));
      if(isSoft) caCocktailSoft+=price;
      else caCocktailAlc+=price;
    }
    if(gsL.includes('alcool')||gsL.includes('likkaz')||gsL.includes('spiritueux')) caAlcool+=price;
    if(gsL.includes('soft')||gsL.includes('sans alcool')) caSoft+=price;

    // By day
    const ds=r.Date;
    if(ds){const p=ds.split(' ');if(p[0]){const dp=p[0].split('/');if(dp.length===3){const dk=`20${dp[2]}-${dp[1]}-${dp[0]}`;byDay[dk]=(byDay[dk]||0)+price;}}}
  });

  return {
    topItems: Object.values(byItem).sort((a,b)=>b.ca-a.ca).slice(0,15),
    byCat, byGroup, byDay, totalCA, totalHT,
    split: { food:caFood, bev:caBev, cocktailAlc:caCocktailAlc, cocktailSoft:caCocktailSoft, alcool:caAlcool, soft:caSoft },
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
async function ykFetch(url){const r=await fetch(url,{headers:YKH});if(!r.ok)throw new Error('YK HTTP '+r.status);return r.json();}
async function ykAll(p,params=''){
  const k=p+params; const c=cacheGet(k); if(c)return c;
  let res=[],url=BASE+p+(params?'?'+params:'');
  while(url){const d=await ykFetch(url);res=res.concat(d.data||[]);const n=d.links?.next;url=(n&&n!==url)?n:null;}
  cacheSet(k,res); return res;
}

// ── UPLOAD CSV ─────────────────────────────────────────
app.post('/upload/lightspeed', upload.single('file'), (req,res) => {
  const secret=req.headers['x-upload-secret']||req.query.secret;
  if(secret!==UPLOAD_SECRET) return res.status(401).json({error:'Secret invalide'});
  if(!req.file) return res.status(400).json({error:'Aucun fichier reçu'});
  try {
    const rows=parseCSV(req.file.buffer.toString('utf-8'));
    const agg=aggregateLS(rows);
    const days=Object.keys(agg.byDay);
    if(days.length===0) lsStore[new Date().toISOString().split('T')[0]]=agg;
    else days.forEach(d=>{lsStore[d]=agg;});
    saveStore(); cacheClearDashboard();
    console.log('CSV LS reçu —',rows.length,'lignes —',days.join(', '));
    res.json({ok:true,rows:rows.length,days,totalCA:agg.totalCA});
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});

// ── SETTINGS ───────────────────────────────────────────
app.get('/settings', checkAuth, (req,res) => res.json(settings));
app.post('/settings', checkAuth, express.json(), (req,res) => {
  if(req.body.monthlyTarget!==undefined) settings.monthlyTarget=parseFloat(req.body.monthlyTarget)||0;
  saveSettings(); cacheClearDashboard();
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
    const [locs,orders,delivNotes,delivItems,suppliers,prodTags,tags,products] = await Promise.all([
      ykAll('/locations'),
      ykAll('/pos_orders',dp),
      ykAll('/supplier_delivery_notes',dp).catch(()=>[]),
      ykAll('/supplier_delivery_note_items').catch(()=>[]),
      ykAll('/suppliers').catch(()=>[]),
      ykAll('/product_tags').catch(()=>[]),
      ykAll('/tags').catch(()=>[]),
      ykAll('/products').catch(()=>[])
    ]);

    const locMap={}; locs.forEach(l=>locMap[l.id]=l.name);
    const tagMap={}; tags.forEach(t=>tagMap[t.id]=(t.name||'').toLowerCase());
    const ptMap={}; prodTags.forEach(pt=>{if(!ptMap[pt.product_id])ptMap[pt.product_id]=[];if(tagMap[pt.tag_id])ptMap[pt.product_id].push(tagMap[pt.tag_id]);});

    const DIV=1000000000;
    const totalCA_yk=orders.reduce((s,o)=>s+parseInt(o.amount_including_tax||0),0);
    const nbOrders=orders.length;
    const ticket=nbOrders>0?Math.round(totalCA_yk/nbOrders):0;

    // Achats par catégorie via tags produit
    const totalAchats=delivNotes.reduce((s,d)=>s+parseInt(d.received_amount_excluding_tax||0),0);

    // Calcul food cost par tag sur les BL items
    // On filtre les BL items qui correspondent aux BL de la période
    const delivNoteIds=new Set(delivNotes.map(d=>d.id));
    const periodDelivItems=delivItems.filter(i=>delivNoteIds.has(i.supplier_delivery_note_id));

    let achatFood=0, achatBev=0;
    periodDelivItems.forEach(i=>{
      const amt=parseInt(i.received_amount_excluding_tax||0);
      const ptags=ptMap[i.product_id]||[];
      const isFood=ptags.some(t=>['cuisine','food','entrée','plat','dessert','burger'].some(s=>t.includes(s)));
      const isBev=ptags.some(t=>['boisson','cocktail','alcool','soft','spiritueux','likkaz','vin','bière'].some(s=>t.includes(s)));
      if(isFood) achatFood+=amt;
      else if(isBev) achatBev+=amt;
      else achatFood+=amt; // par défaut food
    });

    // Yokitup by day
    const byDay_yk={};
    orders.forEach(o=>{byDay_yk[o.date]=(byDay_yk[o.date]||0)+parseInt(o.amount_including_tax||0);});

    const recentOrders=[...orders].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30)
      .map(o=>({date:o.date,loc:locMap[o.location_id]||'',amount:parseInt(o.amount_including_tax||0)}));

    // Lightspeed data
    const lsDays=Object.keys(lsStore).filter(d=>d>=from&&d<=to);
    let lsAgg=null;
    if(lsDays.length>0){
      const m={topItems:{},byCat:{},byGroup:{},byDay:{},totalCA:0,totalHT:0,
        split:{food:0,bev:0,cocktailAlc:0,cocktailSoft:0,alcool:0,soft:0}};
      lsDays.forEach(day=>{
        const ls=lsStore[day]; if(!ls)return;
        ls.topItems.forEach(item=>{
          if(!m.topItems[item.name])m.topItems[item.name]={...item,qty:0,ca:0,ht:0};
          m.topItems[item.name].qty+=item.qty;
          m.topItems[item.name].ca+=item.ca;
          m.topItems[item.name].ht+=item.ht;
        });
        Object.entries(ls.byCat).forEach(([k,v])=>{m.byCat[k]=(m.byCat[k]||0)+v;});
        Object.entries(ls.byGroup).forEach(([k,v])=>{m.byGroup[k]=(m.byGroup[k]||0)+v;});
        Object.entries(ls.byDay).forEach(([k,v])=>{m.byDay[k]=(m.byDay[k]||0)+v;});
        m.totalCA+=ls.totalCA; m.totalHT+=ls.totalHT;
        Object.keys(ls.split).forEach(k=>{m.split[k]=(m.split[k]||0)+ls.split[k];});
      });
      m.topItems=Object.values(m.topItems).sort((a,b)=>b.ca-a.ca).slice(0,12);
      lsAgg=m;
    }

    const byDay=lsAgg&&Object.keys(lsAgg.byDay).length>0
      ?Object.fromEntries(Object.entries(lsAgg.byDay).map(([k,v])=>[k,Math.round(v*DIV)]))
      :byDay_yk;

    const byCat=lsAgg?lsAgg.byCat:{};
    const topProds=lsAgg?lsAgg.topItems.map(p=>({name:p.name,qty:Math.round(p.qty),ca:Math.round(p.ca*DIV),group:p.group})):[];
    const split=lsAgg?Object.fromEntries(Object.entries(lsAgg.split).map(([k,v])=>[k,Math.round(v*DIV)])):null;

    // Food cost ratios
    const caFood=split?split.food:0;
    const caBev=split?split.bev:0;
    const fcGlobal=totalAchats>0?(totalAchats/totalCA_yk*100):null;
    const fcFood=achatFood>0&&caFood>0?(achatFood/caFood*100):null;
    const fcBev=achatBev>0&&caBev>0?(achatBev/caBev*100):null;
    const margeGlobale=totalCA_yk>0?((totalCA_yk-totalAchats)/totalCA_yk*100):null;

    // Mois courant pour objectif
    const monthFrom=from.slice(0,7)+'-01';
    const monthTo=to.slice(0,7)+'-'+new Date(parseInt(to.slice(0,4)),parseInt(to.slice(5,7)),0).getDate();
    let caMonth=totalCA_yk;
    if(from!==monthFrom){
      try{
        const mOrders=await ykAll('/pos_orders',`date_from=${monthFrom}&date_to=${to}`);
        caMonth=mOrders.reduce((s,o)=>s+parseInt(o.amount_including_tax||0),0);
      }catch(e){}
    }

    const payload={
      meta:{locs:locs.map(l=>l.name),nbOrders,from,to,lsAvailable:!!lsAgg,lsDaysCount:lsDays.length},
      kpis:{totalCA:totalCA_yk,ticket,totalAchats,achatFood,achatBev,nbOrders,caMonth},
      ratios:{fcGlobal,fcFood,fcBev,margeGlobale},
      byDay,byCat,topProds,split,
      recentOrders,
      settings,
      div:DIV
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
