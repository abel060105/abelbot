// ABEL FX - SERVER.JS V16.1 FULL TELEGRAM EXNESS API - FIX node-fetch
// Semua setting Exness lewat Telegram, tanpa Render Env untuk Exness.
// Render Env yang dibutuhin cuma: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PORT
// Exness API Host: https://api.exness.com
// FIX: node-fetch dihapus, pake fetch bawaan Node 20

const express = require('express');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

app.use(express.json());

// ============ STATE ============
let state = {
  harga: { xaut: 0, xaut_mid: 0, exness: 0, ws_bybit: '-', ws_okx: '-' },
  walls: [], wallsNear: [], wallsFar: [], wallsFarCount: 0,
  pendingOrders: [], touchedLevels: [],
  signal: 'WAIT',
  setup_id: '',
  entry: 0, entry_low: 0, entry_high: 0,
  sl: 0, sl_low: 0, sl_high: 0,
  tp: 0, tp_low: 0, tp_high: 0,
  exness_entry: 0, exness_sl: 0, exness_tp: 0,
  exness_sl_pips: 50, exness_tp_pips: 50,
  jarak: 0,
  wall: null,
  is_locked: false, lockedAt: null, lockedId: '',
  last_done: null, last_setup: null,
  history: [],
  uptimeStart: Date.now(), uptime_menit: 0, last_update: null,
  exchanges: { bybit: false, okx: false },
  pnl_nominal: null, pnl_text: '-', pnl_pips: 0,
  exness_position_id: null, exness_order_id: null,
  exness_last_error: '',
  exness_connected: false, exness_balance: 0, exness_equity: 0, exness_last_check: null,
};

// Config - bisa diubah semua lewat Tele
let cfg = {
  jarak_min: 0, jarak_max: 3, betah: 5, ratio: 5,
  sl_mode: 'FIX', sl_fix: 50, tp_fix: 50, sl_min: 30, sl_max: 80, tp_min: 30, tp_max: 80,
  lot: 0.01, simbol: 'XAUUSD', isCent: true,
  akun_id: '', akun_label: '',
  exness_api_key: '',
  jam_start: '00:00', jam_end: '23:59', jam24: true, jam_wib_now: '',
  auto_entry: true,
  exness_connected: false,
};

let pendingWalls = {};

// ============ HELPERS ============
function fmt(n, d = 2) { return (n || 0).toFixed(d); }
function nowWIB() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}
function maskKey(k) {
  if (!k) return '-';
  if (k.length <= 8) return '****';
  return '****...' + k.slice(-4);
}
function genSetupId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '#';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ TELEGRAM ============
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.on('polling_error', (e) => console.log('Polling error', e.message));
}

async function sendTele(text) {
  if (!bot || !CHAT_ID) { console.log('TELE:', text); return; }
  try { await bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }); }
  catch (e) { console.log('Gagal kirim Tele:', e.message); }
}

