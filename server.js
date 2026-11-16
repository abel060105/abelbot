// ABEL BOT - V11 - XAUT ONLY - NO GOLD-API, NO SELISIH, NO EXNESS
// LOGIC BARU: Jarak 0-3$, Betah 5m, Ratio 4x
// ZONA: Entry ngikutin Tembok s/d Harga Sekarang, SL 50 pips (5$), TP 50 pips (5$)
// HARGA = XAUT WS BYBIT+OKX 200ms LANGSUNG. GAK ADA KONVERSI MT5.
// SERVER->BYBIT/OKX WEBSOCKET 200ms. PWA->SERVER 1 DETIK.
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);

// ===== LOGIC BARU - JANGAN DIUBAH LAGI KECUALI LO MINTA =====
const JARAK_MIN = 0;
const JARAK_MAX = 3;
const BETAH_MIN_MENIT = 5;
const RATIO_MIN = 4;
const SL_PIPS = 50; // 5$
const TP_PIPS = 50; // 5$ - BUKAN 100 LAGI
const SL_DOLLAR = 5;
const TP_DOLLAR = 5;

let WSClient = null;
try{ WSClient = require('ws'); }catch(e){ console.log('Package ws belum ke-install, fallback REST. Jalankan: npm install ws'); }
let wsBybit = null, wsOkx = null, wsBybitOk = false, wsOkxOk = false, wsLastBybit = 0, wsLastOkx = 0;
let wsBooks = { BYBIT: { bids: new Map(), asks: new Map() }, OKX: { bids: new Map(), asks: new Map() } };

async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_IDS.length) return;
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

// ===== HITUNG ZONA - NYESUAIIN TEMBOK + JARAK =====
// BUY: Entry = [tembok , tembok + jarak] -> tembok di bawah, harga di atas
// SELL: Entry = [tembok - jarak , tembok] -> tembok di atas, harga di bawah
// SL & TP semua 50 pips (5$) dari zona entry
function hitungZona(wallPrice, hargaSekarang, isBuy){
  const jarak = Math.max(JARAK_MIN, Math.min(JARAK_MAX, Math.round(Math.abs(hargaSekarang - wallPrice))));
  const wall = Math.floor(wallPrice);
  if(isBuy){
    return { jarak, entryLow: wall, entryHigh: wall + jarak,
      slLow: wall - SL_DOLLAR, slHigh: wall + jarak - SL_DOLLAR,
      tpLow: wall + TP_DOLLAR, tpHigh: wall + jarak + TP_DOLLAR };
  } else {
    return { jarak, entryLow: wall - jarak, entryHigh: wall,
      slLow: wall - jarak + SL_DOLLAR, slHigh: wall + SL_DOLLAR,
      tpLow: wall - jarak - TP_DOLLAR, tpHigh: wall - TP_DOLLAR };
  }
}
function fmtZona(low, high){
  if(Math.round(low) === Math.round(high)) return `$${Math.round(low)}`;
  return `$${Math.round(low)} - $${Math.round(high)}`;
}
// Harga penutup posisi: BUY kena SL di slLow, kena TP di tpLow. SELL kena SL di slHigh, kena TP di tpHigh.
function hargaSL(zona, isBuy){ return isBuy ? zona.slLow : zona.slHigh; }
function hargaTP(zona, isBuy){ return isBuy ? zona.tpLow : zona.tpHigh; }

let walls = [], wallsFar = [], xautPrice = 0;
let exchanges = { bybit: false, okx: false };
let uptimeStart = Date.now(), lastUpdate = null;
let firstSeenMap = new Map(), signalHistory = [];
let currentSetup = null;
let lastSetup = null;
let lastDone = null;

function addHistory(entry){ signalHistory.unshift(entry); if(signalHistory.length > 100) signalHistory = signalHistory.slice(0,100); }
function closeHistory(id, result, resultPrice){
  const h = signalHistory.find(x=> x.id === id);
  if(h && !h.closed_at){ h.closed_at = Date.now(); h.result = result; h.result_price = resultPrice; h.duration_menit = Math.floor((h.closed_at - h.created_at)/60000); }
}
function getAgeMenit(key){ const t = firstSeenMap.get(key); if(!t) return 0; return Math.floor((Date.now() - t) / 60000); }
function calcProfitPips(signal, entry, harga){
  const dollar = signal === 'BUY' ? (harga - entry) : (entry - harga);
  const pips = dollar * 10;
  return (pips >= 0 ? '+' : '') + pips.toFixed(0) + ' pips (' + (dollar >= 0 ? '+' : '') + dollar.toFixed(2) + '$)';
}

