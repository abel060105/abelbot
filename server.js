// ABEL BOT - V7 - MARKET INSTAN: MARKET -> TP1 -> TP2/SL -> REKAP + LEVEL DIKUNCI
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  }catch(e){ console.log('Telegram gagal:', e.message); }
}

let walls = [], wallsFar = [], xautPrice = 0, xauusdPrice = 0, lastKnownXauusd = 0, selisih = 0, goldSource = '-';
let exchanges = { bybit: false, okx: false, binance: false };
let uptimeStart = Date.now(), lastUpdate = null, lastDone = null;
let firstSeenMap = new Map(), signalHistory = [];

// STATE - LEVEL DIKUNCI PAS TRIGGER MARKET, GAK PERNAH BERUBAH LAGI
let isLocked = false, lockStatus = 'Tidak terkunci';
let lockedSignal = 'WAIT';
let lockedState = 'IDLE'; // IDLE, IN_POSITION, TP1_HIT, CLOSED
let lockedId = null, lockedAt = null;
let lockedEntryMt5 = 0, lockedSlMt5 = 0, lockedTp1Mt5 = 0, lockedTp2Mt5 = 0;
let lockedWallPrice = 0, lockedWallSize = 0, lockedWallSources = '', lockedWallAge = 0;
let lockedTp1At = null, lockedClosedAt = null, lockedResult = '';
let lockedTp1Hit = false;
let reentry = null, partial = '50/50';

function addHistory(entry){ signalHistory.unshift(entry); if(signalHistory.length > 100) signalHistory = signalHistory.slice(0,100); }
function closeHistory(id, result, resultPrice){
  const h = signalHistory.find(x=> x.id === id);
  if(h && !h.closed_at){ h.closed_at = Date.now(); h.result = result; h.result_price = resultPrice; h.duration_menit = Math.floor((h.closed_at - h.created_at)/60000); }
}
function getAgeMenit(key){ const t = firstSeenMap.get(key); if(!t) return 0; return Math.floor((Date.now() - t) / 60000); }