// ============ EXNESS API - FULL TELE ============
async function exnessRequest(path, method = 'GET', body = null) {
  if (!cfg.exness_api_key) throw new Error('Belum ada API Key. Kirim /apikey <key> dulu di Tele.');
  if (!cfg.akun_id) throw new Error('Belum ada Akun ID. Kirim /akun <id> CENT 0.01 dulu.');
  const url = 'https://api.exness.com' + path;
  const opt = {
    method,
    headers: {
      'Authorization': 'Bearer ' + cfg.exness_api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
  if (!r.ok) throw new Error('Exness API ' + r.status + ': ' + (j.message || j.error || txt).toString().slice(0, 300));
  return j;
}

async function exnessGetSnapshot() {
  try {
    const j = await exnessRequest('/v1/trading/accounts/' + cfg.akun_id + '/snapshot');
    return j;
  } catch (e) {
    const j2 = await exnessRequest('/v1/accounts/' + cfg.akun_id);
    return j2;
  }
}

function parseExnessSnapshot(j) {
  let out = { balance: 0, equity: 0, price: 0, positions: [], currency: '' };
  try {
    const d = j.data || j.account || j || {};
    const acc = d.account_state || d.account || d || {};
    out.balance = acc.balance ?? acc.Balance ?? d.balance ?? 0;
    out.equity = acc.equity ?? acc.Equity ?? d.equity ?? out.balance;
    out.currency = acc.currency || d.currency || '';
    if (d.ticks) {
      const t = d.ticks.find(x => (x.symbol || x.instrument || '').toString().toUpperCase().includes('XAU'));
      if (t) out.price = t.bid || t.ask || t.last || t.price || 0;
    }
    if (d.quotes) {
      const q = d.quotes['XAUUSD'] || d.quotes['XAUUSDm'] || d.quotes['XAUUSDc'] || d.quotes[cfg.simbol];
      if (q) out.price = q.bid || q.ask || q.last || 0;
    }
    if (d.price) out.price = d.price;
    let pos = d.positions || d.open_positions || acc.positions || [];
    if (Array.isArray(pos)) out.positions = pos;
    if (!out.price && state.harga.xaut) out.price = state.harga.xaut;
  } catch (e) { console.log('Parse snapshot gagal', e.message); }
  return out;
}

async function exnessCekKoneksi() {
  try {
    const snap = await exnessGetSnapshot();
    const p = parseExnessSnapshot(snap);
    cfg.exness_connected = true;
    state.exness_connected = true;
    state.exness_balance = p.balance;
    state.exness_equity = p.equity;
    state.exness_last_check = new Date().toISOString();
    if (p.price) { state.harga.exness = p.price; }
    state.exness_last_error = '';
    return p;
  } catch (e) {
    cfg.exness_connected = false;
    state.exness_connected = false;
    state.exness_last_error = e.message;
    throw e;
  }
}

async function exnessOpenPosition(side, entryPrice, slPrice, tpPrice) {
  const body = {
    symbol: cfg.simbol,
    side: side.toLowerCase(),
    volume: parseFloat(cfg.lot),
    type: 'market',
    stop_loss: slPrice ? parseFloat(slPrice.toFixed(2)) : undefined,
    take_profit: tpPrice ? parseFloat(tpPrice.toFixed(2)) : undefined,
    comment: 'ABEL ' + state.setup_id,
  };
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
  const j = await exnessRequest('/v1/trading/accounts/' + cfg.akun_id + '/positions', 'POST', body);
  return j;
}

async function exnessClosePosition(positionId) {
  const j = await exnessRequest('/v1/trading/accounts/' + cfg.akun_id + '/positions/' + positionId, 'DELETE');
  return j;
}

async function refreshExnessPrice() {
  if (!cfg.exness_api_key || !cfg.akun_id) return;
  try { await exnessCekKoneksi(); } catch (e) {}
}

// ============ WS BYBIT + OKX - XAUT TEMBOK ============
function startWS() {
  try {
    const wsB = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    wsB.on('open', () => {
      wsB.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.50.XAUTUSDT', 'tickers.XAUTUSDT'] }));
      state.exchanges.bybit = true;
    });
    wsB.on('message', (m) => {
      try {
        const j = JSON.parse(m.toString());
        if (j.topic && j.topic.includes('orderbook')) {
          const data = j.data || {};
          handleOrderbook(data.b || [], data.a || [], 'Bybit');
          if (data.b && data.b[0]) state.harga.ws_bybit = 'BID ' + data.b[0][0] + ' ASK ' + (data.a && data.a[0] ? data.a[0][0] : '-');
        }
        if (j.topic && j.topic.includes('tickers')) {
          const d = j.data || {};
          if (d.lastPrice) { state.harga.xaut = parseFloat(d.lastPrice); state.harga.xaut_mid = state.harga.xaut; state.last_update = new Date().toISOString(); }
        }
      } catch (e) {}
    });
    wsB.on('close', () => { state.exchanges.bybit = false; setTimeout(startWS, 5000); });
    wsB.on('error', () => { state.exchanges.bybit = false; });
  } catch (e) {}

  try {
    const wsO = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    wsO.on('open', () => {
      wsO.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId: 'XAUT-USDT' }, { channel: 'tickers', instId: 'XAUT-USDT' }] }));
      state.exchanges.okx = true;
    });
    wsO.on('message', (m) => {
      try {
        const j = JSON.parse(m.toString());
        if (j.arg && j.arg.channel === 'books' && j.data && j.data[0]) {
          const d = j.data[0];
          handleOrderbook(d.bids || [], d.asks || [], 'OKX');
        }
        if (j.arg && j.arg.channel === 'tickers' && j.data && j.data[0]) {
          const d = j.data[0];
          if (d.last) {
            const p = parseFloat(d.last);
            if (!state.harga.xaut) state.harga.xaut = p;
            else state.harga.xaut = (state.harga.xaut + p) / 2;
            state.harga.xaut_mid = state.harga.xaut;
            state.last_update = new Date().toISOString();
          }
          if (d.bidPx) state.harga.ws_okx = 'BID ' + d.bidPx + ' ASK ' + d.askPx;
        }
      } catch (e) {}
    });
    wsO.on('close', () => { state.exchanges.okx = false; });
    wsO.on('error', () => { state.exchanges.okx = false; });
  } catch (e) {}
}

