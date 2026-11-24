// ABEL BOT - V13.2 FIX AKUN + 429 - XAUT ONLY - WS BYBIT SAMPE OK + EXNESS API + TELE COMMANDS LENGKAP
// BASE: V13.1 - LOGIC V12 DIPERTAHANKAN 100%: Jarak 0-3$, Betah 5m, Ratio 4x, Zona = Tembok s/d Harga, SL 50 pips, TP 50 pips
// HARGA SINYAL = XAUT WS BYBIT+OKX. HARGA EXNESS = DARI EXNESS, BUKAN TEMPELAN XAUT.
// FIX V13.2:
// 1. Akun ID TIDAK LAGI diambil dari potongan key (62b3db). Akun ID cuma dari /akun 27000017363
// 2. /apikey cuma buat key, /akun <id> cuma buat Akun ID, dipisah tegas
// 3. Anti-429: harga Exness di-cache 10 detik, request dibatasin, backoff 30 detik kalo kena 429
// 4. Jujur kalo gagal: kalo Exness gagal, bilang gagal, jangan ngaku NYAMBUNG BENERAN
// Render Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PORT. Exness key lewat Tele, BUKAN lewat Render Env.
const express = require('express');
const app = express();
app.use(express.json());
// CORS manual - gak butuh install package cors
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const PORT = process.env.PORT || 10000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);

// ===== CONFIG BISA DIUBAH LEWAT TELE - DEFAULT SESUAI V12 + REQUEST LO =====
let JARAK_MIN = 0;
let JARAK_MAX = 3;
let BETAH_MIN_MENIT = 5;
let RATIO_MIN = 4;
let SL_PIPS = 50;
let TP_PIPS = 50;
let SL_DOLLAR = 5;
let TP_DOLLAR = 5;

// --- V13 Config ---
let CFG = {
  lot: 0.01,
  simbol: 'XAUUSD',
  slMode: 'FIX',
  slFix: 50, tpFix: 50,
  slMin: 20, slMax: 100, tpMin: 30, tpMax: 150,
  jamStart: '00:00', jamEnd: '23:59', jam24: true,
  autoEntry: true,
  akunLabel: 'Belum disetting',
  akunId: '-', // FIX: default '-', BUKAN potongan key. Cuma diisi dari /akun <id>
  isCent: false,
};
let EXNESS = {
  apiKey: process.env.EXNESS_API_KEY || '',
  secret: process.env.EXNESS_SECRET_KEY || '',
  accountId: process.env.EXNESS_ACCOUNT_ID || '',
  connected: false,
  lastPrice: 0,
  lastPriceAt: 0,
  lastError: '',
  balance: 0,
  equity: 0,
  // Anti-429
  lastRequestAt: 0,
  rateLimitedUntil: 0,
  lastPriceReal: 0, // harga beneran dari Exness, bukan fallback
  lastPriceRealAt: 0,
};
let exnessPositionsCache = [];
let exnessBalanceCache = { balance: 0, equity: 0, at: 0 };

// Conversation state buat /akun dan /sltp step-by-step
let convo = {};

let WSClient = null;
try{ WSClient = require('ws'); }catch(e){ console.log('Package ws belum ke-install, jalankan: npm install ws'); }
let wsBybit = null, wsOkx = null, wsBybitOk = false, wsOkxOk = false, wsLastBybit = 0, wsLastOkx = 0;
let wsBooks = { BYBIT: { bids: new Map(), asks: new Map() }, OKX: { bids: new Map(), asks: new Map() } };

// ===== TELEGRAM SEND - SUPPORT INLINE KEYBOARD =====
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
    { command: 'start', description: 'Mulai + liat status settingan running' },
    { command: 'help', description: 'Liat semua command lengkap' },
    { command: 'status', description: 'Liat semua setting sekarang' },
    { command: 'apikey', description: 'Pasang key Exness single (cuma key)' },
    { command: 'akun', description: 'Set Akun ID Exness, misal /akun 27000017363 CENT 0.01' },
    { command: 'akun_list', description: 'Liat akun yang aktif' },
    { command: 'cekexness', description: 'Cek saldo + harga asli + posisi Exness' },
    { command: 'hapuskey', description: 'Hapus key Exness dari memory' },
    { command: 'simbol', description: 'Ganti simbol, misal XAUUSDc' },
    { command: 'lot', description: 'Ganti lot Exness' },
    { command: 'ratio', description: 'Ganti ratio tembok' },
    { command: 'jarak', description: 'Ganti jarak tembok' },
    { command: 'betah', description: 'Ganti durasi betah tembok' },
    { command: 'sltp', description: 'Ganti SL/TP FIX / FLEKSIBEL' },
    { command: 'jam', description: 'Setting jam aktif bot WIB' },
    { command: 'posisi', description: 'Liat posisi Exness yang jalan' },
    { command: 'saldo', description: 'Liat saldo / equity Exness' },
    { command: 'startbot', description: 'Nyalain auto-entry' },
    { command: 'stopbot', description: 'Matiin auto-entry, sinyal tetep jalan' },
    { command: 'auto', description: 'Auto-entry on / off (cara cepat)' },
    { command: 'unlock', description: 'Batalin lock / posisi aktif manual' },
    { command: 'history', description: 'Liat history sinyal' },
    { command: 'test', description: 'Tes Telegram' },
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) }); console.log('setMyCommands OK - Menu lengkap'); }catch(e){ console.log('setMyCommands gagal', e.message); }
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

// ===== HELPERS =====
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
function maskKey(k){
  if(!k) return '-';
  if(k.length <= 8) return '****';
  return '****...' + k.slice(-4);
}
function akunText(){
  // FIX: jangan pernah tampilkan potongan key sebagai Akun ID
  if(!CFG.akunId || CFG.akunId === '-') return 'Belum diset (kirim /akun 27000017363)';
  return `${CFG.akunLabel} ${CFG.akunId}`;
}
function exnessHargaText(){
  // FIX: bedain harga asli vs fallback
  if(EXNESS.lastPriceReal && (Date.now() - EXNESS.lastPriceRealAt < 30000)){
    return `$${EXNESS.lastPriceReal.toFixed(2)} (ASLI Exness)`;
  }
  if(EXNESS.lastPrice){
    return `$${EXNESS.lastPrice.toFixed(2)} (XAUT - Exness gak dapet: ${EXNESS.lastError || 'belum cek'})`;
  }
  return '-';
}
function statusText(){
  let jamTxt = CFG.jam24 ? '24 jam (00:00 - 23:59 WIB)' : `${CFG.jamStart} - ${CFG.jamEnd} WIB (sekarang ${getWIBNow()} WIB, ${isJamAktif() ? 'AKTIF' : 'ISTIRAHAT'})`;
  let exnessTxt = (EXNESS.connected && EXNESS.lastPriceReal) ? `Nyambung ✅ (${akunText()})` : `Belum nyambung beneran - ${EXNESS.lastError || 'belum cek / key belum dipasang'}`;
  let posTxt = currentSetup ? `${currentSetup.signal} ${currentSetup.setup_id} - Entry Exness ${currentSetup.exness_entry ? '$'+currentSetup.exness_entry.toFixed(2) : '-'}` : 'Gak ada posisi aktif';
  let pnlTxt = '-';
  if(currentSetup && currentSetup.exness_entry){
    let p = hitungPnL(currentSetup);
    pnlTxt = p.text;
  }
  return `🤖 ABEL BOT - STATUS RUNNING\n\n` +
  `Akun: ${akunText()}\n` +
  `Exness: ${exnessTxt}\n` +
  `Simbol: ${CFG.simbol}${CFG.isCent ? ' (Cent)' : ''}\n` +
  `Lot: ${CFG.lot}\n` +
  `Ratio: ${RATIO_MIN}x\n` +
  `Jarak: ${JARAK_MIN} - ${JARAK_MAX}$\n` +
  `Betah: ${BETAH_MIN_MENIT} menit\n` +
  `SL/TP: ${sltpText()}\n` +
  `Jam: ${jamTxt}\n` +
  `Auto-entry: ${CFG.autoEntry ? 'NYALA ✅' : 'MATI ⏸️ (sinyal tetep jalan)'}\n` +
  `XAUT: $${xautPrice ? xautPrice.toFixed(2) : '-'}\n` +
  `Harga Exness: ${exnessHargaText()}\n` +
  `Key: ${EXNESS.apiKey ? 'KEPASANG ' + maskKey(EXNESS.apiKey) : 'BELUM ADA'}\n` +
  `Posisi: ${posTxt}\n` +
  `PnL Live: ${pnlTxt}`;
}

