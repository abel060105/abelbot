// ABEL BOT - V4.4 - FIX MT5 KOSONG / SELISIH NGAWUR
// Render: node server.js
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ============ STATE ============
let walls = [];
let wallsFar = [];
let xautPrice = 0;
let xauusdPrice = 0;
let lastKnownXauusd = 0;
let selisih = 0;
let goldSource = '-';
let exchanges = { bybit: false, okx: false, binance: false };
let uptimeStart = Date.now();
let lastUpdate = null;
let lastDone = null;

let isLocked = false;
let lockStatus = 'Tidak terkunci';
let lockedSignal = 'WAIT';
let lockedEntry = 0, lockedEntryMt5 = 0, lockedSl = 0, lockedSlMt5 = 0;
let lockedTp1 = 0, lockedTp1Mt5 = 0, lockedTp2 = 0, lockedTp2Mt5 = 0;
let lockedEmergency = 0;
let lockedAt = null;
let lockedReason = '';
let reentry = null;
let partial = '50/50';

let firstSeenMap = new Map();

function getAgeMenit(key){
  const t = firstSeenMap.get(key);
  if(!t) return 0;
  return Math.floor((Date.now() - t) / 60000);
}

// ============ FETCH HARGA EMAS MT5 - 3 LAPIS, ANTI KOSONG ============
async function fetchGoldPrice(){
  // LAPIS 1: gold-api.com - gratis, paling ringan
  try{
    const r = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    if(d && d.price && d.price > 1000){
      xauusdPrice = d.price;
      lastKnownXauusd = d.price;
      goldSource = 'Gold-API';
      return true;
    }
  }catch(e){}

  // LAPIS 2: goldprice.org - yang lama, tapi pake User-Agent biar gak di-block Render
  try{
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' } });
    const d = await r.json();
    if(d && d.items && d.items[0] && d.items[0].xauPrice > 1000){
      xauusdPrice = d.items[0].xauPrice;
      lastKnownXauusd = d.items[0].xauPrice;
      goldSource = 'GoldPrice.org';
      return true;
    }
  }catch(e){}

  // LAPIS 3: Binance PAXGUSDT - INI YANG PALING ANTI GAGAL, KARENA BINANCE PASTI JALAN DI RENDER
  // PAXG = emas token, harga nempel XAUUSD, beda cuma 1-2$
  try{
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if(d && parseFloat(d.price) > 1000){
      xauusdPrice = parseFloat(d.price);
      lastKnownXauusd = parseFloat(d.price);
      goldSource = 'PAXG Binance';
      return true;
    }
  }catch(e){}

  // LAPIS 4: Kalau semua mati, pake harga terakhir yang masih keinget, JANGAN 0
  // Ini yang bikin kemarin selisih jadi +0.00$ dan MT5 jadi --. Sekarang gak akan 0 lagi.
  if(lastKnownXauusd > 1000){
    xauusdPrice = lastKnownXauusd;
    goldSource = goldSource + ' (last known)';
    return true;
  }

  // Kalau bener-bener baru pertama nyala dan semua mati, pake XAUT sebagai perkiraan sementara
  // Biar MT5 gak kosong, selisih gak ngawur
  if(xautPrice > 1000){
    xauusdPrice = xautPrice;
    goldSource = 'XAUT fallback';
    return true;
  }

  return false;
}

// ============ FETCH ORDERBOOK ============
async function fetchOne(url, headers){
  try{
    const r = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(5000) });
    const t = await r.text();
    if(!t.trim().startsWith('{') && !t.trim().startsWith('[')) return null;
    return JSON.parse(t);
  }catch(e){ return null; }
}

async function fetchOrderbooks(){
  const bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200');
  const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
  const binance = await fetchOne('https://api.binance.com/api/v3/depth?symbol=XAUTUSDT&limit=200');

  let allBids = [];
  let allAsks = [];

  if(bybit && bybit.result && bybit.result.b){
    exchanges.bybit = true;
    bybit.result.b.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' }));
    bybit.result.a.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' }));
  } else exchanges.bybit = false;

  if(okx && okx.data && okx.data[0]){
    exchanges.okx = true;
    okx.data[0].bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' }));
    okx.data[0].asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' }));
  } else exchanges.okx = false;

  if(binance && binance.bids){
    exchanges.binance = true;
    binance.bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'BIN' }));
    binance.asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'BIN' }));
  } else exchanges.binance = false;

  return { allBids, allAsks };
}

function mergeLevels(list){
  const map = new Map();
  list.forEach(o=>{
    const key = o.price.toFixed(2);
    if(!map.has(key)) map.set(key, { price: o.price, size: 0, sources: new Set() });
    const cur = map.get(key);
    cur.size += o.size;
    cur.sources.add(o.source);
  });
  return [...map.values()].map(v=>({ price: v.price, size: v.size, sources: [...v.sources].join('+') }));
}

