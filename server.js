// ABEL BOT - FUTURES PERP - OKX AGREGASI DELTA
// BYBIT: per-trade, Size 3.000 langsung sinyal
// OKX: agregasi 5 detik, Delta Buy-Sell >= 5000.000 baru sinyal - NO COOLDOWN
// COMMAND: /sizebybit /sizeokx /status /help
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

let TRADE_MIN = 3; // Size Bybit - per-trade
let TRADE_MIN_OKX = 5000; // Size OKX - DELTA 5 detik, bukan per-trade!
let OKX_AGG_SEC = 5; // Agregasi OKX 5 detik
let SL_PIPS = 50;
let TP_PIPS = 50;
let CFG = { lot: 0.01, simbol: 'XAUUSD', isCent: false };

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

// ===== AGREGASI OKX - INI KUNCI ANTI NOISE =====
let okxAgg = { buy: 0, sell: 0, count: 0, lastPrice: 0, start: Date.now(), vwapSum: 0, vwapVol: 0 };

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

async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_IDS.length) return;
  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chat_id)=>{
    try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id,text:msg})}); }catch(e){ console.log('Tele gagal',e.message); }
  }));
}
async function sendTelegramTo(chatId, msg){
  if(!TELEGRAM_TOKEN) return;
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:String(chatId),text:msg})}); }catch(e){ console.log('Tele sendTo gagal',e.message); }
}
async function setMyCommands(){
  if(!TELEGRAM_TOKEN) return;
  const commands=[
    {command:'sizebybit',description:'Size Bybit - misal /sizebybit 3'},
    {command:'sizeokx',description:'Size OKX Delta 5 detik - misal /sizeokx 5000'},
    {command:'status',description:'Status'},
    {command:'help',description:'Help'},
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commands})}); }catch(e){}
}
setMyCommands();

function statusText(){
  return `🤖 ABEL BOT\n\nSize Bybit: ${fmtSize(TRADE_MIN)} XAUT\nSize OKX: ${fmtSize(TRADE_MIN_OKX)} XAU (Delta ${OKX_AGG_SEC}s)\nSinyal Aktif: ${activeSignal ? activeSignal.signal+' '+fmtSize(activeSignal.size)+' XAUT @ $'+activeSignal.price.toFixed(2)+' - '+activeSignal.source : 'WAIT - Belum ada trade gede'}\nXAUT: $${xautPrice?xautPrice.toFixed(2):'-'}\nMT5: ${MT5.connected?'Nyambung ✅':'Belum nyambung - RDP belum jalan'}\nTotal Sinyal Lolos: ${signalHistory.length}\n\nLayering: ON - Tanpa batas, tanpa cooldown\nBuy + Sell berlawanan tetep di-entry semua.`;
}

