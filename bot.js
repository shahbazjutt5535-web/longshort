// bot.js
// ES module style
import axios from "axios";
import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { EMA, RSI, SMA, MACD, BollingerBands, ADX, ATR, OBV } from "technicalindicators";

dotenv.config();

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// Token mapping
const SYMBOLS = {
  eth: process.env.ETH_SYMBOL || "ETH",
  sol: process.env.SOL_SYMBOL || "SOL",
  link: process.env.LINK_SYMBOL || "LINK",
};

// Fetch klines from CryptoCompare
async function fetchKlines(symbol, timeframe, limit = 200) {
  let url = "";
  if (timeframe === "1h") {
    url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=${limit}`;
  } else {
    const aggr = timeframe.replace("m", "");
    url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${aggr}`;
  }
  const res = await axios.get(url, { timeout: 10000 });
  return res.data.Data.Data.map((row) => ({
    openTime: row.time * 1000,
    open: parseFloat(row.open),
    high: parseFloat(row.high),
    low: parseFloat(row.low),
    close: parseFloat(row.close),
    volume: parseFloat(row.volumeto),
  }));
}

function last(arr, n = 1) {
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - n];
}

function safeLast(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[arr.length - 1];
}

// Fibonacci levels
function fibLevels(highs, lows, lookback = 100) {
  const sliceH = highs.slice(-lookback);
  const sliceL = lows.slice(-lookback);
  const swingHigh = Math.max(...sliceH);
  const swingLow = Math.min(...sliceL);
  const range = swingHigh - swingLow || 1;
  return {
    swingHigh,
    swingLow,
    fib382: +(swingLow + range * 0.382).toFixed(6),
    fib618: +(swingLow + range * 0.618).toFixed(6),
  };
}

// Build Telegram message
function buildMessage({
  symbol,
  timeframe,
  trendText,
  emaCrossText,
  priceVsEmaText,
  emaVsBBText,
  bb,
  price,
  bollMsg,
  macdText,
  rsiVal,
  rsiSignal,
  rsiSmaText,
  volObvText,
  adxText,
  stochVal,
  stochText,
  tpSlLong,
  tpSlShort,
  fib,
}) {
  let tpSection = "";
  if (trendText.includes("Bullish")) {
    tpSection = [
      `Entry Price: ${price}`,
      `TP1 (Next Resistance 1): ${tpSlLong.tp1}`,
      `TP2 (Next Resistance 2): ${tpSlLong.tp2}`,
      `SL: ${tpSlLong.sl}`,
    ].join("\n");
  } else if (trendText.includes("Bearish")) {
    tpSection = [
      `Entry Price: ${price}`,
      `Support TP1: ${tpSlShort.tp1}`,
      `Support TP2: ${tpSlShort.tp2}`,
      `SL: ${tpSlShort.sl}`,
    ].join("\n");
  }

  return [
    `🚨 ${symbol} (${timeframe.toUpperCase()})`,
    ``,
    `Trend: ${trendText}`,
    `EMA Crossover: ${emaCrossText}`,
    `EMA vs Price: ${priceVsEmaText}`,
    `EMA vs BB Mid: ${emaVsBBText}`,
    ``,
    `Bollinger Bands:`,
    `Price: ${price}`,
    `UP: ${bb.upper}`,
    `MB: ${bb.middle}`,
    `LB: ${bb.lower}`,
    `${bollMsg}`,
    ``,
    `${macdText}`,
    `RSI(14): ${rsiVal} → ${rsiSignal}`,
    `${rsiSmaText}`,
    `${volObvText}`,
    `${adxText}`,
    `Stoch RSI: ${stochVal} → ${stochText}`,
    ``,
    `Fibonacci Levels:`,
    `Fib 0.382: ${fib.fib382}`,
    `Fib 0.618: ${fib.fib618}`,
    ``,
    `${tpSection}`,
    ``,
    `Commands:`,
    `/eth5m /eth15m /eth1h`,
    `/sol5m /sol15m /sol1h`,
    `/link5m /link15m /link1h`,
  ].join("\n");
}

