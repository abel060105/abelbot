// ABEL BOT - FUTURES PERP - FIX FILTER BEDA EXCHANGE
// BYBIT PERP: XAUTUSDT, min 3 XAUT | OKX XAU SWAP: XAU-USDT-SWAP, min 100 XAU
// KENAPA BEDA? OKX itu pasar institusi, 1 trade = 138 oz = $500k. Bybit itu retail, 1 trade = 0.08 oz = $320.
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

let TRADE_MIN = 3; // Buat BYBIT PERP
let TRADE_MIN_OKX = 100; // Buat OKX XAU SWAP - beda kelas, jangan disamain!
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
    {command:'trade',description:'Ganti min Bybit, misal /trade 3'},
    {command:'tradeokx',description:'Ganti min OKX, misal /tradeokx 100'},
    {command:'status',description:'Liat trade min sekarang'},
    {command:'help',description:'Liat command'},
  ];
  try{ await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commands})}); }catch(e){}
}
setMyCommands();

function statusText(){
  return `🤖 ABEL BOT\n\nTrade Min Bybit: ${TRADE_MIN} XAUT\nTrade Min OKX: ${TRADE_MIN_OKX} XAU\nSinyal Aktif: ${activeSignal ? activeSignal.signal+' '+activeSignal.size.toFixed(2)+' XAUT @ $'+activeSignal.price.toFixed(2)+' - '+activeSignal.source : 'WAIT - Belum ada trade gede'}\nXAUT: $${xautPrice?xautPrice.toFixed(2):'-'}\nMT5: ${MT5.connected?'Nyambung ✅':'Belum nyambung - RDP belum jalan'}\nTotal Sinyal Lolos: ${signalHistory.length}\n\nLayering: ON - Tanpa batas, tanpa cooldown\nBuy + Sell berlawanan tetep di-entry semua.`;
}