// ===== WEBSOCKET BYBIT + OKX - XAUT ONLY =====
function applyWsBook(source, bids, asks, isSnapshot){
  const book = wsBooks[source];
  if(isSnapshot){ book.bids.clear(); book.asks.clear(); }
  (bids||[]).forEach(([p,s])=>{ const price=parseFloat(p), size=parseFloat(s); if(!price) return; if(size===0) book.bids.delete(price); else book.bids.set(price,size); });
  (asks||[]).forEach(([p,s])=>{ const price=parseFloat(p), size=parseFloat(s); if(!price) return; if(size===0) book.asks.delete(price); else book.asks.set(price,size); });
}
function getWsOrderbooks(){
  let allBids=[], allAsks=[];
  for(const src of ['BYBIT','OKX']){
    const b=wsBooks[src];
    b.bids.forEach((size,price)=> allBids.push({ price, size, source: src }));
    b.asks.forEach((size,price)=> allAsks.push({ price, size, source: src }));
  }
  return { allBids, allAsks };
}
function connectWS(){
  if(!WSClient) return;
  try{
    wsBybit = new WSClient('wss://stream.bybit.com/v5/public/spot');
    wsBybit.on('open', ()=>{ wsBybit.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.200.XAUTUSDT'] })); });
    wsBybit.on('message', (data)=>{ try{ const j = JSON.parse(data.toString()); if(j.data && j.data.b){ wsBybitOk = true; wsLastBybit = Date.now(); applyWsBook('BYBIT', j.data.b, j.data.a, j.type === 'snapshot'); } }catch(e){} });
    wsBybit.on('close', ()=>{ wsBybitOk = false; setTimeout(connectWS, 5000); });
    wsBybit.on('error', ()=>{ wsBybitOk = false; });
  }catch(e){ console.log('WS Bybit gagal', e.message); }
  try{
    wsOkx = new WSClient('wss://ws.okx.com:8443/ws/v5/public');
    wsOkx.on('open', ()=>{ wsOkx.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId: 'XAUT-USDT' }] })); });
    wsOkx.on('message', (data)=>{ try{ const j = JSON.parse(data.toString()); if(j.data && j.data[0]){ wsOkxOk = true; wsLastOkx = Date.now(); const d = j.data[0]; applyWsBook('OKX', d.bids, d.asks, d.action === 'snapshot'); } }catch(e){} });
    wsOkx.on('close', ()=>{ wsOkxOk = false; setTimeout(connectWS, 5000); });
    wsOkx.on('error', ()=>{ wsOkxOk = false; });
  }catch(e){ console.log('WS OKX gagal', e.message); }
}
connectWS();
setInterval(()=>{ if(wsBybit) { try{ wsBybit.ping(); }catch(e){} } if(wsOkx) { try{ wsOkx.ping(); }catch(e){} } }, 20000);

async function fetchOne(url){
  try{ const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if(!r.ok) return null; return await r.json(); }catch(e){ return null; }
}
async function fetchOrderbooks(){
  let allBids=[], allAsks=[];
  const w = getWsOrderbooks();
  const bybitWsFresh = wsBybitOk && w.allBids.some(x=> x.source === 'BYBIT') && (Date.now() - wsLastBybit < 5000);
  const okxWsFresh = wsOkxOk && w.allBids.some(x=> x.source === 'OKX') && (Date.now() - wsLastOkx < 5000);
  if(bybitWsFresh || okxWsFresh){ allBids.push(...w.allBids); allAsks.push(...w.allAsks); }
  if(!bybitWsFresh){
    let bybit = await fetchOne('https://api.bytick.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200');
    if(!bybit || !bybit.result || !bybit.result.b){ bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200'); }
    if(bybit && bybit.result && bybit.result.b){ exchanges.bybit=true; bybit.result.b.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source:'BYBIT' })); bybit.result.a.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source:'BYBIT' })); } else { exchanges.bybit=false; }
  } else exchanges.bybit = true;
  if(!okxWsFresh){
    const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
    if(okx && okx.data && okx.data[0]){ exchanges.okx=true; okx.data[0].bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source:'OKX' })); okx.data[0].asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source:'OKX' })); } else exchanges.okx=false;
  } else exchanges.okx = true;
  return { allBids, allAsks };
}
function mergeLevels(list){ const map = new Map(); list.forEach(o=>{ const key = o.price.toFixed(2); if(!map.has(key)) map.set(key, { price: o.price, size: 0, sources: new Set() }); const cur = map.get(key); cur.size += o.size; cur.sources.add(o.source); }); return [...map.values()].map(v=>({ price: v.price, size: v.size, sources: [...v.sources].join('+') })); }