// ===== EXNESS API - ANTI 429 + JUJUR =====
async function exnessRequest(path, method, body){
  if(!EXNESS.apiKey) return null;
  // Anti-429: kalo lagi kena rate limit, jangan spam, langsung balikin null
  if(Date.now() < EXNESS.rateLimitedUntil){
    console.log('Exness skip - masih kena rate limit sampe', new Date(EXNESS.rateLimitedUntil).toLocaleTimeString('id-ID'));
    return null;
  }
  // Throttle: minimal jeda 2 detik antar request ke Exness
  let sinceLast = Date.now() - EXNESS.lastRequestAt;
  if(sinceLast < 2000){
    await new Promise(r=>setTimeout(r, 2000 - sinceLast));
  }
  EXNESS.lastRequestAt = Date.now();
  try{
    let url = 'https://api.exness.com' + path;
    let headers = {
      'Content-Type': 'application/json',
      'X-API-Key': EXNESS.apiKey,
      'X-API-Secret': EXNESS.secret || '',
      'Authorization': 'Bearer ' + EXNESS.apiKey,
    };
    let opt = { method: method || 'GET', headers };
    if(body) opt.body = JSON.stringify(body);
    let r = await fetch(url, opt);
    if(r.status === 429){
      console.log('Exness API 429 - kena rate limit, backoff 30 detik');
      EXNESS.lastError = 'Exness API 429 - kebanyakan request, istirahat 30 detik';
      EXNESS.rateLimitedUntil = Date.now() + 30000;
      EXNESS.connected = false;
      return null;
    }
    if(r.status === 401 || r.status === 403){
      EXNESS.lastError = 'Exness API ' + r.status + ' - Key ditolak / gak ada izin';
      EXNESS.connected = false;
      return null;
    }
    if(r.status === 404){
      EXNESS.lastError = 'Exness API 404 - Endpoint / Akun ID gak ketemu. Cek Akun ID lo: ' + (CFG.akunId || '-');
      return null;
    }
    if(!r.ok){ console.log('Exness API gagal', r.status, path); EXNESS.lastError = 'Exness API ' + r.status; return null; }
    return await r.json();
  }catch(e){ console.log('Exness request gagal', e.message); EXNESS.lastError = e.message; return null; }
}
async function exnessGetPrice(force){
  // Cache 10 detik: kalo baru aja nanya, pake yang lama, jangan spam
  if(!force && EXNESS.lastPriceReal && (Date.now() - EXNESS.lastPriceRealAt < 10000)){
    return EXNESS.lastPriceReal;
  }
  if(Date.now() < EXNESS.rateLimitedUntil) return EXNESS.lastPriceReal || 0;
  try{
    let j = await exnessRequest(`/v1/market/price?symbol=${CFG.simbol}`);
    let p = null;
    if(j){
      if(j.price) p = parseFloat(j.price);
      else if(j.data && j.data.price) p = parseFloat(j.data.price);
      else if(j.bid && j.ask) p = (parseFloat(j.bid)+parseFloat(j.ask))/2;
    }
    if(p && p>0){
      EXNESS.lastPriceReal = p; EXNESS.lastPriceRealAt = Date.now();
      EXNESS.lastPrice = p; EXNESS.lastPriceAt = Date.now(); EXNESS.connected = true; EXNESS.lastError = '';
      return p;
    }
  }catch(e){}
  // FIX: kalo gagal, JANGAN tempelin XAUT jadi harga Exness. Balikin 0 + simpen error.
  // Harga XAUT tetep ada di xautPrice buat sinyal, tapi jangan ngaku itu harga Exness.
  return EXNESS.lastPriceReal || 0;
}
async function exnessPlaceOrder(signal, lot, slPrice, tpPrice){
  if(!EXNESS.apiKey) return { ok: false, msg: 'Exness belum disetting. Ketik /apikey dulu + /akun 27000017363' };
  if(!CFG.akunId || CFG.akunId === '-') return { ok: false, msg: 'Akun ID belum diset. Kirim /akun 27000017363 dulu.' };
  let entryPrice = await exnessGetPrice(true);
  if(!entryPrice) return { ok: false, msg: 'Harga Exness gak dapet (' + (EXNESS.lastError || 'gagal') + '). Order dibatalin, gak pake harga XAUT.' };
  let pp = getSLTP_Pips();
  let sl = signal === 'BUY' ? entryPrice - pp.sl*0.1 : entryPrice + pp.sl*0.1;
  let tp = signal === 'BUY' ? entryPrice + pp.tp*0.1 : entryPrice - pp.tp*0.1;
  if(slPrice) sl = slPrice;
  if(tpPrice) tp = tpPrice;
  try{
    let j = await exnessRequest('/v1/trading/order', 'POST', {
      symbol: CFG.simbol,
      type: signal === 'BUY' ? 'BUY' : 'SELL',
      volume: lot,
      sl: parseFloat(sl.toFixed(2)),
      tp: parseFloat(tp.toFixed(2)),
      account_id: EXNESS.accountId || CFG.akunId || undefined,
    });
    if(!j){ return { ok: false, msg: 'Order Exness ditolak: ' + (EXNESS.lastError || 'gagal') }; }
    let orderId = (j && (j.order_id || j.id || j.data?.order_id)) || ('EXN-' + Date.now());
    console.log('Exness order:', signal, lot, entryPrice, 'SL', sl, 'TP', tp, 'orderId', orderId);
    return { ok: true, orderId, entry: entryPrice, sl, tp, raw: j };
  }catch(e){
    return { ok: false, msg: 'Order Exness gagal: ' + e.message };
  }
}
async function exnessGetPositions(){
  if(!EXNESS.apiKey) return [];
  if(!CFG.akunId || CFG.akunId === '-') return [];
  try{
    let j = await exnessRequest('/v1/trading/positions');
    let arr = [];
    if(j){
      if(Array.isArray(j)) arr = j;
      else if(Array.isArray(j.data)) arr = j.data;
      else if(Array.isArray(j.positions)) arr = j.positions;
    }
    if(arr.length){ exnessPositionsCache = arr; return arr; }
    // Kalo API balikin array kosong beneran, itu artinya beneran gak ada posisi, jangan fallback ke currentSetup
    if(j && (Array.isArray(j) || Array.isArray(j.data) || Array.isArray(j.positions))) return [];
  }catch(e){}
  // FIX: jangan ngaku currentSetup lokal sebagai posisi Exness. Kalo API gagal, balikin [] + error jujur.
  return [];
}
async function exnessGetBalance(){
  if(!EXNESS.apiKey) return null;
  if(!CFG.akunId || CFG.akunId === '-') return null;
  try{
    let j = await exnessRequest('/v1/account/balance');
    if(j){
      let bal = j.balance ?? j.data?.balance ?? j.equity ?? null;
      let eq = j.equity ?? j.data?.equity ?? bal;
      if(bal !== null){
        exnessBalanceCache = { balance: parseFloat(bal), equity: parseFloat(eq), at: Date.now() };
        EXNESS.balance = exnessBalanceCache.balance; EXNESS.equity = exnessBalanceCache.equity;
        return exnessBalanceCache;
      }
    }
    let j2 = await exnessRequest('/v1/trading/accounts/' + (EXNESS.accountId || CFG.akunId) + '/snapshot');
    if(j2){
      let d = j2.data || j2 || {};
      let bal2 = d.balance ?? d.account?.balance ?? null;
      if(bal2 !== null){
        exnessBalanceCache = { balance: parseFloat(bal2), equity: parseFloat(d.equity ?? d.account?.equity ?? bal2), at: Date.now() };
        EXNESS.balance = exnessBalanceCache.balance; EXNESS.equity = exnessBalanceCache.equity;
        return exnessBalanceCache;
      }
    }
  }catch(e){}
  return null;
}
function hitungPnL(setup){
  if(!setup || !setup.exness_entry) return { usd: 0, text: '-' };
  // PnL pake harga Exness asli kalo ada, kalo gak ada pake XAUT tapi kasih tanda *
  let hargaNow = EXNESS.lastPriceReal || xautPrice || setup.exness_entry;
  let delta = setup.signal === 'BUY' ? (hargaNow - setup.exness_entry) : (setup.exness_entry - hargaNow);
  let pnlDollar = delta * CFG.lot * 100;
  let pips = delta * 10;
  let sign = pnlDollar >= 0 ? '+' : '';
  let star = EXNESS.lastPriceReal ? '' : ' *';
  return { usd: pnlDollar, pips, text: `${sign}$${pnlDollar.toFixed(2)} (${sign}${pips.toFixed(0)} pips)${star}` };
}

