// ABEL FX ORDERBOOK v4.0 - SPOT ALA STREAMLIT
// Base: server.js V3.4 + app.py Streamlit lo
// Pair: XAUT = XAUUSD | Entry +3 | SL -3 | Emergency -6 | TP1/TP2 | Partial 50/50 | Re-Entry A | Warm-up 30m
// UPDATE v4.0:
// - BUANG Gate, GANTI Binance Spot (kayak Streamlit, likuiditasnya jauh lebih tebel)
// - BUANG filter 2/3 exchange, BUANG betah 3 menit, BUANG avg*2.5, BUANG grouping 4$
// - CARA BARU: Gabung round 0.1, hitung Heat, Zona Heat > 15 = Level (kayak heatmap Streamlit)
// - BUANG Yahoo GC=F (FUTURES), ganti goldprice.dev XAU-USD-SPOT (SPOT MURNI kayak Streamlit)
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

// Heatmap history ala Streamlit - 40 snapshot terakhir
let heatHistory = { times: [], price_map: {} };

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

// === HARGA XAUUSD - SPOT MURNI ALA STREAMLIT, NO FUTURES ===
// Streamlit lo pake: goldprice.dev XAU-USD-SPOT -> gold-api.com
// GAK ADA Yahoo GC=F lagi. GC=F itu futures, itu yang bikin selisih loncat.
async function fetchGoldPrice(){
  const sources = [
    { name: 'goldprice.dev SPOT', url: 'https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT', parse: (d) => (d.symbols && d.symbols[0] && d.symbols[0].price) ? parseFloat(d.symbols[0].price) : null },
    { name: 'gold-api.com SPOT', url: 'https://api.gold-api.com/price/XAU', parse: (d) => d.price ? parseFloat(d.price) : null },
    { name: 'goldprice.org SPOT', url: 'https://data-asg.goldprice.org/dbXRates/USD', parse: (d) => { const item = d.items?.[0]; return (item && item.curr === 'XAU' && item.ask) ? parseFloat(item.ask) : null; } }
  ];
  for(let s of sources){
    try{
      const res = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept': 'application/json' } });
      const text = await res.text();
      if(!text.trim().startsWith('{')) continue;
      const data = JSON.parse(text);
      const price = s.parse(data);
      if(price && price > 1000 && price < 10000){
        if(xauusdPrice !== price) console.log(`GOLD OK dari ${s.name}: ${price}`);
        xauusdPrice = price;
        lastGoldSource = s.name;
        lastGoldFetch = Date.now();
        return;
      }
    }catch(e){ console.log(`Goldprice ${s.name} gagal:`, e.message); }
  }
  console.log('Semua sumber gold gagal, pake harga terakhir:', xauusdPrice);
}