async function handleTelegramCommand(chatId, textRaw){
  let text=String(textRaw||'').trim();
  let cv=convo[chatId];
  if(cv && cv.step==='SIZEBYBIT'){
    let v=parseNum(text);
    if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka bro, contoh: 3`); return; }
    TRADE_MIN=v; delete convo[chatId];
    await sendTelegramTo(chatId,`✅ Size Bybit diganti ke ${fmtSize(v)} XAUT\nSize OKX Delta tetep ${fmtSize(TRADE_MIN_OKX)} XAU.`);
    return;
  }
  if(cv && cv.step==='SIZEOKX'){
    let v=parseNum(text);
    if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka bro, contoh: 5000`); return; }
    TRADE_MIN_OKX=v; delete convo[chatId];
    await sendTelegramTo(chatId,`✅ Size OKX Delta diganti ke ${fmtSize(v)} XAU (Agregasi ${OKX_AGG_SEC}s)\nSize Bybit tetep ${fmtSize(TRADE_MIN)} XAUT.`);
    return;
  }
  let m=text.match(/^\/?([a-z_]+)\s*(.*)$/i); if(!m) return;
  let cmd=m[1].toLowerCase(); let arg=(m[2]||'').trim();
  if(cmd==='start'){ await sendTelegramTo(chatId,statusText()+`\n\nCommand: Size bybit / Size okx / Status / Help`); return; }
  if(cmd==='help'){ await sendTelegramTo(chatId,`📋 ABEL BOT\n\nSize bybit - /sizebybit 3 - Ganti Size Bybit (per-trade)\nSize okx - /sizeokx 5000 - Ganti Size OKX (Delta ${OKX_AGG_SEC}s)\nStatus - /status - Liat setting sekarang\nHelp - /help - Liat command\n\nBybit = per-trade, 3.000 langsung sinyal\nOKX = agregasi ${OKX_AGG_SEC}s, Delta Buy-Sell >= 5000.000 baru sinyal\nTanpa cooldown, tanpa batas, layering boleh.`); return; }
  if(cmd==='status'){ await sendTelegramTo(chatId,statusText()); return; }
  if(cmd==='sizebybit'){
    if(!arg){ convo[chatId]={step:'SIZEBYBIT'}; await sendTelegramTo(chatId,`Size Bybit sekarang: ${fmtSize(TRADE_MIN)} XAUT\n\nMau ganti ke berapa? Contoh: 3`); return; }
    let v=parseNum(arg); if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Contoh: /sizebybit 3`); return; }
    TRADE_MIN=v;
    await sendTelegramTo(chatId,`✅ Size Bybit diganti ke ${fmtSize(v)} XAUT`);
    return;
  }
  if(cmd==='sizeokx'){
    if(!arg){ convo[chatId]={step:'SIZEOKX'}; await sendTelegramTo(chatId,`Size OKX Delta sekarang: ${fmtSize(TRADE_MIN_OKX)} XAU (Agregasi ${OKX_AGG_SEC}s)\n\nMau ganti ke berapa? Contoh: 5000`); return; }
    let v=parseNum(arg); if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Contoh: /sizeokx 5000`); return; }
    TRADE_MIN_OKX=v;
    await sendTelegramTo(chatId,`✅ Size OKX Delta diganti ke ${fmtSize(v)} XAU`);
    return;
  }
  if(cmd==='trade'){ await sendTelegramTo(chatId,`Command /trade udah diganti bro.\nPake ini:\nSize bybit -> /sizebybit 3\nSize okx -> /sizeokx 5000`); return; }
  if(cmd==='tradeokx'){ await sendTelegramTo(chatId,`Command /tradeokx udah diganti bro.\nPake ini:\nSize okx -> /sizeokx 5000`); return; }
  await sendTelegramTo(chatId,`Command /${cmd} gak aktif. Yang aktif:\nSize bybit -> /sizebybit 3\nSize okx -> /sizeokx 5000\nStatus -> /status`);
}