function buildWalls(allBids, allAsks){
  const bids = mergeLevels(allBids);
  const asks = mergeLevels(allAsks);
  if(!bids.length || !asks.length) return;

  const bestBid = Math.max(...bids.map(b=> b.price));
  const bestAsk = Math.min(...asks.map(a=> a.price));
  xautPrice = (bestBid + bestAsk) / 2;
  // FIX: selisih cuma dihitung kalau MT5-nya beneran ada, bukan 0
  if(xauusdPrice > 1000) selisih = xautPrice - xauusdPrice;

  const allSizes = [...bids, ...asks].map(x=> x.size);
  const avg = allSizes.reduce((a,b)=> a+b, 0) / allSizes.length;
  const threshold = avg * 2.5;

  const activeKeys = new Set();
  bids.forEach(o=> activeKeys.add('BID-' + o.price.toFixed(2)));
  asks.forEach(o=> activeKeys.add('ASK-' + o.price.toFixed(2)));
  for(const k of firstSeenMap.keys()){
    if(!activeKeys.has(k)) firstSeenMap.delete(k);
  }

  const newWalls = [];
  const newFar = [];

  const pushWall = (side, o, isFar)=>{
    const key = side + '-' + o.price.toFixed(2);
    if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now());
    const age = getAgeMenit(key);
    const mt5 = o.price - selisih;
    const wall = {
      side,
      price: o.price,
      price_mt5: Math.floor(mt5 * 100) / 100,
      size: o.size,
      sources: o.sources,
      age_menit: age,
      first_seen: firstSeenMap.get(key)
    };
    if(isFar) newFar.push(wall);
    else newWalls.push(wall);
  };

  bids.forEach(o=>{ if(o.size >= threshold) pushWall('BID', o, false); });
  asks.forEach(o=>{ if(o.size >= threshold) pushWall('ASK', o, false); });

  bids.forEach(o=>{
    const mt5 = o.price - selisih;
    if((mt5 >= 3890 && mt5 <= 3910) || (mt5 >= 3990 && mt5 <= 4010)){
      if(o.size >= threshold * 0.8) pushWall('BID', o, true);
    }
  });
  asks.forEach(o=>{
    const mt5 = o.price - selisih;
    if((mt5 >= 4090 && mt5 <= 4110) || (mt5 >= 4190 && mt5 <= 4210)){
      if(o.size >= threshold * 0.8) pushWall('ASK', o, true);
    }
  });

  const nearKeys = new Set(newWalls.map(w=> w.side + '-' + w.price.toFixed(2)));
  walls = newWalls;
  wallsFar = newFar.filter(w=> !nearKeys.has(w.side + '-' + w.price.toFixed(2)));
}

// ============ PENDING - BETAH 5 MENIT ============
function buildPendingOrders(){
  if(!walls.length || !xauusdPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20);
  const pending = [];
  const touched = [];
  sorted.forEach(w=>{
    if((w.age_menit || 0) < 5) return;
    const mt5 = w.price_mt5 || (w.price - selisih);
    const jarak = Math.abs(mt5 - xauusdPrice);
    const isTouched = jarak <= 3;
    const item = {
      ...w,
      price_mt5: Math.floor(mt5 * 100) / 100,
      instruction: w.side === 'BID' ? 'BUY' : 'SELL',
      status: isTouched ? 'TERSENTUH' : 'PENDING',
      distance_mt5: Math.floor(jarak * 100) / 100,
      notional: Math.floor(w.size * w.price)
    };
    if(isTouched) touched.push(item);
    else pending.push(item);
  });
  pending.sort((a,b)=> b.size - a.size);
  touched.sort((a,b)=> b.size - a.size);
  return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}

