// ABEL BOT - V10 XAUT ONLY - NO GOLD-API, NO SELISIH, NO EXNESS, 1 TP ONLY
// HARGA = XAUT WS BYBIT+OKX 200ms LANGSUNG. GAK ADA KONVERSI MT5.
// SINYAL: BUY/SELL NOW, SL 50 PIPS (5$), TP 100 PIPS (10$). WINRATE HITUNG 1 TP DOANG.
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

// ===== V10: NO EXNESS, NO GOLD-API, NO SELISIH =====
// Harga = XAUT WS langsung. Exness Trading API udah dihapus dari env, gak dipake lagi.

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
  // 1$ = 10 pips buat XAU
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
function startBybitWS(){
  if(!WSClient) return;
  const urls = ['wss://stream.bytick.com/v5/public/spot', 'wss://stream.bybit.com/v5/public/spot'];
  let urlIdx = 0;
  const connect = () => {
    try{
      const url = urls[urlIdx];
      console.log('BYBIT WS nyoba connect ke: ' + url);
      wsBybit = new WSClient(url);
      wsBybit.on('open', ()=>{ wsBybit.send(JSON.stringify({ op:'subscribe', args:['orderbook.200.XAUTUSDT'] })); console.log('BYBIT WS CONNECTED via ' + url); });
      wsBybit.on('message', (raw)=>{
        try{
          const d=JSON.parse(raw.toString());
          if(d.topic==='orderbook.200.XAUTUSDT' && d.data){
            const isSnap = d.type==='snapshot';
            applyWsBook('BYBIT', d.data.b, d.data.a, isSnap);
            wsBybitOk=true; wsLastBybit=Date.now(); exchanges.bybit=true;
          }
        }catch(e){}
      });
      wsBybit.on('close', ()=>{ wsBybitOk=false; exchanges.bybit=false; console.log('BYBIT WS PUTUS dari ' + url + ', reconnect 2 detik...'); urlIdx = (urlIdx + 1) % urls.length; setTimeout(connect,2000); });
      wsBybit.on('error', (e)=>{ console.log('BYBIT WS ERROR ' + url + ' : ' + (e.message||e)); try{ wsBybit.close(); }catch(_){} });
    }catch(e){ console.log('Bybit WS gagal start', e.message); }
  };
  connect();
}
function startOkxWS(){
  if(!WSClient) return;
  try{
    wsOkx = new WSClient('wss://ws.okx.com:8443/ws/v5/public');
    wsOkx.on('open', ()=>{ wsOkx.send(JSON.stringify({ op:'subscribe', args:[{ channel:'books', instId:'XAUT-USDT', sz:'200' }] })); console.log('OKX WS CONNECTED'); });
    wsOkx.on('message', (raw)=>{
      try{
        const d=JSON.parse(raw.toString());
        if(d.arg && d.arg.channel==='books' && d.data && d.data[0]){
          const item=d.data[0];
          const isSnap = d.action==='snapshot';
          applyWsBook('OKX', item.bids, item.asks, isSnap);
          wsOkxOk=true; wsLastOkx=Date.now(); exchanges.okx=true;
        }
      }catch(e){}
    });
    wsOkx.on('close', ()=>{ wsOkxOk=false; exchanges.okx=false; console.log('OKX WS PUTUS, reconnect 2 detik...'); setTimeout(startOkxWS,2000); });
    wsOkx.on('error', ()=>{ try{ wsOkx.close(); }catch(e){} });
  }catch(e){ console.log('OKX WS gagal start', e.message); }
}
startBybitWS(); startOkxWS();