function handleOrderbook(bids, asks, src) {
  const now = Date.now();
  const all = [];
  bids.forEach(b => all.push({ price: parseFloat(b[0]), size: parseFloat(b[1]), side: 'BID', sources: src }));
  asks.forEach(a => all.push({ price: parseFloat(a[0]), size: parseFloat(a[1]), side: 'ASK', sources: src }));
  const map = {};
  all.forEach(w => {
    const k = Math.round(w.price) + '_' + w.side;
    if (!map[k]) map[k] = { ...w, price: Math.round(w.price), sources: src, age_menit: 0 };
    else { map[k].size += w.size; if (!map[k].sources.includes(src)) map[k].sources += '+' + src; }
  });
  Object.values(map).forEach(w => {
    const key = w.side + '_' + Math.round(w.price);
    if (!pendingWalls[key]) pendingWalls[key] = { ...w, firstSeen: now };
    else { pendingWalls[key].size = w.size; pendingWalls[key].sources = w.sources; pendingWalls[key].lastSeen = now; }
  });
  const price = state.harga.xaut || 0;
  const list = Object.values(pendingWalls).map(w => {
    const age = Math.floor((now - w.firstSeen) / 60000);
    return { ...w, age_menit: age, distance: price ? Math.abs(price - w.price) : 999 };
  }).filter(w => w.age_menit >= 0);
  const avg = list.length ? list.reduce((a, b) => a + b.size, 0) / list.length : 0;
  const threshold = Math.max(avg * (cfg.ratio || 5), 1);
  const walls = list.filter(w => w.size >= threshold);
  state.walls = walls;
  state.wallsNear = walls.filter(w => w.distance <= 15);
  state.wallsFar = walls.filter(w => w.distance > 15);
  state.wallsFarCount = state.wallsFar.length;
  const pending = walls.filter(w => w.age_menit >= (cfg.betah || 5));
  state.pendingOrders = pending.map(w => ({ ...w, status: 'PENDING' }));
  state.touchedLevels = walls.filter(w => price && Math.abs(price - w.price) <= 1).map(w => ({ ...w, status: 'TERSENTUH' }));
}

// ============ LOGIC SINYAL ============
function hitungZona(wallPrice, hargaSekarang, isBuy) {
  const jarak = Math.max(0, Math.min(3, Math.round(Math.abs(hargaSekarang - wallPrice))));
  const wall = Math.floor(wallPrice);
  let slPips = cfg.sl_mode === 'FLEKSIBEL' ? cfg.sl_min : cfg.sl_fix;
  let tpPips = cfg.sl_mode === 'FLEKSIBEL' ? cfg.tp_min : cfg.tp_fix;
  if (cfg.sl_mode === 'FLEKSIBEL') { slPips = Math.round((cfg.sl_min + cfg.sl_max) / 2); tpPips = Math.round((cfg.tp_min + cfg.tp_max) / 2); }
  const slJarakHarga = slPips / 10;
  const tpJarakHarga = tpPips / 10;
  if (isBuy) {
    const entryLow = wall, entryHigh = wall + jarak;
    return { jarak, entryLow, entryHigh, slLow: entryLow - slJarakHarga, slHigh: entryHigh - slJarakHarga, tpLow: entryLow + tpJarakHarga, tpHigh: entryHigh + tpJarakHarga, slPips, tpPips };
  } else {
    const entryLow = wall - jarak, entryHigh = wall;
    return { jarak, entryLow, entryHigh, slLow: entryLow + slJarakHarga, slHigh: entryHigh + slJarakHarga, tpLow: entryLow - tpJarakHarga, tpHigh: entryHigh - tpJarakHarga, slPips, tpPips };
  }
}

function jamAktif() {
  if (cfg.jam24) return true;
  const now = nowWIB();
  return now >= cfg.jam_start && now <= cfg.jam_end;
}

