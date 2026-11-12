// ABEL FX ORDERBOOK v4.2 - BOOKMAP + PENDING ORDER + JAM SINYAL
// Base: V4.1 BOOKMAP SIZE ONLY - NO grouping jarak
// UPDATE V4.2 (buat nyambung ke index.html baru):
// 1. Tambah pendingOrders di /api/signal (6 big order terbesar + status PENDING / TERSENTUH + instruksi BUY/SELL)
// 2. Tambah signal_started_at + signal_age di /api/signal (buat jam sinyal aktif di frontend)
// 3. Tambah touchedLevels (level pending yang udah kesentuh, pindahan ke sinyal aktif)
// LOGIKA LAINNYA SAMA PERSIS KAYAK V4.1: Spot OKX+Binance+Bybit, Filter SIZE doang, NO grouping jarak
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let walls = [];
let lastFetch = 0;
let startTime = Date.now();
let lastAvg = 0;
let lastSources = {};

let xauusdPrice = 0;
let xautMid = 0;
let selisih = 0;
let lastGoldFetch = 0;
let lastGoldSource = '-';

let wallFirstSeen = {};
let lockedSignal = null;
let lockedWallGoneSince = 0;
let lastDone = null;

async function saveToSupabase(wall){
  if(!SUPABASE_URL || !SUPABASE_KEY) return;
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/walls`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ price: wall.price, side: wall.side, size: wall.size, score: wall.score || 0 })
    });
  }catch(e){ console.log('Supabase save gagal:', e.message); }
}

async function fetchGoldPrice(){
  const sources = [
    { name: 'goldprice.dev SPOT', url: 'https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT', parse: (d) => (d.symbols && d.symbols[0] && d.symbols[0].price) ? parseFloat(d.symbols[0].price) : null },
    { name: 'gold-api.com SPOT', url: 'https://api.gold-api.com/price/XAU', parse: (d) => d.price ? parseFloat(d.price) : null },
    { name: 'goldprice.org SPOT', url: 'https://data-asg.goldprice.org/dbXRates/USD', parse: (d) => { const item = d.items?.[0]; return (item && item.curr === 'XAU' && item.ask) ? parseFloat(item.ask) : null; } }
  ];
  for(let s of sources){
    try{
      const res = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      const text = await res.text();
      if(!text.trim().startsWith('{')) continue;
      const data = JSON.parse(text);
      const price = s.parse(data);
      if(price && price > 1000 && price < 10000){
        xauusdPrice = price;
        lastGoldSource = s.name;
        lastGoldFetch = Date.now();
        return;
      }
    }catch(e){}
  }
}

async function fetchOKX(){
  try{
    const res = await fetch('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=400');
    const data = await res.json();
    if(!data.data || !data.data[0]) return null;
    const d = data.data[0];
    return { bids: d.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: d.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}
async function fetchBinance(){
  const urls = [
    'https://api.binance.com/api/v3/depth?symbol=XAUTUSDT&limit=500',
    'https://api1.binance.com/api/v3/depth?symbol=XAUTUSDT&limit=500',
    'https://data-api.binance.vision/api/v3/depth?symbol=XAUTUSDT&limit=500'
  ];
  for(let url of urls){
    try{
      const res = await fetch(url);
      const data = await res.json();
      if(!data.bids || !data.asks) continue;
      return { bids: data.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: data.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
    }catch(e){ continue; }
  }
  return null;
}
async function fetchBybit(){
  try{
    const res = await fetch('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=500');
    const data = await res.json();
    if(!data.result || !data.result.b || !data.result.a) return null;
    return { bids: data.result.b.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: data.result.a.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}

// === BARU V4.2: HITUNG PENDING ORDER DI SERVER ===
// Ambil dari walls yang udah ke-filter SIZE gede (Bookmap).
// Urut size terbesar, ambil 6 teratas.
// BID = BUY, ASK = SELL.
// PENDING = jarak MT5 ke harga sekarang > 3$. TERSENTUH = jarak <= 3$.
function buildPendingOrders(){
  if(!walls.length || !xauusdPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 6);
  const pending = [];
  const touched = [];
  sorted.forEach(w=>{
    const mt5 = w.price_mt5 || (w.price - selisih);
    const jarak = Math.abs(mt5 - xauusdPrice);
    const isTouched = jarak <= 3;
    const item = {
      ...w,
      price_mt5: Math.floor(mt5*100)/100,
      instruction: w.side === 'BID' ? 'BUY' : 'SELL',
      status: isTouched ? 'TERSENTUH' : 'PENDING',
      distance_mt5: Math.floor(jarak*100)/100,
      notional: Math.floor(w.size * w.price)
    };
    if(isTouched) touched.push(item);
    else pending.push(item);
  });
  return { pending, touched };
}

async function fetchOrderbook(){
  try{
    const [okx, binance, byb] = await Promise.all([fetchOKX(), fetchBinance(), fetchBybit()]);
    const sources = { okx: !!okx, binance: !!binance, bybit: !!byb };
    lastSources = sources;
    const active = [okx, binance, byb].filter(Boolean);
    if(active.length===0) return;

    let mids = [];
    active.forEach(ex=>{ if(ex.bids[0] && ex.asks[0]) mids.push((ex.bids[0].price + ex.asks[0].price)/2); });
    if(mids.length>0) xautMid = mids.reduce((a,b)=>a+b,0)/mids.length;
    if(xauusdPrice>0) selisih = xautMid - xauusdPrice;

    // BOOKMAP: NO GROUPING JARAK - cuma gabung kalau harga PERSIS SAMA
    let mergedMap = {};
    const exNames = ['OKX','BINANCE','BYBIT'];
    [okx, binance, byb].forEach((ex, idx)=>{
      if(!ex) return;
      [...ex.bids, ...ex.asks].forEach(w=>{
        const key = `${w.side}-${w.price.toFixed(2)}`;
        if(!mergedMap[key]) mergedMap[key] = { price: w.price, side: w.side, size: 0, sources: new Set() };
        mergedMap[key].size += w.size;
        mergedMap[key].sources.add(exNames[idx]);
      });
    });

    let allLevels = Object.values(mergedMap);
    const avg = allLevels.length ? allLevels.reduce((s,w)=>s+w.size,0) / allLevels.length : 0;
    lastAvg = avg;

    // FILTER SIZE DOANG
    let confirmed = [];
    allLevels.forEach(w=>{
      if(w.size < avg * 2.5) return;
      const score = avg > 0 ? w.size / avg : 0;
      confirmed.push({
        price: Math.floor(w.price*100)/100,
        side: w.side,
        size: Math.floor(w.size*10000)/10000,
        score: Math.floor(score*10)/10,
        heat: Math.floor(score*10)/10,
        sources: [...w.sources].join('+'),
        sourceCount: w.sources.size
      });
    });

    confirmed.sort((a,b)=> b.size - a.size);

    const now = Date.now();
    const newSeen = {};
    confirmed.forEach(w=>{
      const key = `${w.side}-${Math.round(w.price)}`;
      const first = wallFirstSeen[key] || now;
      newSeen[key] = first;
      w.age_menit = Math.floor((now - first)/60000);
      w.age_detik = Math.floor((now - first)/1000);
      w.firstSeen = first;
      w.price_mt5 = Math.floor((w.price - selisih)*100)/100;
      w.price_xaut = Math.floor(w.price*100)/100;
      w.distance = Math.abs(w.price - xautMid);
      w.is_far = w.distance >= 20;
    });
    wallFirstSeen = newSeen;

    walls = confirmed;
    walls._stable = confirmed;
    lastFetch = Date.now();
    for(let w of walls.slice(0,3)) await saveToSupabase(w);
    console.log(`3EX SPOT BOOKMAP [OKX:${sources.okx?'OK':'X'} BIN:${sources.binance?'OK':'X'} BYB:${sources.bybit?'OK':'X'}] Avg:${avg.toFixed(4)} | BigOrder:${walls.length} | XAUT:${xautMid.toFixed(2)} XAUUSD:${xauusdPrice.toFixed(2)} (${lastGoldSource}) Selisih:${selisih.toFixed(2)} | LOCK:${lockedSignal?lockedSignal.signal:'-'}`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

function buildSignal(){
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  if(uptime_menit < 30) return { signal:'WAIT', reason:`PEMANASAN ${uptime_menit}/30 menit`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null };

  const stableWalls = walls._stable || walls;

  if(lockedSignal){
    const cur = xauusdPrice;
    let hit = null;
    if(cur > 0){
      if(lockedSignal.signal === 'BUY'){
        if(cur >= lockedSignal.tp2_mt5) hit = 'TP2 KENA ✅';
        else if(cur >= lockedSignal.tp1_mt5) hit = 'TP1 KENA ✅';
        else if(cur <= lockedSignal.emergency_sl_mt5) hit = 'EMERGENCY SL KENA ❌';
        else if(cur <= lockedSignal.sl_mt5) hit = 'SL KENA ❌';
      } else if(lockedSignal.signal === 'SELL'){
        if(cur <= lockedSignal.tp2_mt5) hit = 'TP2 KENA ✅';
        else if(cur <= lockedSignal.tp1_mt5) hit = 'TP1 KENA ✅';
        else if(cur >= lockedSignal.emergency_sl_mt5) hit = 'EMERGENCY SL KENA ❌';
        else if(cur >= lockedSignal.sl_mt5) hit = 'SL KENA ❌';
      }
    }
    if(hit){
      lastDone = { ...lockedSignal, signal: 'DONE', reason: `${hit} - Harga XAUUSD ${cur.toFixed(2)}`, is_locked: false, last_result: hit };
      lockedSignal = null;
      lockedWallGoneSince = 0;
      return { ...lastDone, auto_unlocked: true };
    }
    const wallStillThere = walls.find(w=> w.side === (lockedSignal.signal==='BUY'?'BID':'ASK') && Math.abs(w.price - lockedSignal.wall) <= 2.0);
    if(!wallStillThere){
      if(!lockedWallGoneSince) lockedWallGoneSince = Date.now();
      if(Date.now() - lockedWallGoneSince > 5*60*1000){ lockedSignal = null; lockedWallGoneSince = 0; }
      else { return { ...lockedSignal, lock_status: `LOCKED - Level goyang`, is_locked: true }; }
    } else {
      lockedWallGoneSince = 0;
      // BARU V4.2: balikin lockedAt + jam mulai, biar frontend bisa hitung telat berapa menit
      return { ...lockedSignal, is_locked: true, lock_status: 'LOCKED - Sinyal dikunci', lock_age_menit: Math.floor((Date.now()-lockedSignal.lockedAt)/60000), current_xauusd: cur, signal_started_at: lockedSignal.lockedAt, signal_age_menit: Math.floor((Date.now()-lockedSignal.lockedAt)/60000) };
    }
  }

  if(stableWalls.length===0) return { signal:'WAIT', reason:'Belum ada BIG ORDER (size > 2.5x avg)', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };
  const bidWalls = [...stableWalls].filter(w=>w.side==='BID').sort((a,b)=>b.size-a.size);
  const askWalls = [...stableWalls].filter(w=>w.side==='ASK').sort((a,b)=>b.size-a.size);
  if(bidWalls.length===0 || askWalls.length===0) return { signal:'WAIT', reason:'Big order satu sisi doang', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };

  const biggestBid = bidWalls[0];
  const biggestAsk = askWalls[0];

  let newSignal = null;
  if(biggestBid.size >= biggestAsk.size){
    const wall = biggestBid;
    const entry = wall.price + 3;
    const sl = wall.price - 3;
    const emergency_sl = wall.price - 6;
    const tp1 = biggestAsk.price - 3;
    const tp2 = (askWalls[askWalls.length-1]?.price || biggestAsk.price) - 3;
    const backup = bidWalls[1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price + 3, sl: backup.price - 3, wall: backup.price, entry_mt5: (backup.price + 3) - selisih, sl_mt5: (backup.price - 3) - selisih } : null;
    newSignal = { signal:'BUY', reason:`BOOKMAP: BIG ORDER BID ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) [${wall.sources}] | ASK terbesar ${biggestAsk.price} size ${biggestAsk.size} XAUT`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  } else {
    const wall = biggestAsk;
    const entry = wall.price - 3;
    const sl = wall.price + 3;
    const emergency_sl = wall.price + 6;
    const tp1 = biggestBid.price + 3;
    const tp2 = (bidWalls[bidWalls.length-1]?.price || biggestBid.price) + 3;
    const backup = askWalls[1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price - 3, sl: backup.price + 3, wall: backup.price, entry_mt5: (backup.price - 3) - selisih, sl_mt5: (backup.price + 3) - selisih } : null;
    newSignal = { signal:'SELL', reason:`BOOKMAP: BIG ORDER ASK ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) [${wall.sources}] | BID terbesar ${biggestBid.price} size ${biggestBid.size} XAUT`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  }

  newSignal.entry_mt5 = newSignal.entry - selisih;
  newSignal.sl_mt5 = newSignal.sl - selisih;
  newSignal.emergency_sl_mt5 = newSignal.emergency_sl - selisih;
  newSignal.tp1_mt5 = newSignal.tp1 - selisih;
  newSignal.tp2_mt5 = newSignal.tp2 - selisih;
  newSignal.wall_mt5 = newSignal.wall - selisih;

  lockedSignal = { ...newSignal, lockedAt: Date.now(), is_locked: true, lock_status: 'LOCKED - Baru dikunci' };
  return lockedSignal;
}

setInterval(fetchOrderbook, 2000);
setInterval(fetchGoldPrice, 5000);
fetchOrderbook();
fetchGoldPrice();

app.get('/', (req,res)=> res.send('ABEL FX ORDERBOOK v4.2 BOOKMAP + PENDING jalan!'));
app.get('/api/health', (req,res)=> res.json({ status: 'ok', uptime_menit: Math.floor((Date.now()-startTime)/60000) }));
app.get('/api/unlock', (req,res)=>{ lockedSignal = null; lockedWallGoneSince = 0; res.json({ ok:true, msg:'Lock dibatalkan manual' }); });
app.get('/api/signal', (req,res)=>{
  const s = buildSignal();
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  const wallsNear = walls.filter(w=> !w.is_far);
  const wallsFar = walls.filter(w=> w.is_far);
  const allPrices = walls.map(w=>w.price);

  // === BARU V4.2: PENDING + TOUCHED + JAM SINYAL ===
  const { pending, touched } = buildPendingOrders();
  const signal_started_at = lockedSignal ? lockedSignal.lockedAt : (s.lockedAt || null);
  const signal_age_menit = signal_started_at ? Math.floor((Date.now() - signal_started_at)/60000) : 0;
  const signal_age_detik = signal_started_at ? Math.floor((Date.now() - signal_started_at)/1000) % 60 : 0;

  res.json({ ...s,
    pair: 'XAUT = XAUUSD MT5', exchanges: lastSources, avg_xaut: lastAvg,
    walls: walls.slice(0,50),
    wallsNear: wallsNear.slice(0,10),
    wallsFar: wallsFar,
    wallsFarCount: wallsFar.length,
    // INI YANG DIPAKE FRONTEND BARU - JANGAN DIHAPUS
    pendingOrders: pending,
    pendingCount: pending.length,
    touchedLevels: touched,
    touchedCount: touched.length,
    signal_started_at,
    signal_age_menit,
    signal_age_detik,
    signal_age_text: signal_started_at ? `${signal_age_menit}m ${signal_age_detik}d` : '-',
    range: walls.length ? { low: Math.min(...allPrices), high: Math.max(...allPrices) } : { low: 0, high: 0 },
    uptime_menit, supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET', last_update: new Date(lastFetch).toISOString(), last_done: lastDone,
    harga: { xaut_mid: Math.floor(xautMid*100)/100, xauusd_goldprice: Math.floor(xauusdPrice*100)/100, selisih: Math.floor(selisih*100)/100, selisih_text: selisih>=0? `XAUT +${selisih.toFixed(2)}$ lebih mahal` : `XAUT ${selisih.toFixed(2)}$ lebih murah`, last_gold_update: new Date(lastGoldFetch).toISOString(), source: lastGoldSource },
    rules: 'V4.2 BOOKMAP: NO grouping jarak, Filter SIZE doang, Pending Order 6 terbesar, Sinyal = Big Order terbesar, Jam Sinyal Aktif'
  });
});

app.listen(PORT, ()=> console.log(`ABEL FX ORDERBOOK v4.2 BOOKMAP + PENDING jalan di port ${PORT}`));