async function fetchOne(url, headers){ try{ const r = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(5000) }); const t = await r.text(); if(!t.trim().startsWith('{') && !t.trim().startsWith('[')) return null; return JSON.parse(t); }catch(e){ return null; } }
async function fetchOrderbooks(){
  const wsData = getWsOrderbooks();
  const bybitWsFresh = (Date.now() - wsLastBybit < 5000) && wsBooks.BYBIT.bids.size > 10;
  const okxWsFresh = (Date.now() - wsLastOkx < 5000) && wsBooks.OKX.bids.size > 10;
  if(bybitWsFresh && okxWsFresh){ exchanges.bybit=true; exchanges.okx=true; return wsData; }
  let allBids=[], allAsks=[];
  if(bybitWsFresh){ exchanges.bybit=true; wsBooks.BYBIT.bids.forEach((size,price)=> allBids.push({ price, size, source:'BYBIT' })); wsBooks.BYBIT.asks.forEach((size,price)=> allAsks.push({ price, size, source:'BYBIT' })); }
  if(okxWsFresh){ exchanges.okx=true; wsBooks.OKX.bids.forEach((size,price)=> allBids.push({ price, size, source:'OKX' })); wsBooks.OKX.asks.forEach((size,price)=> allAsks.push({ price, size, source:'OKX' })); }
  if(!bybitWsFresh){
    let bybit = await fetchOne('https://api.bytick.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200');
    if(!bybit || !bybit.result || !bybit.result.b){ bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200'); }
    if(bybit && bybit.result && bybit.result.b){ exchanges.bybit=true; bybit.result.b.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source:'BYBIT' })); bybit.result.a.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source:'BYBIT' })); } else { exchanges.bybit=false; }
  }
  if(!okxWsFresh){
    const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
    if(okx && okx.data && okx.data[0]){ exchanges.okx=true; okx.data[0].bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source:'OKX' })); okx.data[0].asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source:'OKX' })); } else exchanges.okx=false;
  }
  return { allBids, allAsks };
}
function mergeLevels(list){ const map = new Map(); list.forEach(o=>{ const key = o.price.toFixed(2); if(!map.has(key)) map.set(key, { price: o.price, size: 0, sources: new Set() }); const cur = map.get(key); cur.size += o.size; cur.sources.add(o.source); }); return [...map.values()].map(v=>({ price: v.price, size: v.size, sources: [...v.sources].join('+') })); }

// ===== V10: HARGA = XAUT LANGSUNG, NO SELISIH =====
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
    // V10: price = harga XAUT asli, gak ada price_mt5 lagi
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
    const thresholdSrc = avgSrc * 2.5;
    console.log(`WALL ${src} - avg: ${avgSrc.toFixed(2)} threshold: ${thresholdSrc.toFixed(2)} max: ${Math.max(...sizes).toFixed(2)}`);
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

// ===== V10: PENDING - JARAK DARI HARGA XAUT LANGSUNG, BUKAN MT5 =====
function buildPendingOrders(){
  if(!walls.length || !xautPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20); const pending = [], touched = [];
  sorted.forEach(w=>{ if((w.age_menit || 0) < 5) return; const jarak = Math.abs(w.price - xautPrice); const isTouched = jarak <= 3; const item = { ...w, instruction: w.side === 'BID' ? 'BUY' : 'SELL', status: isTouched ? 'TERSENTUH' : 'PENDING', distance: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) }; if(isTouched) touched.push(item); else pending.push(item); });
  pending.sort((a,b)=> b.size - a.size); touched.sort((a,b)=> b.size - a.size); return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}