async function handleTelegramCommand(chatId, textRaw){
  let text=String(textRaw||'').trim();
  let cv=convo[chatId];
  if(cv && cv.step==='TRADE'){
    let v=parseNum(text);
    if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka bro, contoh: 3`); return; }
    TRADE_MIN=v; delete convo[chatId];
    await sendTelegramTo(chatId,`✅ Trade Min Bybit diganti ke ${v} XAUT\nOKX tetep ${TRADE_MIN_OKX} XAU.`);
    return;
  }
  if(cv && cv.step==='TRADEOKX'){
    let v=parseNum(text);
    if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Ketik angka bro, contoh: 100`); return; }
    TRADE_MIN_OKX=v; delete convo[chatId];
    await sendTelegramTo(chatId,`✅ Trade Min OKX diganti ke ${v} XAU\nBybit tetep ${TRADE_MIN} XAUT.`);
    return;
  }
  let m=text.match(/^\/?([a-z_]+)\s*(.*)$/i); if(!m) return;
  let cmd=m[1].toLowerCase(); let arg=(m[2]||'').trim();
  if(cmd==='start'){ await sendTelegramTo(chatId,statusText()+`\n\nCommand: /trade /tradeokx /status /help`); return; }
  if(cmd==='help'){ await sendTelegramTo(chatId,`📋 ABEL BOT\n\n/trade 3 - Ganti min Bybit (XAUT)\n/tradeokx 100 - Ganti min OKX (XAU)\n/status - Liat setting sekarang\n\nBybit = retail, 3 XAUT = $10k\nOKX = institusi, 100 XAU = $363k\nTanpa cooldown, tanpa batas, layering boleh.`); return; }
  if(cmd==='status'){ await sendTelegramTo(chatId,statusText()); return; }
  if(cmd==='trade'){
    if(!arg){ convo[chatId]={step:'TRADE'}; await sendTelegramTo(chatId,`Trade Min Bybit sekarang: ${TRADE_MIN} XAUT\n\nMau ganti ke berapa? Contoh: 3`); return; }
    let v=parseNum(arg); if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Contoh: /trade 3`); return; }
    TRADE_MIN=v;
    await sendTelegramTo(chatId,`✅ Trade Min Bybit diganti ke ${v} XAUT`);
    return;
  }
  if(cmd==='tradeokx'){
    if(!arg){ convo[chatId]={step:'TRADEOKX'}; await sendTelegramTo(chatId,`Trade Min OKX sekarang: ${TRADE_MIN_OKX} XAU\n\nMau ganti ke berapa? Contoh: 100`); return; }
    let v=parseNum(arg); if(isNaN(v)||v<=0){ await sendTelegramTo(chatId,`Contoh: /tradeokx 100`); return; }
    TRADE_MIN_OKX=v;
    await sendTelegramTo(chatId,`✅ Trade Min OKX diganti ke ${v} XAU`);
    return;
  }
  if(['jarak','size','betah','ratio'].includes(cmd)){ await sendTelegramTo(chatId,`Command /${cmd} udah dihapus bro. Sekarang cuma /trade dan /tradeokx.`); return; }
  await sendTelegramTo(chatId,`Command /${cmd} gak aktif. Yang aktif:\n/trade 3\n/tradeokx 100\n/status`);
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
async function handleTrade(source, price, size, side, tradeId, ts){
  if(!price||!size) return;
  xautPrice = price;
  let key = source+'-'+tradeId;
  if(seenTradeIds.has(key)) return;
  seenTradeIds.add(key);
  if(seenTradeIds.size>5000){ seenTradeIds.clear(); }
  let t = { id: tradeId, price, size, side: side==='BUY'?'BUY':'SELL', source, time: ts||Date.now(), time_str: fmtWIB(ts||Date.now()) };
  if(source==='BYBIT PERP') pushTrade(recentTradesBybit, t);
  else pushTrade(recentTradesOkx, t);

  // FILTER BEDA PER EXCHANGE - INI KUNCINYA
  let minForThis = source==='BYBIT PERP' ? TRADE_MIN : TRADE_MIN_OKX;
  if(size < minForThis) return;

  let setupId = generateSetupId();
  let signal = side==='BUY' ? 'BUY' : 'SELL';
  let sl = signal==='BUY' ? price - (SL_PIPS/10) : price + (SL_PIPS/10);
  let tp = signal==='BUY' ? price + (TP_PIPS/10) : price - (TP_PIPS/10);
  activeSignal = { setup_id: setupId, signal, price, size, source, time: t.time, time_str: t.time_str, sl, tp, sl_pips: SL_PIPS, tp_pips: TP_PIPS, trade_min_used: minForThis };
  let hist = { ...activeSignal, created_at: t.time };
  signalHistory.unshift(hist);
  if(signalHistory.length>200) signalHistory=signalHistory.slice(0,200);
  lastUpdate = Date.now();
  let usdValue = (size*price).toLocaleString('en-US',{maximumFractionDigits:0});
  await sendTelegram(`🎯 ${signal} NOW - Setup ${setupId} (TRADE GEDE FUTURES)\n\nTrade: ${side} ${size.toFixed(2)} XAUT @ $${price.toFixed(2)} - ${source}\nNilai: $${usdValue}\nJam: ${t.time_str} WIB\nFilter: >= ${minForThis} XAUT - LOLOS ✅\n\nEntry: $${price.toFixed(2)}\nSL: $${sl.toFixed(2)} (-${SL_PIPS} pips)\nTP: $${tp.toFixed(2)} (+${TP_PIPS} pips)\n\nLayering ON - Entry aja, risk kecil.\nHOLD BAGI YANG MAMPU🔥`);
}

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
            handleTrade('BYBIT PERP', parseFloat(d.p), parseFloat(d.v), side, d.i, parseInt(d.T));
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
            handleTrade('OKX XAU SWAP', parseFloat(d.px), parseFloat(d.sz), side, d.tradeId, parseInt(d.ts));
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

app.get('/', (req,res)=> res.send('ABEL BOT OK - /api/signal - FUTURES PERP - Bybit Min '+TRADE_MIN+' OKX Min '+TRADE_MIN_OKX));
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
    config: { trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol, isCent: CFG.isCent, mt5_connected: MT5.connected, mt5_price: MT5.lastPrice||0, market: 'FUTURES PERP' },
    harga: { xaut: xautPrice, mt5: MT5.lastPrice||0, source: 'Recent Trade FUTURES Bybit PERP + OKX XAU SWAP' },
    exchanges: { bybit_trade: wsTradeBybitOk?'WS-OK':'WS-OFF', okx_trade: wsTradeOkxOk?'WS-OK':'WS-OFF' },
    uptimeStart, uptime_menit: Math.floor((Date.now()-uptimeStart)/60000), last_update: lastUpdate,
  });
});
app.get('/api/config', (req,res)=>{ res.json({ trade_min: TRADE_MIN, trade_min_okx: TRADE_MIN_OKX, sl_pips: SL_PIPS, tp_pips: TP_PIPS, lot: CFG.lot, simbol: CFG.simbol }); });
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
app.get('/api/test-telegram', async (req,res)=>{ let sid=generateSetupId(); await sendTelegram(`🎯 BUY NOW - Setup ${sid} (TRADE GEDE FUTURES)\n\nTrade: BUY 150.00 XAUT @ $3637.20 - OKX XAU SWAP\nNilai: $545,580\nFilter: >= ${TRADE_MIN_OKX} XAUT - LOLOS ✅\n\nEntry: $3637.20\nSL: $3632.20 (-50 pips)\nTP: $3642.20 (+50 pips)\n\nLayering ON.`); res.json({ok:true, setup_id:sid}); });
app.listen(PORT, ()=> console.log('ABEL BOT jalan di port '+PORT+' - FUTURES PERP - Bybit Min '+TRADE_MIN+' OKX Min '+TRADE_MIN_OKX));