async function fetchGoldPrice(){
  try{ const r = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } }); const d = await r.json(); if(d && d.price && d.price > 1000){ xauusdPrice = d.price; lastKnownXauusd = d.price; goldSource = 'Gold-API'; return true; } }catch(e){}
  try{ const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } }); const d = await r.json(); if(d && d.items && d.items[0] && d.items[0].xauPrice > 1000){ xauusdPrice = d.items[0].xauPrice; lastKnownXauusd = d.items[0].xauPrice; goldSource = 'GoldPrice.org'; return true; } }catch(e){}
  try{ const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { signal: AbortSignal.timeout(5000) }); const d = await r.json(); if(d && parseFloat(d.price) > 1000){ xauusdPrice = parseFloat(d.price); lastKnownXauusd = parseFloat(d.price); goldSource = 'PAXG Binance'; return true; } }catch(e){}
  if(lastKnownXauusd > 1000){ xauusdPrice = lastKnownXauusd; goldSource = goldSource + ' (last known)'; return true; }
  if(xautPrice > 1000){ xauusdPrice = xautPrice; goldSource = 'XAUT fallback'; return true; }
  return false;
}
async function fetchOne(url, headers){ try{ const r = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(5000) }); const t = await r.text(); if(!t.trim().startsWith('{') && !t.trim().startsWith('[')) return null; return JSON.parse(t); }catch(e){ return null; } }
async function fetchOrderbooks(){
  const bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200');
  const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
  const binance = await fetchOne('https://api.binance.com/api/v3/depth?symbol=XAUTUSDT&limit=200');
  let allBids = [], allAsks = [];
  if(bybit && bybit.result && bybit.result.b){ exchanges.bybit = true; bybit.result.b.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' })); bybit.result.a.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' })); } else exchanges.bybit = false;
  if(okx && okx.data && okx.data[0]){ exchanges.okx = true; okx.data[0].bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' })); okx.data[0].asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' })); } else exchanges.okx = false;
  if(binance && binance.bids){ exchanges.binance = true; binance.bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'BIN' })); binance.asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'BIN' })); } else exchanges.binance = false;
  return { allBids, allAsks };
}
function mergeLevels(list){ const map = new Map(); list.forEach(o=>{ const key = o.price.toFixed(2); if(!map.has(key)) map.set(key, { price: o.price, size: 0, sources: new Set() }); const cur = map.get(key); cur.size += o.size; cur.sources.add(o.source); }); return [...map.values()].map(v=>({ price: v.price, size: v.size, sources: [...v.sources].join('+') })); }
function buildWalls(allBids, allAsks){
  const bids = mergeLevels(allBids), asks = mergeLevels(allAsks); if(!bids.length || !asks.length) return;
  const bestBid = Math.max(...bids.map(b=> b.price)), bestAsk = Math.min(...asks.map(a=> a.price)); xautPrice = (bestBid + bestAsk) / 2;
  if(xauusdPrice > 1000) selisih = xautPrice - xauusdPrice;
  const allSizes = [...bids, ...asks].map(x=> x.size); const avg = allSizes.reduce((a,b)=> a+b, 0) / allSizes.length; const threshold = avg * 2.5;
  const activeKeys = new Set(); bids.forEach(o=> activeKeys.add('BID-' + o.price.toFixed(2))); asks.forEach(o=> activeKeys.add('ASK-' + o.price.toFixed(2)));
  for(const k of firstSeenMap.keys()){ if(!activeKeys.has(k)) firstSeenMap.delete(k); }
  const newWalls = [], newFar = [];
  const pushWall = (side, o, isFar)=>{ const key = side + '-' + o.price.toFixed(2); if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now()); const age = getAgeMenit(key); const mt5 = o.price - selisih; const wall = { side, price: o.price, price_mt5: Math.floor(mt5 * 100) / 100, size: o.size, sources: o.sources, age_menit: age, first_seen: firstSeenMap.get(key) }; if(isFar) newFar.push(wall); else newWalls.push(wall); };
  bids.forEach(o=>{ if(o.size >= threshold) pushWall('BID', o, false); }); asks.forEach(o=>{ if(o.size >= threshold) pushWall('ASK', o, false); });
  const bidsFarCandidate = bids.filter(o=> o.size >= threshold * 0.8).sort((a,b)=> b.size - a.size).slice(0,3); const asksFarCandidate = asks.filter(o=> o.size >= threshold * 0.8).sort((a,b)=> b.size - a.size).slice(0,3);
  bidsFarCandidate.forEach(o=> pushWall('BID', o, true)); asksFarCandidate.forEach(o=> pushWall('ASK', o, true));
  walls = newWalls; wallsFar = newFar;
}
function buildPendingOrders(){
  if(!walls.length || !xauusdPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20); const pending = [], touched = [];
  sorted.forEach(w=>{ if((w.age_menit || 0) < 5) return; const mt5 = w.price_mt5 || (w.price - selisih); const jarak = Math.abs(mt5 - xauusdPrice); const isTouched = jarak <= 3; const item = { ...w, price_mt5: Math.floor(mt5 * 100) / 100, instruction: w.side === 'BID' ? 'BUY' : 'SELL', status: isTouched ? 'TERSENTUH' : 'PENDING', distance_mt5: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) }; if(isTouched) touched.push(item); else pending.push(item); });
  pending.sort((a,b)=> b.size - a.size); touched.sort((a,b)=> b.size - a.size); return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}

