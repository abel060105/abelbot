// ABEL BOT - FUTURES PERP - FINAL 5 COMMAND
// COMMAND MENU (cuma ini yang muncul di Tele):
// /status /help /sinyalpakai /settingbybit /settingokx
// /settingbybit = cuma Bybit
// /settingokx = Delta OKX + Agregasi di dalemnya
// Contoh: /settingokx 50000 5  -> Delta 50000, Agg 5s
//         /settingokx 50000    -> Delta 50000, Agg tetep
// BUG FIX: kalo lagi nunggu angka terus ketik /command lain, langsung pindah ke command baru, gak ke-kunci.
// TELE SINYAL BERSIH (Pribadi + Channel sinkron):
// 🎯 BUY NOW - Setup #HSZQ
// ENTRY: $3634.31 (NOW)
// SL: $3629.31 (-50 PIPS)
// TP: $3639.31 (+50 PIPS)
// SESUAIKAN RISK MASING MASING💰
// HOLD BAGI YANG MAMPU🔥
// REKAP PDF: auto per 100 sinyal, HANYA ke Channel
// ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID / TELEGRAM_CHAT_IDS, TELEGRAM_CHANNEL_ID=-100xxxx
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
const TELEGRAM_CHANNEL_ID = (process.env.TELEGRAM_CHANNEL_ID || '').trim();

let TRADE_MIN = 3;
let TRADE_MIN_OKX = 50000;
let OKX_AGG_SEC = 5;
let SL_PIPS = 50;
let TP_PIPS = 50;
let CFG = { lot: 0.01, simbol: 'XAUUSD', isCent: false };
let RECAP_EVERY = 100;

let SIGNAL_BYBIT_ON = true;
let SIGNAL_OKX_ON = true;

let MT5 = { connected: false, lastPrice: 0, lastBid: 0, lastAsk: 0, balance: 0, equity: 0, positions: 0, lastSeen: 0, lastError: '' };
let convo = {};
let WSClient = null;
try{ WSClient = require('ws'); }catch(e){ console.log('ws belum install'); }

let recentTradesBybit = [];
let recentTradesOkx = [];
let signalHistory = [];
let activeSignal = null;
let xautPrice = 0;
let wallsFar = [];
let uptimeStart = Date.now(), lastUpdate = null;
let wsTradeBybitOk = false, wsTradeOkxOk = false, wsLastTradeBybit = 0, wsLastTradeOkx = 0;
let okxAgg = { buy: 0, sell: 0, count: 0, lastPrice: 0, start: Date.now(), vwapSum: 0, vwapVol: 0 };
let okxAggTimer = null;
let totalSignalsEver = 0;
let lastRecapAt = 0;

function parseNum(str){
  if(str===undefined||str===null) return NaN;
  let s = String(str).trim().replace(',','.').replace(/[^0-9.\-]/g,'');
  return parseFloat(s);
}
function generateSetupId(){
  const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let id='';
  for(let i=0;i<4;i++) id+=chars[Math.floor(Math.random()*chars.length)];
  return '#'+id;
}
function fmtWIB(ts){ return new Date(ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtSize(v){ return v.toFixed(3); }
function fmtDateID(ts){ return new Date(ts).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) + ' ' + fmtWIB(ts) + ' WIB'; }
function sinyalPakaiText(){ return `Bybit: ${SIGNAL_BYBIT_ON?'ON ✅':'OFF ❌'} | OKX: ${SIGNAL_OKX_ON?'ON ✅':'OFF ❌'}`; }

async function sendTelegramToId(chatId, msg){
  if(!TELEGRAM_TOKEN || !chatId) return;
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:String(chatId),text:msg})}); }catch(e){ console.log('Tele gagal ke', chatId, e.message); }
}
async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN) return;
  let targets = [...TELEGRAM_CHAT_IDS];
  if(TELEGRAM_CHANNEL_ID && !targets.includes(TELEGRAM_CHANNEL_ID)) targets.push(TELEGRAM_CHANNEL_ID);
  await Promise.all(targets.map(id => sendTelegramToId(id, msg)));
}
async function sendTelegramTo(chatId, msg){
  if(!TELEGRAM_TOKEN) return;
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:String(chatId),text:msg})}); }catch(e){ console.log('Tele sendTo gagal',e.message); }
}
async function sendTelegramDocToChannel(pdfBuf, fileName, caption){
  if(!TELEGRAM_TOKEN) return;
  let targets = TELEGRAM_CHANNEL_ID ? [TELEGRAM_CHANNEL_ID] : [...TELEGRAM_CHAT_IDS];
  for(let chat_id of targets){
    try{
      let form = new FormData();
      form.append('chat_id', String(chat_id));
      form.append('caption', caption);
      form.append('document', new Blob([pdfBuf], {type:'application/pdf'}), fileName);
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {method:'POST', body: form});
      console.log('Rekap PDF terkirim ke', chat_id, TELEGRAM_CHANNEL_ID ? '(CHANNEL)' : '(PRIBADI fallback)');
    }catch(e){ console.log('Rekap PDF gagal', e.message); }
  }
}

