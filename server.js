// ABEL BOT v2 - + Supabase Memory
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let walls = [];
let lastFetch = 0;
let startTime = Date.now();

async function saveToSupabase(wall){
  if(!SUPABASE_URL || !SUPABASE_KEY) return;
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/walls`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        price: wall.price,
        side: wall.side,
        size: wall.size,
        score: wall.score || 0
      })
    });
  }catch(e){ console.log('Supabase save gagal:', e.message); }
}

async function fetchOrderbook(){
  try{
    const res = await fetch('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100');
    const data = await res.json();
    const bids = data.bids.map(b=>({price: parseFloat(b[0]), size: parseFloat(b[1]), side:'BID'}));
    const asks = data.asks.map(a=>({price: parseFloat(a[0]), size: parseFloat(a[1]), side:'ASK'}));
    const all = [...bids, ...asks];
    // Cari tembok PAUS: size > 10 BTC
    const bigWalls = all.filter(w=>w.size > 10).map(w=>({...w, score: Math.floor(w.size)}));
    walls = bigWalls;
    lastFetch = Date.now();
    // Simpen tembok gede ke Supabase
    for(let w of bigWalls.slice(0,3)){
      await saveToSupabase(w);
    }
    console.log(`Tembok ke-detek: ${bigWalls.length}, disimpan ke Supabase`);
  }catch(e){ console.log('Fetch gagal:', e.message); }
}

setInterval(fetchOrderbook, 30000);
fetchOrderbook();

app.get('/', (req,res)=> res.send('ABEL BOT v2 + Supabase jalan!'));
app.get('/api/signal', (req,res)=>{
  const uptime_menit = Math.floor((Date.now()-startTime)/60000);
  let signal = 'WAIT';
  let reason = 'Belum ada tembok PAUS';
  if(walls.length > 0){
    const biggest = walls.sort((a,b)=>b.size-a.size)[0];
    if(biggest.side==='BID'){ signal='BUY'; reason=`Tembok BID PAUS di ${biggest.price} size ${biggest.size}`; }
    else { signal='SELL'; reason=`Tembok ASK PAUS di ${biggest.price} size ${biggest.size}`; }
  }
  res.json({
    signal, reason,
    price: walls[0]?.price || 0,
    walls: walls.slice(0,5),
    uptime_menit,
    supabase: SUPABASE_URL ? 'CONNECTED' : 'NOT SET',
    last_update: new Date(lastFetch).toISOString()
  });
});

app.listen(PORT, ()=> console.log(`ABEL BOT jalan di port ${PORT}`));