async function cekSinyal() {
  const price = state.harga.xaut;
  if (!price) return;
  state.uptime_menit = Math.floor((Date.now() - state.uptimeStart) / 60000);
  cfg.jam_wib_now = nowWIB();

  if (state.is_locked && state.setup_id) {
    const hargaLive = state.harga.exness || price;
    const entryLive = state.exness_entry || state.entry;
    if (entryLive) {
      const diffHarga = state.signal.includes('BUY') ? (hargaLive - entryLive) : (entryLive - hargaLive);
      const pips = diffHarga * 10;
      state.pnl_pips = pips;
      const perPips = cfg.lot * 10;
      const nominal = Math.round(pips * perPips * 10) / 10;
      state.pnl_nominal = nominal;
      state.pnl_text = (nominal >= 0 ? '+' : '') + nominal.toLocaleString('en-US').replace(/,/g, '.');
      const slHarga = state.exness_sl || state.sl;
      const tpHarga = state.exness_tp || state.tp;
      let kena = '';
      if (state.signal.includes('BUY')) {
        if (hargaLive >= tpHarga) kena = 'WIN';
        if (hargaLive <= slHarga) kena = 'LOSE';
      } else {
        if (hargaLive <= tpHarga) kena = 'WIN';
        if (hargaLive >= slHarga) kena = 'LOSE';
      }
      if (kena) {
        const histItem = state.history.find(h => h.setup_id === state.setup_id);
        if (histItem) { histItem.result = kena === 'WIN' ? 'WIN - TP KENA' : 'LOSE - SL KENA'; histItem.closed_at = new Date().toISOString(); histItem.result_price = hargaLive; histItem.duration_menit = Math.floor((Date.now() - state.lockedAt) / 60000); }
        state.last_done = { last_result: kena, setup_id: state.setup_id };
        state.last_setup = histItem;
        if (state.exness_position_id) {
          try { await exnessClosePosition(state.exness_position_id); } catch (e) { console.log('Tutup Exness gagal', e.message); }
        }
        await sendTele(
          (kena === 'WIN' ? '✅ <b>TP KENA - WIN</b>' : '❌ <b>SL KENA - LOSE</b>') +
          '\nSetup ' + state.setup_id + ' | ' + state.signal +
          '\nClose: $' + fmt(hargaLive) +
          '\nPnL: ' + state.pnl_text
        );
        state.is_locked = false; state.signal = 'WAIT'; state.setup_id = ''; state.exness_position_id = null;
        state.pnl_nominal = null;
      }
    }
    return;
  }

  if (!jamAktif()) { state.signal = 'WAIT'; return; }

  const candidates = (state.pendingOrders || []).filter(w => w.age_menit >= cfg.betah && w.distance >= cfg.jarak_min && w.distance <= cfg.jarak_max);
  if (!candidates.length) { state.signal = 'WAIT'; return; }
  candidates.sort((a, b) => b.size - a.size);
  const wall = candidates[0];
  const isBuy = wall.side === 'BID';
  const zona = hitungZona(wall.price, price, isBuy);
  const sig = isBuy ? 'BUY' : 'SELL';
  const setupId = genSetupId();

  state.signal = sig;
  state.setup_id = setupId;
  state.wall = wall;
  state.jarak = zona.jarak;
  state.entry = (zona.entryLow + zona.entryHigh) / 2;
  state.entry_low = zona.entryLow; state.entry_high = zona.entryHigh;
  state.sl = (zona.slLow + zona.slHigh) / 2; state.sl_low = zona.slLow; state.sl_high = zona.slHigh;
  state.tp = (zona.tpLow + zona.tpHigh) / 2; state.tp_low = zona.tpLow; state.tp_high = zona.tpHigh;
  state.is_locked = true; state.lockedAt = Date.now(); state.lockedId = setupId + '_' + Date.now();
  state.exness_sl_pips = zona.slPips; state.exness_tp_pips = zona.tpPips;

  let exPrice = state.harga.exness || price;
  if (cfg.exness_api_key && cfg.akun_id) {
    try { const p = await exnessCekKoneksi(); if (p.price) exPrice = p.price; } catch (e) {}
  }
  const selisih = exPrice - price;
  state.exness_entry = state.entry + selisih;
  state.exness_sl = state.sl + selisih;
  state.exness_tp = state.tp + selisih;

  const histItem = {
    id: state.lockedId, setup_id: setupId, created_at: new Date().toISOString(),
    signal: sig, entry: state.entry, entry_low: zona.entryLow, entry_high: zona.entryHigh,
    sl: state.sl, sl_low: zona.slLow, sl_high: zona.slHigh,
    tp: state.tp, tp_low: zona.tpLow, tp_high: zona.tpHigh,
    exness_entry: state.exness_entry, exness_sl: state.exness_sl, exness_tp: state.exness_tp,
    exness_sl_pips: zona.slPips, exness_tp_pips: zona.tpPips,
    size: 0, sources: wall.sources || '', result: 'AKTIF', closed_at: null,
  };
  state.history.unshift(histItem);
  if (state.history.length > 100) state.history.pop();

  let exStatus = '';
  if (cfg.auto_entry) {
    if (!cfg.exness_api_key || !cfg.akun_id) {
      exStatus = '\n⚠️ <b>Auto-Entry GAGAL:</b> Belum ada API Key / Akun. Kirim /apikey + /akun dulu. Sinyal ini masih SIMULASI.';
    } else {
      try {
        const j = await exnessOpenPosition(sig, state.exness_entry, state.exness_sl, state.exness_tp);
        const d = j.data || j || {};
        const pos = d.position || d.order || d || {};
        state.exness_position_id = pos.id || pos.position_id || d.position_id || null;
        state.exness_order_id = pos.order_id || d.order_id || null;
        exStatus = '\n✅ <b>TEREKSEKUSI DI EXNESS</b>\nAkun: ' + cfg.akun_id + ' | Lot: ' + cfg.lot + ' | Pos ID: ' + (state.exness_position_id || '-');
      } catch (e) {
        exStatus = '\n❌ <b>GAGAL EKSEKUSI EXNESS:</b> ' + e.message + '\nSinyal ini jadi SIMULASI. Cek /cekexness';
        state.exness_last_error = e.message;
      }
    }
  } else {
    exStatus = '\n⏸️ Auto-Entry MATI. Sinyal ini SIMULASI, gak buka posisi.';
  }

  const msg =
    '⚡ <b>ABEL FX - ' + sig + ' ' + setupId + '</b>' +
    '\n<b>Entry Exness:</b> $' + fmt(state.exness_entry) +
    '\n<b>XAUT:</b> $' + fmt(state.entry) + ' (Zona $' + fmt(zona.entryLow) + ' - $' + fmt(zona.entryHigh) + ')' +
    '\n<b>SL:</b> $' + fmt(state.exness_sl) + ' (-' + zona.slPips + ' pips)' +
    '\n<b>TP:</b> $' + fmt(state.exness_tp) + ' (+' + zona.tpPips + ' pips)' +
    '\n<b>Tembok:</b> ' + wall.side + ' $' + fmt(wall.price) + ' - ' + fmt(wall.size, 2) + ' XAUT - Betah ' + wall.age_menit + 'm - ' + (wall.sources || '') +
    '\n<b>Harga Exness Live:</b> $' + fmt(exPrice) + ' | <b>XAUT:</b> $' + fmt(price) +
    '\n<b>Lot:</b> ' + cfg.lot + ' | <b>Akun:</b> ' + (cfg.akun_id || '-') + (cfg.isCent ? ' (CENT)' : '') +
    exStatus;
  await sendTele(msg);
}

