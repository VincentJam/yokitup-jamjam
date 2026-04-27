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

const cache = {};
const CACHE_TTL = 60 * 60 * 1000;
function cacheGet(k){const e=cache[k];if(!e)return null;if(Date.now()-e.ts>CACHE_TTL){delete cache[k];return null;}return e.data;}
function cacheSet(k,d){cache[k]={ts:Date.now(),data:d};}
function cacheClearDashboard(){Object.keys(cache).filter(k=>k.startsWith('dashboard:')).forEach(k=>delete cache[k]);}

async function sbGet(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/store?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const data = await r.json();
    if (data && data[0]) return JSON.parse(data[0].value);
  } catch(e) { console.error('sbGet:', e.message); }
  return null;
}
async function sbSet(key, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/store`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value: JSON.stringify(value) })
    });
  } catch(e) { console.error('sbSet:', e.message); }
}

let lsStore = {};
let settings = { monthlyTarget: 0 };

function loadLocal() {
  try { if(fs.existsSync(STORE_PATH)) lsStore=JSON.parse(fs.readFileSync(STORE_PATH,'utf-8')); } catch(e) {}
  try { if(fs.existsSync(SETTINGS_PATH)) settings=JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf-8')); } catch(e) {}
}
async function loadStores() {
  loadLocal();
  const [sb1, sb2] = await Promise.all([sbGet('ls_store'), sbGet('settings')]);
  if (sb1) { lsStore = sb1; console.log('Store Supabase:', Object.keys(lsStore).length, 'jours'); }
  if (sb2) settings = sb2;
}
async function saveStores() {
  try { fs.writeFileSync(STORE_PATH,JSON.stringify(lsStore),'utf-8'); } catch(e) {}
  try { fs.writeFileSync(SETTINGS_PATH,JSON.stringify(settings),'utf-8'); } catch(e) {}
  await Promise.all([sbSet('ls_store', lsStore), sbSet('settings', settings)]);
}
loadStores();

const SOFT_COCKTAILS = ["lover's leap","lover leap","cockpit country","cockpit","calypso"];

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

function getHour(ds){if(!ds)return null;const p=ds.split(' ');return p[1]?parseInt(p[1].split(':')[0]):null;}

function aggregateLS(rows) {
  const byItem={}, byCat={}, byDay={};
  let totalHT=0, caFood=0, caBev=0, caCocktailAlc=0, caCocktailSoft=0, caAlcool=0, caSoft=0, caLikkaz=0;
  const midiOrders={}, soirOrders={};

  rows.forEach(r => {
    const ht=parseFloat(r.PreTax)||0;
    const qty=parseFloat(r.Qty)||1;
    const gs=(r.GroupeStatistique||'Autre').trim();
    const grp=(r.Group||'Autre').replace(/\(.*?\)/g,'').trim();
    const itemName=(r.Item||'').toLowerCase();
    const hour=getHour(r.Date);
    totalHT+=ht;

    if(r.Type==='SALE'&&r.Date){
      const key=r.Date;
      if(hour!==null&&hour<16){midiOrders[key]=(midiOrders[key]||0)+ht;}
      else if(hour!==null&&hour>=19){soirOrders[key]=(soirOrders[key]||0)+ht;}
    }

    if(!byItem[r.Item])byItem[r.Item]={name:r.Item,group:gs,category:grp,qty:0,ht:0};
    byItem[r.Item].qty+=qty; byItem[r.Item].ht+=ht;
    byCat[gs]=(byCat[gs]||0)+ht;

    const grpL=grp.toLowerCase();
    if(grpL.includes('cuisine')||grpL.includes('food'))caFood+=ht; else caBev+=ht;

    const gsL=gs.toLowerCase();
    if(gsL.includes('cocktail')){
      if(SOFT_COCKTAILS.some(s=>itemName.includes(s)))caCocktailSoft+=ht; else caCocktailAlc+=ht;
    }
    if(gsL.includes('likkaz'))caLikkaz+=ht;
    else if(gsL.includes('alcool')||gsL.includes('spiritueux'))caAlcool+=ht;
    if(gsL.includes('soft')||gsL.includes('sans alcool'))caSoft+=ht;

    if(r.Date){const p=r.Date.split(' ');if(p[0]){const dp=p[0].split('/');if(dp.length===3){const dk=`20${dp[2]}-${dp[1]}-${dp[0]}`;byDay[dk]=(byDay[dk]||0)+ht;}}}
  });

  const midiVals=Object.values(midiOrders), soirVals=Object.values(soirOrders);
  return {
    topItems: Object.values(byItem).sort((a,b)=>b.ht-a.ht).slice(0,15),
    byCat, byDay, totalHT,
    nbOrders: rows.filter(r=>r.Type==='SALE').length,
    split: {food:caFood,bev:caBev,cocktailAlc:caCocktailAlc,cocktailSoft:caCocktailSoft,alcool:caAlcool,soft:caSoft,likkaz:caLikkaz},
    cocktailDetail: Object.values(byItem).filter(i=>i.group.toLowerCase().includes('cocktail')).sort((a,b)=>b.ht-a.ht),
    tickets: {
      midi: midiVals.length>0?midiVals.reduce((s,v)=>s+v,0)/midiVals.length:null,
      soir: soirVals.length>0?soirVals.reduce((s,v)=>s+v,0)/soirVals.length:null,
      nbMidi: midiVals.length, nbSoir: soirVals.length
    },
    nbRows: rows.length, updatedAt: new Date().toISOString()
  };
}

function checkAuth(req,res,next){
  const auth=req.headers['authorization'];
  if(!auth||!auth.startsWith('Basic ')){res.set('WWW-Authenticate','Basic realm="Dashboard"');return res.status(401).send('Accès refusé');}
  const[,password]=Buffer.from(auth.slice(6),'base64').toString().split(':');
  if(password!==DASHBOARD_PASSWORD){res.set('WWW-Authenticate','Basic realm="Dashboard"');return res.status(401).send('Mot de passe incorrect');}
  next();
}

const YKH={'Authorization':'Bearer '+API_KEY,'Yokitup-Version':'2025-01-01','Content-Type':'application/json'};
async function ykFetch(url){const r=await fetch(url,{headers:YKH});if(!r.ok)throw new Error('YK '+r.status);return r.json();}
async function ykAll(p,params=''){
  const k='yk:'+p+params; const c=cacheGet(k); if(c)return c;
  let res=[],url=BASE+p+(params?'?'+params:'');
  while(url){const d=await ykFetch(url);res=res.concat(d.data||[]);const n=d.links?.next;url=(n&&n!==url)?n:null;}
  cacheSet(k,res); return res;
}

app.post('/upload/lightspeed', upload.single('file'), async (req,res) => {
  const secret=req.headers['x-upload-secret']||req.query.secret;
  if(secret!==UPLOAD_SECRET) return res.status(401).json({error:'Secret invalide'});
  if(!req.file) return res.status(400).json({error:'Aucun fichier'});
  try {
    const rows=parseCSV(req.file.buffer.toString('utf-8'));
    const agg=aggregateLS(rows);
    const days=Object.keys(agg.byDay);
    if(days.length===0)lsStore[new Date().toISOString().split('T')[0]]=agg;
    else days.forEach(d=>{lsStore[d]=agg;});
    await saveStores(); cacheClearDashboard();
    console.log('CSV LS:',rows.length,'lignes',days.join(', '));
    res.json({ok:true,rows:rows.length,days,totalHT:agg.totalHT});
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.get('/settings', checkAuth, (req,res) => res.json(settings));
app.post('/settings', checkAuth, express.json(), async (req,res) => {
  if(req.body.monthlyTarget!==undefined) settings.monthlyTarget=parseFloat(req.body.monthlyTarget)||0;
  await saveStores(); cacheClearDashboard();
  res.json({ok:true,settings});
});

app.get('/dashboard', checkAuth, async (req,res) => {
  const {from,to}=req.query;
  if(!from||!to) return res.status(400).json({error:'from/to required'});
  const ck='dashboard:'+from+':'+to;
  const cached=cacheGet(ck); if(cached) return res.json({...cached,cached:true});

  try {
    const dp=`date_from=${from}&date_to=${to}`;
    const now=new Date();
    const monthFrom=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const monthTo=now.toISOString().split('T')[0];
    const DIV=1000000000;

    const [locs,orders,delivNotes,prodTags,tags,monthOrders] = await Promise.all([
      ykAll('/locations'),
      ykAll('/pos_orders',dp),
      ykAll('/supplier_delivery_notes',dp).catch(()=>[]),
      ykAll('/product_tags').catch(()=>[]),
      ykAll('/tags').catch(()=>[]),
      ykAll('/pos_orders',`date_from=${monthFrom}&date_to=${monthTo}`).catch(()=>[])
    ]);

    const locMap={}; locs.forEach(l=>locMap[l.id]=l.name);
    const tagMap={}; tags.forEach(t=>tagMap[t.id]=(t.name||'').toLowerCase());
    const ptMap={}; prodTags.forEach(pt=>{if(!ptMap[pt.product_id])ptMap[pt.product_id]=[];if(tagMap[pt.tag_id])ptMap[pt.product_id].push(tagMap[pt.tag_id]);});

    const totalHT_yk=orders.reduce((s,o)=>s+parseInt(o.amount_excluding_tax||0),0)/DIV;
    const caMonthHT=monthOrders.reduce((s,o)=>s+parseInt(o.amount_excluding_tax||0),0)/DIV;
    const totalAchatsHT=delivNotes.reduce((s,d)=>s+parseInt(d.received_amount_excluding_tax||0),0)/DIV;

    const delivItems=await ykAll('/supplier_delivery_note_items').catch(()=>[]);
    const delivNoteIds=new Set(delivNotes.map(d=>d.id));
    let achatFood=0, achatBev=0;
    delivItems.filter(i=>delivNoteIds.has(i.supplier_delivery_note_id)).forEach(i=>{
      const amt=parseInt(i.received_amount_excluding_tax||0)/DIV;
      const tagStr=(ptMap[i.product_id]||[]).join(' ').toLowerCase();
      if(tagStr.includes('cuisine'))achatFood+=amt;
      else if(tagStr.includes('bar'))achatBev+=amt;
    });

    const byDay_yk={};
    orders.forEach(o=>{byDay_yk[o.date]=(byDay_yk[o.date]||0)+parseInt(o.amount_excluding_tax||0)/DIV;});
    const recentOrders=[...orders].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30)
      .map(o=>({date:o.date,loc:locMap[o.location_id]||'',amount:parseInt(o.amount_excluding_tax||0)/DIV}));

    const lsDays=Object.keys(lsStore).filter(d=>d>=from&&d<=to);
    let lsAgg=null;
    if(lsDays.length>0){
      const m={topItems:{},byCat:{},byDay:{},totalHT:0,nbOrders:0,
        split:{food:0,bev:0,cocktailAlc:0,cocktailSoft:0,alcool:0,soft:0,likkaz:0},
        cocktailDetail:{},tickets:{midiSum:0,midiCount:0,soirSum:0,soirCount:0}};
      lsDays.forEach(day=>{
        const ls=lsStore[day]; if(!ls)return;
        ls.topItems.forEach(item=>{
          if(!m.topItems[item.name])m.topItems[item.name]={...item,qty:0,ht:0};
          m.topItems[item.name].qty+=item.qty; m.topItems[item.name].ht+=item.ht;
        });
        Object.entries(ls.byCat).forEach(([k,v])=>{m.byCat[k]=(m.byCat[k]||0)+v;});
        Object.entries(ls.byDay).forEach(([k,v])=>{m.byDay[k]=(m.byDay[k]||0)+v;});
        m.totalHT+=ls.totalHT; m.nbOrders+=ls.nbOrders||0;
        Object.keys(ls.split).forEach(k=>{m.split[k]=(m.split[k]||0)+(ls.split[k]||0);});
        if(ls.cocktailDetail){ls.cocktailDetail.forEach(c=>{
          if(!m.cocktailDetail[c.name])m.cocktailDetail[c.name]={...c,qty:0,ht:0};
          m.cocktailDetail[c.name].qty+=c.qty; m.cocktailDetail[c.name].ht+=c.ht;
        });}
        if(ls.tickets){
          if(ls.tickets.midi!==null&&ls.tickets.nbMidi){m.tickets.midiSum+=ls.tickets.midi*ls.tickets.nbMidi;m.tickets.midiCount+=ls.tickets.nbMidi;}
          if(ls.tickets.soir!==null&&ls.tickets.nbSoir){m.tickets.soirSum+=ls.tickets.soir*ls.tickets.nbSoir;m.tickets.soirCount+=ls.tickets.nbSoir;}
        }
      });
      m.topItems=Object.values(m.topItems).sort((a,b)=>b.ht-a.ht).slice(0,12);
      m.cocktailDetail=Object.values(m.cocktailDetail).sort((a,b)=>b.ht-a.ht);
      lsAgg=m;
    }

    const useLS=!!lsAgg;
    const totalHT=useLS?lsAgg.totalHT:totalHT_yk;
    const byDay=useLS&&Object.keys(lsAgg.byDay).length>0?lsAgg.byDay:byDay_yk;
    const byCat=useLS?lsAgg.byCat:{};
    const topProds=useLS?lsAgg.topItems.map(p=>({name:p.name,qty:Math.round(p.qty),ht:p.ht,group:p.group})):[];
    const split=useLS?lsAgg.split:null;
    const cocktailDetail=useLS?lsAgg.cocktailDetail:[];
    const nbOrdersDisplay=useLS?lsAgg.nbOrders:orders.length;
    const ticketGlobal=nbOrdersDisplay>0?totalHT/nbOrdersDisplay:null;
    const ticketMidi=useLS&&lsAgg.tickets.midiCount>0?lsAgg.tickets.midiSum/lsAgg.tickets.midiCount:null;
    const ticketSoir=useLS&&lsAgg.tickets.soirCount>0?lsAgg.tickets.soirSum/lsAgg.tickets.soirCount:null;
    const caFood=split?split.food:0, caBev=split?split.bev:0;
    const fcGlobal=totalAchatsHT>0&&totalHT>0?(totalAchatsHT/totalHT*100):null;
    const fcFood=achatFood>0&&caFood>0?(achatFood/caFood*100):null;
    const fcBev=achatBev>0&&caBev>0?(achatBev/caBev*100):null;
    const margeGlobale=totalHT>0&&totalAchatsHT>=0?((totalHT-totalAchatsHT)/totalHT*100):null;

    const payload={
      meta:{locs:locs.map(l=>l.name),from,to,lsAvailable:useLS},
      kpis:{totalHT,ticketGlobal,ticketMidi,ticketSoir,totalAchats:totalAchatsHT,achatFood,achatBev,nbOrders:nbOrdersDisplay,caMonth:caMonthHT},
      ratios:{fcGlobal,fcFood,fcBev,margeGlobale},
      byDay,byCat,topProds,split,cocktailDetail,recentOrders,settings
    };
    cacheSet(ck,payload);
    res.json(payload);
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.get('/cache/clear',checkAuth,(req,res)=>{Object.keys(cache).forEach(k=>delete cache[k]);res.json({ok:true});});
app.use(checkAuth);
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/*',async(req,res)=>{
  const endpoint=req.path.replace('/api','');
  const query=req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'';
  try{const r=await fetch(BASE+endpoint+query,{headers:YKH});res.json(await r.json());}
  catch(e){res.status(500).json({error:e.message});}
});
app.listen(PORT,()=>console.log('Dashboard running on port '+PORT));
