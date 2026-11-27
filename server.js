// ABEL BOT - FINAL + PANDUAN KETIK
// /status /help /sinyalpakai /settingbybit /settingokx
// Semua setting ketik manual, angka ditampilin persis ketikan lo
// /status TANPA harga XAUT
// Panduan: titik = koma desimal. 3.000 = 3, 3000 = 3000. 50.000 = 50, 50000 = 50000
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
const TELEGRAM_CHANNEL_ID = (process.env.TELEGRAM_CHANNEL_ID || '').trim() || (TELEGRAM_CHAT_ID.startsWith('-100') ? TELEGRAM_CHAT_ID : '');

// SETTING - simpen RAW (persis ketikan) + NUMERIC (buat filter)
let TRADE_MIN_RAW = '3.000';
let TRADE_MIN = 3;
let TRADE_MIN_OKX_RAW = '50000';
let TRADE_MIN_OKX = 50000;
let OKX_AGG_SEC_RAW = '5';
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

// Parse: "3.000" -> 3, "3000" -> 3000, "3,5" -> 3.5, "50000" -> 50000, "50.000" -> 50
// Titik dianggap koma desimal, bukan ribuan. Jadi 3.000 = 3, 3000 = 3000.
function parseNum(str){
  if(str===undefined||str===null) return NaN;
  let s = String(str).trim().replace(',', '.').replace(/[^0-9.\-]/g,'');
  if(!s) return NaN;
  return parseFloat(s);
}
function generateSetupId(){
  const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let id='';
  for(let i=0;i<4;i++) id+=chars[Math.floor(Math.random()*chars.length)];
  return '#'+id;
}
function fmtWIB(ts){ return new Date(ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtDateID(ts){ return new Date(ts).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) + ' ' + fmtWIB(ts) + ' WIB'; }
function sinyalPakaiText(){ return `Bybit ${SIGNAL_BYBIT_ON?'ON ✅':'OFF ❌'} | OKX ${SIGNAL_OKX_ON?'ON ✅':'OFF ❌'}`; }

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
    lines.push('>> ' + h.signal + ' NOW - Setup ' + h.setup_id);
    lines.push('');
    lines.push('Trade: ' + h.signal + ' ' + h.size + ' XAUT @ $' + h.price.toFixed(2) + ' - ' + h.source);
    lines.push('Nilai: $' + usd);
    lines.push('Jam: ' + (h.time_str||fmtWIB(h.time)) + ' WIB');
    lines.push('Filter: >= ' + (h.trade_min_raw||h.trade_min_used) + ' - LOLOS [OK]');
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
  let caption = `📄 REKAP LAPORAN 100 SINYAL - ABEL BOT\n\nPeriode: ${fmtDateID(from.time)} s/d ${fmtDateID(to.time)}\nTotal Sinyal: ${totalSignalsEver}\n\nSESUAIKAN RISK💰\nHOLD JIKA MAMPU🔥`;
  await sendTelegramDocToChannel(pdfBuf, fileName, caption);
}

async function setMyCommands(){
  if(!TELEGRAM_TOKEN) return;
  const commands=[
    {command:'status',description:'Status'},
    {command:'help',description:'Help + panduan ketik'},
    {command:'sinyalpakai',description:'ON/OFF sinyal'},
    {command:'settingbybit',description:'Setting Bybit'},
    {command:'settingokx',description:'Setting OKX'},
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commands})}); }catch(e){}
}
setMyCommands();

// STATUS TANPA HARGA XAUT - cuma settingan
function statusText(){
  return `Bybit: ${TRADE_MIN_RAW}\nOKX: ${TRADE_MIN_OKX_RAW}, ${OKX_AGG_SEC_RAW}s\nSinyal: ${sinyalPakaiText()}\nTotal: ${totalSignalsEver}\nChannel: ${TELEGRAM_CHANNEL_ID ? TELEGRAM_CHANNEL_ID+' ✅' : 'Belum di-set'}`;
}

// PANDUAN KETIK - ditampilin di /help + di tiap setting
const PANDUAN_KETIK = `Panduan ketik:\n3.000 = 3\n3000 = 3000\n50.000 = 50\n50000 = 50000\nMau ribuan, ketik tanpa titik.`;