function sendRekap(){
  const dur = lockedClosedAt && lockedAt ? Math.floor((lockedClosedAt - lockedAt)/60000) : 0;
  const profit = lockedResult.includes('TP2') ? '+10$' : lockedResult.includes('TP1') ? '+5$' : lockedResult.includes('SL') ? '-5$' : '0$';
  const emoji = lockedResult.includes('TP2') ? '✅' : lockedResult.includes('SL') ? '❌' : '⚠️';
  sendTelegram(`${emoji} <b>REKAP ${lockedSignal} MARKET - ${lockedResult}</b>\n\n` +
    `<b>Entry MARKET [KUNCI]:</b> $${lockedEntryMt5.toFixed(2)}\n` +
    `<b>SL [KUNCI]:</b> $${lockedSlMt5.toFixed(2)}\n` +
    `<b>TP1 [KUNCI]:</b> $${lockedTp1Mt5.toFixed(2)}\n` +
    `<b>TP2 [KUNCI]:</b> $${lockedTp2Mt5.toFixed(2)}\n` +
    `<b>Harga Close:</b> $${xauusdPrice.toFixed(2)}\n` +
    `<b>Hasil:</b> ${profit}\n` +
    `<b>Tembok Pemicu:</b> ${lockedWallPrice.toFixed(2)} - ${lockedWallSize.toFixed(2)} XAUT - Betah ${lockedWallAge}m - ${lockedWallSources}\n` +
    `<b>Total Durasi:</b> ${dur} menit\n\n` +
    `Level di atas TIDAK BERUBAH dari awal sinyal.`);
}

