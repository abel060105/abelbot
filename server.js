// ABEL BOT - V8.2 - MESIN DI SERVER, API CUMA BACA, 1 SETUP = 1 OBJEK
// MODIF: + TELEGRAM PRIBADI+CHANNEL + /api/history SESI INI
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// DUKUNG PRIBADI + CHANNEL: isi TELEGRAM_CHAT_IDS = "1201491575,-1004487592477"
// Kalau TELEGRAM_CHAT_IDS kosong, fallback ke TELEGRAM_CHAT_ID lama biar gak error
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_IDS.length) return;
  // kirim ke semua tujuan: pribadi + channel, barengan
  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chat_id)=>{
    try{
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: msg })
      });
    }catch(e){ console.log('Telegram gagal ke', chat_id, e.message); }
  }));
}

function generateSetupId(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for(let i=0; i<4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return '#' + id;
}

let walls = [], wallsFar = [], xautPrice = 0, xauusdPrice = 0, lastKnownXauusd = 0, selisih = 0, goldSource = '-';
let exchanges = { bybit: false, okx: false, binance: false };
let uptimeStart = Date.now(), lastUpdate = null;
let firstSeenMap = new Map(), signalHistory = [];

// SATU-SATUNYA STATE - JANGAN DIPECAH LAGI
let currentSetup = null; // setup yang lagi jalan
let lastSetup = null; // setup terakhir yang udah close, buat display Last
let lastDone = null;

function addHistory(entry){ signalHistory.unshift(entry); if(signalHistory.length > 100) signalHistory = signalHistory.slice(0,100); }
function closeHistory(id, result, resultPrice){
  const h = signalHistory.find(x=> x.id === id);
  if(h && !h.closed_at){ h.closed_at = Date.now(); h.result = result; h.result_price = resultPrice; h.duration_menit = Math.floor((h.closed_at - h.created_at)/60000); }
}
function getAgeMenit(key){ const t = firstSeenMap.get(key); if(!t) return 0; return Math.floor((Date.now() - t) / 60000); }
function calcProfit(signal, entry, harga){
  const p = signal === 'BUY' ? (harga - entry) : (entry - harga);
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '$';
}

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
  const bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT');
  const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
  const binance = await fetchOne('https://api.binance.com/api/v3/depth?symbol=XAUTUSDT');
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

// MESIN UTAMA - CUMA DIPANGGIL DARI tick(), BUKAN DARI /api/signal
function checkSignal(){
  const { pending, touched } = buildPendingOrders();

  // ADA SETUP JALAN - CEK TP / SL DARI SETUP ITU DOANG
  if(currentSetup){
    const s = currentSetup;
    const displaySignal = s.signal;

    if(s.state === 'IN_POSITION'){
      const kenaSL = displaySignal === 'BUY' ? xauusdPrice <= s.sl_mt5 : xauusdPrice >= s.sl_mt5;
      if(kenaSL){
        const profit = calcProfit(displaySignal, s.entry_mt5, xauusdPrice);
        lastSetup = { ...s, state: 'CLOSED', result: 'SL KENA', result_price: xauusdPrice, closed_at: Date.now() };
        lastDone = { last_result: displaySignal + ' SL KENA di ' + s.sl_mt5.toFixed(2) + ' - Setup ' + s.setup_id };
        closeHistory(s.id, 'SL KENA', xauusdPrice);
        sendTelegram(`❌ ${displaySignal} SL KENA - Setup ${s.setup_id}\n\nHarga: $${xauusdPrice.toFixed(2)}\nEntry tadi: $${s.entry_mt5.toFixed(2)}\nProfit: ${profit}`);
        currentSetup = null;
        return;
      }
      const kenaTP1 = displaySignal === 'BUY' ? xauusdPrice >= s.tp1_mt5 : xauusdPrice <= s.tp1_mt5;
      if(kenaTP1){
        s.state = 'TP1_HIT'; s.tp1_hit = true; s.tp1_at = Date.now();
        const profit = calcProfit(displaySignal, s.entry_mt5, xauusdPrice);
        sendTelegram(`🟢 ${displaySignal} TP1 KENA - Setup ${s.setup_id}\n\nHarga: $${xauusdPrice.toFixed(2)}\nEntry tadi: $${s.entry_mt5.toFixed(2)}\nProfit: ${profit}`);
        return;
      }
      return;
    }

    if(s.state === 'TP1_HIT'){
      const beLevel = s.entry_mt5;
      const kenaBE = displaySignal === 'BUY' ? xauusdPrice <= beLevel : xauusdPrice >= beLevel;
      if(kenaBE){
        const profit = calcProfit(displaySignal, s.entry_mt5, xauusdPrice);
        lastSetup = { ...s, state: 'CLOSED', result: 'BE KENA', result_price: beLevel, closed_at: Date.now() };
        lastDone = { last_result: displaySignal + ' TP1 KENA, SISA BE - Setup ' + s.setup_id };
        closeHistory(s.id, 'BE KENA', beLevel);
        sendTelegram(`🟡 ${displaySignal} BE KENA - Setup ${s.setup_id}\n\nHarga: $${xauusdPrice.toFixed(2)}\nEntry tadi: $${s.entry_mt5.toFixed(2)}\nProfit: ${profit}`);
        currentSetup = null;
        return;
      }
      const kenaTP2 = displaySignal === 'BUY' ? xauusdPrice >= s.tp2_mt5 : xauusdPrice <= s.tp2_mt5;
      if(kenaTP2){
        const profit = calcProfit(displaySignal, s.entry_mt5, xauusdPrice);
        lastSetup = { ...s, state: 'CLOSED', result: 'TP2 KENA', result_price: xauusdPrice, closed_at: Date.now() };
        lastDone = { last_result: displaySignal + ' TP2 KENA di ' + s.tp2_mt5.toFixed(2) + ' - Setup ' + s.setup_id };
        closeHistory(s.id, 'TP2 KENA', xauusdPrice);
        sendTelegram(`✅ ${displaySignal} TP2 KENA - Setup ${s.setup_id}\n\nHarga: $${xauusdPrice.toFixed(2)}\nEntry tadi: $${s.entry_mt5.toFixed(2)}\nProfit: ${profit}`);
        currentSetup = null;
        return;
      }
      return;
    }
    return;
  }

  // GAK ADA SETUP JALAN - CARI TRIGGER BARU
  if(!pending.length || !xauusdPrice) return;
  const byJarak = [...pending].sort((a,b)=> a.distance_mt5 - b.distance_mt5);
  const terdekat = byJarak[0];
  if(terdekat.distance_mt5 > 15) return;
  const isBuy = terdekat.side === 'BID';
  const entryMt5 = Math.floor(xauusdPrice * 100) / 100;
  let slMt5, tp1Mt5, tp2Mt5, emergency, reentry;
  if(isBuy){ slMt5 = entryMt5 - 5; tp1Mt5 = entryMt5 + 5; tp2Mt5 = entryMt5 + 10; emergency = entryMt5 - 8; reentry = { entry_mt5: entryMt5 - 3, sl_mt5: entryMt5 - 8 }; }
  else { slMt5 = entryMt5 + 5; tp1Mt5 = entryMt5 - 5; tp2Mt5 = entryMt5 - 10; emergency = entryMt5 + 8; reentry = { entry_mt5: entryMt5 + 3, sl_mt5: entryMt5 + 8 }; }

  const setupId = generateSetupId();
  const displaySignal = isBuy ? 'BUY' : 'SELL';
  const now = Date.now();
  currentSetup = {
    id: 'SIG-' + now,
    setup_id: setupId,
    signal: displaySignal,
    state: 'IN_POSITION',
    tp1_hit: false,
    entry_mt5: entryMt5, sl_mt5: slMt5, tp1_mt5: tp1Mt5, tp2_mt5: tp2Mt5,
    emergency_sl_mt5: emergency, partial: '50/50', reentry,
    lockedAt: now, tp1_at: null, closed_at: null, result: 'AKTIF - MARKET',
    wall: { side: terdekat.side, price: terdekat.price, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, distance_mt5: terdekat.distance_mt5 },
    lock_status: 'IN POSITION - ' + displaySignal + ' MARKET di ' + entryMt5.toFixed(2)
  };
  addHistory({ id: currentSetup.id, setup_id: setupId, signal: displaySignal + ' MARKET', wall_side: terdekat.side, wall_price: terdekat.price, entry_mt5: entryMt5, entry_xaut: terdekat.price, sl_mt5: slMt5, tp1_mt5: tp1Mt5, tp2_mt5: tp2Mt5, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: now, closed_at: null, result: 'AKTIF - MARKET', result_price: null, duration_menit: 0 });
  sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId}\n\nEntry: $${entryMt5.toFixed(2)}\nSL: $${slMt5.toFixed(2)}\nTP1: $${tp1Mt5.toFixed(2)}\nTP2: $${tp2Mt5.toFixed(2)}\nTembok Pemicu: ${terdekat.side} ${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${terdekat.distance_mt5.toFixed(1)}$)`);
}

// TICK - MESIN JALAN DI SINI, TIAP 2 DETIK, WALAU VERCEL DITUTUP
let tickRunning = false;
async function tick(){
  if(tickRunning) return;
  tickRunning = true;
  try{
    await fetchGoldPrice();
    const { allBids, allAsks } = await fetchOrderbooks();
    if(allBids.length) buildWalls(allBids, allAsks);
    checkSignal();
    lastUpdate = Date.now();
  }catch(e){ console.log('tick gagal', e.message); }
  tickRunning = false;
}
setInterval(tick, 2000); tick();

// API CUMA BACA - GAK BOLEH NGERUBAH STATE
function buildSignalResponse(){
  const { pending, touched } = buildPendingOrders();
  if(currentSetup){
    const s = currentSetup;
    const sigText = s.state === 'TP1_HIT' ? s.signal + ' - TP1 KENA' : s.signal + ' - AKTIF';
    return { signal: sigText, reason: '', setup_id: s.setup_id, pending, touched, entry_mt5: s.entry_mt5, sl_mt5: s.sl_mt5, tp1_mt5: s.tp1_mt5, tp2_mt5: s.tp2_mt5, emergency_sl_mt5: s.emergency_sl_mt5, partial: s.partial, reentry: s.reentry, is_locked: true, lockedState: s.state, lockedAt: s.lockedAt, lockedId: s.id, lockedTp1Hit: s.tp1_hit, lock_status: s.lock_status, wall: s.wall };
  }
  return { signal: 'WAIT', reason: '', setup_id: '', pending, touched, entry_mt5: 0, sl_mt5: 0, tp1_mt5: 0, tp2_mt5: 0, emergency_sl_mt5: 0, partial: '50/50', reentry: null, is_locked: false, lockedState: 'IDLE', lockedAt: null, lockedId: null, lockedTp1Hit: false, lock_status: lastSetup ? 'Last: ' + (lastDone ? lastDone.last_result : lastSetup.result) : 'Tidak terkunci', wall: null };
}

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal'));
app.get('/api/signal', (req,res)=>{
  const sig = buildSignalResponse();
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF', harga: { xaut_mid: xautPrice, xauusd_goldprice: xauusdPrice, selisih, source: goldSource }, range: { low: 3893, high: 4060 }, exchanges, supabase: 'OK', uptimeStart, uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone, last_setup: lastSetup, current_setup: currentSetup });
});
// RIWAYAT SESI INI - sejak server nyala (uptimeStart). Restart = reset, sesuai request lo.
// signalHistory memang in-memory, jadi otomatis cuma isi sesi ini. Kita tambahin info sesi biar HTML bisa nampilin "Sejak Nyala: ..."
app.get('/api/history', (req,res)=>{
  const since = req.query.since ? parseInt(req.query.since) : uptimeStart;
  const filtered = signalHistory.filter(x => (x.created_at || 0) >= since);
  res.json({ history: filtered, total: filtered.length, uptimeStart, sesi_mulai: new Date(uptimeStart).toLocaleString('id-ID'), uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000) });
});
// Alias biar gampang dipanggil dari tombol: /api/history-sesi
app.get('/api/history-sesi', (req,res)=>{ res.redirect('/api/history'); });
app.get('/api/test-telegram', async (req,res)=>{ const testId = generateSetupId(); await sendTelegram(`🎯 BUY NOW - Setup ${testId}\n\nEntry: $3954.19\nSL: $3949.19\nTP1: $3959.19\nTP2: $3964.19\nTembok Pemicu: BID 3935.90 - 58.38 XAUT - Betah 5m - OKX (jarak 12.4$)`); res.json({ ok: true, setup_id: testId, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' }); });
app.get('/api/unlock', (req,res)=>{
  if(currentSetup){
    lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xauusdPrice, closed_at: Date.now() };
    closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xauusdPrice);
    lastDone = { last_result: 'Dibatalkan manual - Setup ' + currentSetup.setup_id };
    currentSetup = null;
  }
  res.json({ ok: true, msg: 'Lock dibatalkan' });
});
app.listen(PORT, ()=> console.log('ABEL BOT V8.2 MARKET jalan di port ' + PORT));