// ===== HARGA = XAUT LANGSUNG, NO SELISIH =====
function buildWalls(allBids, allAsks){
  const bidsAll = mergeLevels(allBids), asksAll = mergeLevels(allAsks);
  if(!bidsAll.length || !asksAll.length) return;
  const bestBid = Math.max(...bidsAll.map(b=> b.price)), bestAsk = Math.min(...asksAll.map(a=> a.price));
  xautPrice = (bestBid + bestAsk) / 2;
  const activeKeys = new Set();
  bidsAll.forEach(o=> activeKeys.add('BID-' + o.price.toFixed(2)));
  asksAll.forEach(o=> activeKeys.add('ASK-' + o.price.toFixed(2)));
  for(const k of firstSeenMap.keys()){ if(!activeKeys.has(k)) firstSeenMap.delete(k); }
  const newWalls = [], newFar = [];
  const pushWall = (side, o, isFar)=>{
    const key = side + '-' + o.price.toFixed(2);
    if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now());
    const age = getAgeMenit(key);
    const wall = { side, price: o.price, size: o.size, sources: o.sources, age_menit: age, first_seen: firstSeenMap.get(key) };
    if(isFar) newFar.push(wall); else newWalls.push(wall);
  };
  const bySource = {};
  allBids.forEach(o=>{ if(!bySource[o.source]) bySource[o.source] = { bids: [], asks: [] }; bySource[o.source].bids.push(o); });
  allAsks.forEach(o=>{ if(!bySource[o.source]) bySource[o.source] = { bids: [], asks: [] }; bySource[o.source].asks.push(o); });
  for(const src of Object.keys(bySource)){
    const b = mergeLevels(bySource[src].bids);
    const a = mergeLevels(bySource[src].asks);
    const sizes = [...b, ...a].map(x=> x.size);
    if(!sizes.length) continue;
    const avgSrc = sizes.reduce((x,y)=> x+y, 0) / sizes.length;
    // MODIF: RATIO 4x - dulu 2.5x
    const thresholdSrc = avgSrc * RATIO_MIN;
    console.log(`WALL ${src} - avg: ${avgSrc.toFixed(2)} threshold (4x): ${thresholdSrc.toFixed(2)} max: ${Math.max(...sizes).toFixed(2)}`);
    b.forEach(o=>{ if(o.size >= thresholdSrc) pushWall('BID', o, false); });
    a.forEach(o=>{ if(o.size >= thresholdSrc) pushWall('ASK', o, false); });
    b.slice().sort((x,y)=> y.size - x.size).slice(0,3).forEach(o=> pushWall('BID', o, true));
    a.slice().sort((x,y)=> y.size - x.size).slice(0,3).forEach(o=> pushWall('ASK', o, true));
  }
  const mergeFinal = (list)=>{
    const map = new Map();
    list.forEach(w=>{
      const k = w.side + '-' + w.price.toFixed(2);
      if(!map.has(k)) map.set(k, { ...w });
      else { const cur = map.get(k); cur.size += w.size; cur.sources = [...new Set((cur.sources + ' + ' + w.sources).split(' + '))].join('+'); }
    });
    return [...map.values()];
  };
  walls = mergeFinal(newWalls);
  wallsFar = mergeFinal(newFar);
}