function escapePdfText(s){
  return String(s)
    .replace(/🎯/g, '>>').replace(/✅/g, '[OK]').replace(/💰/g, '').replace(/🔥/g, '')
    .replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')
    .replace(/[^\x20-\x7E]/g,'');
}
function createRecapPdf(signals, title){
  let lines = [];
  lines.push('ABEL BOT - REKAP LAPORAN 100 SINYAL');
  lines.push(title);
  lines.push('');
  signals.forEach((h) => {
    let usd = (h.size * h.price).toLocaleString('en-US',{maximumFractionDigits:0});
    let aggLine = h.agg ? h.agg : 'Delta - : Buy - Sell - (1 trade)';
    lines.push('🎯 ' + h.signal + ' NOW - Setup ' + h.setup_id);
    lines.push('');
    lines.push('Trade: ' + h.signal + ' ' + fmtSize(h.size) + ' XAUT @ $' + h.price.toFixed(2) + ' - ' + h.source);
    lines.push('Nilai: $' + usd);
    lines.push('Jam: ' + (h.time_str||fmtWIB(h.time)) + ' WIB');
    lines.push('Filter: >= ' + fmtSize(h.trade_min_used||TRADE_MIN) + ' XAUT - LOLOS ✅');
    lines.push('Agregasi: ' + aggLine);
    lines.push('');
    lines.push('Entry: $' + h.price.toFixed(2));
    lines.push('SL: $' + h.sl.toFixed(2) + ' (-' + (h.sl_pips||SL_PIPS) + ' pips)');
    lines.push('TP: $' + h.tp.toFixed(2) + ' (+' + (h.tp_pips||TP_PIPS) + ' pips)');
    lines.push('');
    lines.push('');
  });
  let perPage = 45;
  let pages = [];
  for(let i=0;i<lines.length;i+=perPage) pages.push(lines.slice(i,i+perPage));
  if(!pages.length) pages=[[]];
  let objects = [];
  let contentStreams = pages.map(pageLines => {
    let ops = ['BT /F1 10 Tf 13 TL'];
    let y = 780;
    ops.push('50 ' + y + ' Td');
    pageLines.forEach((ln, li) => {
      if(li>0) ops.push('T*');
      ops.push('(' + escapePdfText(ln) + ') Tj');
    });
    ops.push('ET');
    return ops.join('\n');
  });
  let pageObjIds = [];
  let nextId = 4;
  pages.forEach(() => { pageObjIds.push({pageId: nextId, contentId: nextId+1}); nextId+=2; });
  let kids = pageObjIds.map(p=>p.pageId+' 0 R').join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids ['+kids+'] /Count '+pages.length+' >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
  contentStreams.forEach((stream, i) => {
    let ids = pageObjIds[i];
    objects[ids.pageId] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+ids.contentId+' 0 R >>';
    objects[ids.contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
  });
  let pdf = '%PDF-1.4\n';
  let offsets = [0];
  for(let id=1; id<objects.length; id++){
    if(!objects[id]) continue;
    offsets[id] = Buffer.byteLength(pdf);
    pdf += id + ' 0 obj\n' + objects[id] + '\nendobj\n';
  }
  let xrefPos = Buffer.byteLength(pdf);
  let maxId = objects.length-1;
  pdf += 'xref\n0 ' + (maxId+1) + '\n0000000000 65535 f \n';
  for(let id=1; id<=maxId; id++){
    let off = offsets[id]||0;
    pdf += String(off).padStart(10,'0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (maxId+1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}
async function sendRecapPdf(){
  let batch = signalHistory.slice(0, RECAP_EVERY).reverse();
  if(batch.length < RECAP_EVERY) return;
  let from = batch[0]; let to = batch[batch.length-1];
  let title = 'Periode: ' + fmtDateID(from.time) + ' s/d ' + fmtDateID(to.time) + ' - Total Ever: ' + totalSignalsEver;
  let pdfBuf = createRecapPdf(batch, title);
  let fileName = 'ABEL-REKAP-' + totalSignalsEver + '-SINYAL.pdf';
  let caption = `📄 REKAP LAPORAN 100 SINYAL - ABEL BOT\n\nPeriode: ${fmtDateID(from.time)} s/d ${fmtDateID(to.time)}\nTotal Sinyal: ${totalSignalsEver}\n\nDetail lengkap per sinyal: Trade, Nilai, Jam, Filter, Agregasi Delta, Entry, SL, TP.\n\nSESUAIKAN RISK MASING MASING💰\nHOLD BAGI YANG MAMPU🔥`;
  await sendTelegramDocToChannel(pdfBuf, fileName, caption);
}

async function setMyCommands(){
  if(!TELEGRAM_TOKEN) return;
  const commands=[
    {command:'status',description:'Status'},
    {command:'help',description:'Help'},
    {command:'sinyalpakai',description:'ON/OFF sinyal Bybit & OKX'},
    {command:'settingbybit',description:'Setting Bybit - /settingbybit 3'},
    {command:'settingokx',description:'Setting OKX Delta + Agg - /settingokx 50000 5'},
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commands})}); }catch(e){}
}
setMyCommands();