// === FETCH SPOT ALA STREAMLIT - OKX + BINANCE + BYBIT ===
// Streamlit: OKX sz=400, Binance depth 100, Bybit spot limit=50
// Di sini gue naikin dikit biar full depth, tapi cara bacanya SAMA PERSIS kayak Streamlit
async function fetchOKX(){
  try{
    // OKX SPOT - instId XAUT-USDT (tanpa -SWAP, jadi SPOT murni)
    const res = await fetch('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=400');
    const data = await res.json();
    if(!data.data || !data.data[0]) return null;
    const d = data.data[0];
    return { bids: d.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: d.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}
async function fetchBinance(){
  // BINANCE SPOT - ini pengganti Gate. Endpoint /api/v3/depth itu SPOT, bukan futures.
  // Futures Binance itu di fapi.binance.com, bukan api.binance.com. Jadi ini murni SPOT.
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
    // BYBIT SPOT - category=spot, BUKAN linear / futures
    const res = await fetch('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=500');
    const data = await res.json();
    if(!data.result || !data.result.b || !data.result.a) return null;
    return { bids: data.result.b.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: data.result.a.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}

async function fetchOrderbook(){
  try{
    const [okx, binance, byb] = await Promise.all([fetchOKX(), fetchBinance(), fetchBybit()]);
    const sources = { okx: !!okx, binance: !!binance, bybit: !!byb };
    lastSources = sources;
    const active = [okx, binance, byb].filter(Boolean);
    if(active.length===0){ console.log('Semua exchange kosong, skip'); return; }

    let mids = [];
    active.forEach(ex=>{
      if(ex.bids[0] && ex.asks[0]) mids.push((ex.bids[0].price + ex.asks[0].price)/2);
    });
    if(mids.length>0) xautMid = mids.reduce((a,b)=>a+b,0)/mids.length;
    if(xauusdPrice>0) selisih = xautMid - xauusdPrice;

    // === CARA STREAMLIT: GABUNG SEMUA, ROUND 0.1, JUMLAH SIZE ===
    // Beda sama V3.4 yang harus 2/3 exchange + grouping 4$.
    // Di sini: kalau ada harga yang sama (dibulatkan 0.1), size-nya dijumlah. Udah. Gak ada syarat lain.
    // Makanya levelnya BANYAK dan SERING KE-HIT, kayak heatmap Streamlit lo.
    let mergedMap = {}; // key: price_rounded_side -> { price, size, sources:Set }
    const exNames = ['OKX','BINANCE','BYBIT'];
    [okx, binance, byb].forEach((ex, idx)=>{
      if(!ex) return;
      [...ex.bids, ...ex.asks].forEach(w=>{
        const rounded = Math.round(w.price * 10) / 10; // round 0.1 kayak Streamlit: round(p,1)
        const key = `${w.side}-${rounded.toFixed(1)}`;
        if(!mergedMap[key]) mergedMap[key] = { price: rounded, side: w.side, size: 0, sources: new Set() };
        mergedMap[key].size += w.size;
        mergedMap[key].sources.add(exNames[idx]);
      });
    });

    let allLevels = Object.values(mergedMap);
    // Filter cuma yang masih deket harga: +/- 10% dari mid, kayak heatmap Streamlit
    // Biar gak berat, tapi tetep jauh lebih luas dari V3.4
    allLevels = allLevels.filter(w => Math.abs(w.price - xautMid) < xautMid * 0.10);

    const avg = allLevels.length ? allLevels.reduce((s,w)=>s+w.size,0) / allLevels.length : 0;
    lastAvg = avg;

    // === HEATMAP ALA STREAMLIT: HEAT = SIZE / AVG ===
    // Di Streamlit lo, Zona Heat > 15 yang ditandain sebagai Zona Likuiditas Tinggi.
    // Di sini gue pake rumus yang sama. Heat gede = tembok gede.
    // Tapi gak dibuang kalau Heat kecil. Semua tetep ditampilin, cuma yang Heat > 15 yang jadi kandidat sinyal.
    let confirmed = allLevels.map(w=>{
      const heat = avg > 0 ? w.size / avg : 0;
      return {
        price: Math.floor(w.price*100)/100,
        side: w.side,
        size: Math.floor(w.size*10000)/10000,
        score: Math.floor(heat*10)/10,
        heat: Math.floor(heat*10)/10,
        sources: [...w.sources].join('+'),
        sourceCount: w.sources.size,
        is_heat_zone: heat > 15 // Zona Heat > 15 kayak Streamlit
      };
    });

    // Urutin: BID tinggi ke rendah, ASK rendah ke tinggi
    confirmed.sort((a,b)=> a.side==='BID' ? b.price - a.price : a.price - b.price);

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

    // === BEDANYA SAMA V3.4: STABIL = HEAT ZONE, BUKAN BETAH 3 MENIT ===
    // V3.4: stable = age >= 3 menit -> bikin sinyal jarang
    // V4.0 ala Streamlit: stable = Heat > 15 -> langsung bisa jadi sinyal, gak perlu nunggu 3 menit
    // Makanya levelnya sering ke-hit kayak Streamlit
    const stableWalls = confirmed.filter(w=> w.is_heat_zone);
    walls = confirmed;
    walls._stable = stableWalls;
    lastFetch = Date.now();
    for(let w of walls.slice(0,3)) await saveToSupabase(w);
    console.log(`3EX SPOT [OKX:${sources.okx?'OK':'X'} BIN:${sources.binance?'OK':'X'} BYB:${sources.bybit?'OK':'X'}] Avg:${avg.toFixed(4)} | Level:${walls.length} HeatZone:${stableWalls.length} | Jauh:${walls.filter(w=>w.is_far).length} | Range:${walls.length?Math.min(...walls.map(w=>w.price)).toFixed(0)+'-'+Math.max(...walls.map(w=>w.price)).toFixed(0):'-'} | XAUT:${xautMid.toFixed(2)} XAUUSD:${xauusdPrice.toFixed(2)} (${lastGoldSource}) Selisih:${selisih.toFixed(2)} | LOCK:${lockedSignal?lockedSignal.signal:'-'}`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

function buildSignal(){
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  if(uptime_menit < 30) return { signal:'WAIT', reason:`PEMANASAN ${uptime_menit}/30 menit - Kumpulin data dulu, jangan trigger`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null };

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
      console.log(`AUTO UNLOCK - ${hit} | Harga: ${cur} | Sinyal: ${lockedSignal.signal}`);
      lastDone = { ...lockedSignal, signal: 'DONE', reason: `${hit} - Harga XAUUSD ${cur.toFixed(2)} - Lock dibuka, nyari sinyal baru...`, is_locked: false, last_result: hit };
      lockedSignal = null;
      lockedWallGoneSince = 0;
      return { ...lastDone, auto_unlocked: true };
    }

    const wallStillThere = walls.find(w=> w.side === (lockedSignal.signal==='BUY'?'BID':'ASK') && Math.abs(w.price - lockedSignal.wall) <= 2.0);
    if(!wallStillThere){
      if(!lockedWallGoneSince) lockedWallGoneSince = Date.now();
      if(Date.now() - lockedWallGoneSince > 5*60*1000){
        console.log('LOCK DIBATALKAN - Level hilang >5 menit');
        lockedSignal = null;
        lockedWallGoneSince = 0;
      } else {
        return { ...lockedSignal, lock_status: `LOCKED - Level goyang, tunggu ${Math.floor((5*60*1000 - (Date.now()-lockedWallGoneSince))/1000)}s lagi`, is_locked: true };
      }
    } else {
      lockedWallGoneSince = 0;
      return { ...lockedSignal, is_locked: true, lock_status: 'LOCKED - Sinyal dikunci, jangan ganti-ganti', lock_age_menit: Math.floor((Date.now()-lockedSignal.lockedAt)/60000), current_xauusd: cur };
    }
  }

  if(stableWalls.length===0) return { signal:'WAIT', reason:'Belum ada Zona Heat > 15 (ala Streamlit) yang ke-detect', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };
  const bidWalls = [...stableWalls].filter(w=>w.side==='BID').sort((a,b)=>b.price-a.price);
  const askWalls = [...stableWalls].filter(w=>w.side==='ASK').sort((a,b)=>a.price-b.price);
  if(bidWalls.length===0 || askWalls.length===0) return { signal:'WAIT', reason:'Zona Heat satu sisi doang, skip', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };
  const mid = (bidWalls[0].price + askWalls[0].price) / 2;
  // Cari yang paling deket sama harga, kayak Streamlit yang levelnya nempel harga
  // V3.4 nyari yang 5-15$ jauhnya. V4.0 nyari yang paling deket, biar sering ke-hit.
  const nearestBid = bidWalls.sort((a,b)=> Math.abs(mid - a.price) - Math.abs(mid - b.price))[0];
  const nearestAsk = askWalls.sort((a,b)=> Math.abs(a.price - mid) - Math.abs(mid - b.price))[0];

  let newSignal = null;
  if(nearestBid.score >= nearestAsk.score){
    const wall = nearestBid;
    const entry = wall.price + 3;
    const sl = wall.price - 3;
    const emergency_sl = wall.price - 6;
    const tp1 = nearestAsk.price - 3;
    const tp2 = (askWalls[askWalls.length-1]?.price || nearestAsk.price) - 3;
    const backup = bidWalls[bidWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price + 3, sl: backup.price - 3, wall: backup.price, entry_mt5: (backup.price + 3) - selisih, sl_mt5: (backup.price - 3) - selisih } : null;
    newSignal = { signal:'BUY', reason:`SPOT Heat Zone BID ${wall.price} size ${wall.size} XAUT (Heat ${wall.heat}x avg) [${wall.sources}] | Jarak ${Math.abs(mid - wall.price).toFixed(1)}$ dari harga | TP1 depan ASK ${nearestAsk.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  } else {
    const wall = nearestAsk;
    const entry = wall.price - 3;
    const sl = wall.price + 3;
    const emergency_sl = wall.price + 6;
    const tp1 = nearestBid.price + 3;
    const tp2 = (bidWalls[bidWalls.length-1]?.price || nearestBid.price) + 3;
    const backup = askWalls[askWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price - 3, sl: backup.price + 3, wall: backup.price, entry_mt5: (backup.price - 3) - selisih, sl_mt5: (backup.price + 3) - selisih } : null;
    newSignal = { signal:'SELL', reason:`SPOT Heat Zone ASK ${wall.price} size ${wall.size} XAUT (Heat ${wall.heat}x avg) [${wall.sources}] | Jarak ${Math.abs(wall.price - mid).toFixed(1)}$ dari harga | TP1 depan BID ${nearestBid.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
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

app.get('/', (req,res)=> res.send('ABEL FX ORDERBOOK v4.0 SPOT ALA STREAMLIT jalan!'));
app.get('/api/health', (req,res)=> res.json({ status: 'ok', uptime_menit: Math.floor((Date.now()-startTime)/60000) }));
app.get('/api/unlock', (req,res)=>{ lockedSignal = null; lockedWallGoneSince = 0; res.json({ ok:true, msg:'Lock dibatalkan manual' }); });
app.get('/api/signal', (req,res)=>{
  const s = buildSignal();
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  const wallsNear = walls.filter(w=> !w.is_far);
  const wallsFar = walls.filter(w=> w.is_far);
  const allPrices = walls.map(w=>w.price);
  res.json({ ...s, pair: 'XAUT = XAUUSD MT5', exchanges: lastSources, avg_xaut: lastAvg,
    walls: walls.slice(0,50),
    wallsNear: wallsNear.slice(0,10),
    wallsFar: wallsFar,
    wallsFarCount: wallsFar.length,
    range: walls.length ? { low: Math.min(...allPrices), high: Math.max(...allPrices) } : { low: 0, high: 0 },
    uptime_menit, supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET', last_update: new Date(lastFetch).toISOString(), last_done: lastDone,
    harga: { xaut_mid: Math.floor(xautMid*100)/100, xauusd_goldprice: Math.floor(xauusdPrice*100)/100, selisih: Math.floor(selisih*100)/100, selisih_text: selisih>=0? `XAUT +${selisih.toFixed(2)}$ lebih mahal` : `XAUT ${selisih.toFixed(2)}$ lebih murah`, last_gold_update: new Date(lastGoldFetch).toISOString(), source: lastGoldSource },
    rules: 'V4.0 SPOT ALA STREAMLIT: OKX Spot + Binance Spot + Bybit Spot, Gabung round 0.1, Heat > 15 = Zona, NO 2/3, NO betah 3m, NO grouping 4$, NO GC=F Futures, Entry +3 | SL -3 | Emergency -6 | TP1/TP2 | Partial 50/50 | Re-Entry A | Warm-up 30m'
  });
});

app.listen(PORT, ()=> console.log(`ABEL FX ORDERBOOK v4.0 SPOT ALA STREAMLIT jalan di port ${PORT}`));