// ============ TELEGRAM COMMANDS - FULL TELE ============
if (bot) {
  bot.onText(/\/apikey (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const key = (match[1] || '').trim();
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
    if (!key || key.length < 10) { bot.sendMessage(chatId, 'Key-nya kependekan. Copy full dari Exness > Manajemen API.'); return; }
    cfg.exness_api_key = key;
    bot.sendMessage(chatId, '⏳ Key diterima (' + maskKey(key) + '). Lagi ngetes ke api.exness.com...');
    try {
      if (!cfg.akun_id) {
        bot.sendMessage(chatId, '✅ Key kesimpen.\nSekarang kirim:\n/akun 27000017363 CENT 0.01\n(ganti sama ID akun lo)');
        return;
      }
      const p = await exnessCekKoneksi();
      bot.sendMessage(chatId, '✅ <b>EXNESS NYAMBUNG BENERAN</b>\nAkun: ' + cfg.akun_id + '\nSaldo: ' + p.balance + ' ' + p.currency + '\nEquity: ' + p.equity + '\nHarga XAUUSD Exness: $' + fmt(p.price) + '\nKey: ' + maskKey(key), { parse_mode: 'HTML' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Key kesimpen tapi gagal konek ke Exness:\n' + e.message + '\n\nCek: 1) Key bener? 2) Akun ID udah diisi? Kirim /akun dulu. 3) Key-nya scope Trading: Akses penuh?');
    }
  });

  bot.onText(/\/akun(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const arg = (match[1] || '').trim();
    if (!arg) {
      bot.sendMessage(chatId, 'Format:\n/akun 27000017363 CENT 0.01\n\nAkun aktif sekarang:\nID: ' + (cfg.akun_id || '-') + '\nLabel: ' + (cfg.akun_label || '-') + '\nLot: ' + cfg.lot + '\nCent: ' + (cfg.isCent ? 'YA' : 'TIDAK') + '\nKey: ' + maskKey(cfg.exness_api_key));
      return;
    }
    const parts = arg.split(/\s+/);
    const id = parts[0];
    const jenis = (parts[1] || 'CENT').toUpperCase();
    const lot = parseFloat(parts[2] || cfg.lot);
    cfg.akun_id = id;
    cfg.akun_label = 'Exness ' + id;
    cfg.isCent = jenis.includes('CENT');
    cfg.simbol = 'XAUUSD';
    if (!isNaN(lot) && lot > 0) cfg.lot = lot;
    bot.sendMessage(chatId, '✅ Akun diganti:\nID: ' + id + '\nJenis: ' + jenis + '\nLot: ' + cfg.lot + '\n\nKirim /cekexness buat tes koneksi beneran.');
    if (cfg.exness_api_key) {
      try { const p = await exnessCekKoneksi(); bot.sendMessage(chatId, '✅ Tes koneksi OK - Harga Exness: $' + fmt(p.price) + ' | Saldo: ' + p.balance); }
      catch (e) { bot.sendMessage(chatId, '⚠️ Akun kesimpen tapi koneksi gagal: ' + e.message); }
    } else {
      bot.sendMessage(chatId, '⚠️ Belum ada API Key. Kirim /apikey <key> dulu.');
    }
  });

  bot.onText(/\/hapuskey/, async (msg) => {
    cfg.exness_api_key = '';
    cfg.exness_connected = false; state.exness_connected = false;
    bot.sendMessage(msg.chat.id, '✅ API Key udah dihapus dari memory bot. Auto-entry sekarang jadi SIMULASI sampe lo kirim /apikey lagi.');
  });

  bot.onText(/\/cekexness/, async (msg) => {
    const chatId = msg.chat.id;
    if (!cfg.exness_api_key) { bot.sendMessage(chatId, '❌ Belum ada API Key. Kirim /apikey <key> dulu.'); return; }
    if (!cfg.akun_id) { bot.sendMessage(chatId, '❌ Belum ada Akun ID. Kirim /akun <id> CENT 0.01 dulu.'); return; }
    bot.sendMessage(chatId, '⏳ Lagi cek ke api.exness.com...');
    try {
      const p = await exnessCekKoneksi();
      const pos = p.positions || [];
      let posTxt = pos.length ? pos.map(x => (x.side || x.type || '-') + ' ' + (x.symbol || '') + ' Vol ' + (x.volume || x.size || '-') + ' Entry ' + (x.price_open || x.open_price || '-')).join('\n') : 'Gak ada posisi yang jalan di Exness (beneran kosong)';
      bot.sendMessage(chatId,
        '✅ <b>EXNESS - CEK LANGSUNG</b>\n' +
        'Akun: ' + cfg.akun_id + '\n' +
        'Saldo: ' + p.balance + ' ' + p.currency + '\n' +
        'Equity: ' + p.equity + '\n' +
        'Harga XAUUSD Exness (ASLI): $' + fmt(p.price) + '\n' +
        'Harga XAUT Bybit+OKX: $' + fmt(state.harga.xaut) + '\n' +
        'Selisih: $' + fmt(Math.abs(p.price - state.harga.xaut)) + '\n' +
        'Posisi di Exness:\n' + posTxt + '\n' +
        'Key: ' + maskKey(cfg.exness_api_key) + '\n' +
        'Error terakhir: ' + (state.exness_last_error || '-'), { parse_mode: 'HTML' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Gagal cek Exness:\n' + e.message);
    }
  });

  bot.onText(/\/status/, async (msg) => {
    bot.sendMessage(msg.chat.id,
      '📊 <b>STATUS ABEL</b>\n' +
      'Sinyal: ' + state.signal + ' ' + (state.setup_id || '') + '\n' +
      'XAUT: $' + fmt(state.harga.xaut) + '\n' +
      'Exness Live: $' + fmt(state.harga.exness) + '\n' +
      'Akun: ' + (cfg.akun_id || '-') + ' | Lot: ' + cfg.lot + ' | ' + (cfg.isCent ? 'CENT' : 'STANDARD') + '\n' +
      'Key: ' + (cfg.exness_api_key ? 'KEPASANG ' + maskKey(cfg.exness_api_key) : 'BELUM ADA') + '\n' +
      'Exness Connected: ' + (cfg.exness_connected ? 'YA ✅' : 'TIDAK ❌') + '\n' +
      'Auto-Entry: ' + (cfg.auto_entry ? 'ON ✅' : 'OFF ⏸️') + '\n' +
      'Ratio: ' + cfg.ratio + 'x | Betah: ' + cfg.betah + 'm | SL/TP: ' + (cfg.sl_mode === 'FIX' ? cfg.sl_fix + '/' + cfg.tp_fix : 'FLEKSIBEL ' + cfg.sl_min + '-' + cfg.sl_max + ' / ' + cfg.tp_min + '-' + cfg.tp_max) + '\n' +
      'Jam: ' + (cfg.jam24 ? '24 jam' : cfg.jam_start + ' - ' + cfg.jam_end + ' WIB') + ' | Sekarang: ' + nowWIB() + ' WIB', { parse_mode: 'HTML' });
  });

  bot.onText(/\/ratio (\d+)/, (msg, match) => { cfg.ratio = parseInt(match[1]); bot.sendMessage(msg.chat.id, '✅ Ratio diganti jadi ' + cfg.ratio + 'x'); });
  bot.onText(/\/sl (\d+)/, (msg, match) => { cfg.sl_fix = parseInt(match[1]); cfg.sl_mode = 'FIX'; bot.sendMessage(msg.chat.id, '✅ SL diganti jadi FIX ' + cfg.sl_fix + ' pips'); });
  bot.onText(/\/tp (\d+)/, (msg, match) => { cfg.tp_fix = parseInt(match[1]); cfg.sl_mode = 'FIX'; bot.sendMessage(msg.chat.id, '✅ TP diganti jadi FIX ' + cfg.tp_fix + ' pips'); });
  bot.onText(/\/lot ([0-9.]+)/, (msg, match) => { cfg.lot = parseFloat(match[1]); bot.sendMessage(msg.chat.id, '✅ Lot diganti jadi ' + cfg.lot); });
  bot.onText(/\/jam (\S+) (\S+)/, (msg, match) => {
    cfg.jam_start = match[1]; cfg.jam_end = match[2];
    cfg.jam24 = (cfg.jam_start === '00:00' && cfg.jam_end === '23:59');
    bot.sendMessage(msg.chat.id, '✅ Jam bot diganti jadi ' + cfg.jam_start + ' - ' + cfg.jam_end + ' WIB');
  });
  bot.onText(/\/auto (on|off)/, (msg, match) => {
    cfg.auto_entry = match[1] === 'on';
    bot.sendMessage(msg.chat.id, cfg.auto_entry ? '✅ Auto-Entry NYALA - sinyal baru bakal buka posisi beneran di Exness' : '⏸️ Auto-Entry MATI - sinyal jadi SIMULASI doang');
  });
  bot.onText(/\/unlock/, (msg) => {
    state.is_locked = false; state.signal = 'WAIT'; state.setup_id = ''; state.exness_position_id = null;
    bot.sendMessage(msg.chat.id, '✅ Lock dibatalin manual. Bot siap cari sinyal baru.');
  });
  bot.onText(/\/test/, async (msg) => {
    bot.sendMessage(msg.chat.id, '📩 <b>TEST TELEGRAM</b>\nXAUT: $' + fmt(state.harga.xaut) + '\nExness: $' + fmt(state.harga.exness) + '\nAkun: ' + (cfg.akun_id || '-') + ' | Key: ' + maskKey(cfg.exness_api_key) + '\nKalo lo baca ini, Tele bot jalan.', { parse_mode: 'HTML' });
  });
  bot.onText(/\/help|\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '🤖 <b>ABEL FX - COMMAND</b>\n\n' +
      '<b>Exness (Full Tele):</b>\n' +
      '/apikey <key> - pasang key Exness\n' +
      '/akun 27000017363 CENT 0.01 - ganti akun\n' +
      '/cekexness - cek saldo + harga asli + posisi beneran\n' +
      '/hapuskey - hapus key\n' +
      '/status - liat status\n\n' +
      '<b>Setting:</b>\n' +
      '/ratio 5 - ganti ratio\n' +
      '/sl 50 - ganti SL\n' +
      '/tp 50 - ganti TP\n' +
      '/lot 0.01 - ganti lot\n' +
      '/jam 00:00 23:59 - ganti jam\n' +
      '/auto on / off - nyala/matiin eksekusi beneran\n' +
      '/unlock - batalin lock\n' +
      '/test - tes Tele', { parse_mode: 'HTML' });
  });
}