app.post('/webhook', async (req,res)=>{
  try{
    let upd=req.body||{};
    if(upd.message){ let chatId=upd.message.chat.id; let txt=upd.message.text||''; if(txt) await handleTelegramCommand(chatId,txt); }
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
        for(let upd of j.result){ teleOffset=upd.update_id+1; try{ if(upd.message){ let chatId=upd.message.chat.id; let txt=upd.message.text||''; if(txt) await handleTelegramCommand(chatId,txt); } }catch(e){} }
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
  let setupId = generateSetupId();
  let sl = signal==='BUY' ? price - (SL_PIPS/10) : price + (SL_PIPS/10);
  let tp = signal==='BUY' ? price + (TP_PIPS/10) : price - (TP_PIPS/10);
  let now = Date.now();
  activeSignal = { setup_id: setupId, signal, price, size, source, time: now, time_str: fmtWIB(now), sl, tp, sl_pips: SL_PIPS, tp_pips: TP_PIPS, trade_min_used: source==='BYBIT PERP' ? TRADE_MIN : TRADE_MIN_OKX, ...extra };
  let hist = { ...activeSignal, created_at: now };
  signalHistory.unshift(hist);
  if(signalHistory.length>200) signalHistory=signalHistory.slice(0,200);
  lastUpdate = Date.now();
  let usdValue = (size*price).toLocaleString('en-US',{maximumFractionDigits:0});
  let aggInfo = extra && extra.agg ? `\nAgregasi: ${extra.agg}` : '';
  await sendTelegram(`🎯 ${signal} NOW - Setup ${setupId} (TRADE GEDE FUTURES)\n\nTrade: ${signal} ${fmtSize(size)} XAUT @ $${price.toFixed(2)} - ${source}\nNilai: $${usdValue}\nJam: ${fmtWIB(now)} WIB\nFilter: >= ${fmtSize(source==='BYBIT PERP'?TRADE_MIN:TRADE_MIN_OKX)} XAUT - LOLOS ✅${aggInfo}\n\nEntry: $${price.toFixed(2)}\nSL: $${sl.toFixed(2)} (-${SL_PIPS} pips)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} pips)\n\nLayering ON - Entry aja, risk kecil.\nHOLD BAGI YANG MAMPU🔥`);
}

// ===== BYBIT: PER-TRADE LANGSUNG =====
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

// ===== OKX: AGREGASI 5 DETIK + DELTA - ANTI NOISE =====
function handleTradeOkx(price, size, side, tradeId, ts){
  if(!price||!size) return;
  xautPrice = price;
  let key = 'OKX-'+tradeId;
  if(seenTradeIds.has(key)) return;
  seenTradeIds.add(key);
  if(seenTradeIds.size>5000){ seenTradeIds.clear(); }
  let t = { id: tradeId, price, size, side: side==='BUY'?'BUY':'SELL', source:'OKX XAU SWAP', time: ts||Date.now(), time_str: fmtWIB(ts||Date.now()) };
  pushTrade(recentTradesOkx, t);
  // Cuma kumpulin, JANGAN langsung sinyal - ini kunci anti noise
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
  // Reset dulu biar window berikutnya bersih, tanpa cooldown
  okxAgg = { buy: 0, sell: 0, count: 0, lastPrice: okxAgg.lastPrice, start: Date.now(), vwapSum: 0, vwapVol: 0 };
  if(count===0) return;
  if(Math.abs(delta) < TRADE_MIN_OKX) return; // Noise, diemin
  let signal = delta>0 ? 'BUY' : 'SELL';
  let size = Math.abs(delta);
  let aggInfo = `Delta ${OKX_AGG_SEC}s: Buy ${fmtSize(buy)} - Sell ${fmtSize(sell)} = ${delta>0?'+':''}${fmtSize(delta)} (${count} trade)`;
  console.log('OKX DELTA LOLOS:', aggInfo);
  await emitSignal(signal, vwap||okxAgg.lastPrice, size, 'OKX XAU SWAP', { agg: aggInfo });
}
setInterval(flushOkxAgg, OKX_AGG_SEC*1000);

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

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - FUTURES PERP - Size Bybit '+TRADE_MIN+' Size OKX Delta '+TRADE_MIN_OKX));
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
    config: { trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, okx_agg_sec: OKX_AGG_SEC, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice||0, market: 'FUTURES PERP' },
    harga: { xaut: xautPrice, mt5: MT5.lastPrice||0, source: 'Recent Trade FUTURES Bybit PERP + OKX XAU SWAP Delta' },
    exchanges: { bybit_trade: wsTradeBybitOk?'WS-OK':'WS-OFF', okx_trade: wsTradeOkxOk?'WS-OK':'WS-OFF' },
    uptimeStart, uptime_menit: Math.floor((Date.now()-uptimeStart)/60000), last_update: lastUpdate,
  });
});
app.get('/api/config', (req,res)=>{ res.json({ trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, okx_agg_sec: OKX_AGG_SEC, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol }); });
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
app.get('/api/history', (req,res)=>{ res.json({ history: signalHistory, total: signalHistory.length, uptimeStart }); });
app.get('/api/test-telegram', async (req,res)=>{ let sid=generateSetupId(); await sendTelegram(`🎯 BUY NOW - Setup ${sid} (TRADE GEDE FUTURES)\n\nTrade: BUY 6200.000 XAUT @ $3636.50 - OKX XAU SWAP\nNilai: $22,546,300\nFilter: >= 5000.000 XAUT - LOLOS ✅\nAgregasi: Delta 5s: Buy 6200.000 - Sell 800.000 = +5400.000 (20 trade)\n\nEntry: $3636.50\nSL: $3631.50 (-50 pips)\nTP: $3641.50 (+50 pips)\n\nLayering ON.`); res.json({ok:true, setup_id:sid}); });
app.listen(PORT, ()=> console.log('ABEL BOT jalan di port '+PORT+' - FUTURES PERP - Size Bybit '+TRADE_MIN+' Size OKX Delta '+TRADE_MIN_OKX));
