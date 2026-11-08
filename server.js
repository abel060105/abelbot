// ABEL BOT v3.2 - LOCK AUTO-UNLOCK + SELISIH + LEVEL ORDERBOOK - FINAL
// Pair: XAUT = XAUUSD | Konfirmasi 2/3 | Entry +3 | SL -3 | Emergency -6 | TP1/TP2 | Partial 50/50 | Re-Entry A | Warm-up 30m
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
  try{
    const res = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    const data = await res.json();
    const item = data.items?.[0];
    if(item && item.curr === 'XAU' && item.ask){
      xauusdPrice = parseFloat(item.ask);
      lastGoldFetch = Date.now();
    }
  }catch(e){ console.log('Goldprice gagal:', e.message); }
}

async function fetchBybit(){
  try{
    const res = await fetch('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=100');
    const data = await res.json();
    if(!data.result || !data.result.b || !data.result.a) return null;
    return { bids: data.result.b.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: data.result.a.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}
async function fetchOKX(){
  try{
    const res = await fetch('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=100');
    const data = await res.json();
    if(!data.data || !data.data[0]) return null;
    const d = data.data[0];
    return { bids: d.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: d.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}
async function fetchGate(){
  try{
    const res = await fetch('https://api.gateio.ws/api/v4/spot/order_book?currency_pair=XAUT_USDT&limit=100');
    const data = await res.json();
    if(!data.bids || !data.asks) return null;
    return { bids: data.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'})), asks: data.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'})) };
  }catch(e){ return null; }
}

async function fetchOrderbook(){
  try{
    const [byb, okx, gate] = await Promise.all([fetchBybit(), fetchOKX(), fetchGate()]);
    const sources = { bybit: !!byb, okx: !!okx, gate: !!gate };
    lastSources = sources;
    const active = [byb, okx, gate].filter(Boolean);
    if(active.length===0){ console.log('Semua exchange kosong, skip'); return; }

    let mids = [];
    active.forEach(ex=>{
      if(ex.bids[0] && ex.asks[0]) mids.push((ex.bids[0].price + ex.asks[0].price)/2);
    });
    if(mids.length>0) xautMid = mids.reduce((a,b)=>a+b,0)/mids.length;
    if(xauusdPrice>0) selisih = xautMid - xauusdPrice;

    let allLevels = [];
    active.forEach(ex=>{ allLevels.push(...ex.bids.slice(0,30), ...ex.asks.slice(0,30)); });
    const avg = allLevels.reduce((s,w)=>s+w.size,0) / allLevels.length;
    lastAvg = avg;

    let candidates = [];
    const exNames = ['BYBIT','OKX','GATE'];
    [byb, okx, gate].forEach((ex, idx)=>{
      if(!ex) return;
      [...ex.bids, ...ex.asks].forEach(w=>{
        if(w.size > avg * 2.5) candidates.push({...w, source: exNames[idx]});
      });
    });

    let confirmed = [];
    candidates.forEach(c=>{
      const others = candidates.filter(o=> o.side===c.side && o.source!==c.source && Math.abs(o.price - c.price) <= 1.0);
      const uniqueSources = new Set([c.source, ...others.map(o=>o.source)]);
      if(uniqueSources.size >= 2){
        const exists = confirmed.find(x=> x.side===c.side && Math.abs(x.price - c.price) <= 1.0);
        if(!exists){
          const totalSize = c.size + others.reduce((s,o)=>s+o.size,0);
          confirmed.push({ price: c.price, side: c.side, size: Math.floor(totalSize*10000)/10000, score: Math.floor(totalSize/avg*10)/10, sources: [...uniqueSources].join('+'), sourceCount: uniqueSources.size });
        }
      }
    });

    const now = Date.now();
    const newSeen = {};
    confirmed.forEach(w=>{
      const key = `${w.side}-${Math.round(w.price)}`;
      const first = wallFirstSeen[key] || now;
      newSeen[key] = first;
      w.age_menit = Math.floor((now - first)/60000);
      w.age_detik = Math.floor((now - first)/1000);
      w.firstSeen = first;
      // HARGA MT5 BUAT TIAP LEVEL - UDAH DIKURANG SELISIH
      w.price_mt5 = Math.floor((w.price - selisih)*100)/100;
      w.price_xaut = Math.floor(w.price*100)/100;
    });
    wallFirstSeen = newSeen;
    const stableWalls = confirmed.filter(w=> w.age_menit >= 3);
    walls = confirmed;
    walls._stable = stableWalls;
    lastFetch = Date.now();
    for(let w of walls.slice(0,3)) await saveToSupabase(w);
    console.log(`3EX [BYB:${sources.bybit?'OK':'X'} OKX:${sources.okx?'OK':'X'} GATE:${sources.gate?'OK':'X'}] Avg:${avg.toFixed(4)} | Level:${walls.length} Stabil:${stableWalls.length} | XAUT:${xautMid.toFixed(2)} XAUUSD:${xauusdPrice.toFixed(2)} Selisih:${selisih.toFixed(2)} | LOCK:${lockedSignal?lockedSignal.signal:'-'}`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

function buildSignal(){
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  if(uptime_menit < 30) return { signal:'WAIT', reason:`PEMANASAN ${uptime_menit}/30 menit - Kumpulin data dulu, jangan trigger`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null };

  const stableWalls = walls._stable || walls;

  // === LOCK + AUTO UNLOCK KALAU UDAH TP/SL ===
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

  if(stableWalls.length===0) return { signal:'WAIT', reason:'Belum ada level STABIL (>=3 menit) yang terkonfirmasi 2/3 exchange', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };
  const bidWalls = [...stableWalls].filter(w=>w.side==='BID').sort((a,b)=>b.price-a.price);
  const askWalls = [...stableWalls].filter(w=>w.side==='ASK').sort((a,b)=>a.price-b.price);
  if(bidWalls.length===0 || askWalls.length===0) return { signal:'WAIT', reason:'Level stabil satu sisi doang, skip', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, entry_mt5:0, sl_mt5:0, emergency_sl_mt5:0, tp1_mt5:0, tp2_mt5:0, partial:'50/50', reentry:null, last_done: lastDone };
  const mid = (bidWalls[0].price + askWalls[0].price) / 2;
  const nearestBid = bidWalls.find(w=> (mid - w.price) >= 5 && (mid - w.price) <= 15) || bidWalls[0];
  const nearestAsk = askWalls.find(w=> (w.price - mid) >= 5 && (w.price - mid) <= 15) || askWalls[0];

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
    newSignal = { signal:'BUY', reason:`Level BID ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) TERKONFIRMASI [${wall.sources}] | Umur level ${wall.age_menit}m | TP1 depan ASK ${nearestAsk.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  } else {
    const wall = nearestAsk;
    const entry = wall.price - 3;
    const sl = wall.price + 3;
    const emergency_sl = wall.price + 6;
    const tp1 = nearestBid.price + 3;
    const tp2 = (bidWalls[bidWalls.length-1]?.price || nearestBid.price) + 3;
    const backup = askWalls[askWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price - 3, sl: backup.price + 3, wall: backup.price, entry_mt5: (backup.price - 3) - selisih, sl_mt5: (backup.price + 3) - selisih } : null;
    newSignal = { signal:'SELL', reason:`Level ASK ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) TERKONFIRMASI [${wall.sources}] | Umur level ${wall.age_menit}m | TP1 depan BID ${nearestBid.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
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

app.get('/', (req,res)=> res.send('ABEL BOT v3.2 LOCK AUTO-UNLOCK + SELISIH jalan!'));
app.get('/api/health', (req,res)=> res.json({ status: 'ok', uptime_menit: Math.floor((Date.now()-startTime)/60000) }));
app.get('/api/unlock', (req,res)=>{ lockedSignal = null; lockedWallGoneSince = 0; res.json({ ok:true, msg:'Lock dibatalkan manual' }); });
app.get('/api/signal', (req,res)=>{
  const s = buildSignal();
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  res.json({ ...s, pair: 'XAUT = XAUUSD MT5', exchanges: lastSources, avg_xaut: lastAvg, walls: walls.slice(0,8), uptime_menit, supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET', last_update: new Date(lastFetch).toISOString(), last_done: lastDone,
    harga: { xaut_mid: Math.floor(xautMid*100)/100, xauusd_goldprice: Math.floor(xauusdPrice*100)/100, selisih: Math.floor(selisih*100)/100, selisih_text: selisih>=0? `XAUT +${selisih.toFixed(2)}$ lebih mahal` : `XAUT ${selisih.toFixed(2)}$ lebih murah`, last_gold_update: new Date(lastGoldFetch).toISOString() },
    rules: 'V3.2: Bybit+OKX+Gate, Konfirmasi 2/3, Level Betah 3m, Lock + Auto-Unlock TP/SL, Entry +3 | SL -3 | Emergency -6 | TP1/TP2 | Partial 50/50 | Re-Entry A | Warm-up 30m | Selisih XAUT-XAUUSD'
  });
});

app.listen(PORT, ()=> console.log(`ABEL BOT jalan di port ${PORT}`));
