// ABEL BOT - V5.2 - NOTIF VIA TELEGRAM + RIWAYAT + HAPUS DESKRIPSI
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

// TELEGRAM CONFIG - isi dari Render Environment
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){
    console.log('Telegram belum di-setting, skip:', msg.slice(0,50));
    return;
  }
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    console.log('Telegram terkirim');
  }catch(e){ console.log('Telegram gagal:', e.message); }
}

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
let lockedId = null;
let reentry = null;
let partial = '50/50';
let firstSeenMap = new Map();
let signalHistory = [];
function addHistory(entry){
  signalHistory.unshift(entry);
  if(signalHistory.length > 100) signalHistory = signalHistory.slice(0,100);
}
function closeHistory(id, result, resultPrice){
  const h = signalHistory.find(x=> x.id === id);
  if(h && !h.closed_at){
    h.closed_at = Date.now();
    h.result = result;
    h.result_price = resultPrice;
    h.duration_menit = Math.floor((h.closed_at - h.created_at)/60000);
  }
}
function getAgeMenit(key){
  const t = firstSeenMap.get(key);
  if(!t) return 0;
  return Math.floor((Date.now() - t) / 60000);
}

async function fetchGoldPrice(){
  try{
    const r = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    if(d && d.price && d.price > 1000){ xauusdPrice = d.price; lastKnownXauusd = d.price; goldSource = 'Gold-API'; return true; }
  }catch(e){}
  try{
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const d = await r.json();
    if(d && d.items && d.items[0] && d.items[0].xauPrice > 1000){ xauusdPrice = d.items[0].xauPrice; lastKnownXauusd = d.items[0].xauPrice; goldSource = 'GoldPrice.org'; return true; }
  }catch(e){}
  try{
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if(d && parseFloat(d.price) > 1000){ xauusdPrice = parseFloat(d.price); lastKnownXauusd = parseFloat(d.price); goldSource = 'PAXG Binance'; return true; }
  }catch(e){}
  if(lastKnownXauusd > 1000){ xauusdPrice = lastKnownXauusd; goldSource = goldSource + ' (last known)'; return true; }
  if(xautPrice > 1000){ xauusdPrice = xautPrice; goldSource = 'XAUT fallback'; return true; }
  return false;
}

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
  if(xauusdPrice > 1000) selisih = xautPrice - xauusdPrice;
  const allSizes = [...bids, ...asks].map(x=> x.size);
  const avg = allSizes.reduce((a,b)=> a+b, 0) / allSizes.length;
  const threshold = avg * 2.5;
  const activeKeys = new Set();
  bids.forEach(o=> activeKeys.add('BID-' + o.price.toFixed(2)));
  asks.forEach(o=> activeKeys.add('ASK-' + o.price.toFixed(2)));
  for(const k of firstSeenMap.keys()){ if(!activeKeys.has(k)) firstSeenMap.delete(k); }
  const newWalls = [];
  const newFar = [];
  const pushWall = (side, o, isFar)=>{
    const key = side + '-' + o.price.toFixed(2);
    if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now());
    const age = getAgeMenit(key);
    const mt5 = o.price - selisih;
    const wall = { side, price: o.price, price_mt5: Math.floor(mt5 * 100) / 100, size: o.size, sources: o.sources, age_menit: age, first_seen: firstSeenMap.get(key) };
    if(isFar) newFar.push(wall);
    else newWalls.push(wall);
  };
  bids.forEach(o=>{ if(o.size >= threshold) pushWall('BID', o, false); });
  asks.forEach(o=>{ if(o.size >= threshold) pushWall('ASK', o, false); });
  const bidsFarCandidate = bids.filter(o=> o.size >= threshold * 0.8).sort((a,b)=> b.size - a.size).slice(0,3);
  const asksFarCandidate = asks.filter(o=> o.size >= threshold * 0.8).sort((a,b)=> b.size - a.size).slice(0,3);
  bidsFarCandidate.forEach(o=> pushWall('BID', o, true));
  asksFarCandidate.forEach(o=> pushWall('ASK', o, true));
  walls = newWalls;
  wallsFar = newFar;
}

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
    const item = { ...w, price_mt5: Math.floor(mt5 * 100) / 100, instruction: w.side === 'BID' ? 'BUY LIMIT' : 'SELL LIMIT', status: isTouched ? 'TERSENTUH' : 'PENDING', distance_mt5: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) };
    if(isTouched) touched.push(item);
    else pending.push(item);
  });
  pending.sort((a,b)=> b.size - a.size);
  touched.sort((a,b)=> b.size - a.size);
  return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}