// Compute signal
async function computeSignal(symbol, timeframe) {
  const fetchLimit = 200;
  const klines = await fetchKlines(symbol, timeframe, fetchLimit);
  if (!klines || klines.length === 0) throw new Error("No klines");

  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const volumes = klines.map((k) => k.volume);

  const price = +last(closes).toFixed(6);

  // EMA
  const ema9 = safeLast(EMA.calculate({ period: 9, values: closes }));
  const ema21 = safeLast(EMA.calculate({ period: 21, values: closes }));
  const ema50 = safeLast(EMA.calculate({ period: 50, values: closes }));
  const ema200 = safeLast(EMA.calculate({ period: 200, values: closes }));

  // Bollinger
  const bb = safeLast(BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })) || { upper: null, middle: null, lower: null };

  // MACD
  const macd = safeLast(MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes })) || { histogram: 0 };

  // RSI & SMA9
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsiVal = +(safeLast(rsiArr) || 0).toFixed(2);
  const rsiSmaVal = +(safeLast(SMA.calculate({ period: 9, values: rsiArr.length ? rsiArr : [rsiVal] })) || 0).toFixed(2);
  const rsiSignal = rsiVal > 76 ? "OVERBOUGHT 🔥" : rsiVal > 70 ? "Extreme Strong ✅✅" : rsiVal > 55 ? "Bullish ✅" : rsiVal < 50 ? "Bearish ❌" : "Neutral";
  const rsiSmaText = rsiVal > rsiSmaVal ? "RSI > SMA9 ✅" : "RSI < SMA9 ❌";

  // OBV & ADX
  const obvArr = OBV.calculate({ close: closes, volume: volumes });
  const obv = safeLast(obvArr) || 0;
  const volumeRising = volumes[volumes.length - 1] > volumes[volumes.length - 2];
  const obvRising = obvArr && obvArr.length >= 2 ? obv > obvArr[obvArr.length - 2] : true;
  const volObvText = volumeRising && obvRising ? "Volume+OBV rising ✅" : !volumeRising && !obvRising ? "Volume+OBV falling ❌" : "Mixed Volume/OBV";

  let adxVal = null;
  try {
    const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const aobj = safeLast(adxArr);
    adxVal = aobj ? +(aobj.adx || aobj) : null;
  } catch (e) {
    adxVal = null;
  }
  const adxText = adxVal !== null ? (adxVal > 25 ? `ADX: ${adxVal.toFixed(2)} Strong ✅` : `ADX: ${adxVal.toFixed(2)} Weak ❌`) : "ADX: n/a";

  // ATR
  const atr = +(safeLast(ATR.calculate({ high: highs, low: lows, close: closes, period: 14 })) || 0).toFixed(6);

  // Stoch RSI
  const stochLen = 14;
  const rsiSlice = rsiArr.slice(-stochLen);
  const rsiLow = Math.min(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const rsiHigh = Math.max(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const stochRaw = rsiHigh === rsiLow ? 0 : (rsiVal - rsiLow) / (rsiHigh - rsiLow);
  const stochVal = +(stochRaw * 100).toFixed(2);
  const stochText = stochRaw < 0.2 ? "Oversold BUY" : stochRaw > 0.8 ? "Overbought SELL" : "Neutral";

  // Bollinger message
  const bollMsg = price >= bb.upper ? "Near Upper BB ❌" : price <= bb.lower ? "Near Lower BB ✅" : "Near Middle BB";

  // EMA vs BB middle
  let emaVsBBText = "";
  if (ema9 > bb.middle && ema21 > bb.middle) emaVsBBText = "Strong Bullish ✅✅";
  else if (ema9 > bb.middle && ema21 < bb.middle) emaVsBBText = "Small Bullish ✅";
  else emaVsBBText = "Neutral / Bearish ❌";

  // EMA crossover logic per timeframe
  let emaCrossText = "";
  let trendText = "";
  if (timeframe === "5m") {
    emaCrossText = ema9 > ema21 ? "EMA9 > EMA21 ✅" : "EMA9 < EMA21 ❌";
    trendText = ema9 > ema21 ? "Bullish 🚨" : "Bearish 🚨";
  } else if (timeframe === "15m") {
    if (ema9 > ema21 && ema21 > ema50) {
      emaCrossText = "Strong Bullish ✅✅";
      trendText = "Bullish 🚨";
    } else if (ema9 > ema21 && ema21 < ema50) {
      emaCrossText = "Small Bullish ✅";
      trendText = "Bullish 🚨";
    } else if (ema9 < ema21 && ema21 > ema50) {
      emaCrossText = "Small Bearish ❌";
      trendText = "Bearish 🚨";
    } else if (ema9 < ema21 && ema21 < ema50) {
      emaCrossText = "Strong Bearish ❌❌";
      trendText = "Bearish 🚨";
    } else {
      emaCrossText = "Neutral EMA";
      trendText = "Neutral";
    }
  } else if (timeframe === "1h") {
    emaCrossText = ema50 > ema200 ? "EMA50 > EMA200 ✅" : "EMA50 < EMA200 ❌";
    trendText = ema50 > ema200 ? "Bullish 🚨" : "Bearish 🚨";
  }

  // TP/SL Custom formula: next resistance/support based on recent range
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const tpSlLong = { tp1: +(price + (recentHigh - price) * 0.5).toFixed(6), tp2: +(price + (recentHigh - price) * 0.8).toFixed(6), sl: +(recentLow).toFixed(6) };
  const tpSlShort = { tp1: +(price - (price - recentLow) * 0.5).toFixed(6), tp2: +(price - (price - recentLow) * 0.8).toFixed(6), sl: +(recentHigh).toFixed(6) };

  // Fibonacci
  const fib = fibLevels(highs, lows, Math.min(200, closes.length));

  return buildMessage({
    symbol,
    timeframe,
    trendText,
    emaCrossText,
    priceVsEmaText: price > ema9 ? "Price > EMA9 ✅" : "Price < EMA9 ❌",
    emaVsBBText,
    bb,
    price,
    bollMsg,
    macdText: macd.histogram > 0 ? "MACD Bullish ✅" : "MACD Bearish ❌",
    rsiVal,
    rsiSignal,
    rsiSmaText,
    volObvText,
    adxText,
    stochVal,
    stochText,
    tpSlLong,
    tpSlShort,
    fib,
  });
}

// Telegram command handlers
function registerCommands() {
  const tokens = Object.keys(SYMBOLS);
  tokens.forEach((tk) => {
    ["5m", "15m", "1h"].forEach((tf) => {
      const cmd = `/${tk}${tf}`;
      bot.onText(new RegExp(`^\\${cmd}$`, "i"), async (msg) => {
        const chatId = msg.chat.id;
        try {
          await bot.sendMessage(chatId, `Working on ${tk.toUpperCase()} ${tf} signal...`);
          const message = await computeSignal(SYMBOLS[tk], tf);
          await bot.sendMessage(chatId, message);
        } catch (err) {
          console.error(err);
          await bot.sendMessage(chatId, `Error computing signal: ${err.message}`);
        }
      });
    });
  });
}

// webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const { symbol, timeframe } = req.body;
    if (!symbol || !timeframe) return res.status(400).json({ error: "symbol & timeframe required" });
    const message = await computeSignal(symbol, timeframe);
    if (process.env.ADMIN_CHAT_ID) {
      await bot.sendMessage(process.env.ADMIN_CHAT_ID, message);
    }
    return res.status(200).json({ ok: true, message: "Signal generated" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  registerCommands();
});