function checkSignal(){
  const { pending, touched } = buildPendingOrders();

  if(isLocked){
    const displaySignal = lockedSignal === 'BUY' ? 'BUY' : 'SELL';
    const base = { pending, touched, entry_mt5: lockedEntryMt5, sl_mt5: lockedSlMt5, tp1_mt5: lockedTp1Mt5, tp2_mt5: lockedTp2Mt5, partial, reentry, is_locked: true, lockedAt, lockedId, lockedState, lockedTp1Hit, lock_status: lockStatus };

    // STATE: IN_POSITION - CEK TP1 / SL
    if(lockedState === 'IN_POSITION'){
      const kenaSL = lockedSignal === 'BUY' ? xauusdPrice <= lockedSlMt5 : xauusdPrice >= lockedSlMt5;
      if(kenaSL){
        lockedResult = 'SL KENA'; lockedClosedAt = Date.now(); lockedState = 'CLOSED';
        lastDone = { last_result: displaySignal + ' SL KENA di ' + lockedSlMt5.toFixed(2) };
        closeHistory(lockedId, 'SL KENA', lockedSlMt5);
        sendTelegram(`❌ <b>TRIGGER SL - ${displaySignal} MARKET SL KENA</b>\n\n<b>Harga:</b> $${xauusdPrice.toFixed(2)}\n<b>SL [KUNCI]:</b> $${lockedSlMt5.toFixed(2)}\n<b>Entry [KUNCI]:</b> $${lockedEntryMt5.toFixed(2)}\n<b>Loss:</b> -5$`);
        sendRekap();
        isLocked = false; lockedState = 'IDLE'; lockStatus = 'SL KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
      const kenaTP1 = lockedSignal === 'BUY' ? xauusdPrice >= lockedTp1Mt5 : xauusdPrice <= lockedTp1Mt5;
      if(kenaTP1){
        lockedTp1Hit = true; lockedTp1At = Date.now(); lockedState = 'TP1_HIT'; lockStatus = 'TP1 KENA - SL KE BE';
        sendTelegram(`🟢 <b>TRIGGER TP1 - ${displaySignal} MARKET TP1 KENA</b>\n\n<b>Harga:</b> $${xauusdPrice.toFixed(2)}\n<b>TP1 [KUNCI]:</b> $${lockedTp1Mt5.toFixed(2)}\n<b>Entry [KUNCI]:</b> $${lockedEntryMt5.toFixed(2)}\n<b>Profit Terkunci:</b> +5$ (50% TP1)\n<b>SL Pindah ke BE:</b> $${lockedEntryMt5.toFixed(2)} untuk sisa 50%\n\nTunggu TP2 $${lockedTp2Mt5.toFixed(2)} atau SL BE.`);
        return { signal: displaySignal + ' - TP1 KENA', ...base, lockedState: 'TP1_HIT', lockedTp1Hit: true, lock_status: lockStatus };
      }
      return { signal: displaySignal + ' - AKTIF', ...base, lock_status: lockStatus };
    }

    // STATE: TP1_HIT - SL UDAH BE, TINGGAL TP2 / BE
    if(lockedState === 'TP1_HIT'){
      const beLevel = lockedEntryMt5;
      const kenaSLBE = lockedSignal === 'BUY' ? xauusdPrice <= beLevel : xauusdPrice >= beLevel;
      if(kenaSLBE){
        lockedResult = 'TP1 KENA, SISA BE KENA'; lockedClosedAt = Date.now(); lockedState = 'CLOSED';
        lastDone = { last_result: displaySignal + ' TP1 KENA, SISA BE' };
        closeHistory(lockedId, 'TP1 KENA, SISA BE KENA', beLevel);
        sendTelegram(`🟡 <b>TRIGGER SL BE - ${displaySignal} SISA BE KENA</b>\n\n<b>Harga:</b> $${xauusdPrice.toFixed(2)}\n<b>BE [KUNCI]:</b> $${beLevel.toFixed(2)}\n<b>Profit Total:</b> +5$ (dari TP1 50%)`);
        sendRekap();
        isLocked = false; lockedState = 'IDLE'; lockStatus = 'TP1 + BE - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
      const kenaTP2 = lockedSignal === 'BUY' ? xauusdPrice >= lockedTp2Mt5 : xauusdPrice <= lockedTp2Mt5;
      if(kenaTP2){
        lockedResult = 'TP2 KENA'; lockedClosedAt = Date.now(); lockedState = 'CLOSED';
        lastDone = { last_result: displaySignal + ' TP2 KENA di ' + lockedTp2Mt5.toFixed(2) };
        closeHistory(lockedId, 'TP2 KENA', lockedTp2Mt5);
        sendTelegram(`✅ <b>TRIGGER TP2 - ${displaySignal} MARKET TP2 KENA</b>\n\n<b>Harga:</b> $${xauusdPrice.toFixed(2)}\n<b>TP2 [KUNCI]:</b> $${lockedTp2Mt5.toFixed(2)}\n<b>Entry [KUNCI]:</b> $${lockedEntryMt5.toFixed(2)}\n<b>Profit Total:</b> +10$`);
        sendRekap();
        isLocked = false; lockedState = 'IDLE'; lockStatus = 'TP2 KENA - DONE';
        return { signal: 'DONE', reason: '', pending, touched };
      }
      return { signal: displaySignal + ' - TP1 KENA', ...base, lockedState: 'TP1_HIT', lockedTp1Hit: true, lock_status: lockStatus };
    }
    return { signal: displaySignal, ...base };
  }

  // GAK ADA SINYAL - TRIGGER MARKET INSTAN
  if(!pending.length || !xauusdPrice){ return { signal: 'WAIT', reason: '', pending, touched }; }
  const byJarak = [...pending].sort((a,b)=> a.distance_mt5 - b.distance_mt5);
  const terdekat = byJarak[0];
  if(terdekat.distance_mt5 > 15){ return { signal: 'WAIT', reason: '', pending, touched }; }
  const isBuy = terdekat.side === 'BID';

  // KUNCI LEVEL BERDASARKAN HARGA MARKET SAAT INI, BUKAN HARGA TEMBOK
  const entryMt5 = Math.floor(xauusdPrice * 100) / 100;
  let slMt5, tp1Mt5, tp2Mt5, emergency;
  if(isBuy){ slMt5 = entryMt5 - 5; tp1Mt5 = entryMt5 + 5; tp2Mt5 = entryMt5 + 10; emergency = entryMt5 - 8; reentry = { entry_mt5: entryMt5 - 3, sl_mt5: entryMt5 - 8 }; }
  else { slMt5 = entryMt5 + 5; tp1Mt5 = entryMt5 - 5; tp2Mt5 = entryMt5 - 10; emergency = entryMt5 + 8; reentry = { entry_mt5: entryMt5 + 3, sl_mt5: entryMt5 + 8 }; }

  isLocked = true; lockedSignal = isBuy ? 'BUY' : 'SELL'; lockedState = 'IN_POSITION'; lockedTp1Hit = false;
  const displaySignal = isBuy ? 'BUY' : 'SELL';
  lockedEntryMt5 = entryMt5; lockedSlMt5 = slMt5; lockedTp1Mt5 = tp1Mt5; lockedTp2Mt5 = tp2Mt5;
  lockedWallPrice = terdekat.price; lockedWallSize = terdekat.size; lockedWallSources = terdekat.sources; lockedWallAge = terdekat.age_menit;
  lockedAt = Date.now(); lockedId = 'SIG-' + lockedAt; lockedTp1At = null; lockedClosedAt = null; lockedResult = '';
  lockStatus = 'IN POSITION - ' + displaySignal + ' MARKET di ' + entryMt5.toFixed(2);
  addHistory({ id: lockedId, signal: displaySignal + ' MARKET', wall_side: terdekat.side, wall_price: terdekat.price, entry_mt5: entryMt5, entry_xaut: terdekat.price, sl_mt5: slMt5, tp1_mt5: tp1Mt5, tp2_mt5: tp2Mt5, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: lockedAt, closed_at: null, result: 'AKTIF - MARKET', result_price: null, duration_menit: 0 });

  // TRIGGER MARKET + TRIGGER ENTRY JADI SATU - LANGSUNG EKSEKUSI
  sendTelegram(`🚀 <b>TRIGGER MARKET - ${displaySignal} MARKET EKSEKUSI SEKARANG</b>\n\n<b>Entry MARKET [KUNCI]:</b> $${entryMt5.toFixed(2)}\n<b>SL [KUNCI]:</b> $${slMt5.toFixed(2)}\n<b>TP1 [KUNCI]:</b> $${tp1Mt5.toFixed(2)}\n<b>TP2 [KUNCI]:</b> $${tp2Mt5.toFixed(2)}\n<b>Tembok Pemicu:</b> ${terdekat.side} ${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${terdekat.distance_mt5.toFixed(1)}$)\n\n⚡ EKSEKUSI MARKET SEKARANG di $${entryMt5.toFixed(2)}, JANGAN TUNGGU. Level ini TIDAK AKAN BERUBAH.`);

  return { signal: displaySignal + ' MARKET - AKTIF', reason: '', pending, touched, entry_mt5: lockedEntryMt5, sl_mt5: lockedSlMt5, tp1_mt5: lockedTp1Mt5, tp2_mt5: lockedTp2Mt5, partial, reentry, is_locked: true, lockedState: 'IN_POSITION', lock_status: lockStatus, lockedAt, lockedId };
}

async function tick(){ await fetchGoldPrice(); const { allBids, allAsks } = await fetchOrderbooks(); if(allBids.length) buildWalls(allBids, allAsks); lastUpdate = Date.now(); }
setInterval(tick, 2000); tick();

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal'));
app.get('/api/signal', (req,res)=>{
  const sig = checkSignal();
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF', harga: { xaut_mid: xautPrice, xauusd_goldprice: xauusdPrice, selisih, source: goldSource }, range: { low: 3893, high: 4060 }, exchanges, supabase: 'OK', uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone });
});
app.get('/api/history', (req,res)=>{ res.json({ history: signalHistory, total: signalHistory.length }); });
app.get('/api/test-telegram', async (req,res)=>{ await sendTelegram(`🔔 <b>TEST ABEL BOT V7 MARKET</b>\n\nAlur baru: MARKET -> TP1 -> TP2/SL -> REKAP. Eksekusi instan, level dikunci.`); res.json({ ok: true, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' }); });
app.get('/api/unlock', (req,res)=>{ if(isLocked && lockedId) closeHistory(lockedId, 'MANUAL / DIBATALKAN', xauusdPrice); isLocked = false; lockedState = 'IDLE'; lockStatus = 'Dibatalkan manual'; lockedSignal = 'WAIT'; res.json({ ok: true, msg: 'Lock dibatalkan' }); });
app.listen(PORT, ()=> console.log('ABEL BOT V7 MARKET jalan di port ' + PORT));