function checkSignal(){
  const { pending, touched } = buildPendingOrders();
  if(isLocked){
    const entryMt5Now = lockedEntry - selisih;
    const slMt5Now = lockedSl - selisih;
    const tp1Mt5Now = lockedTp1 - selisih;
    const tp2Mt5Now = lockedTp2 - selisih;
    const displaySignal = lockedSignal === 'BUY' ? 'BUY LIMIT' : 'SELL LIMIT';
    if(lockedSignal === 'BUY'){
      if(xauusdPrice >= tp2Mt5Now){
        lastDone = { last_result: 'BUY LIMIT TP2 KENA di ' + tp2Mt5Now.toFixed(2) };
        closeHistory(lockedId, 'TP2 KENA', tp2Mt5Now);
        sendTelegram(`✅ <b>BUY LIMIT TP2 KENA</b>\n\nHarga: $${tp2Mt5Now.toFixed(2)}\nEntry tadi: $${entryMt5Now.toFixed(2)}\nProfit: +10$\n\nCek dashboard buat sinyal baru.`);
        isLocked = false; lockStatus = 'TP2 KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
      if(xauusdPrice <= slMt5Now){
        lastDone = { last_result: 'BUY LIMIT SL KENA di ' + slMt5Now.toFixed(2) };
        closeHistory(lockedId, 'SL KENA', slMt5Now);
        sendTelegram(`❌ <b>BUY LIMIT SL KENA</b>\n\nHarga: $${slMt5Now.toFixed(2)}\nEntry tadi: $${entryMt5Now.toFixed(2)}\nLoss: -5$\n\nTunggu sinyal baru, jangan revenge.`);
        isLocked = false; lockStatus = 'SL KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
    }
    if(lockedSignal === 'SELL'){
      if(xauusdPrice <= tp2Mt5Now){
        lastDone = { last_result: 'SELL LIMIT TP2 KENA di ' + tp2Mt5Now.toFixed(2) };
        closeHistory(lockedId, 'TP2 KENA', tp2Mt5Now);
        sendTelegram(`✅ <b>SELL LIMIT TP2 KENA</b>\n\nHarga: $${tp2Mt5Now.toFixed(2)}\nEntry tadi: $${entryMt5Now.toFixed(2)}\nProfit: +10$\n\nCek dashboard buat sinyal baru.`);
        isLocked = false; lockStatus = 'TP2 KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
      if(xauusdPrice >= slMt5Now){
        lastDone = { last_result: 'SELL LIMIT SL KENA di ' + slMt5Now.toFixed(2) };
        closeHistory(lockedId, 'SL KENA', slMt5Now);
        sendTelegram(`❌ <b>SELL LIMIT SL KENA</b>\n\nHarga: $${slMt5Now.toFixed(2)}\nEntry tadi: $${entryMt5Now.toFixed(2)}\nLoss: -5$\n\nTunggu sinyal baru, jangan revenge.`);
        isLocked = false; lockStatus = 'SL KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
    }
    return { signal: displaySignal, reason: '', pending, touched, entry: lockedEntry, entry_mt5: Math.floor(entryMt5Now*100)/100, sl: lockedSl, sl_mt5: Math.floor(slMt5Now*100)/100, tp1: lockedTp1, tp1_mt5: Math.floor(tp1Mt5Now*100)/100, tp2: lockedTp2, tp2_mt5: Math.floor(tp2Mt5Now*100)/100, emergency_sl_mt5: lockedEmergency, partial, reentry, is_locked: true, lock_status: 'LOCKED - ' + displaySignal + ' di ' + (Math.floor(entryMt5Now*100)/100).toFixed(2), lockedAt, lockedId };
  }
  if(!pending.length || !xauusdPrice){ return { signal: 'WAIT', reason: '', pending, touched }; }
  const byJarak = [...pending].sort((a,b)=> a.distance_mt5 - b.distance_mt5);
  const terdekat = byJarak[0];
  if(terdekat.distance_mt5 > 15){ return { signal: 'WAIT', reason: '', pending, touched }; }
  const isBuy = terdekat.side === 'BID';
  const entryMt5 = terdekat.price_mt5;
  const entryXaut = terdekat.price;
  let slMt5, tp1Mt5, tp2Mt5, emergency;
  if(isBuy){ slMt5 = entryMt5 - 5; tp1Mt5 = entryMt5 + 5; tp2Mt5 = entryMt5 + 10; emergency = entryMt5 - 8; reentry = { entry_mt5: entryMt5 - 3, sl_mt5: entryMt5 - 8 }; }
  else { slMt5 = entryMt5 + 5; tp1Mt5 = entryMt5 - 5; tp2Mt5 = entryMt5 - 10; emergency = entryMt5 + 8; reentry = { entry_mt5: entryMt5 + 3, sl_mt5: entryMt5 + 8 }; }
  isLocked = true;
  lockedSignal = isBuy ? 'BUY' : 'SELL';
  const displaySignal = isBuy ? 'BUY LIMIT' : 'SELL LIMIT';
  lockedEntry = entryXaut; lockedEntryMt5 = entryMt5;
  lockedSl = entryXaut + (isBuy ? -5 : 5); lockedSlMt5 = slMt5;
  lockedTp1 = entryXaut + (isBuy ? 5 : -5); lockedTp1Mt5 = tp1Mt5;
  lockedTp2 = entryXaut + (isBuy ? 10 : -10); lockedTp2Mt5 = tp2Mt5;
  lockedEmergency = emergency;
  lockedAt = Date.now();
  lockedId = 'SIG-' + lockedAt;
  lockStatus = 'LOCKED - ' + displaySignal + ' di ' + entryMt5.toFixed(2);
  lockedReason = '';
  addHistory({ id: lockedId, signal: displaySignal, wall_side: terdekat.side, wall_price: terdekat.price, entry_mt5: entryMt5, entry_xaut: entryXaut, sl_mt5: slMt5, tp1_mt5: tp1Mt5, tp2_mt5: tp2Mt5, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: lockedAt, closed_at: null, result: 'AKTIF', result_price: null, duration_menit: 0 });

  // KIRIM TELEGRAM - INI YANG BIKIN NOTIF MASUK WALAU PWA DI-CLOSE
  if(isBuy){
    sendTelegram(`🎯 <b>BUY LIMIT</b>\n\n<b>Entry (Limit):</b> $${entryMt5.toFixed(2)}\n<b>Harga Sekarang:</b> $${xauusdPrice.toFixed(2)} (jarak ${terdekat.distance_mt5.toFixed(1)}$)\n<b>SL:</b> $${slMt5.toFixed(2)}\n<b>TP1:</b> $${tp1Mt5.toFixed(2)}\n<b>TP2:</b> $${tp2Mt5.toFixed(2)}\n<b>Tembok:</b> BID ${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources}\n\n⚠️ PASANG LIMIT di $${entryMt5.toFixed(2)}, JANGAN MARKET SEKARANG. Tunggu kejemput.`);
  } else {
    sendTelegram(`🎯 <b>SELL LIMIT</b>\n\n<b>Entry (Limit):</b> $${entryMt5.toFixed(2)}\n<b>Harga Sekarang:</b> $${xauusdPrice.toFixed(2)} (jarak ${terdekat.distance_mt5.toFixed(1)}$)\n<b>SL:</b> $${slMt5.toFixed(2)}\n<b>TP1:</b> $${tp1Mt5.toFixed(2)}\n<b>TP2:</b> $${tp2Mt5.toFixed(2)}\n<b>Tembok:</b> ASK ${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources}\n\n⚠️ PASANG LIMIT di $${entryMt5.toFixed(2)}, JANGAN MARKET SEKARANG. Tunggu kejemput.`);
  }

  return { signal: displaySignal, reason: '', pending, touched, entry: lockedEntry, entry_mt5: lockedEntryMt5, sl: lockedSl, sl_mt5: lockedSlMt5, tp1: lockedTp1, tp1_mt5: lockedTp1Mt5, tp2: lockedTp2, tp2_mt5: lockedTp2Mt5, emergency_sl_mt5: lockedEmergency, partial, reentry, is_locked: true, lock_status: lockStatus, lockedAt, lockedId };
}

async function tick(){
  await fetchGoldPrice();
  const { allBids, allAsks } = await fetchOrderbooks();
  if(allBids.length) buildWalls(allBids, allAsks);
  lastUpdate = Date.now();
}
setInterval(tick, 2000);
tick();

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal'));
app.get('/api/signal', (req,res)=>{
  const sig = checkSignal();
  res.json({ ...sig, walls: walls, wallsNear: walls, wallsFar: wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF - isi TELEGRAM_BOT_TOKEN di Render', harga: { xaut_mid: xautPrice, xauusd_goldprice: xauusdPrice, selisih, source: goldSource }, range: { low: 3893, high: 4060 }, exchanges, supabase: 'OK', uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone });
});
app.get('/api/history', (req,res)=>{ res.json({ history: signalHistory, total: signalHistory.length }); });
app.get('/api/test-telegram', async (req,res)=>{
  await sendTelegram(`🔔 <b>TEST TELEGRAM ABEL BOT</b>\n\nKalau pesan ini masuk, berarti Telegram lo udah nyambung. Sinyal baru nanti bakal masuk ke sini, walau PWA di-close.`);
  res.json({ ok: true, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF', chat_id_set: !!TELEGRAM_CHAT_ID });
});
app.get('/api/unlock', (req,res)=>{
  if(isLocked && lockedId) closeHistory(lockedId, 'MANUAL / DIBATALKAN', xauusdPrice);
  isLocked = false; lockStatus = 'Dibatalkan manual'; lockedSignal = 'WAIT';
  res.json({ ok: true, msg: 'Lock dibatalkan, sinyal di-reset ke WAIT' });
});
app.listen(PORT, ()=> console.log('ABEL BOT jalan di port ' + PORT));
