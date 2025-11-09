// ✅ Fresh bot.js with RSI14 smoothed with SMA9 and requested Telegram output format

import axios from 'axios';
import express from 'express';
import dotenv from 'dotenv';
import { RSI, SMA, EMA, MACD, BollingerBands, ADX, ATR } from 'technicalindicators';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

const app = express();
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const SYMBOLS = ['BTC','ETH','LINK','DOT','SUI','XRP'];
const TIMEFRAMES = ['5m','15m','1h'];
const LIMIT = 100;

async function getCryptoData(symbol, timeframe, limit=LIMIT){
  let url = '';
  if(timeframe === '1h'){
    url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=${limit}`;
  } else {
    const aggr = timeframe.replace('m','');
    url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${aggr}`;
  }
  try{
    const res = await axios.get(url);
    if(!res.data.Data || !res.data.Data.Data) return [];
    return res.data.Data.Data.map(c=>({open:c.open,high:c.high,low:c.low,close:c.close,vol:c.volumefrom}));
  }catch(e){
    console.log(`❌ Failed to fetch CryptoCompare API: ${e.message}`);
    return [];
  }
}

async function calculateSignal(symbol,timeframe){
  const candles = await getCryptoData(symbol,timeframe);
  if(!candles.length) return `❌ No data for ${symbol} ${timeframe}`;

  const closes = candles.map(c=>c.close);
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const vols = candles.map(c=>c.vol);
  const lastPrice = closes[closes.length-1];

  const ema9 = EMA.calculate({period:9,values:closes});
  const ema21 = EMA.calculate({period:21,values:closes});
  const macd = MACD.calculate({values:closes,fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false});
  const rsi14 = RSI.calculate({period:14,values:closes});
  const rsiSMA9 = SMA.calculate({period:9,values:rsi14}); // Smoothed RSI
  const bb = BollingerBands.calculate({period:20,values:closes,stdDev:2});
  const adx = ADX.calculate({high:highs,low:lows,close:closes,period:14});
  const atr = ATR.calculate({high:highs,low:lows,close:closes,period:14});

  const lastEMA9 = ema9[ema9.length-1];
  const lastEMA21 = ema21[ema21.length-1];
  const lastBB = bb[bb.length-1];
  const lastADX = adx[adx.length-1] ? adx[adx.length-1].adx : 0;
  const lastATR = atr[atr.length-1];
  const lastRSI = rsi14[rsi14.length-1];
  const lastRSISMA9 = rsiSMA9[rsiSMA9.length-1] || lastRSI;

  // EMA Signals
  const emaCrossSignal = lastEMA9 > lastEMA21 ? '✅ Bullish' : '❌ Bearish';
  let emaBBSignal = '';
  if(lastEMA9 > lastBB.middle && lastEMA21 > lastBB.middle) emaBBSignal='✅✅ Strong Bullish';
  else if(lastEMA9 > lastBB.middle && lastEMA21 < lastBB.middle) emaBBSignal='✅ Small Bullish';
  else if(lastEMA9 < lastBB.middle && lastEMA21 > lastBB.middle) emaBBSignal='❌ Mixed/Bearish';
  else emaBBSignal='❌ Strong Bearish';

  // RSI+SMA9 signal using smoothed RSI
  const rsiSignal = lastRSI > lastRSISMA9 
      ? `✅ RSI Bullish (${lastRSI.toFixed(2)} > SMA9 ${lastRSISMA9.toFixed(2)})` 
      : `❌ RSI Bearish (${lastRSI.toFixed(2)} < SMA9 ${lastRSISMA9.toFixed(2)})`;

  const adxSignal = lastADX > 25 ? `✅ Trend Strong (${lastADX.toFixed(2)})` : `❌ Weak Trend (${lastADX.toFixed(2)})`;
  const volSignal = vols[vols.length-1] > vols[vols.length-2] ? `✅ Increasing (OBV rising)` : `❌ Decreasing (OBV falling)`;

  const entry = lastPrice;
  const sl = entry - lastATR;
  const tp1 = entry + lastATR*1.5;
  const tp2 = entry + lastATR*3;

  const dayHigh = Math.max(...highs);
  const dayLow = Math.min(...lows);

  const message = `
${symbol.toUpperCase()} (${timeframe.toUpperCase()}) 🚨 ${lastEMA9>lastEMA21?'LONG':'SHORT'} SIGNAL

📊 Trend: ${lastEMA9>lastEMA21?'Bullish':'Bearish'}

EMA 9/21 Crossover: ${emaCrossSignal}
EMA 9 & 21 vs Middle Bollinger: ${emaBBSignal}

Bollinger Bands: Price at ${lastPrice>lastBB.upper?'Upper':'Lower'} band ${lastPrice>lastBB.upper?'(might be price drop now)':'(might be now price go up)'}
MACD: ${macd[macd.length-1].histogram>0?'✅ Bullish':'❌ Bearish'}
RSI: ${lastRSI.toFixed(2)}
RSI+SMA: ${rsiSignal}
ADX: ${adxSignal}
Volume: ${volSignal}

Price: ${lastPrice.toFixed(2)}
🎯 Entry Zone: ${entry.toFixed(2)}
SL (ATR-based): ${sl.toFixed(2)}
TP1: ${tp1.toFixed(2)}
TP2: ${tp2.toFixed(2)}

🟢 ${lastEMA9>lastEMA21?'Long':'Short'} Bias

Commands: /BTC5m /BTC15m /BTC1h /ETH5m /ETH15m /ETH1h /LINK5m /LINK15m /LINK1h /DOT5m /DOT15m /DOT1h /SUI5m /SUI15m /SUI1h /XRP5m /XRP15m /XRP1h
`;

  return message;
}

bot.onText(/\/(BTC|ETH|LINK|DOT|SUI|XRP)(5m|15m|1h)?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();
  const timeframe = match[2] || '1h';
  const signal = await calculateSignal(symbol, timeframe);
  bot.sendMessage(chatId, signal);
});

app.get('/', (req,res)=>{res.send('Crypto Signal Bot is Running ✅');});
app.listen(PORT,()=>console.log(`🚀 Bot running on port ${PORT}`));
