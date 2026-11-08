// ABEL BOT v2.4 - FULL SCRIPT - XAUT - RULES LENGKAP
// Pair: XAUTUSDT = XAUUSD | Entry: Tembok Terdekat | SL 3 USD | Emergency 6 USD | TP1/TP2 | Partial 50/50 | Re-Entry A
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let walls = [];
let lastFetch = 0;
let startTime = Date.now();
let lastAvg = 0;
let lastSignal = null;

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

async function fetchOrderbook(){
  try{
    const res = await fetch('https://api.binance.us/api/v3/depth?symbol=XAUTUSDT&limit=100');
    const data = await res.json();
    if(!data.bids || !data.asks){ console.log('XAUT kosong, skip'); return; }

    const bids = data.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'}));
    const asks = data.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'}));
    const all = [...bids, ...asks];

    // DINAMIS: Rata-rata 60 level
    const nearest = [...bids.slice(0,30), ...asks.slice(0,30)];
    const avg = nearest.reduce((s,w)=>s+w.size,0) / nearest.length;
    lastAvg = avg;

    // Tembok = >2.5x avg
    walls = all.filter(w=>w.size > avg * 2.5).map(w=>({...w, score: Math.floor(w.size/avg*10)/10}));
    lastFetch = Date.now();
    for(let w of walls.slice(0,3)) await saveToSupabase(w);
    console.log(`XAUT Avg:${avg.toFixed(4)} | Tembok:${walls.length}`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

function buildSignal(){
  // Harga sekarang = tengah BID/ASK terdekat dari walls, fallback 0
  // Kita pake harga tembok terdekat sebagai patokan
  if(walls.length===0) return { signal:'WAIT', reason:'Belum ada tembok XAUT >2.5x avg', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };

  const bidWalls = [...walls].filter(w=>w.side==='BID').sort((a,b)=>b.price-a.price);
  const askWalls = [...walls].filter(w=>w.side==='ASK').sort((a,b)=>a.price-b.price);
  if(bidWalls.length===0 || askWalls.length===0) return { signal:'WAIT', reason:'Tembok satu sisi doang, skip', entry:0, sl:0, emergency_sl:0, tp1:0, tp2:0, partial:'50/50', reentry:null };

  // Contoh harga sekarang = di tengah BID terdekat & ASK terdekat
  const mid = (bidWalls[0].price + askWalls[0].price) / 2;

  // Pilih sisi yang temboknya lebih dominan / terdekat
  // RULE: Entry di tembok gede TERDEKAT 5-12 USD, bukan paus terjauh
  const nearestBid = bidWalls.find(w=> (mid - w.price) >= 5 && (mid - w.price) <= 15) || bidWalls[0];
  const nearestAsk = askWalls.find(w=> (w.price - mid) >= 5 && (w.price - mid) <= 15) || askWalls[0];

  // Tentukan BUY vs SELL dari mana tembok yang lebih kuat / lebih dekat
  // Kalau BID wall lebih gede ratio-nya -> BUY, sebaliknya SELL
  const bidScore = nearestBid.score;
  const askScore = nearestAsk.score;

  if(bidScore >= askScore){
    // BUY SETUP - Entry di tembok BID terdekat
    const wall = nearestBid;
    const entry = wall.price + 3;
    const sl = wall.price - 3;
    const emergency_sl = wall.price - 6;
    const tp1 = nearestAsk.price - 3;
    const tp2 = (askWalls[askWalls.length-1]?.price || nearestAsk.price) - 3;
    // Re-Entry A = paus BID paling bawah (cadangan)
    const backup = bidWalls[bidWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price + 3, sl: backup.price - 3, wall: backup.price } : null;
    return { signal:'BUY', reason:`Tembok BID ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) | TP1 depan ASK ${nearestAsk.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  } else {
    // SELL SETUP - Mirror
    const wall = nearestAsk;
    const entry = wall.price - 3;
    const sl = wall.price + 3;
    const emergency_sl = wall.price + 6;
    const tp1 = nearestBid.price + 3;
    const tp2 = (bidWalls[bidWalls.length-1]?.price || nearestBid.price) + 3;
    const backup = askWalls[askWalls.length-1];
    const reentry = backup && backup.price !== wall.price ? { entry: backup.price - 3, sl: backup.price + 3, wall: backup.price } : null;
    return { signal:'SELL', reason:`Tembok ASK ${wall.price} size ${wall.size} XAUT (${wall.score}x avg) | TP1 depan BID ${nearestBid.price}`, entry, sl, emergency_sl, tp1, tp2, partial:'50/50 - 50% di TP1, 50% ke TP2', reentry, wall: wall.price, avg: lastAvg };
  }
}

setInterval(fetchOrderbook, 2000);
fetchOrderbook();

app.get('/', (req,res)=> res.send('ABEL BOT v2.4 XAUT RULES LENGKAP jalan!'));
app.get('/api/signal', (req,res)=>{
  const s = buildSignal();
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  res.json({
    ...s,
    pair: 'XAUTUSDT = XAUUSD MT5',
    avg_xaut: lastAvg,
    walls: walls.slice(0,8),
    uptime_menit,
    supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET',
    last_update: new Date(lastFetch).toISOString(),
    rules: 'Entry Tembok Terdekat +3 | SL -3 | Emergency -6 | TP1/TP2 | Partial 50/50 | Re-Entry A'
  });
});

app.listen(PORT, ()=> console.log(`ABEL BOT jalan di port ${PORT}`));
