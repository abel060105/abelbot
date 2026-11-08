const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== STATE / INGATAN BOT =====
let startTime = Date.now();
let memory = {}; // { harga: { first_seen, last_seen, total_volume, score, exchanges } }
let lastSignal = { signal: "WAIT", reason: "Menunggu warm-up", time: new Date().toISOString() };
let lastPrice = 0;
let lastWalls = [];

// ===== HELPER: AMBIL ORDERBOOK 3 EXCHANGE (SPOT, SESUAI SET AWAL APP LO) =====
async function getOrderbook() {
  let allBids = [];
  let allAsks = [];
  let exchangesOk = [];

  // OKX - SPOT
  try {
    const r = await axios.get('https://www.okx.com/api/v5/market/books?instId=XAUT-USDT&sz=100', { timeout: 8000 });
    if (r.data.code === '0') {
      const book = r.data.data[0];
      book.bids.forEach(([p, q]) => allBids.push([parseFloat(p), parseFloat(q), 'OKX']));
      book.asks.forEach(([p, q]) => allAsks.push([parseFloat(p), parseFloat(q), 'OKX']));
      exchangesOk.push('OKX');
    }
  } catch (e) { console.log('OKX error', e.message); }

  // BINANCE - SPOT (PAKAI data-api.binance.vision BIAR GAK KENA 418 DI RENDER)
  try {
    const r = await axios.get('https://data-api.binance.vision/api/v3/depth?symbol=XAUTUSDT&limit=100', { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.data.bids) {
      r.data.bids.forEach(([p, q]) => allBids.push([parseFloat(p), parseFloat(q), 'Binance']));
      r.data.asks.forEach(([p, q]) => allAsks.push([parseFloat(p), parseFloat(q), 'Binance']));
      exchangesOk.push('Binance');
    }
  } catch (e) { console.log('Binance error', e.message); }

  // BYBIT - SPOT
  try {
    const r = await axios.get('https://api.bybit.com/v5/market/orderbook?category=spot&symbol=XAUTUSDT&limit=50', { timeout: 8000 });
    if (r.data.retCode === 0) {
      r.data.result.b.forEach(([p, q]) => allBids.push([parseFloat(p), parseFloat(q), 'Bybit']));
      r.data.result.a.forEach(([p, q]) => allAsks.push([parseFloat(p), parseFloat(q), 'Bybit']));
      exchangesOk.push('Bybit');
    }
  } catch (e) { console.log('Bybit error', e.message); }

  return { allBids, allAsks, exchangesOk };
}

// ===== HITUNG TEMBOK DINAMIS =====
function hitungTembok(allBids, allAsks) {
  // Ambil 30 BID + 30 ASK terdekat dari mid price
  allBids.sort((a, b) => b[0] - a[0]);
  allAsks.sort((a, b) => a[0] - b[0]);
  if (!allBids.length || !allAsks.length) return null;

  let mid = (allBids[0][0] + allAsks[0][0]) / 2;
  lastPrice = mid;

  let nearBids = allBids.slice(0, 30);
  let nearAsks = allAsks.slice(0, 30);
  let allNear = [...nearBids, ...nearAsks];

  // Rata-rata dinamis
  let total = allNear.reduce((s, x) => s + x[1], 0);
  let avg = total / allNear.length;

  // Gabung per harga (dibulatkan 1 desimal) + hitung berapa exchange
  let grouped = {};
  allNear.forEach(([p, q, ex]) => {
    let key = Math.round(p * 10) / 10;
    if (!grouped[key]) grouped[key] = { price: key, vol: 0, exchanges: new Set() };
    grouped[key].vol += q;
    grouped[key].exchanges.add(ex);
  });

  let walls = [];
  let now = Date.now();

  for (let key in grouped) {
    let g = grouped[key];
    let ratio = g.vol / avg;
    let kategori = 'KROCO';
    if (ratio >= 7) kategori = 'PAUS';
    else if (ratio >= 4) kategori = 'TEMBOK GEDE';
    else if (ratio >= 2.5) kategori = 'TEMBOK KECIL';

    if (kategori === 'KROCO') continue;

    // Update memory / umur tembok
    if (!memory[key]) {
      memory[key] = { first_seen: now, last_seen: now, vol: g.vol, score: 1, exchanges: [...g.exchanges] };
    } else {
      memory[key].last_seen = now;
      memory[key].vol = g.vol;
      memory[key].exchanges = [...g.exchanges];
      let umurMenit = (now - memory[key].first_seen) / 60000;
      if (umurMenit < 1) memory[key].score = 1;
      else if (umurMenit < 15) memory[key].score = 5;
      else if (umurMenit >= 30) memory[key].score = 10;
      else memory[key].score = 7;
    }

    walls.push({
      price: g.price,
      vol: parseFloat(g.vol.toFixed(4)),
      ratio: parseFloat(ratio.toFixed(2)),
      kategori,
      umur_menit: parseFloat(((now - memory[key].first_seen) / 60000).toFixed(1)),
      score: memory[key].score,
      exchanges: [...g.exchanges],
      exchange_count: g.exchanges.size
    });
  }

  // Bersihin memory yang udah ilang (spoofing) - kalau udah 2 menit gak keliatan, hapus + blacklist sementara
  for (let key in memory) {
    if (now - memory[key].last_seen > 120000) {
      // Kalau ilang sebelum 5 menit, anggap spoofing
      delete memory[key];
    }
  }

  walls.sort((a, b) => b.ratio - a.ratio);
  lastWalls = walls;
  return { mid, avg, walls };
}

// ===== LOOP UTAMA - TIAP 2 DETIK =====
async function loopUtama() {
  try {
    let { allBids, allAsks, exchangesOk } = await getOrderbook();
    let hasil = hitungTembok(allBids, allAsks);
    if (!hasil) return;

    let umurBotMenit = (Date.now() - startTime) / 60000;

    // WARM-UP 30 MENIT
    if (umurBotMenit < 30) {
      lastSignal = {
        signal: "WAIT",
        reason: `PEMANASAN - Bot baru jalan ${umurBotMenit.toFixed(1)} menit, tunggu 30 menit`,
        price: hasil.mid,
        avg: parseFloat(hasil.avg.toFixed(4)),
        walls: hasil.walls.slice(0, 5),
        time: new Date().toISOString()
      };
      return;
    }

    // CARI TEMBOK VALID: Score >= 7 + muncul di >=2 exchange + kategori bukan kroco
    let validWalls = hasil.walls.filter(w => w.score >= 7 && w.exchange_count >= 2);

    if (validWalls.length === 0) {
      lastSignal = {
        signal: "WAIT",
        reason: "Belum ada tembok valid (score >=7 + 2 exchange)",
        price: hasil.mid,
        avg: parseFloat(hasil.avg.toFixed(4)),
        walls: hasil.walls.slice(0, 5),
        time: new Date().toISOString()
      };
      return;
    }

    // Cari tembok terdekat dari harga sekarang (5-12 USD)
    let mid = hasil.mid;
    let terdekat = null;
    let jarakTerdekat = 9999;

    validWalls.forEach(w => {
      let jarak = Math.abs(w.price - mid);
      if (jarak >= 5 && jarak <= 12 && jarak < jarakTerdekat) {
        jarakTerdekat = jarak;
        terdekat = w;
      }
    });

    if (!terdekat) {
      lastSignal = {
        signal: "WAIT",
        reason: "Tembok valid ada tapi jaraknya kejauhan / kedeketan",
        price: mid,
        walls: validWalls.slice(0, 5),
        time: new Date().toISOString()
      };
      return;
    }

    // BIKIN SINYAL
    let entry, sl, tp1, tp2, arah;
    if (terdekat.price < mid) {
      // Tembok di bawah = support = BUY
      arah = "BUY";
      entry = terdekat.price + 3;
      sl = terdekat.price - 3;
      tp1 = mid + 7; // Dinamis sederhana, nanti kita refine
      tp2 = mid + 13;
    } else {
      // Tembok di atas = resistance = SELL
      arah = "SELL";
      entry = terdekat.price - 3;
      sl = terdekat.price + 3;
      tp1 = mid - 7;
      tp2 = mid - 13;
    }

    lastSignal = {
      signal: arah,
      entry: parseFloat(entry.toFixed(1)),
      sl: parseFloat(sl.toFixed(1)),
      tp1: parseFloat(tp1.toFixed(1)),
      tp2: parseFloat(tp2.toFixed(1)),
      wall_price: terdekat.price,
      wall_vol: terdekat.vol,
      wall_kategori: terdekat.kategori,
      wall_ratio: terdekat.ratio,
      wall_umur: terdekat.umur_menit,
      wall_score: terdekat.score,
      wall_exchanges: terdekat.exchanges,
      price_now: parseFloat(mid.toFixed(1)),
      avg: parseFloat(hasil.avg.toFixed(4)),
      reason: `Tembok ${terdekat.kategori} ${terdekat.vol} XAUT di ${terdekat.price}`,
      time: new Date().toISOString()
    };

  } catch (e) {
    console.log('Loop error', e.message);
  }
}

setInterval(loopUtama, 2000);

// ===== ENDPOINT YANG DITANYA EA / WEBSITE =====
app.get('/api/signal', (req, res) => {
  res.json(lastSignal);
});

app.get('/api/walls', (req, res) => {
  res.json({
    price_now: lastPrice,
    walls: lastWalls,
    memory_count: Object.keys(memory).length,
    uptime_menit: parseFloat(((Date.now() - startTime) / 60000).toFixed(1)),
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({ status: "ABEL BOT NYALA", uptime_menit: parseFloat(((Date.now() - startTime) / 60000).toFixed(1)), last_signal: lastSignal });
});

app.listen(PORT, () => console.log(`ABEL BOT jalan di port ${PORT}`));