function statusText(){
  let nextRecap = RECAP_EVERY - (totalSignalsEver % RECAP_EVERY);
  if(totalSignalsEver>0 && totalSignalsEver % RECAP_EVERY===0) nextRecap = RECAP_EVERY;
  return `🤖 ABEL BOT\n\nSize Bybit: ${fmtSize(TRADE_MIN)} XAUT\nSize OKX Delta: ${fmtSize(TRADE_MIN_OKX)} XAU\nAgregasi OKX: ${OKX_AGG_SEC}s\nSinyal Pakai: ${sinyalPakaiText()}\nSinyal Aktif: ${activeSignal ? activeSignal.signal+' '+fmtSize(activeSignal.size)+' XAUT @ $'+activeSignal.price.toFixed(2)+' - '+activeSignal.source : 'WAIT - Belum ada trade gede'}\nXAUT: $${xautPrice?xautPrice.toFixed(2):'-'}\nMT5: ${MT5.connected?'Nyambung ✅':'Belum nyambung - RDP belum jalan'}\nTotal Sinyal Lolos: ${signalHistory.length}\nTotal Sinyal Ever: ${totalSignalsEver}\nRekap PDF berikutnya: ${nextRecap} sinyal lagi (per ${RECAP_EVERY}) -> ke Channel\nChannel: ${TELEGRAM_CHANNEL_ID ? TELEGRAM_CHANNEL_ID+' ✅' : 'Belum di-set - cek TELEGRAM_CHANNEL_ID di Render'}\n\nLayering: ON - Tanpa batas, tanpa cooldown\nBuy + Sell berlawanan tetep di-entry semua.\n\nCommand:\n/status\n/help\n/sinyalpakai\n/settingbybit\n/settingokx`;
}

function parseSinyalPakai(text){
  let t = String(text||'').toLowerCase();
  let hasBybit = t.includes('bybit');
  let hasOkx = t.includes('okx');
  let hasBoth = t.includes('dua') || t.includes('both') || t.includes('semua') || t.includes('all') || (hasBybit && hasOkx);
  if(t.trim()==='1') return {bybit:true, okx:false};
  if(t.trim()==='2') return {bybit:false, okx:true};
  if(t.trim()==='3' || t.trim()==='12' || t.trim()==='21') return {bybit:true, okx:true};
  if(hasBoth) return {bybit:true, okx:true};
  if(hasBybit && !hasOkx) return {bybit:true, okx:false};
  if(hasOkx && !hasBybit) return {bybit:false, okx:true};
  return null;
}

