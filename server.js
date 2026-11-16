// ABEL BOT - V8.4 NO-BINANCE + THRESHOLD PER-EXCHANGE - MESIN DI SERVER, API CUMA BACA, 1 SETUP = 1 OBJEK
// MODIF: + TELEGRAM PRIBADI+CHANNEL + /api/history SESI INI
// MODIF V8.3: HAPUS BINANCE TOTAL - CUMA BYBIT + OKX
// MODIF V8.4: BYBIT VIA BYTICK (ANTI-BLOCK) + THRESHOLD DIPISAH PER EXCHANGE BIAR BYBIT GAK KE-FILTER OKX
// MODIF V9.2 REALTIME: SERVER->BYBIT/OKX PAKAI WEBSOCKET (200ms). SERVER->EXNESS POLLING 1 DETIK (MENTOK EXNESS, JANGAN LEBIH CEPET NANTI KE-BLOCK).
// PWA->SERVER TETEP POLLING 1 DETIK (SIMPLE, ANTI PUTUS). BID/ASK+TEMBOK TETEP BYBIT+OKX. EXNESS CUMA HARGA ACUAN MT5. BOT MQL BELUM DISAMBUNG.
// CARA PASANG: npm install ws  ATAU tambah "ws": "^8.18.0" di package.json -> Render > Environment isi EXNESS_API_KEY, EXNESS_API_SECRET, EXNESS_ACCOUNT_ID -> Deploy
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

// ===== EXNESS - CUMA HARGA ACUAN MT5, POLLING 1 DETIK =====
const EXNESS_API_KEY = process.env.EXNESS_API_KEY || '';
const EXNESS_API_SECRET = process.env.EXNESS_API_SECRET || '';
const EXNESS_ACCOUNT_ID = process.env.EXNESS_ACCOUNT_ID || '';
const EXNESS_API_BASE_URL = (process.env.EXNESS_API_BASE_URL || 'https://api.exness.com').replace(/\/$/, '');
let exnessPrice = 0, exnessLastOk = 0, exnessLastError = '';
let exnessStatus = 'BELUM JALAN';

// ===== WEBSOCKET BYBIT+OKX - REALTIME ORDERBOOK =====
// Butuh package 'ws'. Di Render: npm install ws. Kalo 'ws' gak ada, otomatis fallback ke REST polling 1 detik biar gak crash.
let WSClient = null;
try{ WSClient = require('ws'); }catch(e){ console.log('Package ws belum ke-install, fallback REST polling. Jalankan: npm install ws'); }
let wsBybit = null, wsOkx = null, wsBybitOk = false, wsOkxOk = false, wsLastBybit = 0, wsLastOkx = 0;
// Cache orderbook dari WS, format sama kayak REST biar buildWalls gak perlu diubah
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

let walls = [], wallsFar = [], xautPrice = 0, xauusdPrice = 0, lastKnownXauusd = 0, selisih = 0, goldSource = '-';
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
function calcProfit(signal, entry, harga){
  const p = signal === 'BUY' ? (harga - entry) : (entry - harga);
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '$';
}