// ============ SINYAL + LOCK ============
function checkSignal(){
  const { pending, touched } = buildPendingOrders();
  if(isLocked){
    if(lockedSignal === 'BUY'){
      if(xauusdPrice >= lockedTp2Mt5){
        lastDone = { last_result: 'BUY TP2 KENA di ' + lockedTp2Mt5.toFixed(2) };
        isLocked = false; lockStatus = 'TP2 KENA - DONE';
        return { signal: 'DONE', reason: 'BUY TP2 kena, tunggu sinyal baru', pending, touched };
      }
      if(xauusdPrice <= lockedSlMt5){
        lastDone = { last_result: 'BUY SL KENA di ' + lockedSlMt5.toFixed(2) };
        isLocked = false; lockStatus = 'SL KENA - DONE';
        return { signal: 'DONE', reason: 'BUY SL kena, tunggu sinyal baru', pending, touched };
      }
    }
    if(lockedSignal === 'SELL'){
      if(xauusdPrice <= lockedTp2Mt5){
        lastDone = { last_result: 'SELL TP2 KENA di ' + lockedTp2Mt5.toFixed(2) };
        isLocked = false; lockStatus = 'TP2 KENA - DONE';
        return { signal: 'DONE', reason: 'SELL TP2 kena, tunggu sinyal baru', pending, touched };
      }
      if(xauusdPrice >= lockedSlMt5){
        lastDone = { last_result: 'SELL SL KENA di ' + lockedSlMt5.toFixed(2) };
        isLocked = false; lockStatus = 'SL KENA - DONE';
        return { signal: 'DONE', reason: 'SELL SL kena, tunggu sinyal baru', pending, touched };
      }
    }
    return {
      signal: lockedSignal,
      reason: lockedReason,
      pending, touched,
      entry: lockedEntry, entry_mt5: lockedEntryMt5,
      sl: lockedSl, sl_mt5: lockedSlMt5,
      tp1: lockedTp1, tp1_mt5: lockedTp1Mt5,
      tp2: lockedTp2, tp2_mt5: lockedTp2Mt5,
      emergency_sl_mt5: lockedEmergency,
      partial, reentry, is_locked: true, lock_status: lockStatus, lockedAt
    };
  }

  if(!pending.length || !xauusdPrice){
    return { signal: 'WAIT', reason: 'Nunggu tembok betah 5 menit muncul...', pending, touched };
  }
  const byJarak = [...pending].sort((a,b)=> a.distance_mt5 - b.distance_mt5);
  const terdekat = byJarak[0];
  if(terdekat.distance_mt5 > 15){
    return { signal: 'WAIT', reason: `Tembok terdekat ${terdekat.side} ${terdekat.price_mt5.toFixed(2)} masih jauh ${terdekat.distance_mt5.toFixed(1)}$, tunggu harga deket dulu`, pending, touched };
  }

  const isBuy = terdekat.side === 'BID';
  const entryMt5 = terdekat.price_mt5;
  const entryXaut = terdekat.price;
  let slMt5, tp1Mt5, tp2Mt5, emergency;
  if(isBuy){
    slMt5 = entryMt5 - 5;
    tp1Mt5 = entryMt5 + 5;
    tp2Mt5 = entryMt5 + 10;
    emergency = entryMt5 - 8;
    reentry = { entry_mt5: entryMt5 - 3, sl_mt5: entryMt5 - 8 };
  } else {
    slMt5 = entryMt5 + 5;
    tp1Mt5 = entryMt5 - 5;
    tp2Mt5 = entryMt5 - 10;
    emergency = entryMt5 + 8;
    reentry = { entry_mt5: entryMt5 + 3, sl_mt5: entryMt5 + 8 };
  }
  isLocked = true;
  lockedSignal = isBuy ? 'BUY' : 'SELL';
  lockedEntry = entryXaut; lockedEntryMt5 = entryMt5;
  lockedSl = entryXaut + (isBuy ? -5 : 5); lockedSlMt5 = slMt5;
  lockedTp1 = entryXaut + (isBuy ? 5 : -5); lockedTp1Mt5 = tp1Mt5;
  lockedTp2 = entryXaut + (isBuy ? 10 : -10); lockedTp2Mt5 = tp2Mt5;
  lockedEmergency = emergency;
  lockedAt = Date.now();
  lockStatus = 'LOCKED - ' + lockedSignal + ' di ' + entryMt5.toFixed(2);
  lockedReason = `${lockedSignal} di tembok ${terdekat.side} ${terdekat.price.toFixed(2)} (MT5 ${entryMt5.toFixed(2)}) - Betah ${terdekat.age_menit}m, Size ${terdekat.size.toFixed(2)} XAUT, ${terdekat.sources}. SL ${slMt5.toFixed(2)}, TP1 ${tp1Mt5.toFixed(2)}, TP2 ${tp2Mt5.toFixed(2)}`;

  return {
    signal: lockedSignal,
    reason: lockedReason,
    pending, touched,
    entry: lockedEntry, entry_mt5: lockedEntryMt5,
    sl: lockedSl, sl_mt5: lockedSlMt5,
    tp1: lockedTp1, tp1_mt5: lockedTp1Mt5,
    tp2: lockedTp2, tp2_mt5: lockedTp2Mt5,
    emergency_sl_mt5: lockedEmergency,
    partial, reentry, is_locked: true, lock_status: lockStatus, lockedAt
  };
}

// ============ LOOP ============
async function tick(){
  await fetchGoldPrice();
  const { allBids, allAsks } = await fetchOrderbooks();
  if(allBids.length) buildWalls(allBids, allAsks);
  lastUpdate = Date.now();
}

setInterval(tick, 2000);
tick();

// ============ API ============
app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal'));
app.get('/api/signal', (req,res)=>{
  const sig = checkSignal();
  res.json({
    ...sig,
    walls: walls,
    wallsNear: walls,
    wallsFar: wallsFar,
    wallsFarCount: wallsFar.length,
    pendingOrders: sig.pending,
    touchedLevels: sig.touched,
    harga: { xaut_mid: xautPrice, xauusd_goldprice: xauusdPrice, selisih, source: goldSource },
    range: { low: 3893, high: 4060 },
    exchanges,
    supabase: 'OK',
    uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000),
    last_update: lastUpdate,
    last_done: lastDone
  });
});

app.get('/api/unlock', (req,res)=>{
  isLocked = false;
  lockStatus = 'Dibatalkan manual';
  lockedSignal = 'WAIT';
  res.json({ ok: true, msg: 'Lock dibatalkan, sinyal di-reset ke WAIT' });
});

app.listen(PORT, ()=> console.log('ABEL BOT jalan di port ' + PORT));