function parseSinyalPakai(text){
  let t = String(text||'').toLowerCase().trim();
  if(t==='1' || t==='bybit') return {bybit:true, okx:false};
  if(t==='2' || t==='okx') return {bybit:false, okx:true};
  if(t==='3' || t==='12' || t==='21' || t==='bybit okx' || t==='okx bybit' || t==='dua' || t==='semua' || t==='both') return {bybit:true, okx:true};
  return null;
}

async function handleTelegramCommand(chatId, textRaw){
  let text=String(textRaw||'').trim();
  if(!text) return;
  let isCommand = text.startsWith('/');
  let m = text.match(/^\/?([a-z_]+)\s*(.*)$/i);
  let cmd = m ? m[1].toLowerCase() : '';
  let arg = m ? (m[2]||'').trim() : '';

  let cv = convo[chatId];
  if(cv && isCommand){
    delete convo[chatId];
    cv = null;
  }

  // MODE TUNGGU INPUT MANUAL - cuma jalan kalo BUKAN command
  if(cv && !isCommand){
    if(cv.step==='SINYALPAKAI'){
      let p = parseSinyalPakai(text);
      if(!p){ await sendTelegramTo(chatId,`Ketik: 1=Bybit 2=OKX 3=Dua-duanya`); return; }
      SIGNAL_BYBIT_ON = p.bybit; SIGNAL_OKX_ON = p.okx; delete convo[chatId];
      await sendTelegramTo(chatId,`✅ ${sinyalPakaiText()}`);
      return;
    }
    if(cv.step==='SETTINGBYBIT'){
      let raw = text.split(/[\s,]+/)[0];
      let v = parseNum(raw);
      if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka, contoh: 3.000\n${PANDUAN_KETIK}`); return; }
      TRADE_MIN_RAW = raw;
      TRADE_MIN = v;
      delete convo[chatId];
      await sendTelegramTo(chatId,`✅ Bybit: ${TRADE_MIN_RAW}`);
      return;
    }
    if(cv.step==='SETTINGOKX'){
      let parts = text.split(/[\s,]+/).filter(Boolean);
      if(!parts.length){ await sendTelegramTo(chatId,`Ketik: Delta Agg\nContoh: 50000 5\n${PANDUAN_KETIK}`); return; }
      let v0 = parseNum(parts[0]);
      if(isNaN(v0)||v0<=0){ await sendTelegramTo(chatId,`Ketik: Delta Agg\nContoh: 50000 5\n${PANDUAN_KETIK}`); return; }
      TRADE_MIN_OKX_RAW = parts[0];
      TRADE_MIN_OKX = v0;
      if(parts[1]){
        let v1 = parseNum(parts[1]);
        if(!isNaN(v1) && v1>0){ OKX_AGG_SEC_RAW = parts[1]; OKX_AGG_SEC = Math.max(1,Math.min(60,Math.round(v1))); restartOkxAggTimer(); }
      }
      delete convo[chatId];
      await sendTelegramTo(chatId,`✅ OKX: ${TRADE_MIN_OKX_RAW}, ${OKX_AGG_SEC_RAW}s`);
      return;
    }
  }

  if(!isCommand) return;
  if(cmd==='start' || cmd==='status'){ await sendTelegramTo(chatId,statusText()); return; }
  if(cmd==='help'){ await sendTelegramTo(chatId,`Command:\n/status\n/help\n/sinyalpakai -> ketik 1/2/3\n/settingbybit -> ketik angka\n/settingokx -> ketik Delta Agg\n\n${PANDUAN_KETIK}`); return; }
  if(cmd==='sinyalpakai' || cmd==='sinyal'){
    convo[chatId]={step:'SINYALPAKAI'};
    await sendTelegramTo(chatId,`Sinyal: ${sinyalPakaiText()}\nKetik: 1=Bybit 2=OKX 3=Dua-duanya`);
    return;
  }
  if(cmd==='settingbybit'){
    convo[chatId]={step:'SETTINGBYBIT'};
    await sendTelegramTo(chatId,`Bybit: ${TRADE_MIN_RAW}\nKetik angka baru:\nContoh: 3.000\n\n${PANDUAN_KETIK}`);
    return;
  }
  if(cmd==='settingokx'){
    convo[chatId]={step:'SETTINGOKX'};
    await sendTelegramTo(chatId,`OKX: ${TRADE_MIN_OKX_RAW}, ${OKX_AGG_SEC_RAW}s\nKetik: Delta Agg\nContoh: 50000 5\n\n${PANDUAN_KETIK}`);
    return;
  }
  if(cmd==='rekap'){
    if(signalHistory.length < 10){ await sendTelegramTo(chatId,`Belum cukup, baru ${signalHistory.length}. Minimal 10.`); return; }
    await sendTelegramTo(chatId,`Bikin rekap... dikirim ke Channel.`);
    let batch = signalHistory.slice(0, RECAP_EVERY).reverse();
    let pdfBuf = createRecapPdf(batch, 'Manual Rekap - ' + fmtDateID(Date.now()) + ' - Total Ever: ' + totalSignalsEver);
    await sendTelegramDocToChannel(pdfBuf, 'ABEL-REKAP-MANUAL-' + Date.now() + '.pdf', `📄 REKAP MANUAL - ${batch.length} sinyal terakhir\n\nSESUAIKAN RISK💰\nHOLD JIKA MAMPU🔥`);
    await sendTelegramTo(chatId,`✅ Rekap udah dikirim ke Channel.`);
    return;
  }
  await sendTelegramTo(chatId,`Command gak aktif.\n/status\n/help\n/sinyalpakai\n/settingbybit\n/settingokx\n\n${PANDUAN_KETIK}`);
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
  let trade_min_raw_used = source==='BYBIT PERP' ? TRADE_MIN_RAW : TRADE_MIN_OKX_RAW;
  let trade_min_used = source==='BYBIT PERP' ? TRADE_MIN : TRADE_MIN_OKX;
  activeSignal = { setup_id: setupId, signal, price, size, source, time: now, time_str: fmtWIB(now), sl, tp, sl_pips: SL_PIPS, tp_pips: TP_PIPS, trade_min_used, trade_min_raw: trade_min_raw_used, ...extra };
  let hist = { ...activeSignal, created_at: now };
  signalHistory.unshift(hist);
  if(signalHistory.length>200) signalHistory=signalHistory.slice(0,200);
  totalSignalsEver++;
  lastUpdate = Date.now();
  await sendTelegram(`🎯 ${signal} NOW - Setup ${setupId}\n\nENTRY: $${price.toFixed(2)} (NOW)\nSL: $${sl.toFixed(2)} (-${SL_PIPS} PIPS)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} PIPS)\n\nSESUAIKAN RISK💰\nHOLD JIKA MAMPU🔥`);
  if(totalSignalsEver % RECAP_EVERY === 0 && totalSignalsEver !== lastRecapAt){
    lastRecapAt = totalSignalsEver;
    await sendTelegram(`📄 Udah ${totalSignalsEver} sinyal, bikin rekap PDF... dikirim ke Channel.`);
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
  let aggInfo = `Delta ${OKX_AGG_SEC_RAW}s: Buy ${buy} - Sell ${sell} = ${delta>0?'+':''}${delta} (${count} trade)`;
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
  try{
    wsBybitTrade=new WSClient('wss://stream.bybit.com/v5/public/linear');
    wsBybitTrade.on('open',()=>{ wsTradeBybitOk=true; wsBybitTrade.send(JSON.stringify({op:'subscribe',args:['publicTrade.XAUTUSDT']})); setInterval(()=>{ try{ if(wsBybitTrade&&wsBybitTrade.readyState===1) wsBybitTrade.send(JSON.stringify({op:'ping'})); }catch(e){} },20000); });
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
    wsBybitTrade.on('close',()=>{ wsTradeBybitOk=false; setTimeout(connectBybitTrade,3000); });
    wsBybitTrade.on('error',(e)=>{ console.log('Bybit ERROR',e.message); });
  }catch(e){ setTimeout(connectBybitTrade,3000); }
}
let wsOkxTrade=null;
function connectOkxTrade(){
  if(!WSClient) return;
  if(wsOkxTrade){ try{ wsOkxTrade.removeAllListeners(); wsOkxTrade.terminate(); }catch(e){} }
  try{
    wsOkxTrade=new WSClient('wss://ws.okx.com:8443/ws/v5/public');
    wsOkxTrade.on('open',()=>{
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
    wsOkxTrade.on('close',()=>{ wsTradeOkxOk=false; setTimeout(connectOkxTrade,3000); });
    wsOkxTrade.on('error',(e)=>{ console.log('OKX ERROR',e.message); });
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
  }catch(e){}
}
fetchFarWalls();
setInterval(fetchFarWalls, 60000);

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - Bybit '+TRADE_MIN_RAW+' OKX '+TRADE_MIN_OKX_RAW+' Agg '+OKX_AGG_SEC_RAW+'s'));
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
    config: { trade_min: TRADE_MIN, trade_min_raw: TRADE_MIN_RAW, trade_min_okx: TRADE_MIN_OKX, trade_min_okx_raw: TRADE_MIN_OKX_RAW, okx_agg_sec: OKX_AGG_SEC, okx_agg_sec_raw: OKX_AGG_SEC_RAW, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice||0, market: 'FUTURES PERP', total_signals_ever: totalSignalsEver, recap_every: RECAP_EVERY, signal_bybit_on: SIGNAL_BYBIT_ON, signal_okx_on: SIGNAL_OKX_ON, channel_id: TELEGRAM_CHANNEL_ID ? 'SET' : '' },
    harga: { xaut: xautPrice, mt5: MT5.lastPrice||0, source: 'Recent Trade FUTURES Bybit PERP + OKX XAU SWAP Delta' },
    exchanges: { bybit_trade: wsTradeBybitOk?'WS-OK':'WS-OFF', okx_trade: wsTradeOkxOk?'WS-OK':'WS-OFF' },
    uptimeStart, uptime_menit: Math.floor((Date.now()-uptimeStart)/60000), last_update: lastUpdate,
  });
});
app.get('/api/config', (req,res)=>{ res.json({ trade_min: TRADE_MIN, trade_min_raw: TRADE_MIN_RAW, trade_min_okx: TRADE_MIN_OKX, trade_min_okx_raw: TRADE_MIN_OKX_RAW, okx_agg_sec: OKX_AGG_SEC, okx_agg_sec_raw: OKX_AGG_SEC_RAW, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, signal_bybit_on: SIGNAL_BYBIT_ON, signal_okx_on: SIGNAL_OKX_ON }); });
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
  await sendTelegram(`🎯 BUY NOW - Setup ${sid}\n\nENTRY: $${price.toFixed(2)} (NOW)\nSL: $${sl.toFixed(2)} (-${SL_PIPS} PIPS)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} PIPS)\n\nSESUAIKAN RISK💰\nHOLD JIKA MAMPU🔥`);
  res.json({ok:true, setup_id:sid});
});
app.get('/api/test-rekap', async (req,res)=>{
  if(signalHistory.length<1){ res.json({ok:false, error:'Belum ada sinyal'}); return; }
  let batch = signalHistory.slice(0, Math.min(10, signalHistory.length)).reverse();
  let pdfBuf = createRecapPdf(batch, 'TEST REKAP - ' + fmtDateID(Date.now()));
  await sendTelegramDocToChannel(pdfBuf, 'ABEL-TEST-REKAP.pdf', `📄 TEST REKAP PDF - ${batch.length} sinyal - ke Channel`);
  res.json({ok:true, count: batch.length, to_channel: !!TELEGRAM_CHANNEL_ID});
});
app.listen(PORT, ()=> console.log('ABEL BOT jalan di port '+PORT+' - Bybit '+TRADE_MIN_RAW+' OKX '+TRADE_MIN_OKX_RAW+' Agg '+OKX_AGG_SEC_RAW+'s'));