// ===== V10: SINYAL 1 TP DOANG - SL 50 PIPS (5$), TP 100 PIPS (10$) =====
function checkSignal(){
  const { pending, touched } = buildPendingOrders();
  if(currentSetup){
    const s = currentSetup;
    const displaySignal = s.signal;
    // Kena SL = LOSE
    const kenaSL = displaySignal === 'BUY' ? xautPrice <= s.sl : xautPrice >= s.sl;
    if(kenaSL){
      const profit = calcProfitPips(displaySignal, s.entry, xautPrice);
      lastSetup = { ...s, state: 'CLOSED', result: 'LOSE - SL KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' LOSE - SL KENA di ' + s.sl.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'LOSE - SL KENA', xautPrice);
      sendTelegram(`❌ ${displaySignal} LOSE - Setup ${s.setup_id}\n\nHarga: $${xautPrice.toFixed(2)}\nEntry: $${s.entry.toFixed(2)}\nSL: $${s.sl.toFixed(2)} (-50 pips)\nHasil: ${profit}`);
      currentSetup = null;
      return;
    }
    // Kena TP = WIN - CUMA 1 TP, GAK ADA TP2 / BE / TP1
    const kenaTP = displaySignal === 'BUY' ? xautPrice >= s.tp : xautPrice <= s.tp;
    if(kenaTP){
      const profit = calcProfitPips(displaySignal, s.entry, xautPrice);
      lastSetup = { ...s, state: 'CLOSED', result: 'WIN - TP KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' WIN - TP KENA di ' + s.tp.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'WIN - TP KENA', xautPrice);
      sendTelegram(`✅ ${displaySignal} WIN - Setup ${s.setup_id}\n\nHarga: $${xautPrice.toFixed(2)}\nEntry: $${s.entry.toFixed(2)}\nTP: $${s.tp.toFixed(2)} (+100 pips)\nHasil: ${profit}`);
      currentSetup = null;
      return;
    }
    return;
  }
  if(!pending.length || !xautPrice) return;
  const byJarak = [...pending].sort((a,b)=> a.distance - b.distance);
  const terdekat = byJarak[0];
  if(terdekat.distance > 15) return;
  const isBuy = terdekat.side === 'BID';
  const entry = Math.floor(xautPrice * 100) / 100;
  // V10: SL 5$ = 50 pips, TP 10$ = 100 pips. 1$ = 10 pips.
  let sl, tp;
  if(isBuy){ sl = entry - 5; tp = entry + 10; }
  else { sl = entry + 5; tp = entry - 10; }
  const setupId = generateSetupId();
  const displaySignal = isBuy ? 'BUY' : 'SELL';
  const now = Date.now();
  currentSetup = {
    id: 'SIG-' + now,
    setup_id: setupId,
    signal: displaySignal,
    state: 'IN_POSITION',
    entry, sl, tp,
    sl_pips: 50, tp_pips: 100,
    lockedAt: now, closed_at: null, result: 'AKTIF',
    wall: { side: terdekat.side, price: terdekat.price, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, distance: terdekat.distance },
    lock_status: 'IN POSITION - ' + displaySignal + ' di ' + entry.toFixed(2)
  };
  addHistory({ id: currentSetup.id, setup_id: setupId, signal: displaySignal + ' NOW', wall_side: terdekat.side, wall_price: terdekat.price, entry, sl, tp, sl_pips: 50, tp_pips: 100, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: now, closed_at: null, result: 'AKTIF', result_price: null, duration_menit: 0 });
  // V10 FORMAT TELEGRAM BARU - SIMPEL, GAK ADA TP2
  sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId}\n\nEntry: $${entry.toFixed(2)}\nSL: $${sl.toFixed(2)} (-50 pips)\nTP: $${tp.toFixed(2)} (+100 pips)\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${terdekat.distance.toFixed(1)}$)`);
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
    return { signal: s.signal + ' - AKTIF', reason: '', setup_id: s.setup_id, pending, touched, entry: s.entry, entry_mt5: s.entry, sl: s.sl, sl_mt5: s.sl, tp: s.tp, tp_mt5: s.tp, sl_pips: 50, tp_pips: 100, is_locked: true, lockedState: s.state, lockedAt: s.lockedAt, lockedId: s.id, lock_status: s.lock_status, wall: s.wall };
  }
  return { signal: 'WAIT', reason: '', setup_id: '', pending, touched, entry: 0, entry_mt5: 0, sl: 0, sl_mt5: 0, tp: 0, tp_mt5: 0, sl_pips: 50, tp_pips: 100, is_locked: false, lockedState: 'IDLE', lockedAt: null, lockedId: null, lock_status: lastSetup ? 'Last: ' + (lastDone ? lastDone.last_result : lastSetup.result) : 'Tidak terkunci', wall: null };
}
function calcWinrate(){
  const closed = signalHistory.filter(x=> x.closed_at);
  const win = closed.filter(x=> (x.result||'').includes('WIN')).length;
  const lose = closed.filter(x=> (x.result||'').includes('LOSE')).length;
  const total = win + lose;
  return { total, win, lose, winrate: total ? Math.round(win/total*100) : 0 };
}
app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - V10 XAUT ONLY'));
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
app.get('/api/test-telegram', async (req,res)=>{ const testId = generateSetupId(); await sendTelegram(`🎯 BUY NOW - Setup ${testId}\n\nEntry: $3854.19\nSL: $3849.19 (-50 pips)\nTP: $3864.19 (+100 pips)\n\nTembok: BID $3852.90 - 58.38 XAUT - Betah 5m - OKX (jarak 1.2$)`); res.json({ ok: true, setup_id: testId, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' }); });
app.get('/api/unlock', (req,res)=>{
  if(currentSetup){
    lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xautPrice, closed_at: Date.now() };
    closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xautPrice);
    lastDone = { last_result: 'Dibatalkan manual - Setup ' + currentSetup.setup_id };
    currentSetup = null;
  }
  res.json({ ok: true, msg: 'Lock dibatalkan' });
});
app.listen(PORT, ()=> console.log('ABEL BOT V10 XAUT ONLY jalan di port ' + PORT + ' | WS lib: ' + (WSClient ? 'OK' : 'BELUM INSTALL ws') + ' | Harga: XAUT WS 200ms langsung, NO GOLD-API, NO EXNESS'));
