// ABEL BOT v2.9 - ANTI MEPET - FINAL - 3 EXCHANGE: Bybit + OKX + Gate.io
// FIX: CORS + Tembok min jarak 6$ + TP1 min 10$ + Score 3.5x - BIAR GAK MEPET
// Pair: XAUT = XAUUSD | Konfirmasi 2/3 | Entry +3 | SL -4 | Emergency -7 | TP1 min 10$ | TP2 min 18$ | Partial 50/50 | Re-Entry A | Warm-up 30m
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

    let allLevels = [];
    active.forEach(ex=>{ allLevels.push(...ex.bids.slice(0,30), ...ex.asks.slice(0,30)); });
    const avg = allLevels.reduce((s,w)=>s+w.size,0) / allLevels.length;
    lastAvg = avg;

    let candidates = [];
    const exNames = ['BYBIT','OKX','GATE'];
    [byb, okx, gate].forEach((ex, idx)=>{
      if(!ex) return;
      [...ex.bids, ...ex.asks].forEach(w=>{
        // NAIKIN DARI 2.5 JADI 3.5 BIAR TEMBOK PALSU KE-FILTER
        if(w.size > avg * 3.5) candidates.push({...w, source: exNames[idx]});
      });
    });

    let confirmed = [];
    candidates.forEach(c=>{
      const others = candidates.filter(o=> o.side===c.side && o.source!==c.source && Math.abs(o.price - c.price) <= 2.0);
      const uniqueSources = new Set([c.source, ...others.map(o=>o.source)]);
      if(uniqueSources.size >= 2){
        // ANTI MEPET: Tembok baru harus beda min 6$ dari tembok yang udah ada
        const exists = confirmed.find(x=> x.side===c.side && Math.abs(x.price - c.price) <= 6.0);
        if(!exists){
          const totalSize = c.size + others.reduce((s,o)=>s+o.size,0);
          confirmed.push({ price: c.price, side: c.side, size: Math.floor(totalSize*10000)/10000, score: Math.floor(totalSize/avg*10)/10, sources: [...uniqueSources].join('+'), sourceCount: uniqueSources.size });
        }
      }
    });

    walls = confirmed;
    lastFetch = Date.now();
    for(let w of walls.slice(0,3)) await saveToSupabase(w);
    console.log(`3EX [BYB:${sources.bybit?'OK':'X'} OKX:${sources.okx?'OK':'X'} GATE:${sources.gate?'OK':'X'}] Avg:${avg.toFixed(4)} | Kandidat:${candidates.length} | TERKONFIRMASI 2/3:${walls.length}`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

function buildSignal(){
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  if(uptime_menit < 30) return { signal:'WAIT', reason:`PEMANASAN ${uptime_menit}/30 menit - Kumpulin data dulu, jangan trigger`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };
  if(walls.length===0) return { signal:'WAIT', reason:'Belum ada tembok yang terkonfirmasi 2/3 exchange', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };
  const bidWalls = [...walls].filter(w=>w.side==='BID').sort((a,b)=>b.price-a.price);
  const askWalls = [...walls].filter(w=>w.side==='ASK').sort((a,b)=>a.price-b.price);
  if(bidWalls.length===0 || askWalls.length===0) return { signal:'WAIT', reason:'Tembok terkonfirmasi satu sisi doang, skip', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };
  const mid = (bidWalls[0].price + askWalls[0].price) / 2;
  const nearestBid = bidWalls.find(w=> (mid - w.price) >= 5 && (mid - w.price) <= 20) || bidWalls[0];
  const nearestAsk = askWalls.find(w=> (w.price - mid) >= 5 && (w.price - mid) <= 20) || askWalls[0];

  // FILTER ANTI MEPET: Jarak BID ke ASK harus min 10$, kalau mepet SKIP
  if((nearestAsk.price - nearestBid.price) < 10) return { signal:'WAIT', reason:`Jarak BID ${nearestBid.price} ke ASK ${nearestAsk.price} cuma ${(nearestAsk.price - nearestBid.price).toFixed(2)}$ - TERLALU MEPET, skip biar gak boncos`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };

  if(nearestBid.score >= nearestAsk.score){
    const wall = nearestBid;
    const entry = wall.price + 3;
    const sl = wall.price - 4;
    const emergency_sl = wall.price - 7;
    const tp1 = nearestAsk.price - 3;
    const tp2 = (askWalls[askWalls.length-1]?.price || nearestAsk.price) - 3;
    // TP1 WAJIB MIN 10$ DARI ENTRY, KALAU KURANG SKIP
    if((tp1 - entry) < 10) return { signal:'WAIT', reason:`TP1 cuma ${(tp1-entry).toFixed(2)}$ dari Entry - TERLALU MEPET, skip`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };
    const backup = bidWalls[bidWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price + 3, sl: backup.price - 4, wall: backup.price } : null;
    return { signal:'BUY', reason:`Tembok BID ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) TERKONFIRMASI [${wall.sources}] | TP1 depan ASK ${nearestAsk.price} (+${(tp1-entry).toFixed(1)}$)`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  } else {
    const wall = nearestAsk;
    const entry = wall.price - 3;
    const sl = wall.price + 4;
    const emergency_sl = wall.price + 7;
    const tp1 = nearestBid.price + 3;
    const tp2 = (bidWalls[bidWalls.length-1]?.price || nearestBid.price) + 3;
    if((entry - tp1) < 10) return { signal:'WAIT', reason:`TP1 cuma ${(entry-tp1).toFixed(2)}$ dari Entry - TERLALU MEPET, skip`, entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };
    const backup = askWalls[askWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price - 3, sl: backup.price + 4, wall: backup.price } : null;
    return { signal:'SELL', reason:`Tembok ASK ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) TERKONFIRMASI [${wall.sources}] | TP1 depan BID ${nearestBid.price} (+${(entry-tp1).toFixed(1)}$)`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  }
}

setInterval(fetchOrderbook, 2000);
fetchOrderbook();

app.get('/', (req,res)=> res.send('ABEL BOT v2.9 ANTI MEPET - Bybit+OKX+Gate jalan!'));
app.get('/api/health', (req,res)=> res.json({ status: 'ok', uptime_menit: Math.floor((Date.now()-startTime)/60000) }));
app.get('/api/signal', (req,res)=>{
  const s = buildSignal();
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  res.json({ ...s, pair: 'XAUT = XAUUSD MT5', exchanges: lastSources, avg_xaut: lastAvg, walls: walls.slice(0,8), uptime_menit, supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET', last_update: new Date(lastFetch).toISOString(), rules: 'FINAL v2.9: Bybit+OKX+Gate.io, Konfirmasi 2/3, Tembok min 6$, TP1 min 10$, Entry +3 | SL -4 | Emergency -7 | TP1/TP2 | Partial 50/50 | Re-Entry A | Warm-up 30m' });
});

app.listen(PORT, ()=> console.log(`ABEL BOT jalan di port ${PORT}`));