// ===== TELEGRAM COMMAND HANDLER - LENGKAP DETAIL =====
async function handleTelegramCommand(chatId, textRaw){
  let text = String(textRaw||'').trim();
  let lower = text.toLowerCase().replace(',', '.');
  let cv = convo[chatId];
  // FIX: kalo user kirim key mentah tanpa /apikey, jangan dikira command aneh. Kasih tau cara benernya.
  if(/^exnsk-/i.test(text) || /^exn_/i.test(text)){
    await sendTelegramTo(chatId, `⚠️ Key-nya jangan dikirim mentah gitu bro, bahaya kalo ke-forward.\n\nCara benernya:\n/apikey <key lo>\n\nGue gak nyimpen key yang barusan lo kirim mentah itu. Kirim ulang pake /apikey.`);
    return;
  }
  if(cv){
    if(cv.step === 'AKUN_KEY'){
      let key = text.trim();
      if(key.length < 5){ await sendTelegramTo(chatId, `Key-nya kependekan bro, coba kirim lagi. Contoh: exn_xxxx`); return; }
      cv.tmp.apiKey = key;
      cv.step = 'AKUN_SECRET';
      await sendTelegramTo(chatId, `✅ API Key kesimpen.\n\nSekarang kirim Secret Key lo (yang cuma muncul sekali pas bikin key).\n\nKalo lo cuma punya 1 key doang (tanpa secret), ketik: - (strip)`);
      return;
    }
    if(cv.step === 'AKUN_SECRET'){
      let sec = text.trim();
      if(sec === '-' || sec.toLowerCase() === 'skip' || sec.toLowerCase() === 'gak ada'){
        EXNESS.apiKey = cv.tmp.apiKey; EXNESS.secret = ''; EXNESS.connected = false;
        // FIX: JANGAN isi akunId dari potongan key
        delete convo[chatId];
        await sendTelegramTo(chatId, `✅ Key kesimpen.\n\nSekarang kirim Akun ID lo:\n/akun 27000017363 CENT 0.01\n\nAtau kirim: /akun 27000017363\n\nAkun ID sekarang masih: ${CFG.akunId || '-'}`);
        return;
      }
      if(sec.length < 5){ await sendTelegramTo(chatId, `Secret-nya kependekan bro, coba kirim lagi. Atau ketik - kalo gak punya secret.`); return; }
      EXNESS.apiKey = cv.tmp.apiKey;
      EXNESS.secret = sec;
      EXNESS.connected = false;
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Key + Secret kesimpen.\n\nSekarang kirim Akun ID lo:\n/akun 27000017363 CENT 0.01`);
      return;
    }
    if(cv.step === 'SLTP_SL'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Angkanya gak kebaca bro. Ketik angka, contoh: 50`); return; }
      cv.tmp.sl = v; cv.step = 'SLTP_TP';
      await sendTelegramTo(chatId, `SL FIX ${v} pips oke.\n\nSekarang TP berapa pips? Contoh: 50`);
      return;
    }
    if(cv.step === 'SLTP_TP'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Angkanya gak kebaca bro. Ketik angka, contoh: 50`); return; }
      CFG.slMode = 'FIX'; CFG.slFix = cv.tmp.sl; CFG.tpFix = v;
      SL_PIPS = cv.tmp.sl; TP_PIPS = v; SL_DOLLAR = cv.tmp.sl/10; TP_DOLLAR = v/10;
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ SL/TP diganti!\nMode: FIX\nSL: ${CFG.slFix} pips\nTP: ${CFG.tpFix} pips\n\nSinyal berikutnya langsung pake setting ini, dan SL/TP di Tele + Vercel langsung sinkron ke harga Exness.`);
      return;
    }
    if(cv.step === 'SLTP_SLMIN'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 20`); return; }
      cv.tmp.slMin = v; cv.step = 'SLTP_SLMAX';
      await sendTelegramTo(chatId, `SL Min ${v} oke.\n\nSL Max berapa? Contoh: 100`);
      return;
    }
    if(cv.step === 'SLTP_SLMAX'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 100`); return; }
      cv.tmp.slMax = v; cv.step = 'SLTP_TPMIN';
      await sendTelegramTo(chatId, `SL Max ${v} oke.\n\nTP Min berapa? Contoh: 30`);
      return;
    }
    if(cv.step === 'SLTP_TPMIN'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 30`); return; }
      cv.tmp.tpMin = v; cv.step = 'SLTP_TPMAX';
      await sendTelegramTo(chatId, `TP Min ${v} oke.\n\nTP Max berapa? Contoh: 150`);
      return;
    }
    if(cv.step === 'SLTP_TPMAX'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 150`); return; }
      CFG.slMode = 'FLEKSIBEL'; CFG.slMin = cv.tmp.slMin; CFG.slMax = cv.tmp.slMax; CFG.tpMin = cv.tmp.tpMin; CFG.tpMax = v;
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ SL/TP diganti!\nMode: FLEKSIBEL\nSL: ${CFG.slMin} - ${CFG.slMax} pips\nTP: ${CFG.tpMin} - ${CFG.tpMax} pips\n\nSinyal berikutnya pake tengah range-nya biar konsisten.`);
      return;
    }
    if(cv.step === 'LOT'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka lot bro, contoh: 0.01`); return; }
      CFG.lot = v; delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Lot diganti ke ${v}`);
      return;
    }
    if(cv.step === 'RATIO'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka bro, contoh: 5`); return; }
      RATIO_MIN = v; delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Ratio diganti ke ${v}x`);
      return;
    }
    if(cv.step === 'JARAK'){
      let parts = text.replace(/-/g,' ').split(/\s+/).map(parseNum).filter(x=>!isNaN(x));
      if(!parts.length){ await sendTelegramTo(chatId, `Ketik jarak bro, contoh: 0 3`); return; }
      if(parts.length===1){ JARAK_MIN = 0; JARAK_MAX = parts[0]; }
      else { JARAK_MIN = parts[0]; JARAK_MAX = parts[1]; }
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Jarak diganti ke ${JARAK_MIN} - ${JARAK_MAX}$`);
      return;
    }
    if(cv.step === 'BETAH'){
      let v = parseNum(text);
      if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Ketik angka menit bro, contoh: 5`); return; }
      BETAH_MIN_MENIT = Math.round(v); delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Betah diganti ke ${BETAH_MIN_MENIT} menit`);
      return;
    }
    if(cv.step === 'SIMBOL'){
      let s = text.trim().toUpperCase().replace(/\s/g,'');
      if(!s){ await sendTelegramTo(chatId, `Ketik simbol bro, contoh: XAUUSDc`); return; }
      CFG.simbol = s;
      CFG.isCent = s.toLowerCase().includes('c') || s.includes('.c') || s.toLowerCase().endsWith('c');
      delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Simbol diganti ke ${s}${CFG.isCent ? ' (kedetek Cent)' : ''}`);
      return;
    }
    if(cv.step === 'JAM'){
      if(lower.includes('24')){
        CFG.jam24 = true; CFG.jamStart='00:00'; CFG.jamEnd='23:59'; delete convo[chatId];
        await sendTelegramTo(chatId, `✅ Jam diganti ke 24 jam (00:00 - 23:59 WIB)`);
        return;
      }
      let parts = text.replace(/-/g,' ').split(/\s+/).map(parseJam).filter(Boolean);
      if(parts.length<2){ await sendTelegramTo(chatId, `Formatnya bro: 08:00 22:00 atau ketik 24jam`); return; }
      CFG.jamStart = parts[0]; CFG.jamEnd = parts[1]; CFG.jam24 = false; delete convo[chatId];
      await sendTelegramTo(chatId, `✅ Jam diganti ke ${CFG.jamStart} - ${CFG.jamEnd} WIB`);
      return;
    }
  }

  let m = text.match(/^\/?([a-z_]+)\s*(.*)$/i);
  if(!m) return;
  let cmd = m[1].toLowerCase();
  let arg = (m[2]||'').trim();
  let argLower = arg.toLowerCase();

  if(cmd === 'start'){
    await sendTelegramTo(chatId, statusText() + `\n\nKetik /help buat liat semua command.`);
    return;
  }
  if(cmd === 'help'){
    await sendTelegramTo(chatId,
`📋 COMMAND ABEL BOT - LENGKAP\n\n`+
`AKUN (WAJIB 2 LANGKAH):\n`+
`/apikey <key> - Pasang key Exness (cuma key, gak ngubah Akun ID)\n`+
`/akun 27000017363 CENT 0.01 - Set Akun ID + jenis + lot\n`+
`/akun_list - Liat akun aktif\n`+
`/cekexness - Cek saldo + harga asli + posisi Exness beneran\n`+
`/hapuskey - Hapus key Exness dari memory\n\n`+
`SETTING:\n`+
`/status - Liat setting sekarang\n`+
`/simbol - Ganti simbol (XAUUSD / XAUUSDc)\n`+
`/lot 0.01 - Ganti lot\n`+
`/ratio 5 - Ganti ratio\n`+
`/jarak 0 3 - Ganti jarak tembok\n`+
`/betah 5 - Ganti durasi betah (menit)\n`+
`/sltp - Ganti SL/TP FIX / FLEKSIBEL (pake tombol)\n`+
`/jam 08:00 22:00 - Jam aktif WIB\n`+
`/jam 24jam - Jalan 24 jam\n\n`+
`POSISI:\n`+
`/posisi - Liat posisi Exness (beneran dari Exness, bukan simulasi)\n`+
`/saldo - Liat saldo Exness\n`+
`/startbot - Nyalain auto-entry\n`+
`/stopbot - Matiin auto-entry (sinyal tetep jalan)\n`+
`/auto on / off - Cara cepat start/stop auto-entry\n`+
`/unlock - Batalin lock / posisi aktif manual\n`+
`/history - History sinyal\n`+
`/test - Tes Telegram\n\n`+
`Tips: ketik command-nya doang tanpa angka, bot bakal nanya step by step.`);
    return;
  }
  if(cmd === 'status'){
    await sendTelegramTo(chatId, statusText());
    return;
  }
  // ===== FIX: /apikey CUMA BUAT KEY, GAK NGUBAH AKUN ID =====
  if(cmd === 'apikey'){
    if(!arg){ await sendTelegramTo(chatId, `Format: /apikey <key lo>\n\nContoh: /apikey exn_xxxx\n\nIni CUMA nyimpen key. Abis ini lo WAJIB kirim:\n/akun 27000017363 CENT 0.01\n\nBiar bot tau akun mana yang mau dicek.`); return; }
    EXNESS.apiKey = arg.trim(); EXNESS.secret = ''; EXNESS.connected = false; EXNESS.lastError = '';
    // FIX: JANGAN ubah CFG.akunId di sini. Biarin apa adanya.
    await sendTelegramTo(chatId, `⏳ Key diterima (${maskKey(EXNESS.apiKey)}).\n\nAkun ID sekarang masih: ${CFG.akunId || '-'}\n\nKalo Akun ID lo belum 27000017363, kirim sekarang:\n/akun 27000017363 CENT 0.01\n\nAbis itu kirim /cekexness buat tes beneran.`);
    return;
  }
  if(cmd === 'cekexness'){
    if(!EXNESS.apiKey){ await sendTelegramTo(chatId, `❌ Belum ada API Key. Kirim /apikey <key> dulu.`); return; }
    if(!CFG.akunId || CFG.akunId === '-'){ await sendTelegramTo(chatId, `❌ Akun ID belum diset.\n\nKirim dulu:\n/akun 27000017363 CENT 0.01\n\nAbis itu baru /cekexness lagi.`); return; }
    await sendTelegramTo(chatId, `⏳ Lagi cek ke api.exness.com...\nAkun ID yang dicek: ${CFG.akunId}`);
    try{
      let p = await exnessGetPrice(true);
      let b = await exnessGetBalance();
      let pos = await exnessGetPositions();
      // JUJUR: kalo harga Exness gak dapet, bilang gak dapet, jangan tempelin XAUT
      let hargaTxt = p ? `$${p.toFixed(2)} (ASLI Exness)` : `GAK DAPET - ${EXNESS.lastError || 'gagal'}`;
      let saldoTxt = b ? `$${b.balance.toFixed(2)}` : `GAK DAPET - ${EXNESS.lastError || 'gagal'}`;
      let equityTxt = b ? `$${b.equity.toFixed(2)}` : `GAK DAPET`;
      let posTxt = 'Gak ada posisi yang jalan di Exness (beneran kosong - hasil dari API Exness)';
      if(pos.length){
        posTxt = pos.map(x=> `${x.type || x.side || '-'} ${x.symbol || CFG.simbol} Vol ${x.volume || '-'} Entry $${parseFloat(x.open_price||0).toFixed(2)}`).join('\n');
      } else if(EXNESS.lastError){
        posTxt = `GAK BISA CEK POSISI - ${EXNESS.lastError}`;
      }
      let selisihTxt = (p && xautPrice) ? `$${Math.abs(p-xautPrice).toFixed(2)}` : '- (harga Exness gak dapet)';
      await sendTelegramTo(chatId, `✅ EXNESS - CEK LANGSUNG\nAkun: ${akunText()}\nSaldo: ${saldoTxt}\nEquity: ${equityTxt}\nHarga XAUUSD Exness (ASLI): ${hargaTxt}\nHarga XAUT Bybit+OKX: $${xautPrice ? xautPrice.toFixed(2) : '-'}\nSelisih: ${selisihTxt}\nPosisi di Exness:\n${posTxt}\nKey: ${maskKey(EXNESS.apiKey)}\nError terakhir: ${EXNESS.lastError || '-'}`);
    }catch(e){ await sendTelegramTo(chatId, `❌ Gagal cek Exness:\n${e.message}`); }
    return;
  }
  if(cmd === 'hapuskey' || cmd === 'hapuskunci'){
    EXNESS.apiKey = ''; EXNESS.secret = ''; EXNESS.connected = false; EXNESS.lastPriceReal = 0; EXNESS.lastError = '';
    await sendTelegramTo(chatId, `✅ API Key udah dihapus dari memory bot. Akun ID tetep kesimpen: ${CFG.akunId || '-'}\nAuto-entry sekarang jadi SIMULASI sampe lo kirim /apikey lagi.`);
    return;
  }
  // ===== FIX: /akun KHUSUS BUAT AKUN ID, BUKAN BUAT KEY =====
  if(cmd === 'akun'){
    if(arg){
      let parts = arg.split(/\s+/);
      // Format: /akun 27000017363 CENT 0.01  ATAU  /akun 27000017363
      if(/^\d+$/.test(parts[0])){
        CFG.akunId = parts[0]; EXNESS.accountId = parts[0]; CFG.akunLabel = 'Exness';
        if(parts[1]){ let jenis = parts[1].toUpperCase(); CFG.isCent = jenis.includes('CENT'); if(jenis.includes('CENT')) CFG.simbol = 'XAUUSDc'; else if(jenis.includes('STANDARD') || jenis.includes('PRO') || jenis.includes('RAW')) CFG.simbol = 'XAUUSD'; }
        if(parts[2]){ let lot = parseNum(parts[2]); if(!isNaN(lot) && lot>0) CFG.lot = lot; }
        await sendTelegramTo(chatId, `✅ Akun diganti (BENERAN Akun ID, bukan potongan key):\nAkun ID: ${CFG.akunId}\nLabel: ${CFG.akunLabel}\nSimbol: ${CFG.simbol}${CFG.isCent ? ' (CENT)' : ''}\nLot: ${CFG.lot}\nKey: ${maskKey(EXNESS.apiKey)}\n\nKirim /cekexness buat tes koneksi beneran ke akun ${CFG.akunId}.`);
        return;
      }
      // Kalo arg bukan angka, misal /akun CENT, kasih tau format bener
      await sendTelegramTo(chatId, `Format /akun yang bener:\n/akun 27000017363 CENT 0.01\n\nYang pertama harus angka Akun ID lo, bukan key, bukan nama.`);
      return;
    }
    // Kalo /akun doang tanpa arg, JANGAN langsung minta key. Kasih tau 2 pilihan yang jelas.
    await sendTelegramTo(chatId, `🔑 Setting Akun\n\nAkun ID sekarang: ${CFG.akunId || '-'}\nKey: ${maskKey(EXNESS.apiKey)}\n\nPilih salah satu:\n1. Set Akun ID doang (paling sering):\n/akun 27000017363 CENT 0.01\n\n2. Ganti Key + Secret step by step:\nKetik: /akun key\n\nKetik angka 1 atau 2? Atau langsung kirim format no.1.`);
    // Simpen state kalo user mau cara key+secret
    convo[chatId] = { step: 'AKUN_MENU', tmp: {} };
    return;
  }
  // Handler khusus kalo user lagi di menu /akun dan pilih 1 / 2 / key
  if(cmd === 'akun_list' || cmd === 'akunlist'){
    await sendTelegramTo(chatId, `👤 Akun Aktif\n\nAkun: ${akunText()}\nSimbol: ${CFG.simbol}${CFG.isCent ? ' (Cent)' : ''}\nLot: ${CFG.lot}\nExness: ${(EXNESS.connected && EXNESS.lastPriceReal) ? 'Nyambung ✅ (harga asli dapet)' : 'Belum nyambung beneran - ' + (EXNESS.lastError || 'belum cek')}\nHarga Exness (asli): ${EXNESS.lastPriceReal ? '$'+EXNESS.lastPriceReal.toFixed(2) : 'GAK DAPET'}\nHarga XAUT: $${xautPrice ? xautPrice.toFixed(2) : '-'}\nKey: ${maskKey(EXNESS.apiKey)}\n\nBuat ganti Akun ID, ketik: /akun 27000017363 CENT 0.01\nBuat ganti Key, ketik: /apikey <key>`);
    return;
  }
  if(cmd === 'simbol'){
    if(!arg){ convo[chatId] = { step: 'SIMBOL', tmp: {} }; await sendTelegramTo(chatId, `Simbol sekarang: ${CFG.simbol}\n\nMau ganti ke apa? Contoh: XAUUSD atau XAUUSDc (buat Cent)`); return; }
    CFG.simbol = arg.toUpperCase().replace(/\s/g,'');
    CFG.isCent = CFG.simbol.toLowerCase().includes('c');
    await sendTelegramTo(chatId, `✅ Simbol diganti ke ${CFG.simbol}${CFG.isCent ? ' (kedetek Cent)' : ''}`);
    return;
  }
  if(cmd === 'lot'){
    if(!arg){ convo[chatId] = { step: 'LOT', tmp: {} }; await sendTelegramTo(chatId, `Lot sekarang: ${CFG.lot}\n\nMau ganti ke berapa? Contoh: 0.01`); return; }
    let v = parseNum(arg);
    if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Lot-nya gak kebaca bro. Contoh: /lot 0.01`); return; }
    CFG.lot = v;
    await sendTelegramTo(chatId, `✅ Lot diganti ke ${v}`);
    return;
  }
  if(cmd === 'ratio'){
    if(!arg){ convo[chatId] = { step: 'RATIO', tmp: {} }; await sendTelegramTo(chatId, `Ratio sekarang: ${RATIO_MIN}x\n\nMau ganti ke berapa? Contoh: 5`); return; }
    let v = parseNum(arg);
    if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Contoh: /ratio 5`); return; }
    RATIO_MIN = v;
    await sendTelegramTo(chatId, `✅ Ratio diganti ke ${v}x`);
    return;
  }
  if(cmd === 'jarak'){
    if(!arg){ convo[chatId] = { step: 'JARAK', tmp: {} }; await sendTelegramTo(chatId, `Jarak sekarang: ${JARAK_MIN} - ${JARAK_MAX}$\n\nMau ganti ke berapa? Contoh: 0 3`); return; }
    let parts = arg.replace(/-/g,' ').split(/\s+/).map(parseNum).filter(x=>!isNaN(x));
    if(!parts.length){ await sendTelegramTo(chatId, `Contoh: /jarak 0 3`); return; }
    if(parts.length===1){ JARAK_MIN = 0; JARAK_MAX = parts[0]; } else { JARAK_MIN = parts[0]; JARAK_MAX = parts[1]; }
    await sendTelegramTo(chatId, `✅ Jarak diganti ke ${JARAK_MIN} - ${JARAK_MAX}$`);
    return;
  }
  if(cmd === 'betah'){
    if(!arg){ convo[chatId] = { step: 'BETAH', tmp: {} }; await sendTelegramTo(chatId, `Betah sekarang: ${BETAH_MIN_MENIT} menit\n\nMau ganti ke berapa menit? Contoh: 5`); return; }
    let v = parseNum(arg);
    if(isNaN(v) || v<=0){ await sendTelegramTo(chatId, `Contoh: /betah 5`); return; }
    BETAH_MIN_MENIT = Math.round(v);
    await sendTelegramTo(chatId, `✅ Betah diganti ke ${BETAH_MIN_MENIT} menit`);
    return;
  }
  if(cmd === 'sltp'){
    await sendTelegramTo(chatId, `🎯 Pilih mode SL/TP:\n\nSekarang: ${sltpText()}\n\nKlik salah satu:`, [
      [{ text: 'FIX', callback_data: 'SLTP_FIX' }, { text: 'FLEKSIBEL', callback_data: 'SLTP_FLEX' }]
    ]);
    return;
  }
  if(cmd === 'jam'){
    if(!arg){ convo[chatId] = { step: 'JAM', tmp: {} }; await sendTelegramTo(chatId, `Jam sekarang: ${CFG.jam24 ? '24 jam' : CFG.jamStart+' - '+CFG.jamEnd+' WIB'}\n\nMau ganti ke apa?\n- 24 jam: ketik 24jam\n- Jam tertentu: ketik 08:00 22:00`); return; }
    if(argLower.includes('24') || argLower.includes('full') || argLower === 'off'){
      CFG.jam24 = true; CFG.jamStart='00:00'; CFG.jamEnd='23:59';
      await sendTelegramTo(chatId, `✅ Jam diganti ke 24 jam (00:00 - 23:59 WIB)`);
      return;
    }
    let parts = arg.replace(/-/g,' ').split(/\s+/).map(parseJam).filter(Boolean);
    if(parts.length<2){ await sendTelegramTo(chatId, `Formatnya: /jam 08:00 22:00 atau /jam 24jam`); return; }
    CFG.jamStart = parts[0]; CFG.jamEnd = parts[1]; CFG.jam24 = false;
    await sendTelegramTo(chatId, `✅ Jam diganti ke ${CFG.jamStart} - ${CFG.jamEnd} WIB`);
    return;
  }
  if(cmd === 'posisi'){
    if(!EXNESS.apiKey){ await sendTelegramTo(chatId, `❌ Belum ada API Key. Kirim /apikey dulu.`); return; }
    if(!CFG.akunId || CFG.akunId === '-'){ await sendTelegramTo(chatId, `❌ Akun ID belum diset. Kirim /akun 27000017363 dulu.`); return; }
    let pos = await exnessGetPositions();
    if(!pos.length){
      if(EXNESS.lastError) await sendTelegramTo(chatId, `Gak bisa cek posisi - ${EXNESS.lastError}\n\nPosisi lokal bot (bukan dari Exness): ${currentSetup ? currentSetup.signal + ' ' + currentSetup.setup_id : 'gak ada'}`);
      else await sendTelegramTo(chatId, `Gak ada posisi yang jalan di Exness (beneran kosong, dari API Exness).\n\nPosisi lokal bot: ${currentSetup ? currentSetup.signal + ' ' + currentSetup.setup_id : 'gak ada'}`);
      return;
    }
    let txt = `📈 Posisi Exness yang jalan (dari API Exness):\n\n`;
    pos.forEach((p,i)=>{
      txt += `${i+1}. ${p.type || p.side || ''} ${p.symbol || CFG.simbol} ${p.volume || CFG.lot} lot\nEntry: $${parseFloat(p.open_price||0).toFixed(2)} | Sekarang: $${parseFloat(p.current_price||EXNESS.lastPriceReal||0).toFixed(2)}\nPnL: ${p.profit !== undefined ? '$'+parseFloat(p.profit).toFixed(2) : '-'}\nSL: ${p.sl||'-'} TP: ${p.tp||'-'}\n\n`;
    });
    await sendTelegramTo(chatId, txt);
    return;
  }
  if(cmd === 'saldo'){
    if(!EXNESS.apiKey){ await sendTelegramTo(chatId, `❌ Belum ada API Key. Kirim /apikey dulu.`); return; }
    if(!CFG.akunId || CFG.akunId === '-'){ await sendTelegramTo(chatId, `❌ Akun ID belum diset. Kirim /akun 27000017363 dulu.`); return; }
    let b = await exnessGetBalance();
    if(!b){ await sendTelegramTo(chatId, `Saldo GAK DAPET - ${EXNESS.lastError || 'gagal'}\n\nAkun yang dicek: ${CFG.akunId}\nCek key + Akun ID lo, atau tunggu 30 detik kalo tadi kena 429.`); return; }
    await sendTelegramTo(chatId, `💰 Saldo Exness (ASLI)\n\nAkun: ${akunText()}\nBalance: $${b.balance.toFixed(2)}\nEquity: $${b.equity.toFixed(2)}`);
    return;
  }
  if(cmd === 'startbot'){
    CFG.autoEntry = true;
    await sendTelegramTo(chatId, `✅ Auto-entry NYALA.\nSinyal + entry Exness jalan.`);
    return;
  }
  if(cmd === 'stopbot'){
    CFG.autoEntry = false;
    await sendTelegramTo(chatId, `⏸️ Auto-entry MATI.\nSinyal tetep jalan terus, tapi gak entry ke Exness. Buat nyalain lagi: /startbot`);
    return;
  }
  if(cmd === 'auto'){
    if(!arg){ await sendTelegramTo(chatId, `Auto-entry sekarang: ${CFG.autoEntry ? 'ON ✅' : 'OFF ⏸️'}\n\nKetik: /auto on atau /auto off`); return; }
    CFG.autoEntry = argLower === 'on' || argLower === 'nyala' || argLower === '1';
    await sendTelegramTo(chatId, CFG.autoEntry ? `✅ Auto-entry NYALA - sinyal baru bakal buka posisi beneran di Exness` : `⏸️ Auto-entry MATI - sinyal jadi SIMULASI doang`);
    return;
  }
  if(cmd === 'unlock'){
    if(currentSetup){ lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xautPrice, closed_at: Date.now() }; closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xautPrice); currentSetup = null; await sendTelegramTo(chatId, `✅ Lock dibatalin manual. Bot siap cari sinyal baru.`); }
    else await sendTelegramTo(chatId, `✅ Gak ada lock aktif. Bot udah siap cari sinyal baru.`);
    return;
  }
  if(cmd === 'history'){
    let closed = signalHistory.filter(x=>x.closed_at).slice(0,10);
    if(!closed.length){ await sendTelegramTo(chatId, `Belum ada history sinyal yang ke-close.`); return; }
    let txt = `📜 History 10 terakhir:\n\n`;
    closed.forEach(h=>{
      txt += `${h.setup_id} ${h.signal} - ${h.result}\n`;
    });
    await sendTelegramTo(chatId, txt);
    return;
  }
  if(cmd === 'test'){
    await sendTelegramTo(chatId, `📩 TEST TELEGRAM\nXAUT: $${xautPrice ? xautPrice.toFixed(2) : '-'}\nExness (asli): ${EXNESS.lastPriceReal ? '$'+EXNESS.lastPriceReal.toFixed(2) : 'GAK DAPET - ' + (EXNESS.lastError || '-')}\nAkun: ${akunText()} | Key: ${maskKey(EXNESS.apiKey)}\nKalo lo baca ini, Tele bot jalan.`);
    return;
  }
  await sendTelegramTo(chatId, `Command /${cmd} gak dikenal bro. Ketik /help buat liat list command.`);
}

// Callback tombol FIX / FLEKSIBEL
async function handleCallback(chatId, data, callbackId){
  if(data === 'SLTP_FIX'){
    convo[chatId] = { step: 'SLTP_SL', tmp: {} };
    await answerCallback(callbackId, 'FIX dipilih');
    await sendTelegramTo(chatId, `Mode FIX dipilih.\n\nSL berapa pips? Contoh: 50`);
    return;
  }
  if(data === 'SLTP_FLEX'){
    convo[chatId] = { step: 'SLTP_SLMIN', tmp: {} };
    await answerCallback(callbackId, 'FLEKSIBEL dipilih');
    await sendTelegramTo(chatId, `Mode FLEKSIBEL dipilih.\n\nSL Min berapa? Contoh: 20`);
    return;
  }
  await answerCallback(callbackId, 'OK');
}

// ===== WEBHOOK TELEGRAM =====
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

// ===== POLLING TELEGRAM - BIAR COMMAND JALAN TANPA SET WEBHOOK =====
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
              if(txt.trim().toLowerCase().startsWith('/apikey ')){
                try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: upd.message.message_id }) }); }catch(e){}
              }
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

// ===== FIX WS BYBIT SAMPE OK - JANGAN DIOTAK-ATIK LAGI =====
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
      await sendTelegram(`❌ ${displaySignal} LOSE - Setup ${s.setup_id}\n\nHarga Exness (asli): ${EXNESS.lastPriceReal ? '$'+EXNESS.lastPriceReal.toFixed(2) : 'GAK DAPET - ' + (EXNESS.lastError || '-')}\nHarga XAUT: $${xautPrice.toFixed(2)}\nEntry Exness: ${s.exness_entry ? '$'+s.exness_entry.toFixed(2) : fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nSL Exness: ${s.exness_sl ? '$'+s.exness_sl.toFixed(2) : fmtZona(s.zona.slLow, s.zona.slHigh)} (-${s.exness_sl_pips||SL_PIPS} pips)\nHasil: LOSE - SL KENA`);
      currentSetup = null; return;
    }
    const kenaTP = isBuy ? xautPrice >= tpHarga : xautPrice <= tpHarga;
    if(kenaTP){
      lastSetup = { ...s, state: 'CLOSED', result: 'WIN - TP KENA', result_price: xautPrice, closed_at: Date.now() };
      lastDone = { last_result: displaySignal + ' WIN - TP KENA di ' + tpHarga.toFixed(2) + ' - Setup ' + s.setup_id };
      closeHistory(s.id, 'WIN - TP KENA', xautPrice);
      await sendTelegram(`✅ ${displaySignal} WIN - Setup ${s.setup_id}\n\nHarga Exness (asli): ${EXNESS.lastPriceReal ? '$'+EXNESS.lastPriceReal.toFixed(2) : 'GAK DAPET - ' + (EXNESS.lastError || '-')}\nHarga XAUT: $${xautPrice.toFixed(2)}\nEntry Exness: ${s.exness_entry ? '$'+s.exness_entry.toFixed(2) : fmtZona(s.zona.entryLow, s.zona.entryHigh)}\nTP Exness: ${s.exness_tp ? '$'+s.exness_tp.toFixed(2) : fmtZona(s.zona.tpLow, s.zona.tpHigh)} (+${s.exness_tp_pips||TP_PIPS} pips)\nHasil: WIN - TP KENA`);
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

  let exnessEntry = null, exnessSL = null, exnessTP = null, exnessOrderId = null, exnessOk = false;
  let pp = getSLTP_Pips();
  // FIX: cuma entry Exness kalo Akun ID udah bener + harga Exness asli dapet. Kalo gak, jadi sinyal XAUT doang, JANGAN ngaku entry Exness.
  if(isJamAktif() && CFG.autoEntry && EXNESS.apiKey && CFG.akunId && CFG.akunId !== '-'){
    try{
      let ord = await exnessPlaceOrder(displaySignal, CFG.lot);
      if(ord && ord.ok){
        exnessEntry = ord.entry; exnessSL = ord.sl; exnessTP = ord.tp; exnessOrderId = ord.orderId; exnessOk = true;
      } else {
        console.log('Exness order dibatalin:', ord ? ord.msg : 'gagal');
      }
    }catch(e){ console.log('Exness order gagal', e.message); }
  }
  // Kalo Exness gagal, entry/sl/tp pake zona XAUT buat sinyal, tapi tandain exness_ok = false
  let entryExnessFinal = exnessEntry || entry;
  let slExnessFinal = exnessSL || slHarga;
  let tpExnessFinal = exnessTP || tpHarga;

  currentSetup = { id: 'SIG-' + now, setup_id: setupId, signal: displaySignal, state: 'IN_POSITION', entry, sl: slHarga, tp: tpHarga, zona, jarak: zona.jarak, entry_low: zona.entryLow, entry_high: zona.entryHigh, sl_low: zona.slLow, sl_high: zona.slHigh, tp_low: zona.tpLow, tp_high: zona.tpHigh, sl_pips: pp.sl, tp_pips: pp.tp, lockedAt: now, closed_at: null, result: 'AKTIF', wall: { side: terdekat.side, price: terdekat.price, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, distance: terdekat.distance }, lock_status: 'IN POSITION - ' + displaySignal + ' di ' + fmtZona(zona.entryLow, zona.entryHigh),
    exness_entry: entryExnessFinal, exness_sl: slExnessFinal, exness_tp: tpExnessFinal, exness_sl_pips: pp.sl, exness_tp_pips: pp.tp, exness_order_id: exnessOrderId, exness_ok: exnessOk, exness_price: entryExnessFinal, xaut_price: xautPrice, lot: CFG.lot, simbol: CFG.simbol };
  addHistory({ id: currentSetup.id, setup_id: setupId, signal: displaySignal + ' NOW', wall_side: terdekat.side, wall_price: terdekat.price, entry, sl: slHarga, tp: tpHarga, entry_low: zona.entryLow, entry_high: zona.entryHigh, sl_low: zona.slLow, sl_high: zona.slHigh, tp_low: zona.tpLow, tp_high: zona.tpHigh, sl_pips: pp.sl, tp_pips: pp.tp, size: terdekat.size, sources: terdekat.sources, age_menit: terdekat.age_menit, created_at: now, closed_at: null, result: 'AKTIF', result_price: null, duration_menit: 0,
    exness_entry: entryExnessFinal, exness_sl: slExnessFinal, exness_tp: tpExnessFinal, exness_sl_pips: pp.sl, exness_tp_pips: pp.tp, exness_order_id: exnessOrderId, lot: CFG.lot, simbol: CFG.simbol, xaut_price: xautPrice });

  if(exnessOk){
    await sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId} (ENTRY EXNESS BENERAN)\n\nEntry: $${entryExnessFinal.toFixed(2)} (Exness ASLI)\nSL: $${slExnessFinal.toFixed(2)} (SL -${pp.sl} pips dari entry Exness)\nTP: $${tpExnessFinal.toFixed(2)} (TP +${pp.tp} pips dari entry Exness)\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${zona.jarak}$)\nLot: ${CFG.lot} | Simbol: ${CFG.simbol} | Akun: ${CFG.akunId}\n\nHOLD BAGI YANG MAMPU🔥`);
  } else {
    let alasan = !EXNESS.apiKey ? 'Exness belum nyambung - ketik /apikey + /akun 27000017363' : (!CFG.akunId || CFG.akunId === '-' ? 'Akun ID belum diset - kirim /akun 27000017363 CENT 0.01' : (!isJamAktif() ? `Di luar jam ${CFG.jamStart}-${CFG.jamEnd} WIB` : (!CFG.autoEntry ? 'Auto-entry lagi STOP (sinyal tetep jalan)' : (EXNESS.lastError || 'Harga Exness gak dapet, jadi sinyal XAUT doang'))));
    await sendTelegram(`🎯 ${displaySignal} NOW - Setup ${setupId} (SINYAL XAUT - BELUM ENTRY EXNESS)\n\nEntry: $${entryExnessFinal.toFixed(2)} (XAUT - belum entry Exness)\nSL: $${slExnessFinal.toFixed(2)} (SL -${pp.sl} pips dari harga entry)\nTP: $${tpExnessFinal.toFixed(2)} (TP +${pp.tp} pips dari harga entry)\n\nTembok: ${terdekat.side} $${terdekat.price.toFixed(2)} - ${terdekat.size.toFixed(2)} XAUT - Betah ${terdekat.age_menit}m - ${terdekat.sources} (jarak ${zona.jarak}$)\nNote: ${alasan}\n\nHOLD BAGI YANG MAMPU🔥`);
  }
}
let tickRunning = false;
async function tick(){ if(tickRunning) return; tickRunning = true; try{ const { allBids, allAsks } = await fetchOrderbooks(); if(allBids.length) buildWalls(allBids, allAsks); await checkSignal(); lastUpdate = Date.now(); }catch(e){ console.log('tick gagal', e.message); } tickRunning = false; }
setInterval(tick, 1000); tick();
function buildSignalResponse(){
  const { pending, touched } = buildPendingOrders();
  let pnl = null;
  if(currentSetup && currentSetup.exness_entry) pnl = hitungPnL(currentSetup);
  if(currentSetup){ const s = currentSetup; return { signal: s.signal + ' - AKTIF', reason: '', setup_id: s.setup_id, pending, touched, entry: s.entry, entry_mt5: s.entry, sl: s.sl, sl_mt5: s.sl, tp: s.tp, tp_mt5: s.tp, entry_low: s.entry_low, entry_high: s.entry_high, sl_low: s.sl_low, sl_high: s.sl_high, tp_low: s.tp_low, tp_high: s.tp_high, jarak: s.jarak, zona: s.zona, sl_pips: s.sl_pips || SL_PIPS, tp_pips: s.tp_pips || TP_PIPS, is_locked: true, lockedState: s.state, lockedAt: s.lockedAt, lockedId: s.id, lock_status: s.lock_status, wall: s.wall,
    exness_entry: s.exness_entry || s.entry, exness_sl: s.exness_sl || s.sl, exness_tp: s.exness_tp || s.tp, exness_sl_pips: s.exness_sl_pips || SL_PIPS, exness_tp_pips: s.exness_tp_pips || TP_PIPS, exness_price: EXNESS.lastPriceReal || 0, exness_price_real: EXNESS.lastPriceReal || 0, exness_order_id: s.exness_order_id || null, exness_ok: !!s.exness_ok, lot: s.lot || CFG.lot, simbol: s.simbol || CFG.simbol, xaut_price: xautPrice, pnl_live: pnl ? pnl.usd : 0, pnl_text: pnl ? pnl.text : '-', pnl_pips: pnl ? pnl.pips : 0 }; }
  return { signal: 'WAIT', reason: '', setup_id: '', pending, touched, entry: 0, entry_mt5: 0, sl: 0, sl_mt5: 0, tp: 0, tp_mt5: 0, entry_low: 0, entry_high: 0, sl_low: 0, sl_high: 0, tp_low: 0, tp_high: 0, jarak: 0, zona: null, sl_pips: SL_PIPS, tp_pips: TP_PIPS, is_locked: false, lockedState: 'IDLE', lockedAt: null, lockedId: null, lock_status: lastSetup ? 'Last: ' + (lastDone ? lastDone.last_result : lastSetup.result) : 'Tidak terkunci', wall: null,
    exness_entry: 0, exness_sl: 0, exness_tp: 0, exness_price: EXNESS.lastPriceReal || 0, exness_price_real: EXNESS.lastPriceReal || 0, exness_order_id: null, exness_ok: false, lot: CFG.lot, simbol: CFG.simbol, xaut_price: xautPrice, pnl_live: 0, pnl_text: '-', pnl_pips: 0 };
}
function calcWinrate(){ const closed = signalHistory.filter(x=> x.closed_at); const win = closed.filter(x=> (x.result||'').includes('WIN')).length; const lose = closed.filter(x=> (x.result||'').includes('LOSE')).length; const total = win + lose; return { total, win, lose, winrate: total ? Math.round(win/total*100) : 0 }; }
app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - V13.2 FIX AKUN + 429 - Jarak 0-3$ Betah 5m Ratio 4x Zona SL50 TP50'));
app.get('/api/signal', async (req,res)=>{
  // FIX: JANGAN nanya Exness tiap hit /api/signal, pake cache 10 detik. Ini yang bikin 429 kemarin.
  const sig = buildSignalResponse(); const wr = calcWinrate();
  res.json({ ...sig, walls, wallsNear: walls, wallsFar, wallsFarCount: wallsFar.length, pendingOrders: sig.pending, touchedLevels: sig.touched, history: signalHistory, winrate_data: wr, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF',
    config: { lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, ratio: RATIO_MIN, jarak_min: JARAK_MIN, jarak_max: JARAK_MAX, betah: BETAH_MIN_MENIT, sl_mode: CFG.slMode, sl_fix: CFG.slFix, tp_fix: CFG.tpFix, sl_min: CFG.slMin, sl_max: CFG.slMax, tp_min: CFG.tpMin, tp_max: CFG.tpMax, jam_start: CFG.jamStart, jam_end: CFG.jamEnd, jam24: CFG.jam24, jam_wib_now: getWIBNow(), jam_aktif: isJamAktif(), auto_entry: CFG.autoEntry, akun_label: CFG.akunLabel, akun_id: CFG.akunId, exness_connected: !!(EXNESS.connected && EXNESS.lastPriceReal), exness_api_key: EXNESS.apiKey ? maskKey(EXNESS.apiKey) : '', exness_last_error: EXNESS.lastError || '' },
    harga: { xaut: xautPrice, xaut_mid: xautPrice, exness: EXNESS.lastPriceReal || 0, exness_price: EXNESS.lastPriceReal || 0, exness_real: EXNESS.lastPriceReal || 0, source: 'XAUT WS Bybit+OKX + Exness (asli, bukan tempelan)', ws_bybit: wsBybitOk ? 'WS-OK' : 'WS-OFF/REST', ws_okx: wsOkxOk ? 'WS-OK' : 'WS-OFF/REST', ws_last_bybit: wsLastBybit, ws_last_okx: wsLastOkx }, exchanges, uptimeStart, uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000), last_update: lastUpdate, last_done: lastDone, last_setup: lastSetup, current_setup: currentSetup });
});
app.get('/api/config', (req,res)=>{ res.json({ lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, ratio: RATIO_MIN, jarak_min: JARAK_MIN, jarak_max: JARAK_MAX, betah: BETAH_MIN_MENIT, sl_mode: CFG.slMode, sl_fix: CFG.slFix, tp_fix: CFG.tpFix, sl_min: CFG.slMin, sl_max: CFG.slMax, tp_min: CFG.tpMin, tp_max: CFG.tpMax, jam_start: CFG.jamStart, jam_end: CFG.jamEnd, jam24: CFG.jam24, jam_wib_now: getWIBNow(), jam_aktif: isJamAktif(), auto_entry: CFG.autoEntry, akun_label: CFG.akunLabel, akun_id: CFG.akunId, exness_connected: !!(EXNESS.connected && EXNESS.lastPriceReal), exness_price: EXNESS.lastPriceReal || 0, exness_last_error: EXNESS.lastError || '' }); });
app.get('/api/posisi', async (req,res)=>{ let pos = await exnessGetPositions(); res.json({ ok: true, positions: pos, exness_price: EXNESS.lastPriceReal || 0, xaut_price: xautPrice, last_error: EXNESS.lastError || '' }); });
app.get('/api/saldo', async (req,res)=>{ let b = await exnessGetBalance(); res.json({ ok: !!b, balance: b, akun: CFG.akunId, simbol: CFG.simbol, last_error: EXNESS.lastError || '' }); });
app.get('/api/history', (req,res)=>{ const since = req.query.since ? parseInt(req.query.since) : uptimeStart; const filtered = signalHistory.filter(x => (x.created_at || 0) >= since); const wr = calcWinrate(); res.json({ history: filtered, total: filtered.length, winrate_data: wr, uptimeStart, sesi_mulai: new Date(uptimeStart).toLocaleString('id-ID'), uptime_menit: Math.floor((Date.now() - uptimeStart) / 60000) }); });
app.get('/api/history-sesi', (req,res)=>{ res.redirect('/api/history'); });
app.get('/api/ws-test', (req,res)=>{ const w=getWsOrderbooks(); res.json({ ws_bybit_ok: wsBybitOk, ws_okx_ok: wsOkxOk, ws_last_bybit: wsLastBybit ? new Date(wsLastBybit).toLocaleTimeString('id-ID') : '-', ws_last_okx: wsLastOkx ? new Date(wsLastOkx).toLocaleTimeString('id-ID') : '-', bids_cached: w.allBids.length, asks_cached: w.allAsks.length, top_bid: w.allBids.length ? Math.max(...w.allBids.map(x=>x.price)) : 0, top_ask: w.allAsks.length ? Math.min(...w.allAsks.map(x=>x.price)) : 0, xaut_price: xautPrice, exness_price: EXNESS.lastPriceReal || 0 }); });
app.get('/api/test-telegram', async (req,res)=>{ const testId = generateSetupId(); const z = { jarak: 1, entryLow: 3830, entryHigh: 3831, slLow: 3825, slHigh: 3826, tpLow: 3835, tpHigh: 3836 }; await sendTelegram(`🎯 BUY NOW - Setup ${testId}\n\nEntry: ${fmtZona(z.entryLow, z.entryHigh)} (zona ${z.jarak * 10} pips dari harga sekarang)\nSL: ${fmtZona(z.slLow, z.slHigh)} ( SL -50 pips dari harga entry)\nTP: ${fmtZona(z.tpLow, z.tpHigh)} (TP +50 pips dari harga entry )\n\nTembok: BID $3830.30 - 13.70 XAUT - Betah 8m - OKX (jarak ${z.jarak}$)\n\nHOLD BAGI YANG MAMPU🔥`); res.json({ ok: true, setup_id: testId, telegram: TELEGRAM_TOKEN ? 'ON' : 'OFF' }); });
app.get('/api/unlock', (req,res)=>{ if(currentSetup){ lastSetup = { ...currentSetup, state: 'CLOSED', result: 'MANUAL / DIBATALKAN', result_price: xautPrice, closed_at: Date.now() }; closeHistory(currentSetup.id, 'MANUAL / DIBATALKAN', xautPrice); currentSetup = null; res.json({ ok: true, msg: 'Unlocked - posisi dibatalkan manual' }); } else res.json({ ok: true, msg: 'Gak ada posisi aktif' }); });
app.listen(PORT, ()=> console.log('ABEL BOT V13.2 FIX AKUN + 429 jalan di port ' + PORT + ' - WS BYBIT FIX SAMPE OK + EXNESS + COMMANDS LENGKAP'));