// ===== PENDING - JARAK DARI HARGA XAUT LANGSUNG =====
function buildPendingOrders(){
  if(!walls.length || !xautPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20); const pending = [], touched = [];
  sorted.forEach(w=>{
    if((w.age_menit || 0) < BETAH_MIN_MENIT) return;
    const jarak = Math.abs(w.price - xautPrice);
    const isTouched = jarak <= JARAK_MAX;
    const item = { ...w, instruction: w.side === 'BID' ? 'BUY' : 'SELL', status: isTouched ? 'TERSENTUH' : 'PENDING', distance: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) };
    if(isTouched) touched.push(item); else pending.push(item);
  });
  pending.sort((a,b)=> b.size - a.size); touched.sort((a,b)=> b.size - a.size); return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}

// ===== SINYAL - ZONA DINAMIS, SL 50 PIPS, TP 50 PIPS =====
function checkSignal(){
  const { pending, touched } = buildPendingOrders();
  if(currentSetup){
    const s = currentSetup;
    const displaySignal = s.signal;
    const isBuy = displaySignal === 'BUY';
    const slHarga = hargaSL(s.zona, isBuy);
    const tpHarga = hargaTP(s.zona, isBuy);
    // Kena SL = LOSE - pake ujung zona SL
    const kenaSL = isBuy ? xautPrice <= slHarga : xautPrice >= slHarga;
    if(kenaSL){
      const profit = calcProfitPips(displaySignal, s.entry, xautPrice);
      lastSetup = { ...s, state: 'CLOSED', result: 'LOSE - SL KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' LOSE - SL KENA di ' + slHarga.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'LOSE - SL KENA', xautPrice);
      sendTelegram(`❌ ${displaySignal} LOSE - Setup ${s.setup_id}\n\nHarga: $${xautPrice.toFixed(2)}\nEntry: ${fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nSL: ${fmtZona(s.zona.slLow, s.zona.slHigh)} (-50 pips)\nHasil: ${profit}`);
      currentSetup = null;
      return;
    }
    // Kena TP = WIN - CUMA 1 TP, SL 50 / TP 50
    const kenaTP = isBuy ? xautPrice >= tpHarga : xautPrice <= tpHarga;
    if(kenaTP){
      const profit = calcProfitPips(displaySignal, s.entry, xautPrice);
      lastSetup = { ...s, state: 'CLOSED', result: 'WIN - TP KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' WIN - TP KENA di ' + tpHarga.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'WIN - TP KENA', xautPrice);
      sendTelegram(`✅ ${displaySignal} WIN - Setup ${s.setup_id}\n\nHarga: $${xautPrice.toFixed(2)}\nEntry: ${fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nTP: ${fmtZona(s.zona.tpLow, s.zona.tpHigh)} (+50 pips)\nHasil: ${profit}`);
      currentSetup = null;
      return;
    }
    return;
  }
  // Belum ada posisi - cari tembok yang jaraknya 0-3$ doang
  const gabungan = [...touched, ...pending];
  if(!gabungan.length || !xautPrice) return;
  const kandidat = gabungan.filter(w => w.distance >= JARAK_MIN && w.distance <= JARAK_MAX);
  if(!kandidat.length) return;
  const byJarak = [...kandidat].sort((a,b)=> a.distance - b.distance);
  const terdekat = byJarak[0];
  // MODIF: DULU distance > 15 baru return, SEKARANG cuma 0-3$ yang lolos, di atas udah ke-filter
  const isBuy = terdekat.side === 'BID';
  // MODIF: Entry bukan harga sekarang lagi, tapi ZONA tembok s/d harga sekarang
  const zona = hitungZona(terdekat.price, xautPrice, isBuy);
  const entry = isBuy ? zona.entryLow : zona.entryHigh; // harga acuan buat hitung profit
  const slHarga = hargaSL(zona, isBuy);
  const tpHarga = hargaTP(zona, isBuy);
  const setupId = generateSetupId();
  const displaySignal = isBuy ? 'BUY' : 'SELL';
  const now = Date.now();
  currentSetup = {
    id: 'SIG-' + now,
    setup_id: setupId,
    signal: displaySignal,
    state: 'IN_POSITION',
    // Legacy - biar frontend lama tetep jalan
    entry, sl: slHarga, tp: tpHarga,
    // Zona baru
    zona, jarak: zona.jarak,
    entry_low: zona.entryLow, entry_high: zona.entryHigh,
    sl_low: zona.slLow, sl_high: zona.slHigh,
    tp_low: zona.tpLow, tp_high: zona.tpHigh,
    sl_pips: SL_PIPS, tp_pips: TP_PIPS,
    lockedAt: now, closed_at: null, result: 'AKTIF',
    wall: { side: terdekat.side, price: terdekat.price, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, distance: terdekat.distance },
    lock_status: 'IN POSITION - ' + displaySignal + ' di ' + fmtZona(zona.entryLow, zona.entryHigh)
  };
  addHistory({ id: currentSetup.id, setup_id: setupId, signal: displaySignal + ' NOW', wall_side: terdekat.side, wall_price: terdekat.price,
    entry, sl: slHarga, tp: tpHarga,
    entry_low: zona.entryLow, entry_high: zona.entryHigh,
    sl_low: zona.slLow, sl_high: zona.slHigh,
    tp_low: zona.tpLow, tp_high: zona.tpHigh,
    sl_pips: SL_PIPS, tp_pips: TP_PIPS, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: now, closed_at: null, result: 'AKTIF', result_price: null, duration_menit: 0 });
  // MODIF: FORMAT TELEGRAM BARU - ZONA DINAMIS + HOLD
  if(isBuy){
    sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId}\n\nEntry: ${fmtZona(zona.entryLow, zona.entryHigh)} (zona ${zona.jarak * 10} pips dari harga sekarang)\nSL: ${fmtZona(zona.slLow, zona.slHigh)} ( SL -50 pips dari harga entry)\nTP: ${fmtZona(zona.tpLow, zona.tpHigh)} (TP +50 pips dari harga entry )\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${zona.jarak}$)\n\nHOLD BAGI YANG MAMPU🔥`);
  } else {
    sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId}\n\nEntry: ${fmtZona(zona.entryLow, zona.entryHigh)} (zona ${zona.jarak * 10} pips dari harga sekarang)\nSL: ${fmtZona(zona.slLow, zona.slHigh)} ( SL -50 pips dari harga entry)\nTP: ${fmtZona(zona.tpLow, zona.tpHigh)} (TP +50 pips dari harga entry )\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${zona.jarak}$)\n\nHOLD BAGI YANG MAMPU🔥`);
  }
}
let tickRunning = false;
async function tick(){
  if(tickRunning) return;
  tickRunning = true;
  try{
    const { allBids, allAsks } = await fetchOrderbooks();
    if(allBids.length) buildWalls(allBids, allAsks);
    checkSignal();
    lastUpdate = Date.now();
  }catch(e){ console.log('tick gagal', e.message); }
  tickRunning = false;
}
setInterval(tick, 1000); tick();
function buildSignalResponse(){
  const { pending, touched } = buildPendingOrders();
  if(currentSetup){
    const s = currentSetup;
    return { signal: s.signal + ' - AKTIF', reason: '', setup_id: s.setup_id, pending, touched,
      entry: s.entry, entry_mt5: s.entry, sl: s.sl, sl_mt5: s.sl, tp: s.tp, tp_mt5: s.tp,
      entry_low: s.entry_low, entry_high: s.entry_high,
      sl_low: s.sl_low, sl_high: s.sl_high,
      tp_low: s.tp_low, tp_high: s.tp_high,
      jarak: s.jarak, zona: s.zona,
      sl_pips: SL_PIPS, tp_pips: TP_PIPS, is_locked: true, lockedState: s.state, lockedAt: s.lockedAt, lockedId: s.id, lock_status: s.lock_status, wall: s.wall };
  }
  return { signal: 'WAIT', reason: '', setup_id: '', pending, touched,
    entry: 0, entry_mt5: 0, sl: 0, sl_mt5: 0, tp: 0, tp_mt5: 0,
    entry_low: 0, entry_high: 0, sl_low: 0, sl_high: 0, tp_low: 0, tp_high: 0, jarak: 0, zona: null,
    sl_pips: SL_PIPS, tp_pips: TP_PIPS, is_locked: false, lockedState: 'IDLE', lockedAt: null, lockedId: null, lock_status: lastSetup ? 'Last: ' + (lastDone ? lastDone.last_result : lastSetup.result) : 'Tidak terkunci', wall: null };
}
function calcWinrate(){
  const closed = signalHistory.filter(x=> x.closed_at);
  const win = closed.filter(x=> (x.result||'').includes('WIN')).length;
  const lose = closed.filter(x=> (x.result||'').includes('LOSE')).length;
  const total = win + lose;
  return { total, win, lose, winrate: total ? Math.round(win/total*100) : 0 };
}
app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - V11 XAUT ONLY - Jarak 0-3$ Betah 5m Ratio 4x Zona SL50 TP50'));
app.get('/api/signal', (req,res)=>{
  const sig = buildSignalResponse();
  const wr = calcWinrate();
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, winrate_data: wr, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF', harga: { xaut: xautPrice, xaut_mid: xautPrice, source: 'XAUT WS Bybit+OKX 200ms - NO GOLD-API, NO SELISIH, NO EXNESS', ws_bybit: wsBybitOk ? 'WS-OK' : 'WS-OFF/REST', ws_okx: wsOkxOk ? 'WS-OK' : 'WS-OFF/REST', ws_last_bybit: wsLastBybit, ws_last_okx: wsLastOkx }, exchanges, uptimeStart, uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone, last_setup: lastSetup, current_setup: currentSetup });
});
app.get('/api/history', (req,res)=>{
  const since = req.query.since ? parseInt(req.query.since) : uptimeStart;
  const filtered = signalHistory.filter(x => (x.created_at || 0) >= since);
  const wr = calcWinrate();
  res.json({ history: filtered, total: filtered.length, winrate_data: wr, uptimeStart, sesi_mulai: new Date(uptimeStart).toLocaleString('id-ID'), uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000) });
});
app.get('/api/history-sesi', (req,res)=>{ res.redirect('/api/history'); });
app.get('/api/ws-test', (req,res)=>{ const w=getWsOrderbooks(); res.json({ ws_bybit_ok: wsBybitOk, ws_okx_ok: wsOkxOk, ws_last_bybit: wsLastBybit ? new Date(wsLastBybit).toLocaleTimeString('id-ID') : '-', ws_last_okx: wsLastOkx ? new Date(wsLastOkx).toLocaleTimeString('id-ID') : '-', bids_cached: w.allBids.length, asks_cached: w.allAsks.length, top_bid: w.allBids.length ? Math.max(...w.allBids.map(x=>x.price)) : 0, top_ask: w.allAsks.length ? Math.min(...w.allAsks.map(x=>x.price)) : 0, xaut_price: xautPrice }); });
app.get('/api/test-telegram', async (req,res)=>{
  const testId = generateSetupId();
  // Contoh BUY - zona ngikutin jarak 1$
  const z = { jarak: 1, entryLow: 3830, entryHigh: 3831, slLow: 3825, slHigh: 3826, tpLow: 3835, tpHigh: 3836 };
  await sendTelegram(`🎯 BUY NOW - Setup ${testId}\n\nEntry: ${fmtZona(z.entryLow, z.entryHigh)} (zona ${z.jarak * 10} pips dari harga sekarang)\nSL: ${fmtZona(z.slLow, z.slHigh)} ( SL -50 pips dari harga entry)\nTP: ${fmtZona(z.tpLow, z.tpHigh)} (TP +50 pips dari harga entry )\n\nTembok: BID $3830.30 - 13.70 XAUT - Betah 8m - OKX (jarak ${z.jarak}$)\n\nHOLD BAGI YANG MAMPU🔥`);
  res.json({ ok: true, setup_id: testId, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' });
});
app.get('/api/unlock', (req,res)=>{
  if(currentSetup){
    lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xautPrice, closed_at: Date.now() };
    closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xautPrice);
    currentSetup = null;
    res.json({ ok: true, msg: 'Unlocked - posisi dibatalkan manual' });
  } else res.json({ ok: true, msg: 'Gak ada posisi aktif' });
});
app.listen(PORT, ()=> console.log('ABEL BOT V11 jalan di port ' + PORT + ' - Jarak 0-3$ Betah 5m Ratio 4x Zona SL50 TP50'));