// ============ API BUAT VERCEL ============
app.get('/api/signal', (req, res) => {
  res.json({
    signal: state.signal, setup_id: state.setup_id,
    harga: state.harga,
    xaut_price: state.harga.xaut, exness_price: state.harga.exness,
    entry: state.entry, entry_low: state.entry_low, entry_high: state.entry_high,
    sl: state.sl, sl_low: state.sl_low, sl_high: state.sl_high,
    tp: state.tp, tp_low: state.tp_low, tp_high: state.tp_high,
    exness_entry: state.exness_entry, exness_sl: state.exness_sl, exness_tp: state.exness_tp,
    exness_sl_pips: state.exness_sl_pips, exness_tp_pips: state.exness_tp_pips,
    jarak: state.jarak, wall: state.wall, is_locked: state.is_locked, lockedAt: state.lockedAt, lockedId: state.lockedId,
    last_done: state.last_done, last_setup: state.last_setup,
    history: state.history, uptime_menit: state.uptime_menit, uptimeStart: state.uptimeStart, last_update: state.last_update,
    exchanges: state.exchanges, walls: state.walls, wallsNear: state.wallsNear, wallsFar: state.wallsFar, wallsFarCount: state.wallsFarCount,
    pendingOrders: state.pendingOrders, touchedLevels: state.touchedLevels,
    pnl_nominal: state.pnl_nominal, pnl_text: state.pnl_text, pnl_live: state.pnl_nominal, pnl_pips: state.pnl_pips,
    lot: cfg.lot, sl_pips: cfg.sl_fix, tp_pips: cfg.tp_fix,
    config: { ...cfg, exness_api_key: cfg.exness_api_key ? maskKey(cfg.exness_api_key) : '', akun_label: cfg.akun_label, exness_connected: cfg.exness_connected },
    winrate_data: { winrate: state.history.filter(h => h.closed_at).length ? Math.floor(state.history.filter(h => (h.result || '').includes('WIN')).length / state.history.filter(h => h.closed_at).length * 100) : 0 },
  });
});

