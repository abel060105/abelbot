// ABEL BOT - V13.4 - Jarak 0-1$, Size 5x, Betah 5m
// LOGIC DIKUNCI: Zona = Tembok s/d Harga, SL 50 pips, TP 50 pips
// HARGA SINYAL = XAUT WS BYBIT+OKX. HARGA MT5 = DARI RDP VIA POST /api/mt5/price (BELUM JALAN)
// Render Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PORT.
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
let JARAK_MIN = 0;
let JARAK_MAX = 1;
let BETAH_MIN_MENIT = 5;
let RATIO_MIN = 5;
let SL_PIPS = 50;
let TP_PIPS = 50;
let SL_DOLLAR = 5;
let TP_DOLLAR = 5;
let CFG = {
  lot: 0.01,
  simbol: 'XAUUSD',
  slMode: 'FIX',
  slFix: 50, tpFix: 50,
  slMin: 20, slMax: 100, tpMin: 30, tpMax: 150,
  jamStart: '00:00', jamEnd: '23:59', jam24: true,
  autoEntry: false,
  isCent: false,
};
// ===== MT5 DARI RDP - BUKAN DARI API EXNESS =====
// EA di RDP nanti POST ke /api/mt5/price tiap 1 detik.
// Sekarang masih kosong, jadi status = Belum nyambung.
let MT5 = {
  connected: false,
  lastPrice: 0,
  lastBid: 0,
  lastAsk: 0,
  balance: 0,
  equity: 0,
  positions: 0,
  lastSeen: 0,
  lastError: '',
};
let convo = {};
let WSClient = null;
try{ WSClient = require('ws'); }catch(e){ console.log('Package ws belum ke-install, jalankan: npm install ws'); }
let wsBybit = null, wsOkx = null, wsBybitOk = false, wsOkxOk = false, wsLastBybit = 0, wsLastOkx = 0;
let wsBooks = { BYBIT: { bids: new Map(), asks: new Map() }, OKX: { bids: new Map(), asks: new Map() } };
async function sendTelegram(msg, keyboard){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_IDS.length) return;
  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chat_id)=>{
    try{
      let body = { chat_id, text: msg };
      if(keyboard) body.reply_markup = { inline_keyboard: keyboard };
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }catch(e){ console.log('Telegram gagal ke', chat_id, e.message); }
  }));
}
async function sendTelegramTo(chatId, msg, keyboard){
  if(!TELEGRAM_TOKEN) return;
  try{
    let body = { chat_id: String(chatId), text: msg };
    if(keyboard) body.reply_markup = { inline_keyboard: keyboard };
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }catch(e){ console.log('Telegram sendTo gagal', e.message); }
}
async function answerCallback(callbackId, text){
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId, text: text || 'OK' }) }); }catch(e){}
}
async function setMyCommands(){
  if(!TELEGRAM_TOKEN) return;
  const commands = [
    { command: 'jarak', description: 'Ganti jarak tembok, misal /jarak 0 1' },
    { command: 'size', description: 'Ganti size ratio tembok, misal /size 5' },
    { command: 'betah', description: 'Ganti durasi betah tembok, misal /betah 5' },
    { command: 'status', description: 'Liat jarak, size, betah sekarang' },
    { command: 'help', description: 'Liat 3 command yang aktif' },
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) }); console.log('setMyCommands OK - cuma jarak/size/betah'); }catch(e){ console.log('setMyCommands gagal', e.message); }
}
setMyCommands();
function generateSetupId(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for(let i=0; i<4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return '#' + id;
}
function hitungZona(wallPrice, hargaSekarang, isBuy){
  const jarak = Math.max(JARAK_MIN, Math.min(JARAK_MAX, Math.round(Math.abs(hargaSekarang - wallPrice))));
  const wall = Math.floor(wallPrice);
  if(isBuy){ return { jarak, entryLow: wall, entryHigh: wall + jarak, slLow: wall - SL_DOLLAR, slHigh: wall + jarak - SL_DOLLAR, tpLow: wall + TP_DOLLAR, tpHigh: wall + jarak + TP_DOLLAR }; }
  else { return { jarak, entryLow: wall - jarak, entryHigh: wall, slLow: wall - jarak + SL_DOLLAR, slHigh: wall + SL_DOLLAR, tpLow: wall - jarak - TP_DOLLAR, tpHigh: wall - TP_DOLLAR }; }
}
function fmtZona(low, high){ if(Math.round(low) === Math.round(high)) return `$${Math.round(low)}`; return `$${Math.round(low)} - $${Math.round(high)}`; }
function hargaSL(zona, isBuy){ return isBuy ? zona.slLow : zona.slHigh; }
function hargaTP(zona, isBuy){ return isBuy ? zona.tpLow : zona.tpHigh; }
function parseNum(str){
  if(str === undefined || str === null) return NaN;
  let s = String(str).trim().replace(',', '.').replace(/[^0-9.\-]/g, '');
  return parseFloat(s);
}
function parseJam(str){
  let s = String(str||'').trim().replace('.', ':');
  if(/^\d{1,2}$/.test(s)) s = s.padStart(2,'0') + ':00';
  if(/^\d{3,4}$/.test(s) && !s.includes(':')) s = s.slice(0,-2) + ':' + s.slice(-2);
  let m = s.match(/^(\d{1,2}):(\d{1,2})/);
  if(!m) return null;
  let h = parseInt(m[1]), mi = parseInt(m[2]);
  if(h<0||h>23||mi<0||mi>59) return null;
  return String(h).padStart(2,'0') + ':' + String(mi).padStart(2,'0');
}
function getWIBNow(){
  let d = new Date(Date.now() + 7*3600*1000);
  let hh = String(d.getUTCHours()).padStart(2,'0');
  let mm = String(d.getUTCMinutes()).padStart(2,'0');
  return hh + ':' + mm;
}
function isJamAktif(){
  if(CFG.jam24) return true;
  let now = getWIBNow();
  if(CFG.jamStart <= CFG.jamEnd) return now >= CFG.jamStart && now <= CFG.jamEnd;
  return now >= CFG.jamStart || now <= CFG.jamEnd;
}
function getSLTP_Pips(){
  if(CFG.slMode === 'FLEKSIBEL'){
    let sl = Math.round((CFG.slMin + CFG.slMax)/2);
    let tp = Math.round((CFG.tpMin + CFG.tpMax)/2);
    return { sl, tp };
  }
  return { sl: CFG.slFix, tp: CFG.tpFix };
}
function sltpText(){
  if(CFG.slMode === 'FLEKSIBEL') return `FLEKSIBEL SL ${CFG.slMin}-${CFG.slMax} / TP ${CFG.tpMin}-${CFG.tpMax} pips`;
  return `FIX ${CFG.slFix} / ${CFG.tpFix} pips`;
}
function mt5HargaText(){
  if(MT5.connected && MT5.lastPrice && (Date.now() - MT5.lastSeen < 30000)){
    return `$${MT5.lastPrice.toFixed(2)} (ASLI MT5 RDP)`;
  }
  return 'Belum nyambung - RDP belum jalan';
}
function statusText(){
  let jamTxt = CFG.jam24 ? '24 jam (00:00 - 23:59 WIB)' : `${CFG.jamStart} - ${CFG.jamEnd} WIB (sekarang ${getWIBNow()} WIB, ${isJamAktif() ? 'AKTIF' : 'ISTIRAHAT'})`;
  let mt5Txt = (MT5.connected && MT5.lastPrice) ? `Nyambung ✅ (Balance $${MT5.balance.toFixed(2)})` : `Belum nyambung - RDP belum jalan`;
  let posTxt = currentSetup ? `${currentSetup.signal} ${currentSetup.setup_id} - Entry MT5 ${currentSetup.mt5_entry ? '$'+currentSetup.mt5_entry.toFixed(2) : '-'}` : 'Gak ada posisi aktif';
  let pnlTxt = '-';
  if(currentSetup && currentSetup.mt5_entry){
    let p = hitungPnL(currentSetup);
    pnlTxt = p.text;
  }
  return `🤖 ABEL BOT - STATUS RUNNING\n\n` +
  `MT5: ${mt5Txt}\n` +
  `Simbol: ${CFG.simbol}${CFG.isCent ? ' (Cent)' : ''}\n` +
  `Lot: ${CFG.lot}\n` +
  `Size: ${RATIO_MIN}x\n` +
  `Jarak: ${JARAK_MIN} - ${JARAK_MAX}$\n` +
  `Betah: ${BETAH_MIN_MENIT} menit\n` +
  `SL/TP: ${sltpText()}\n` +
  `Jam: ${jamTxt}\n` +
  `Auto-entry: ${CFG.autoEntry ? 'NYALA ✅' : 'MATI ⏸️ (sinyal tetep jalan)'}\n` +
  `XAUT: $${xautPrice ? xautPrice.toFixed(2) : '-'}\n` +
  `Harga MT5: ${mt5HargaText()}\n` +
  `Posisi: ${posTxt}\n` +
  `PnL Live: ${pnlTxt}`;
}
function hitungPnL(setup){
  if(!setup || !setup.mt5_entry) return { usd: 0, text: '-' };
  let hargaNow = MT5.lastPrice || xautPrice || setup.mt5_entry;
  let delta = setup.signal === 'BUY' ? (hargaNow - setup.mt5_entry) : (setup.mt5_entry - hargaNow);
  let pnlDollar = delta * CFG.lot * 100;
  let pips = delta * 10;
  let sign = pnlDollar >= 0 ? '+' : '';
  let star = MT5.lastPrice ? '' : ' *';
  return { usd: pnlDollar, pips, text: `${sign}$${pnlDollar.toFixed(2)} (${sign}${pips.toFixed(0)} pips)${star}` };
}
async function handleTelegramCommand(chatId, textRaw){
  let text = String(textRaw||'').trim();
  let lower = text.toLowerCase().replace(',', '.');
  let cv = convo[chatId];
  if(cv){
    if(cv.step === 'SIZE'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 5`); return; }
      RATIO_MIN = v; delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Size diganti ke ${v}x\n\nVercel + PWA auto ke-sync ke ${v}x, sinyal berikutnya langsung pake ${v}x.`);
      return;
    }
    if(cv.step === 'JARAK'){
      let parts = text.replace(/-/g,' ').split(/\s+/).map(parseNum).filter(x=>!isNaN(x));
      if(!parts.length){ await sendTelegramTo(chatId, `Ketik jarak bro, contoh: 0 1`); return; }
      if(parts.length===1){ JARAK_MIN = 0; JARAK_MAX = parts[0]; }
      else { JARAK_MIN = parts[0]; JARAK_MAX = parts[1]; }
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Jarak diganti ke ${JARAK_MIN} - ${JARAK_MAX}$\n\nVercel + PWA auto ke-sync.`);
      return;
    }
    if(cv.step === 'BETAH'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka menit bro, contoh: 5`); return; }
      BETAH_MIN_MENIT = Math.round(v); delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Betah diganti ke ${BETAH_MIN_MENIT} menit\n\nVercel + PWA auto ke-sync.`);
      return;
    }
  }
  let m = text.match(/^\/?([a-z_]+)\s*(.*)$/i);
  if(!m) return;
  let cmd = m[1].toLowerCase();
  let arg = (m[2]||'').trim();
  if(cmd === 'start'){
    await sendTelegramTo(chatId, statusText() + `\n\nCommand aktif: /jarak /size /betah`);
    return;
  }
  if(cmd === 'help'){
    await sendTelegramTo(chatId,
`📋 COMMAND ABEL BOT - AKTIF\n\n`+
`/jarak 0 1 - Ganti jarak tembok\n`+
`/size 5 - Ganti size ratio tembok\n`+
`/betah 5 - Ganti durasi betah (menit)\n`+
`/status - Liat jarak, size, betah sekarang\n\n`+
`Ubah di Tele = auto ke-sync ke Vercel + PWA.\n`+
`Ketik command-nya doang tanpa angka, bot bakal nanya step by step.`);
    return;
  }
  if(cmd === 'status'){
    await sendTelegramTo(chatId, statusText());
    return;
  }
  if(cmd === 'ratio'){
    await sendTelegramTo(chatId, `Pake /size bro, /ratio udah gak kepake.\n\nContoh: /size 5\nKalo mau ganti ke 7: /size 7`);
    return;
  }
  if(cmd === 'jarak'){
    if(!arg){ convo[chatId] = { step: 'JARAK', tmp: {} }; await sendTelegramTo(chatId, `Jarak sekarang: ${JARAK_MIN} - ${JARAK_MAX}$\n\nMau ganti ke berapa? Contoh: 0 1`); return; }
    let parts = arg.replace(/-/g,' ').split(/\s+/).map(parseNum).filter(x=>!isNaN(x));
    if(!parts.length){ await sendTelegramTo(chatId, `Contoh: /jarak 0 1`); return; }
    if(parts.length===1){ JARAK_MIN = 0; JARAK_MAX = parts[0]; } else { JARAK_MIN = parts[0]; JARAK_MAX = parts[1]; }
    await sendTelegramTo(chatId, `✅ Jarak diganti ke ${JARAK_MIN} - ${JARAK_MAX}$\n\nVercel + PWA auto ke-sync ke ${JARAK_MIN} - ${JARAK_MAX}$, sinyal berikutnya langsung pake setting ini.`);
    return;
  }
  if(cmd === 'size'){
    if(!arg){ convo[chatId] = { step: 'SIZE', tmp: {} }; await sendTelegramTo(chatId, `Size sekarang: ${RATIO_MIN}x\n\nMau ganti ke berapa? Contoh: 5`); return; }
    let v = parseNum(arg);
    if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Contoh: /size 5`); return; }
    RATIO_MIN = v;
    await sendTelegramTo(chatId, `✅ Size diganti ke ${v}x\n\nVercel + PWA auto ke-sync ke ${v}x, sinyal berikutnya langsung pake ${v}x.`);
    return;
  }
  if(cmd === 'betah'){
    if(!arg){ convo[chatId] = { step: 'BETAH', tmp: {} }; await sendTelegramTo(chatId, `Betah sekarang: ${BETAH_MIN_MENIT} menit\n\nMau ganti ke berapa menit? Contoh: 5`); return; }
    let v = parseNum(arg);
    if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Contoh: /betah 5`); return; }
    BETAH_MIN_MENIT = Math.round(v);
    await sendTelegramTo(chatId, `✅ Betah diganti ke ${BETAH_MIN_MENIT} menit\n\nVercel + PWA auto ke-sync.`);
    return;
  }
  await sendTelegramTo(chatId, `Command /${cmd} gak aktif bro. Yang aktif cuma:\n/jarak 0 1\n/size 5\n/betah 5\n/status`);
}
async function handleCallback(chatId, data, callbackId){
  await answerCallback(callbackId, 'OK');
}
app.post('/webhook', async (req,res)=>{
  try{
    let upd = req.body || {};
    if(upd.callback_query){
      let cq = upd.callback_query;
      let chatId = cq.message?.chat?.id;
      if(chatId) await handleCallback(chatId, cq.data, cq.id);
    } else if(upd.message){
      let chatId = upd.message.chat.id;
      let txt = upd.message.text || '';
      if(txt) await handleTelegramCommand(chatId, txt);
    }
    res.json({ ok: true });
  }catch(e){ console.log('webhook gagal', e.message); res.json({ ok: false }); }
});
app.post('/api/telegram-webhook', async (req,res)=>{ res.redirect(307, '/webhook'); });
let teleOffset = 0;
let pollingRunning = false;
async function telegramPolling(){
  if(!TELEGRAM_TOKEN || pollingRunning) return;
  pollingRunning = true;
  console.log('Telegram polling START - command langsung jalan tanpa webhook');
  while(true){
    try{
      let url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${teleOffset}&timeout=30`;
      let r = await fetch(url);
      let j = await r.json();
      if(j.ok && j.result && j.result.length){
        for(let upd of j.result){
          teleOffset = upd.update_id + 1;
          try{
            if(upd.callback_query){
              let cq = upd.callback_query;
              let chatId = cq.message?.chat?.id;
              if(chatId) await handleCallback(chatId, cq.data, cq.id);
            } else if(upd.message){
              let chatId = upd.message.chat.id;
              let txt = upd.message.text || '';
              if(txt) await handleTelegramCommand(chatId, txt);
            }
          }catch(e){ console.log('Polling handle gagal', e.message); }
        }
      }
    }catch(e){
      await new Promise(r=>setTimeout(r, 2000));
    }
    await new Promise(r=>setTimeout(r, 500));
  }
}
if(TELEGRAM_TOKEN) telegramPolling();
let walls = [], wallsFar = [], xautPrice = 0;
let exchanges = { bybit: false, okx: false };
let uptimeStart = Date.now(), lastUpdate = null;
let firstSeenMap = new Map(), signalHistory = [];
let currentSetup = null, lastSetup = null, lastDone = null;
function addHistory(entry){ signalHistory.unshift(entry); if(signalHistory.length > 100) signalHistory = signalHistory.slice(0,100); }
function closeHistory(id, result, resultPrice){ const h = signalHistory.find(x=> x.id === id); if(h && !h.closed_at){ h.closed_at = Date.now(); h.result = result; h.result_price = resultPrice; h.duration_menit = Math.floor((h.closed_at - h.created_at)/60000); } }
function getAgeMenit(key){ const t = firstSeenMap.get(key); if(!t) return 0; return Math.floor((Date.now() - t) / 60000); }
function calcProfitPips(signal, entry, harga){ const dollar = signal === 'BUY' ? (harga - entry) : (entry - harga); const pips = dollar * 10; return (pips >= 0 ? '+' : '') + pips.toFixed(0) + ' pips (' + (dollar >= 0 ? '+' : '') + dollar.toFixed(2) + '$)'; }
function applyWsBook(source, bids, asks, isSnapshot){
  const book = wsBooks[source];
  if(isSnapshot){ book.bids.clear(); book.asks.clear(); }
  (bids||[]).forEach(([p,s])=>{ const price=parseFloat(p), size=parseFloat(s); if(!price) return; if(size===0) book.bids.delete(price); else book.bids.set(price,size); });
  (asks||[]).forEach(([p,s])=>{ const price=parseFloat(p), size=parseFloat(s); if(!price) return; if(size===0) book.asks.delete(price); else book.asks.set(price,size); });
}
function getWsOrderbooks(){
  let allBids=[], allAsks=[];
  for(const src of ['BYBIT','OKX']){ const b=wsBooks[src]; b.bids.forEach((size,price)=> allBids.push({ price, size, source: src })); b.asks.forEach((size,price)=> allAsks.push({ price, size, source: src })); }
  return { allBids, allAsks };
}
const BYBIT_WS_URLS = ['wss://stream.bybit.com/v5/public/spot', 'wss://stream.bytick.com/v5/public/spot'];
let bybitUrlIndex = 0;
let bybitReconnectTimer = null;
let bybitPingTimer = null;
let bybitConnecting = false;
function stopBybitTimers(){ if(bybitReconnectTimer){ clearTimeout(bybitReconnectTimer); bybitReconnectTimer = null; } if(bybitPingTimer){ clearInterval(bybitPingTimer); bybitPingTimer = null; } }
function scheduleBybitReconnect(delayMs){
  if(bybitReconnectTimer) clearTimeout(bybitReconnectTimer);
  bybitReconnectTimer = setTimeout(()=>{ connectBybitWS(); }, delayMs || 3000);
}
function connectBybitWS(){
  if(!WSClient){ console.log('WS lib gak ada, Bybit pake REST doang'); return; }
  if(bybitConnecting) return;
  bybitConnecting = true;
  stopBybitTimers();
  if(wsBybit){ try{ wsBybit.removeAllListeners(); wsBybit.terminate(); }catch(e){} wsBybit = null; }
  const url = BYBIT_WS_URLS[bybitUrlIndex % BYBIT_WS_URLS.length];
  console.log('Connect Bybit WS -> ' + url);
  try{
    wsBybit = new WSClient(url);
    wsBybit.on('open', ()=>{
      console.log('Bybit WS OPEN - ' + url);
      bybitConnecting = false;
      wsBybit.send(JSON.stringify({ op: 'subscribe', req_id: 'abel-' + Date.now(), args: ['orderbook.200.XAUTUSDT'] }));
      bybitPingTimer = setInterval(()=>{ try{ if(wsBybit && wsBybit.readyState === 1) wsBybit.send(JSON.stringify({ op: 'ping' })); }catch(e){} }, 20000);
    });
    wsBybit.on('message', (data)=>{
      try{
        const raw = data.toString();
        if(raw === 'pong'){ wsBybitOk = true; wsLastBybit = Date.now(); return; }
        const j = JSON.parse(raw);
        if(j.op === 'ping'){ try{ wsBybit.send(JSON.stringify({ op: 'pong', req_id: j.req_id || '' })); }catch(e){} wsBybitOk = true; wsLastBybit = Date.now(); return; }
        if(j.op === 'pong'){ wsBybitOk = true; wsLastBybit = Date.now(); return; }
        if(j.success === true && j.op === 'subscribe'){ console.log('Bybit WS SUBSCRIBE OK'); wsBybitOk = true; wsLastBybit = Date.now(); return; }
        if(j.success === false){ console.log('Bybit WS subscribe gagal:', raw); return; }
        if(j.topic && j.topic.indexOf('orderbook') !== -1 && j.data){
          wsBybitOk = true; wsLastBybit = Date.now();
          applyWsBook('BYBIT', j.data.b, j.data.a, j.type === 'snapshot');
          return;
        }
        if(j.data && j.data.b){ wsBybitOk = true; wsLastBybit = Date.now(); applyWsBook('BYBIT', j.data.b, j.data.a, j.type === 'snapshot'); return; }
      }catch(e){ console.log('Bybit WS parse gagal', e.message); }
    });
    wsBybit.on('close', (code, reason)=>{
      console.log('Bybit WS CLOSE code=' + code + ' reason=' + (reason ? reason.toString() : ''));
      wsBybitOk = false; bybitConnecting = false;
      stopBybitTimers();
      bybitUrlIndex++;
      scheduleBybitReconnect(3000);
    });
    wsBybit.on('error', (e)=>{
      console.log('Bybit WS ERROR ' + e.message + ' url=' + url);
      wsBybitOk = false; bybitConnecting = false;
    });
  }catch(e){
    console.log('Bybit WS gagal connect ' + e.message);
    bybitConnecting = false;
    bybitUrlIndex++;
    scheduleBybitReconnect(3000);
  }
}
let okxReconnectTimer = null;
function connectOkxWS(){
  if(!WSClient) return;
  if(wsOkx){ try{ wsOkx.removeAllListeners(); wsOkx.terminate(); }catch(e){} wsOkx = null; }
  console.log('Connect OKX WS');
  try{
    wsOkx = new WSClient('wss://ws.okx.com:8443/ws/v5/public');
    wsOkx.on('open', ()=>{ console.log('OKX WS OPEN'); wsOkx.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId: 'XAUT-USDT' }] })); });
    wsOkx.on('message', (data)=>{ try{ const j = JSON.parse(data.toString()); if(j.event === 'subscribe'){ console.log('OKX WS SUBSCRIBE OK'); wsOkxOk = true; wsLastOkx = Date.now(); return; } if(j.op === 'ping'){ try{ wsOkx.send(JSON.stringify({ op: 'pong' })); }catch(e){} return; } if(j.data && j.data[0]){ wsOkxOk = true; wsLastOkx = Date.now(); const d = j.data[0]; applyWsBook('OKX', d.bids, d.asks, d.action === 'snapshot'); } }catch(e){} });
    wsOkx.on('close', ()=>{ console.log('OKX WS CLOSE'); wsOkxOk = false; if(okxReconnectTimer) clearTimeout(okxReconnectTimer); okxReconnectTimer = setTimeout(connectOkxWS, 3000); });
    wsOkx.on('error', (e)=>{ console.log('OKX WS ERROR ' + e.message); wsOkxOk = false; });
  }catch(e){ console.log('OKX WS gagal', e.message); }
}
connectBybitWS();
connectOkxWS();
setInterval(()=>{
  if(Date.now() - wsLastBybit > 10000 && wsLastBybit !== 0){ console.log('Bybit WS watchdog: 10 detik gak ada data, reconnect'); wsBybitOk = false; connectBybitWS(); }
  if(Date.now() - wsLastOkx > 10000 && wsLastOkx !== 0){ console.log('OKX WS watchdog: 10 detik gak ada data, reconnect'); wsOkxOk = false; connectOkxWS(); }
}, 10000);
async function fetchOne(url){ try{ const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }
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
  const pushWall = (side, o, isFar)=>{ const key = side + '-' + o.price.toFixed(2); if(!firstSeenMap.has(key)) firstSeenMap.set(key, Date.now()); const age = getAgeMenit(key); const wall = { side, price: o.price, size: o.size, sources: o.sources, age_menit: age, first_seen: firstSeenMap.get(key) }; if(isFar) newFar.push(wall); else newWalls.push(wall); };
  const bySource = {};
  allBids.forEach(o=>{ if(!bySource[o.source]) bySource[o.source] = { bids: [], asks: [] }; bySource[o.source].bids.push(o); });
  allAsks.forEach(o=>{ if(!bySource[o.source]) bySource[o.source] = { bids: [], asks: [] }; bySource[o.source].asks.push(o); });
  for(const src of Object.keys(bySource)){
    const b = mergeLevels(bySource[src].bids); const a = mergeLevels(bySource[src].asks);
    const sizes = [...b, ...a].map(x=> x.size); if(!sizes.length) continue;
    const avgSrc = sizes.reduce((x,y)=> x+y, 0) / sizes.length;
    const thresholdSrc = avgSrc * RATIO_MIN;
    console.log(`WALL ${src} - avg: ${avgSrc.toFixed(2)} threshold (${RATIO_MIN}x): ${thresholdSrc.toFixed(2)} max: ${Math.max(...sizes).toFixed(2)}`);
    b.forEach(o=>{ if(o.size >= thresholdSrc) pushWall('BID', o, false); });
    a.forEach(o=>{ if(o.size >= thresholdSrc) pushWall('ASK', o, false); });
    b.slice().sort((x,y)=> y.size - x.size).slice(0,3).forEach(o=> pushWall('BID', o, true));
    a.slice().sort((x,y)=> y.size - x.size).slice(0,3).forEach(o=> pushWall('ASK', o, true));
  }
  const mergeFinal = (list)=>{ const map = new Map(); list.forEach(w=>{ const k = w.side + '-' + w.price.toFixed(2); if(!map.has(k)) map.set(k, { ...w }); else { const cur = map.get(k); cur.size += w.size; cur.sources = [...new Set((cur.sources + ' + ' + w.sources).split(' + '))].join('+'); } }); return [...map.values()]; };
  walls = mergeFinal(newWalls); wallsFar = mergeFinal(newFar);
}
function buildPendingOrders(){
  if(!walls.length || !xautPrice) return { pending: [], touched: [] };
  const sorted = [...walls].sort((a,b)=> b.size - a.size).slice(0, 20); const pending = [], touched = [];
  sorted.forEach(w=>{ if((w.age_menit || 0) < BETAH_MIN_MENIT) return; const jarak = Math.abs(w.price - xautPrice); const isTouched = jarak <= JARAK_MAX; const item = { ...w, instruction: w.side === 'BID' ? 'BUY' : 'SELL', status: isTouched ? 'TERSENTUH' : 'PENDING', distance: Math.floor(jarak * 100) / 100, notional: Math.floor(w.size * w.price) }; if(isTouched) touched.push(item); else pending.push(item); });
  pending.sort((a,b)=> b.size - a.size); touched.sort((a,b)=> b.size - a.size); return { pending: pending.slice(0,6), touched: touched.slice(0,6) };
}
async function checkSignal(){
  const { pending, touched } = buildPendingOrders();
  if(currentSetup){
    const s = currentSetup; const displaySignal = s.signal; const isBuy = displaySignal === 'BUY';
    const slHarga = hargaSL(s.zona, isBuy); const tpHarga = hargaTP(s.zona, isBuy);
    const kenaSL = isBuy ? xautPrice <= slHarga : xautPrice >= slHarga;
    if(kenaSL){
      lastSetup = { ...s, state: 'CLOSED', result: 'LOSE - SL KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' LOSE - SL KENA di ' + slHarga.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'LOSE - SL KENA', xautPrice);
      await sendTelegram(`❌ ${displaySignal} LOSE - Setup ${s.setup_id}\n\nHarga MT5 (RDP): ${MT5.lastPrice ? '$'+MT5.lastPrice.toFixed(2) : 'Belum nyambung - RDP belum jalan'}\nHarga XAUT: $${xautPrice.toFixed(2)}\nEntry: ${fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nSL: ${fmtZona(s.zona.slLow, s.zona.slHigh)} (-${s.mt5_sl_pips||SL_PIPS} pips)\nHasil: LOSE - SL KENA`);
      currentSetup = null; return;
    }
    const kenaTP = isBuy ? xautPrice >= tpHarga : xautPrice <= tpHarga;
    if(kenaTP){
      lastSetup = { ...s, state: 'CLOSED', result: 'WIN - TP KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' WIN - TP KENA di ' + tpHarga.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'WIN - TP KENA', xautPrice);
      await sendTelegram(`✅ ${displaySignal} WIN - Setup ${s.setup_id}\n\nHarga MT5 (RDP): ${MT5.lastPrice ? '$'+MT5.lastPrice.toFixed(2) : 'Belum nyambung - RDP belum jalan'}\nHarga XAUT: $${xautPrice.toFixed(2)}\nEntry: ${fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nTP: ${fmtZona(s.zona.tpLow, s.zona.tpHigh)} (+${s.mt5_tp_pips||TP_PIPS} pips)\nHasil: WIN - TP KENA`);
      currentSetup = null; return;
    }
    return;
  }
  const gabungan = [...touched, ...pending];
  if(!gabungan.length || !xautPrice) return;
  const kandidat = gabungan.filter(w => w.distance >= JARAK_MIN && w.distance <= JARAK_MAX);
  if(!kandidat.length) return;
  const byJarak = [...kandidat].sort((a,b)=> a.distance - b.distance);
  const terdekat = byJarak[0];
  const isBuy = terdekat.side === 'BID';
  const zona = hitungZona(terdekat.price, xautPrice, isBuy);
  const entry = isBuy ? zona.entryLow : zona.entryHigh;
  const slHarga = hargaSL(zona, isBuy); const tpHarga = hargaTP(zona, isBuy);
  const setupId = generateSetupId(); const displaySignal = isBuy ? 'BUY' : 'SELL'; const now = Date.now();
  let pp = getSLTP_Pips();
  currentSetup = { id: 'SIG-' + now, setup_id: setupId, signal: displaySignal, state: 'IN_POSITION', entry, sl: slHarga, tp: tpHarga, zona, jarak: zona.jarak, entry_low: zona.entryLow, entry_high: zona.entryHigh, sl_low: zona.slLow, sl_high: zona.slHigh, tp_low: zona.tpLow, tp_high: zona.tpHigh, sl_pips: pp.sl, tp_pips: pp.tp, lockedAt: now, closed_at: null, result: 'AKTIF', wall: { side: terdekat.side, price: terdekat.price, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, distance: terdekat.distance }, lock_status: 'IN POSITION - ' + displaySignal + ' di ' + fmtZona(zona.entryLow, zona.entryHigh),
    mt5_entry: entry, mt5_sl: slHarga, mt5_tp: tpHarga, mt5_sl_pips: pp.sl, mt5_tp_pips: pp.tp, mt5_price: MT5.lastPrice || 0, xaut_price: xautPrice, lot: CFG.lot, simbol: CFG.simbol };
  addHistory({ id: currentSetup.id, setup_id: setupId, signal: displaySignal + ' NOW', wall_side: terdekat.side, wall_price: terdekat.price, entry, sl: slHarga, tp: tpHarga, entry_low: zona.entryLow, entry_high: zona.entryHigh, sl_low: zona.slLow, sl_high: zona.slHigh, tp_low: zona.tpLow, tp_high: zona.tpHigh, sl_pips: pp.sl, tp_pips: pp.tp, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: now, closed_at: null, result: 'AKTIF', result_price: null, duration_menit: 0,
    mt5_entry: entry, mt5_sl: slHarga, mt5_tp: tpHarga, mt5_sl_pips: pp.sl, mt5_tp_pips: pp.tp, lot: CFG.lot, simbol: CFG.simbol, xaut_price: xautPrice });
  await sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId} (SINYAL XAUT - MT5 RDP BELUM JALAN)\n\nEntry: $${entry.toFixed(2)} (XAUT)\nSL: $${slHarga.toFixed(2)} (SL -${pp.sl} pips dari harga entry)\nTP: $${tpHarga.toFixed(2)} (TP +${pp.tp} pips dari harga entry)\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${zona.jarak}$)\nNote: MT5 RDP belum jalan, jadi ini sinyal XAUT doang, belum entry MT5.\n\nHOLD BAGI YANG MAMPU🔥`);
}
let tickRunning = false;
async function tick(){ if(tickRunning) return; tickRunning = true; try{ const { allBids, allAsks } = await fetchOrderbooks(); if(allBids.length) buildWalls(allBids, allAsks); await checkSignal(); lastUpdate = Date.now(); }catch(e){ console.log('tick gagal', e.message); } tickRunning = false; }
setInterval(tick, 1000); tick();
function buildSignalResponse(){
  const { pending, touched } = buildPendingOrders();
  let pnl = null;
  if(currentSetup && currentSetup.mt5_entry) pnl = hitungPnL(currentSetup);
  if(currentSetup){ const s = currentSetup; return { signal: s.signal + ' - AKTIF', reason: '', setup_id: s.setup_id, pending, touched, entry: s.entry, entry_mt5: s.entry, sl: s.sl, sl_mt5: s.sl, tp: s.tp, tp_mt5: s.tp, entry_low: s.entry_low, entry_high: s.entry_high, sl_low: s.sl_low, sl_high: s.sl_high, tp_low: s.tp_low, tp_high: s.tp_high, jarak: s.jarak, zona: s.zona, sl_pips: s.sl_pips || SL_PIPS, tp_pips: s.tp_pips || TP_PIPS, is_locked: true, lockedState: s.state, lockedAt: s.lockedAt, lockedId: s.id, lock_status: s.lock_status, wall: s.wall,
    mt5_entry: s.mt5_entry || s.entry, mt5_sl: s.mt5_sl || s.sl, mt5_tp: s.mt5_tp || s.tp, mt5_sl_pips: s.mt5_sl_pips || SL_PIPS, mt5_tp_pips: s.mt5_tp_pips || TP_PIPS, mt5_price: MT5.lastPrice || 0, mt5_price_real: MT5.lastPrice || 0, mt5_connected: MT5.connected, mt5_last_seen: MT5.lastSeen, lot: s.lot || CFG.lot, simbol: s.simbol || CFG.simbol, xaut_price: xautPrice, pnl_live: pnl ? pnl.usd : 0, pnl_text: pnl ? pnl.text : '-', pnl_pips: pnl ? pnl.pips : 0 }; }
  return { signal: 'WAIT', reason: '', setup_id: '', pending, touched, entry: 0, entry_mt5: 0, sl: 0, sl_mt5: 0, tp: 0, tp_mt5: 0, entry_low: 0, entry_high: 0, sl_low: 0, sl_high: 0, tp_low: 0, tp_high: 0, jarak: 0, zona: null, sl_pips: SL_PIPS, tp_pips: TP_PIPS, is_locked: false, lockedState: 'IDLE', lockedAt: null, lockedId: null, lock_status: lastSetup ? 'Last: ' + (lastDone ? lastDone.last_result : lastSetup.result) : 'Tidak terkunci', wall: null,
    mt5_entry: 0, mt5_sl: 0, mt5_tp: 0, mt5_price: MT5.lastPrice || 0, mt5_price_real: MT5.lastPrice || 0, mt5_connected: MT5.connected, mt5_last_seen: MT5.lastSeen, lot: CFG.lot, simbol: CFG.simbol, xaut_price: xautPrice, pnl_live: 0, pnl_text: '-', pnl_pips: 0 };
}
function calcWinrate(){ const closed = signalHistory.filter(x=> x.closed_at); const win = closed.filter(x=> (x.result||'').includes('WIN')).length; const lose = closed.filter(x=> (x.result||'').includes('LOSE')).length; const total = win + lose; return { total, win, lose, winrate: total ? Math.round(win/total*100) : 0 }; }
app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - V13.4 TANPA API EXNESS - Jarak 0-1$ Betah 5m Size 5x Zona SL50 TP50'));
app.get('/api/signal', async (req,res)=>{
  const sig = buildSignalResponse(); const wr = calcWinrate();
  res.set('Cache-Control', 'no-store');
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, winrate_data: wr, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF',
    config: { lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, ratio: RATIO_MIN, size: RATIO_MIN, jarak_min: JARAK_MIN, jarak_max: JARAK_MAX, betah: BETAH_MIN_MENIT, sl_mode: CFG.slMode, sl_fix: CFG.slFix, tp_fix: CFG.tpFix, sl_min: CFG.slMin, sl_max: CFG.slMax, tp_min: CFG.tpMin, tp_max: CFG.tpMax, jam_start: CFG.jamStart, jam_end: CFG.jamEnd, jam24: CFG.jam24, jam_wib_now: getWIBNow(), jam_aktif: isJamAktif(), auto_entry: CFG.autoEntry, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice || 0, mt5_last_seen: MT5.lastSeen },
    harga: { xaut: xautPrice, xaut_mid: xautPrice, mt5: MT5.lastPrice || 0, mt5_price: MT5.lastPrice || 0, mt5_real: MT5.lastPrice || 0, source: 'XAUT WS Bybit+OKX + MT5 RDP (bukan API Exness)', ws_bybit: wsBybitOk ? 'WS-OK' : 'WS-OFF/REST', ws_okx: wsOkxOk ? 'WS-OK' : 'WS-OFF/REST', ws_last_bybit: wsLastBybit, ws_last_okx: wsLastOkx }, exchanges, uptimeStart, uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone, last_setup: lastSetup, current_setup: currentSetup });
});
app.get('/api/config', (req,res)=>{ res.set('Cache-Control', 'no-store'); res.json({ lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, ratio: RATIO_MIN, size: RATIO_MIN, jarak_min: JARAK_MIN, jarak_max: JARAK_MAX, betah: BETAH_MIN_MENIT, sl_mode: CFG.slMode, sl_fix: CFG.slFix, tp_fix: CFG.tpFix, sl_min: CFG.slMin, sl_max: CFG.slMax, tp_min: CFG.tpMin, tp_max: CFG.tpMax, jam_start: CFG.jamStart, jam_end: CFG.jamEnd, jam24: CFG.jam24, jam_wib_now: getWIBNow(), jam_aktif: isJamAktif(), auto_entry: CFG.autoEntry, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice || 0, mt5_last_seen: MT5.lastSeen }); });
// ===== MT5 DARI RDP - EA POST HARGA KE SINI TIAP 1 DETIK =====
app.post('/api/mt5/price', (req,res)=>{
  try{
    let b = req.body || {};
    let bid = parseFloat(b.bid || b.price || 0);
    let ask = parseFloat(b.ask || b.price || 0);
    let mid = (bid && ask) ? (bid + ask) / 2 : (bid || ask || 0);
    if(mid > 0){
      MT5.lastPrice = mid;
      MT5.lastBid = bid || mid;
      MT5.lastAsk = ask || mid;
      if(b.balance != null) MT5.balance = parseFloat(b.balance) || 0;
      if(b.equity != null) MT5.equity = parseFloat(b.equity) || 0;
      if(b.positions != null) MT5.positions = parseInt(b.positions) || 0;
      MT5.connected = true;
      MT5.lastSeen = Date.now();
      MT5.lastError = '';
    }
    res.json({ ok: true, mt5_price: MT5.lastPrice, connected: MT5.connected });
  }catch(e){ res.json({ ok: false, error: e.message }); }
});
app.get('/api/mt5/price', (req,res)=>{ res.json({ ok: true, connected: MT5.connected, price: MT5.lastPrice, bid: MT5.lastBid, ask: MT5.lastAsk, balance: MT5.balance, equity: MT5.equity, positions: MT5.positions, last_seen: MT5.lastSeen, last_seen_detik_lalu: MT5.lastSeen ? Math.floor((Date.now() - MT5.lastSeen)/1000) : null }); });
app.post('/api/mt5/report', (req,res)=>{ console.log('MT5 report:', req.body || {}); res.json({ ok: true }); });
app.get('/api/history', (req,res)=>{ const since = req.query.since ? parseInt(req.query.since) : uptimeStart; const filtered = signalHistory.filter(x => (x.created_at || 0) >= since); const wr = calcWinrate(); res.json({ history: filtered, total: filtered.length, winrate_data: wr, uptimeStart, sesi_mulai: new Date(uptimeStart).toLocaleString('id-ID'), uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000) }); });
app.get('/api/history-sesi', (req,res)=>{ res.redirect('/api/history'); });
app.get('/api/ws-test', (req,res)=>{ const w=getWsOrderbooks(); res.json({ ws_bybit_ok: wsBybitOk, ws_okx_ok: wsOkxOk, ws_last_bybit: wsLastBybit ? new Date(wsLastBybit).toLocaleTimeString('id-ID') : '-', ws_last_okx: wsLastOkx ? new Date(wsLastOkx).toLocaleTimeString('id-ID') : '-', bids_cached: w.allBids.length, asks_cached: w.allAsks.length, top_bid: w.allBids.length ? Math.max(...w.allBids.map(x=>x.price)) : 0, top_ask: w.allAsks.length ? Math.min(...w.allAsks.map(x=>x.price)) : 0, xaut_price: xautPrice, mt5_price: MT5.lastPrice || 0 }); });
app.get('/api/test-telegram', async (req,res)=>{ const testId = generateSetupId(); const z = { jarak: 1, entryLow: 3830, entryHigh: 3831, slLow: 3825, slHigh: 3826, tpLow: 3835, tpHigh: 3836 }; await sendTelegram(`🎯 BUY NOW - Setup ${testId}\n\nEntry: ${fmtZona(z.entryLow, z.entryHigh)} (zona ${z.jarak * 10} pips dari harga sekarang)\nSL: ${fmtZona(z.slLow, z.slHigh)} ( SL -50 pips dari harga entry)\nTP: ${fmtZona(z.tpLow, z.tpHigh)} (TP +50 pips dari harga entry )\n\nTembok: BID $3830.30 - 13.70 XAUT - Betah 8m - OKX (jarak ${z.jarak}$)\n\nHOLD BAGI YANG MAMPU🔥`); res.json({ ok: true, setup_id: testId, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' }); });
app.get('/api/unlock', (req,res)=>{ if(currentSetup){ lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xautPrice, closed_at: Date.now() }; closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xautPrice); currentSetup = null; res.json({ ok: true, msg: 'Unlocked - posisi dibatalkan manual' }); } else res.json({ ok: true, msg: 'Gak ada posisi aktif' }); });
app.listen(PORT, ()=> console.log('ABEL BOT V13.4 jalan di port ' + PORT + ' - TANPA API EXNESS + WS BYBIT/OKX + COMMANDS JARAK/SIZE/BETAH'));