async function handleTelegramCommand(chatId, textRaw){
  let text=String(textRaw||'').trim();
  if(!text) return;
  let isCommand = text.startsWith('/');
  let m = text.match(/^\/?([a-z_]+)\s*(.*)$/i);
  let cmd = m ? m[1].toLowerCase() : '';
  let arg = m ? (m[2]||'').trim() : '';

  // ===== FIX KUNCI: kalo ketik /command baru, batalin mode nunggu angka yang lama =====
  // Kecuali kalo command-nya SAMA dengan yang lagi ditunggu, biar /settingbybit 3 tetep jalan
  let cv = convo[chatId];
  if(cv && isCommand){
    let waitingCmd = cv.step; // SETTINGBYBIT / SETTINGOKX / SINYALPAKAI
    let newCmdMap = { settingbybit:'SETTINGBYBIT', settingokx:'SETTINGOKX', sinyalpakai:'SINYALPAKAI', sinyal:'SINYALPAKAI' };
    let newStep = newCmdMap[cmd];
    // Kalo command baru beda sama yang ditunggu -> batalin yang lama, lanjut ke command baru di bawah
    // Kalo command baru sama tapi ada arg (misal /settingbybit 3) -> batalin juga, biar diproses sebagai command langsung
    // Kalo command baru sama tapi TANPA arg -> biarin, jangan batalin, biar tetep nunggu
    if(!newStep || newStep !== waitingCmd || (newStep === waitingCmd && arg)){
      delete convo[chatId];
      cv = null;
    }
  }

  // ===== MODE TUNGGU ANGKA (cuma jalan kalo teks BUKAN command) =====
  if(cv && !isCommand){
    if(cv.step==='SINYALPAKAI'){
      let p = parseSinyalPakai(text);
      if(!p){ await sendTelegramTo(chatId,`Ketik salah satu bro:\n1 / bybit - Bybit aja\n2 / okx - OKX aja\n3 / bybit okx - Dua-duanya\n\nAtau batalin pake command lain, misal /status`); return; }
      SIGNAL_BYBIT_ON = p.bybit; SIGNAL_OKX_ON = p.okx; delete convo[chatId];
      await sendTelegramTo(chatId,`✅ Sinyal Pakai di-update:\n${sinyalPakaiText()}\n\nCommand:\n/status\n/help\n/sinyalpakai\n/settingbybit\n/settingokx`);
      return;
    }
    if(cv.step==='SETTINGBYBIT'){
      let v = parseNum(text);
      if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka bro, contoh: 3\n\nAtau batalin pake command lain, misal /status`); return; }
      TRADE_MIN = v; delete convo[chatId];
      await sendTelegramTo(chatId,`✅ Setting Bybit di-update:\nSize Bybit: ${fmtSize(TRADE_MIN)} XAUT\nOKX gak berubah: Delta ${fmtSize(TRADE_MIN_OKX)} XAU, Agg ${OKX_AGG_SEC}s`);
      return;
    }
    if(cv.step==='SETTINGOKX'){
      let parts = text.split(/[\s,]+/).map(parseNum).filter(v=>!isNaN(v));
      if(!parts.length){ await sendTelegramTo(chatId,`Ketik angka bro, contoh:\n50000 - Delta doang\n50000 5 - Delta + Agg sekaligus\n\nAtau batalin pake command lain, misal /status`); return; }
      TRADE_MIN_OKX = parts[0];
      if(parts[1]!=null){ OKX_AGG_SEC = Math.max(1,Math.min(60,Math.round(parts[1]))); restartOkxAggTimer(); }
      delete convo[chatId];
      await sendTelegramTo(chatId,`✅ Setting OKX di-update:\nDelta OKX: ${fmtSize(TRADE_MIN_OKX)} XAU\nAgregasi OKX: ${OKX_AGG_SEC}s\nBybit gak berubah: ${fmtSize(TRADE_MIN)} XAUT`);
      return;
    }
  }

  if(!isCommand) return;
  if(cmd==='start' || cmd==='status'){ await sendTelegramTo(chatId,statusText()); return; }
  if(cmd==='help'){ await sendTelegramTo(chatId,`📋 ABEL BOT\n\n/status - Status\n/help - Help\n\n/sinyalpakai - ON/OFF sinyal\nContoh:\n/sinyalpakai bybit - Bybit aja\n/sinyalpakai okx - OKX aja\n/sinyalpakai bybit okx - Dua-duanya\n\n/settingbybit - Setting Bybit doang\nContoh: /settingbybit 3\n\n/settingokx - Setting OKX Delta + Agregasi (jadi satu)\nContoh:\n/settingokx 50000 - Delta doang, Agg tetep\n/settingokx 50000 5 - Delta 50000 + Agg 5 detik\n\n/rekap - Kirim rekap PDF ke Channel (command tersembunyi)\n\nSinyal auto ke Pribadi + Channel.\nRekap PDF auto ke Channel tiap 100 sinyal.\n\nCommand:\n/status\n/help\n/sinyalpakai\n/settingbybit\n/settingokx`); return; }
  if(cmd==='sinyalpakai' || cmd==='sinyal'){
    if(!arg){
      convo[chatId]={step:'SINYALPAKAI'};
      await sendTelegramTo(chatId,`⚙️ Sinyal Pakai Sekarang:\n${sinyalPakaiText()}\n\nMau pake yang mana?\nKetik:\n1 / bybit - Bybit aja\n2 / okx - OKX aja\n3 / bybit okx - Dua-duanya\n\nAtau langsung:\n/sinyalpakai bybit\n/sinyalpakai okx\n/sinyalpakai bybit okx`);
      return;
    }
    let p = parseSinyalPakai(arg);
    if(!p){ await sendTelegramTo(chatId,`Contoh:\n/sinyalpakai bybit\n/sinyalpakai okx\n/sinyalpakai bybit okx`); return; }
    SIGNAL_BYBIT_ON = p.bybit; SIGNAL_OKX_ON = p.okx;
    await sendTelegramTo(chatId,`✅ Sinyal Pakai di-update:\n${sinyalPakaiText()}\n\nCommand:\n/sinyalpakai\n/status`);
    return;
  }
  if(cmd==='settingbybit' || cmd==='sizebybit'){
    if(!arg){
      convo[chatId]={step:'SETTINGBYBIT'};
      await sendTelegramTo(chatId,`⚙️ Setting Bybit Sekarang: ${fmtSize(TRADE_MIN)} XAUT\nOKX gak ikut berubah.\n\nMau ganti ke berapa? Ketik angka, contoh: 3\n\nAtau langsung: /settingbybit 3\n\nKalo mau batalin, ketik command lain aja, misal /status`);
      return;
    }
    let v = parseNum(arg);
    if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Contoh: /settingbybit 3`); return; }
    TRADE_MIN = v;
    await sendTelegramTo(chatId,`✅ Setting Bybit di-update:\nSize Bybit: ${fmtSize(TRADE_MIN)} XAUT\nOKX gak berubah: Delta ${fmtSize(TRADE_MIN_OKX)} XAU, Agg ${OKX_AGG_SEC}s\n\nCommand:\n/settingbybit\n/settingokx\n/status`);
    return;
  }
  if(cmd==='settingokx' || cmd==='sizeokx'){
    if(!arg){
      convo[chatId]={step:'SETTINGOKX'};
      await sendTelegramTo(chatId,`⚙️ Setting OKX Sekarang:\nDelta: ${fmtSize(TRADE_MIN_OKX)} XAU\nAgregasi: ${OKX_AGG_SEC}s\nBybit gak ikut berubah.\n\nMau ganti? Ketik salah satu:\n50000 - Delta doang, Agg tetep\n50000 5 - Delta + Agg sekaligus\n\nAtau langsung:\n/settingokx 50000 5\n\nKalo mau batalin, ketik command lain aja, misal /status`);
      return;
    }
    let parts = arg.split(/[\s,]+/).map(parseNum).filter(v=>!isNaN(v));
    if(!parts.length){ await sendTelegramTo(chatId,`Contoh:\n/settingokx 50000\n/settingokx 50000 5`); return; }
    TRADE_MIN_OKX = parts[0];
    if(parts[1]!=null){ OKX_AGG_SEC = Math.max(1,Math.min(60,Math.round(parts[1]))); restartOkxAggTimer(); }
    await sendTelegramTo(chatId,`✅ Setting OKX di-update:\nDelta OKX: ${fmtSize(TRADE_MIN_OKX)} XAU\nAgregasi OKX: ${OKX_AGG_SEC}s\nBybit gak berubah: ${fmtSize(TRADE_MIN)} XAUT\n\nCommand:\n/settingokx\n/settingbybit\n/status`);
    return;
  }
  if(cmd==='agg' || cmd==='agregasi'){
    await sendTelegramTo(chatId,`Agg sekarang masuk ke /settingokx bro.\n\nContoh:\n/settingokx 50000 5 - Delta 50000 + Agg 5 detik\n/settingokx 50000 - Delta doang`);
    return;
  }
  if(cmd==='rekap'){
    if(signalHistory.length < 10){ await sendTelegramTo(chatId,`Belum cukup sinyal buat rekap bro, baru ${signalHistory.length} sinyal. Minimal 10.`); return; }
    await sendTelegramTo(chatId,`📄 Lagi bikin rekap PDF ${Math.min(RECAP_EVERY, signalHistory.length)} sinyal terakhir...\nDikirim ke Channel: ${TELEGRAM_CHANNEL_ID || 'Belum di-set, dikirim ke Pribadi dulu'}`);
    let batch = signalHistory.slice(0, RECAP_EVERY).reverse();
    let pdfBuf = createRecapPdf(batch, 'Manual Rekap - ' + fmtDateID(Date.now()) + ' - Total Ever: ' + totalSignalsEver);
    await sendTelegramDocToChannel(pdfBuf, 'ABEL-REKAP-MANUAL-' + Date.now() + '.pdf', `📄 REKAP MANUAL - ${batch.length} sinyal terakhir\n\nSESUAIKAN RISK MASING MASING💰\nHOLD BAGI YANG MAMPU🔥`);
    await sendTelegramTo(chatId,`✅ Rekap PDF udah dikirim ke Channel.`);
    return;
  }
  if(cmd==='trade' || cmd==='tradeokx'){
    await sendTelegramTo(chatId,`Command itu udah diganti bro.\nPake ini:\n/settingbybit 3\n/settingokx 50000 5`);
    return;
  }
  await sendTelegramTo(chatId,`Command /${cmd} gak aktif. Yang aktif:\n/status\n/help\n/sinyalpakai\n/settingbybit\n/settingokx`);
}