function parseExnessQuote(d){
  if(!d) return null;
  const cands=[];
  if(Array.isArray(d)) cands.push(...d);
  if(d.data && Array.isArray(d.data)) cands.push(...d.data);
  if(d.quotes && Array.isArray(d.quotes)) cands.push(...d.quotes);
  if(d.result && Array.isArray(d.result)) cands.push(...d.result);
  if(d.symbol || d.bid || d.ask || d.price) cands.push(d);
  if(d.data && (d.data.bid || d.data.ask || d.data.price)) cands.push(d.data);
  for(const q of cands){
    const sym=(q.symbol||q.instrument||q.pair||q.name||'').toString().toUpperCase();
    if(sym && !sym.includes('XAU')) continue;
    const bid=parseFloat(q.bid ?? q.bidPrice ?? q.buy ?? q.b);
    const ask=parseFloat(q.ask ?? q.askPrice ?? q.sell ?? q.a);
    const mid=parseFloat(q.mid ?? q.price ?? q.last ?? q.close);
    if(bid>1000 && ask>1000) return { mid:(bid+ask)/2 };
    if(mid>1000) return { mid };
  }
  return null;
}
async function fetchExnessPrice(){
  if(!EXNESS_API_KEY || !EXNESS_API_SECRET){ exnessStatus='NO-KEY'; exnessLastError='EXNESS_API_KEY / SECRET belum diisi di Render Environment'; return false; }
  const headers={ 'Content-Type':'application/json','User-Agent':'ABEL-FX/9.2','X-API-Key':EXNESS_API_KEY,'X-API-Secret':EXNESS_API_SECRET,'Authorization':'Bearer '+EXNESS_API_KEY };
  const body=JSON.stringify({ symbols:['XAUUSD'], symbol:'XAUUSD', accountId: EXNESS_ACCOUNT_ID || undefined, account_id: EXNESS_ACCOUNT_ID || undefined });
  const paths=['/trading/v1/quotes','/v1/quotes','/trading/quotes','/trading/v1/ticker','/v1/ticker'];
  for(const p of paths){
    try{ const r=await fetch(EXNESS_API_BASE_URL+p,{method:'POST',headers,body,signal:AbortSignal.timeout(4000)}); if(r.ok){ const d=await r.json().catch(()=>null); const q=parseExnessQuote(d); if(q){ exnessPrice=q.mid; xauusdPrice=q.mid; lastKnownXauusd=q.mid; goldSource='Exness DEMO Raw Spread'; exnessStatus='EXNESS-OK'; exnessLastOk=Date.now(); exnessLastError=''; return true; } } }catch(e){ exnessLastError=e.message; }
    try{ const r=await fetch(EXNESS_API_BASE_URL+p+'?symbol=XAUUSD&symbols=XAUUSD'+(EXNESS_ACCOUNT_ID?'&accountId='+EXNESS_ACCOUNT_ID:''),{headers,signal:AbortSignal.timeout(4000)}); if(r.ok){ const d=await r.json().catch(()=>null); const q=parseExnessQuote(d); if(q){ exnessPrice=q.mid; xauusdPrice=q.mid; lastKnownXauusd=q.mid; goldSource='Exness DEMO Raw Spread'; exnessStatus='EXNESS-OK'; exnessLastOk=Date.now(); exnessLastError=''; return true; } } }catch(e){ exnessLastError=e.message; }
  }
  exnessStatus='EXNESS-GAGAL'; return false;
}
async function fetchGoldPrice(){
  const okExness = await fetchExnessPrice();
  if(okExness) return true;
  try{ const r = await fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0' } }); const d = await r.json(); if(d && d.price && d.price > 1000){ xauusdPrice = d.price; lastKnownXauusd = d.price; goldSource = 'Gold-API (FALLBACK Exness gagal: ' + (exnessLastError || exnessStatus) + ')'; return true; } }catch(e){}
  try{ const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0' } }); const d = await r.json(); if(d && d.items && d.items[0] && d.items[0].xauPrice > 1000){ xauusdPrice = d.items[0].xauPrice; lastKnownXauusd = d.items[0].xauPrice; goldSource = 'GoldPrice.org (FALLBACK)'; return true; } }catch(e){}
  if(lastKnownXauusd > 1000){ xauusdPrice = lastKnownXauusd; goldSource = goldSource + ' (last known)'; return true; }
  if(xautPrice > 1000){ xauusdPrice = xautPrice; goldSource = 'XAUT fallback'; return true; }
  return false;
}
// ===== WEBSOCKET BYBIT + OKX =====
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
  try{
    wsBybit = new WSClient('wss://stream.bybit.com/v5/public/spot');
    wsBybit.on('open', ()=>{ wsBybit.send(JSON.stringify({ op:'subscribe', args:['orderbook.200.XAUTUSDT'] })); console.log('BYBIT WS CONNECTED'); });
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
    wsBybit.on('close', ()=>{ wsBybitOk=false; exchanges.bybit=false; console.log('BYBIT WS PUTUS, reconnect 2 detik...'); setTimeout(startBybitWS,2000); });
    wsBybit.on('error', ()=>{ try{ wsBybit.close(); }catch(e){} });
  }catch(e){ console.log('Bybit WS gagal start', e.message); }
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
  // V9.2 UTAMA: ambil dari cache WebSocket (realtime 200ms). Kalo WS belum ada data / putus >5 detik, fallback REST polling 1 detik.
  const wsData = getWsOrderbooks();
  const wsFresh = (Date.now() - wsLastBybit < 5000) || (Date.now() - wsLastOkx < 5000);
  if(wsData.allBids.length > 10 && wsFresh){
    exchanges.bybit = (Date.now() - wsLastBybit < 5000);
    exchanges.okx = (Date.now() - wsLastOkx < 5000);
    return wsData;
  }
  let bybit = await fetchOne('https://api.bytick.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200');
  if(!bybit || !bybit.result || !bybit.result.b){ bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=200'); }
  const okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=200');
  let allBids = [], allAsks = [];
  if(bybit && bybit.result && bybit.result.b){ exchanges.bybit = true; bybit.result.b.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' })); bybit.result.a.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'BYBIT' })); } else { exchanges.bybit = false; }
  if(okx && okx.data && okx.data[0]){ exchanges.okx = true; okx.data[0].bids.forEach(([p,s])=> allBids.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' })); okx.data[0].asks.forEach(([p,s])=> allAsks.push({ price: parseFloat(p), size: parseFloat(s), source: 'OKX' })); } else exchanges.okx = false;
  return { allBids, allAsks };
}
function mergeLevels(list){ const map = new Map(); list.forEach(o=>{ const key = o.price.toFixed(2); if(!map.has(key)) map.set(key, { price: o.price, size: 0, sources: new Set() }); const cur = map.get(key); cur.size += o.size; cur.sources.add(o.source); }); return [...map.values()].map(v=>({ price: v.price, size: v.size, sources: [...v.sources].join('+') })); }
function buildWalls(allBids, allAsks){
  const bidsAll = mergeLevels(allBids), asksAll = mergeLevels(allAsks);
  if(!bidsAll.length || !asksAll.length) return;
  const bestBid = Math.max(...bidsAll.map(b=> b.price)), bestAsk = Math.min(...asksAll.map(a=> a.price));
  xautPrice = (bestBid + bestAsk) / 2;
  if(xauusdPrice > 1000) selisih = xautPrice - xauusdPrice;
  const activeKeys = new Set();
  bidsAll.forEach(o=> activeKeys.add('BID-' + o.price.toFixed(2)));
  asksAll.forEach(o=> activeKeys.add('ASK-' + o.price.toFixed(2)));
  for(const k of firstSeenMap.keys()){ if(!activeKeys.has(k)) firstSeenMap.delete(k); }
  const newWalls = [], newFar = [];
  const pushWall = (side, o, isFar)=>{
    const key = side + '-' + o.price.toFixed(2);
    if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now());
    const age = getAgeMenit(key);
    const mt5 = o.price - selisih;
    const wall = { side, price: o.price, price_mt5: Math.floor(mt5 * 100) / 100, size: o.size, sources: o.sources, age_menit: age, first_seen: firstSeenMap.get(key) };
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
function buildPendingOrders(){
  if(!walls.length || !xauusdPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20); const pending = [], touched = [];
  sorted.forEach(w=>{ if((w.age_menit || 0) < 5) return; const mt5 = w.price_mt5 || (w.price - selisih); const jarak = Math.abs(mt5 - xauusdPrice); const isTouched = jarak <= 3; const item = { ...w, price_mt5: Math.floor(mt5 * 100) / 100, instruction: w.side === 'BID' ? 'BUY' : 'SELL', status: isTouched ? 'TERSENTUH' : 'PENDING', distance_mt5: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) }; if(isTouched) touched.push(item); else pending.push(item); });
  pending.sort((a,b)=> b.size - a.size); touched.sort((a,b)=> b.size - a.size); return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}
function checkSignal(){
  const { pending, touched } = buildPendingOrders();
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
setInterval(async ()=>{ try{ await fetchGoldPrice(); }catch(e){} }, 1000);
setInterval(tick, 1000); tick(); fetchGoldPrice();
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
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF', harga: { xaut_mid: xautPrice, xauusd_goldprice: xauusdPrice, xauusd_exness: exnessPrice, selisih, source: goldSource, exness_status: exnessStatus, exness_last_error: exnessLastError, exness_last_ok: exnessLastOk, ws_bybit: wsBybitOk ? 'WS-OK' : 'WS-OFF/REST', ws_okx: wsOkxOk ? 'WS-OK' : 'WS-OFF/REST', ws_last_bybit: wsLastBybit, ws_last_okx: wsLastOkx }, range: { low: 3893, high: 4060 }, exchanges, supabase: 'OK', uptimeStart, uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone, last_setup: lastSetup, current_setup: currentSetup });
});
app.get('/api/history', (req,res)=>{
  const since = req.query.since ? parseInt(req.query.since) : uptimeStart;
  const filtered = signalHistory.filter(x => (x.created_at || 0) >= since);
  res.json({ history: filtered, total: filtered.length, uptimeStart, sesi_mulai: new Date(uptimeStart).toLocaleString('id-ID'), uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000) });
});
app.get('/api/history-sesi', (req,res)=>{ res.redirect('/api/history'); });
app.get('/api/exness-test', async (req,res)=>{
  const ok = await fetchExnessPrice();
  res.json({ ok, source: goldSource, status: exnessStatus, harga_acuan_mt5: xauusdPrice, harga_exness: exnessPrice, last_error: exnessLastError, last_ok: exnessLastOk ? new Date(exnessLastOk).toLocaleString('id-ID') : null, key_terisi: !!EXNESS_API_KEY, secret_terisi: !!EXNESS_API_SECRET, account_terisi: !!EXNESS_ACCOUNT_ID, ws_bybit: wsBybitOk, ws_okx: wsOkxOk, ws_bids_cached: wsBooks.BYBIT.bids.size + wsBooks.OKX.bids.size, ws_asks_cached: wsBooks.BYBIT.asks.size + wsBooks.OKX.asks.size, note: 'Exness polling 1 detik. Bybit+OKX WebSocket. BID/ASK+tembok dari Bybit+OKX.' });
});
app.get('/api/ws-test', (req,res)=>{ const w=getWsOrderbooks(); res.json({ ws_bybit_ok: wsBybitOk, ws_okx_ok: wsOkxOk, ws_last_bybit: wsLastBybit ? new Date(wsLastBybit).toLocaleTimeString('id-ID') : '-', ws_last_okx: wsLastOkx ? new Date(wsLastOkx).toLocaleTimeString('id-ID') : '-', bids_cached: w.allBids.length, asks_cached: w.allAsks.length, top_bid: w.allBids.length ? Math.max(...w.allBids.map(x=>x.price)) : 0, top_ask: w.allAsks.length ? Math.min(...w.allAsks.map(x=>x.price)) : 0 }); });
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
app.listen(PORT, ()=> console.log('ABEL BOT V9.2 REALTIME WS jalan di port ' + PORT + ' | WS lib: ' + (WSClient ? 'OK' : 'BELUM INSTALL ws') + ' | Exness: ' + (EXNESS_API_KEY ? 'TERISI' : 'KOSONG')));