app.get('/api/history', (req, res) => {
  res.json({ history: state.history, total: state.history.length, sesi_mulai: new Date(state.uptimeStart).toISOString(), uptime_menit: state.uptime_menit, winrate_data: { winrate: 0 } });
});
app.get('/api/unlock', (req, res) => { state.is_locked = false; state.signal = 'WAIT'; state.setup_id = ''; res.json({ msg: 'Unlocked' }); });
app.get('/api/test-telegram', async (req, res) => {
  await sendTele('📩 <b>TEST TELEGRAM ABEL</b>\nXAUT: $' + fmt(state.harga.xaut) + ' | Exness: $' + fmt(state.harga.exness) + ' | Akun: ' + (cfg.akun_id || '-'));
  res.json({ setup_id: state.setup_id || genSetupId() });
});
app.get('/api/ws-test', (req, res) => {
  res.json({ ws_bybit_ok: state.exchanges.bybit, ws_okx_ok: state.exchanges.okx, xaut_price: state.harga.xaut, exness_price: state.harga.exness });
});
app.get('/', (req, res) => res.send('ABEL FX V16.1 - Full Telegram Exness API - OK'));

app.listen(PORT, () => console.log('ABEL jalan di port ' + PORT));

startWS();
setInterval(() => { cekSinyal(); }, 1000);
setInterval(() => { refreshExnessPrice(); }, 10000);
setInterval(() => {
  const now = Date.now();
  Object.keys(pendingWalls).forEach(k => { if (now - (pendingWalls[k].lastSeen || pendingWalls[k].firstSeen) > 10 * 60000) delete pendingWalls[k]; });
}, 60000);