app.post('/webhook', async (req,res)=>{
  try{
    let upd=req.body||{};
    if(upd.message){ let chatId=upd.message.chat.id; let txt=upd.message.text||''; if(txt) await handleTelegramCommand(chatId,txt); }
    if(upd.channel_post){ let chatId=upd.channel_post.chat.id; let txt=upd.channel_post.text||''; if(txt && txt.startsWith('/')) await handleTelegramCommand(chatId,txt); }
    res.json({ok:true});
  }catch(e){ res.json({ok:false}); }
});
app.post('/api/telegram-webhook', async (req,res)=>{ res.redirect(307,'/webhook'); });

let teleOffset=0, pollingRunning=false;
async function telegramPolling(){
  if(!TELEGRAM_TOKEN||pollingRunning) return; pollingRunning=true;
  console.log('Telegram polling START');
  while(true){
    try{
      let r=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${teleOffset}&timeout=30`);
      let j=await r.json();
      if(j.ok&&j.result&&j.result.length){
        for(let upd of j.result){ teleOffset=upd.update_id+1; try{
          if(upd.message){ let chatId=upd.message.chat.id; let txt=upd.message.text||''; if(txt) await handleTelegramCommand(chatId,txt); }
          if(upd.channel_post){ let chatId=upd.channel_post.chat.id; let txt=upd.channel_post.text||''; if(txt && txt.startsWith('/')) await handleTelegramCommand(chatId,txt); }
        }catch(e){} }
      }
    }catch(e){ await new Promise(r=>setTimeout(r,2000)); }
    await new Promise(r=>setTimeout(r,500));
  }
}
if(TELEGRAM_TOKEN) telegramPolling();

let seenTradeIds = new Set();
function pushTrade(list, t){
  list.unshift(t);
  if(list.length>100) list=list.slice(0,100);
}

async function emitSignal(signal, price, size, source, extra){
  if(source==='BYBIT PERP' && !SIGNAL_BYBIT_ON) return;
  if(source==='OKX XAU SWAP' && !SIGNAL_OKX_ON) return;
  let setupId = generateSetupId();
  let sl = signal==='BUY' ? price - (SL_PIPS/10) : price + (SL_PIPS/10);
  let tp = signal==='BUY' ? price + (TP_PIPS/10) : price - (TP_PIPS/10);
  let now = Date.now();
  activeSignal = { setup_id: setupId, signal, price, size, source, time: now, time_str: fmtWIB(now), sl, tp, sl_pips: SL_PIPS, tp_pips: TP_PIPS, trade_min_used: source==='BYBIT PERP' ? TRADE_MIN : TRADE_MIN_OKX, ...extra };
  let hist = { ...activeSignal, created_at: now };
  signalHistory.unshift(hist);
  if(signalHistory.length>200) signalHistory=signalHistory.slice(0,200);
  totalSignalsEver++;
  lastUpdate = Date.now();
  await sendTelegram(`🎯 ${signal} NOW - Setup ${setupId}\n\nENTRY: $${price.toFixed(2)} (NOW)\nSL: $${sl.toFixed(2)} (-${SL_PIPS} PIPS)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} PIPS)\n\nSESUAIKAN RISK MASING MASING💰\nHOLD BAGI YANG MAMPU🔥`);
  if(totalSignalsEver % RECAP_EVERY === 0 && totalSignalsEver !== lastRecapAt){
    lastRecapAt = totalSignalsEver;
    await sendTelegram(`📄 Udah ${totalSignalsEver} sinyal, lagi bikin rekap PDF 100 sinyal terakhir... dikirim ke Channel.`);
    await sendRecapPdf();
  }
}

async function handleTradeBybit(price, size, side, tradeId, ts){
  if(!price||!size) return;
  xautPrice = price;
  let key = 'BYBIT-'+tradeId;
  if(seenTradeIds.has(key)) return;
  seenTradeIds.add(key);
  if(seenTradeIds.size>5000){ seenTradeIds.clear(); }
  let t = { id: tradeId, price, size, side: side==='BUY'?'BUY':'SELL', source:'BYBIT PERP', time: ts||Date.now(), time_str: fmtWIB(ts||Date.now()) };
  pushTrade(recentTradesBybit, t);
  if(size < TRADE_MIN) return;
  await emitSignal(side==='BUY'?'BUY':'SELL', price, size, 'BYBIT PERP', {});
}

function handleTradeOkx(price, size, side, tradeId, ts){
  if(!price||!size) return;
  xautPrice = price;
  let key = 'OKX-'+tradeId;
  if(seenTradeIds.has(key)) return;
  seenTradeIds.add(key);
  if(seenTradeIds.size>5000){ seenTradeIds.clear(); }
  let t = { id: tradeId, price, size, side: side==='BUY'?'BUY':'SELL', source:'OKX XAU SWAP', time: ts||Date.now(), time_str: fmtWIB(ts||Date.now()) };
  pushTrade(recentTradesOkx, t);
  if(side==='BUY') okxAgg.buy += size;
  else okxAgg.sell += size;
  okxAgg.count++;
  okxAgg.lastPrice = price;
  okxAgg.vwapSum += price*size;
  okxAgg.vwapVol += size;
}

async function flushOkxAgg(){
  let buy = okxAgg.buy, sell = okxAgg.sell, count = okxAgg.count;
  let delta = buy - sell;
  let vwap = okxAgg.vwapVol>0 ? okxAgg.vwapSum/okxAgg.vwapVol : okxAgg.lastPrice;
  okxAgg = { buy: 0, sell: 0, count: 0, lastPrice: okxAgg.lastPrice, start: Date.now(), vwapSum: 0, vwapVol: 0 };
  if(count===0) return;
  if(Math.abs(delta) < TRADE_MIN_OKX) return;
  let signal = delta>0 ? 'BUY' : 'SELL';
  let size = Math.abs(delta);
  let aggInfo = `Delta ${OKX_AGG_SEC}s: Buy ${fmtSize(buy)} - Sell ${fmtSize(sell)} = ${delta>0?'+':''}${fmtSize(delta)} (${count} trade)`;
  console.log('OKX DELTA LOLOS:', aggInfo);
  await emitSignal(signal, vwap||okxAgg.lastPrice, size, 'OKX XAU SWAP', { agg: aggInfo });
}
function restartOkxAggTimer(){
  if(okxAggTimer) clearInterval(okxAggTimer);
  okxAggTimer = setInterval(flushOkxAgg, OKX_AGG_SEC*1000);
}
restartOkxAggTimer();

let wsBybitTrade=null;
function connectBybitTrade(){
  if(!WSClient) return;
  if(wsBybitTrade){ try{ wsBybitTrade.removeAllListeners(); wsBybitTrade.terminate(); }catch(e){} }
  console.log('Connect Bybit FUTURES PERP WS');
  try{
    wsBybitTrade=new WSClient('wss://stream.bybit.com/v5/public/linear');
    wsBybitTrade.on('open',()=>{ console.log('Bybit PERP OPEN'); wsTradeBybitOk=true; wsBybitTrade.send(JSON.stringify({op:'subscribe',args:['publicTrade.XAUTUSDT']})); setInterval(()=>{ try{ if(wsBybitTrade&&wsBybitTrade.readyState===1) wsBybitTrade.send(JSON.stringify({op:'ping'})); }catch(e){} },20000); });
    wsBybitTrade.on('message',(data)=>{
      try{
        let j=JSON.parse(data.toString());
        if(j.topic==='publicTrade.XAUTUSDT' && j.data){
          wsLastTradeBybit=Date.now();
          j.data.forEach(d=>{
            let side = (d.S==='Buy') ? 'BUY' : 'SELL';
            handleTradeBybit(parseFloat(d.p), parseFloat(d.v), side, d.i, parseInt(d.T));
          });
        }
      }catch(e){}
    });
    wsBybitTrade.on('close',()=>{ console.log('Bybit PERP CLOSE'); wsTradeBybitOk=false; setTimeout(connectBybitTrade,3000); });
    wsBybitTrade.on('error',(e)=>{ console.log('Bybit PERP ERROR',e.message); });
  }catch(e){ setTimeout(connectBybitTrade,3000); }
}
let wsOkxTrade=null;
function connectOkxTrade(){
  if(!WSClient) return;
  if(wsOkxTrade){ try{ wsOkxTrade.removeAllListeners(); wsOkxTrade.terminate(); }catch(e){} }
  console.log('Connect OKX XAU SWAP WS');
  try{
    wsOkxTrade=new WSClient('wss://ws.okx.com:8443/ws/v5/public');
    wsOkxTrade.on('open',()=>{
      console.log('OKX XAU SWAP OPEN');
      wsTradeOkxOk=true;
      wsOkxTrade.send(JSON.stringify({op:'subscribe',args:[{channel:'trades',instId:'XAU-USDT-SWAP'}]}));
      setInterval(()=>{ try{ if(wsOkxTrade&&wsOkxTrade.readyState===1) wsOkxTrade.send('ping'); }catch(e){} },25000);
    });
    wsOkxTrade.on('message',(data)=>{
      try{
        let txt=data.toString();
        if(txt==='pong') return;
        let j=JSON.parse(txt);
        if(j.data && j.data[0] && j.arg && j.arg.channel==='trades'){
          wsLastTradeOkx=Date.now();
          j.data.forEach(d=>{
            let side = (d.side==='buy') ? 'BUY' : 'SELL';
            handleTradeOkx(parseFloat(d.px), parseFloat(d.sz), side, d.tradeId, parseInt(d.ts));
          });
        }
      }catch(e){}
    });
    wsOkxTrade.on('close',()=>{ console.log('OKX XAU SWAP CLOSE'); wsTradeOkxOk=false; setTimeout(connectOkxTrade,3000); });
    wsOkxTrade.on('error',(e)=>{ console.log('OKX XAU SWAP ERROR',e.message); });
  }catch(e){ setTimeout(connectOkxTrade,3000); }
}
connectBybitTrade();
connectOkxTrade();

async function fetchOne(url){ try{ let r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }
async function fetchFarWalls(){
  try{
    let allBids=[], allAsks=[];
    let bybit = await fetchOne('https://api.bytick.com/v5/market/orderbook?category=linear&symbol=XAUTUSDT&limit=200');
    if(!bybit||!bybit.result||!bybit.result.b) bybit = await fetchOne('https://api.bybit.com/v5/market/orderbook?category=linear&symbol=XAUTUSDT&limit=200');
    if(bybit&&bybit.result&&bybit.result.b){
      bybit.result.b.forEach(([p,s])=> allBids.push({price:parseFloat(p),size:parseFloat(s),source:'BYBIT PERP'}));
      bybit.result.a.forEach(([p,s])=> allAsks.push({price:parseFloat(p),size:parseFloat(s),source:'BYBIT PERP'}));
    }
    let okx = await fetchOne('https://www.okx.com/api/v5/market/books?instId=XAU-USDT-SWAP&sz=200');
    if(okx&&okx.data&&okx.data[0]){
      okx.data[0].bids.forEach(([p,s])=> allBids.push({price:parseFloat(p),size:parseFloat(s),source:'OKX XAU SWAP'}));
      okx.data[0].asks.forEach(([p,s])=> allAsks.push({price:parseFloat(p),size:parseFloat(s),source:'OKX XAU SWAP'}));
    }
    function topFar(list, side){
      let bySrc={};
      list.forEach(o=>{ if(!bySrc[o.source]) bySrc[o.source]=[]; bySrc[o.source].push(o); });
      let out=[];
      for(let src of Object.keys(bySrc)){
        let sorted=[...bySrc[src]].sort((a,b)=>b.size-a.size).slice(0,3);
        sorted.forEach(o=> out.push({side, price:o.price, size:o.size, sources:src, age_menit:0}));
      }
      return out;
    }
    wallsFar = [...topFar(allBids,'BID'), ...topFar(allAsks,'ASK')];
    console.log('Far walls FUTURES update - total:', wallsFar.length);
  }catch(e){ console.log('fetchFar gagal',e.message); }
}
fetchFarWalls();
setInterval(fetchFarWalls, 60000);

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - FUTURES PERP - Size Bybit '+TRADE_MIN+' Delta OKX '+TRADE_MIN_OKX+' Agg '+OKX_AGG_SEC+'s'));
app.get('/api/signal', (req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({
    signal: activeSignal ? activeSignal.signal+' - AKTIF' : 'WAIT',
    active_signal: activeSignal,
    setup_id: activeSignal ? activeSignal.setup_id : '',
    recent_bybit: recentTradesBybit,
    recent_okx: recentTradesOkx,
    recent_trades: [...recentTradesBybit, ...recentTradesOkx].sort((a,b)=>b.time-a.time).slice(0,50),
    history: signalHistory,
    history_sinyal: signalHistory,
    wallsFar,
    okx_agg: { buy: okxAgg.buy, sell: okxAgg.sell, delta: okxAgg.buy-okxAgg.sell, count: okxAgg.count, window_sec: OKX_AGG_SEC, threshold: TRADE_MIN_OKX },
    config: { trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, okx_agg_sec: OKX_AGG_SEC, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice||0, market: 'FUTURES PERP', total_signals_ever: totalSignalsEver, recap_every: RECAP_EVERY, signal_bybit_on: SIGNAL_BYBIT_ON, signal_okx_on: SIGNAL_OKX_ON, channel_id: TELEGRAM_CHANNEL_ID ? 'SET' : '' },
    harga: { xaut: xautPrice, mt5: MT5.lastPrice||0, source: 'Recent Trade FUTURES Bybit PERP + OKX XAU SWAP Delta' },
    exchanges: { bybit_trade: wsTradeBybitOk?'WS-OK':'WS-OFF', okx_trade: wsTradeOkxOk?'WS-OK':'WS-OFF' },
    uptimeStart, uptime_menit: Math.floor((Date.now()-uptimeStart)/60000), last_update: lastUpdate,
  });
});
app.get('/api/config', (req,res)=>{ res.json({ trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, okx_agg_sec: OKX_AGG_SEC, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, signal_bybit_on: SIGNAL_BYBIT_ON, signal_okx_on: SIGNAL_OKX_ON }); });
app.post('/api/mt5/price', (req,res)=>{
  try{
    let b=req.body||{};
    let bid=parseFloat(b.bid||b.price||0); let ask=parseFloat(b.ask||b.price||0);
    let mid=(bid&&ask)?(bid+ask)/2:(bid||ask||0);
    if(mid>0){ MT5.lastPrice=mid; MT5.lastBid=bid||mid; MT5.lastAsk=ask||mid; if(b.balance!=null) MT5.balance=parseFloat(b.balance)||0; if(b.equity!=null) MT5.equity=parseFloat(b.equity)||0; if(b.positions!=null) MT5.positions=parseInt(b.positions)||0; MT5.connected=true; MT5.lastSeen=Date.now(); }
    res.json({ok:true, mt5_price: MT5.lastPrice, connected: MT5.connected});
  }catch(e){ res.json({ok:false,error:e.message}); }
});
app.get('/api/mt5/price', (req,res)=>{ res.json({ok:true, connected: MT5.connected, price: MT5.lastPrice, bid: MT5.lastBid, ask: MT5.lastAsk, balance: MT5.balance, equity: MT5.equity, positions: MT5.positions, last_seen: MT5.lastSeen}); });
app.get('/api/history', (req,res)=>{ res.json({ history: signalHistory, total: signalHistory.length, total_ever: totalSignalsEver, uptimeStart }); });
app.get('/api/test-telegram', async (req,res)=>{
  let sid=generateSetupId();
  let price=3634.31; let sl=price-(SL_PIPS/10); let tp=price+(TP_PIPS/10);
  await sendTelegram(`🎯 BUY NOW - Setup ${sid}\n\nENTRY: $${price.toFixed(2)} (NOW)\nSL: $${sl.toFixed(2)} (-${SL_PIPS} PIPS)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} PIPS)\n\nSESUAIKAN RISK MASING MASING💰\nHOLD BAGI YANG MAMPU🔥`);
  res.json({ok:true, setup_id:sid});
});
app.get('/api/test-rekap', async (req,res)=>{
  if(signalHistory.length<1){ res.json({ok:false, error:'Belum ada sinyal'}); return; }
  let batch = signalHistory.slice(0, Math.min(10, signalHistory.length)).reverse();
  let pdfBuf = createRecapPdf(batch, 'TEST REKAP - ' + fmtDateID(Date.now()));
  await sendTelegramDocToChannel(pdfBuf, 'ABEL-TEST-REKAP.pdf', `📄 TEST REKAP PDF - ${batch.length} sinyal - ke Channel`);
  res.json({ok:true, count: batch.length, to_channel: !!TELEGRAM_CHANNEL_ID});
});
app.listen(PORT, ()=> console.log('ABEL BOT jalan di port '+PORT+' - FUTURES PERP - Size Bybit '+TRADE_MIN+' Delta OKX '+TRADE_MIN_OKX+' Agg '+OKX_AGG_SEC+'s'));
