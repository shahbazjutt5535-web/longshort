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

// Custom TP/SL formula: uses recent high/low & volatility
function calcTP(price, highs, lows, trend) {
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const range = recentHigh - recentLow;
  if (trend === "bullish") {
    return {
      entry: price,
      tp1: +(price + range * 0.5).toFixed(2),
      tp2: +(price + range * 1).toFixed(2),
      sl: +(price - range * 0.5).toFixed(2),
    };
  } else {
    return {
      entry: price,
      tp1: +(price - range * 0.5).toFixed(2),
      tp2: +(price - range * 1).toFixed(2),
      sl: +(price + range * 0.5).toFixed(2),
    };
  }
}

// Build Telegram message
function buildMessage({
  symbol,
  timeframe,
  trend,
  entryPrice,
  tp1,
  tp2,
  sl,
  emaCross,
  priceVsEma,
  emaVsBB,
  bb,
  bollMsg,
  macdText,
  rsiVal,
  rsiSignal,
  rsiSmaText,
  volObvText,
  adxText,
  stochVal,
  stochCond,
  stochSign,
}) {
  return [
    `🚨 ${symbol} (${timeframe.toUpperCase()}) Signal`,
    ``,
    `Trend: ${trend}`,
    ``,
    `Entry Price: ${entryPrice}`,
    `TP1: ${tp1}`,
    `TP2: ${tp2}`,
    `SL: ${sl}`,
    ``,
    `EMA Crossover: ${emaCross}`,
    `EMA vs Price: ${priceVsEma}`,
    `EMA vs BB Mid: ${emaVsBB}`,
    ``,
    `Bollinger Bands:`,
    `Price: ${entryPrice}`,
    `Upper: ${bb.upper}`,
    `Middle: ${bb.middle}`,
    `Lower: ${bb.lower}`,
    `${bollMsg}`,
    ``,
    `${macdText}`,
    `RSI(14): ${rsiVal} → ${rsiSignal}`,
    `${rsiSmaText}`,
    `${volObvText}`,
    `${adxText}`,
    `Stoch RSI: ${stochVal} → ${stochCond} ${stochSign}`,
    ``,
    `Other Commands:`,
    `/eth5m  /eth15m  /eth1h`,
    `/sol5m  /sol15m  /sol1h`,
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
  const price = +last(closes).toFixed(2);

  const ema9 = safeLast(EMA.calculate({ period: 9, values: closes }));
  const ema21 = safeLast(EMA.calculate({ period: 21, values: closes }));
  const bb = safeLast(BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })) || { upper: null, middle: null, lower: null };
  const macd = safeLast(MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes })) || { histogram: 0 };
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsiVal = +(safeLast(rsiArr) || 0).toFixed(2);
  const rsiSmaVal = +(safeLast(SMA.calculate({ period: 5, values: rsiArr.length ? rsiArr : [rsiVal] })) || 0).toFixed(2);
  const obvArr = OBV.calculate({ close: closes, volume: volumes });
  const obv = safeLast(obvArr) || 0;

  let adxVal = null;
  try {
    const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const aobj = safeLast(adxArr);
    adxVal = aobj ? +(aobj.adx || aobj) : null;
  } catch (e) {
    adxVal = null;
  }

  // Stoch RSI
  const stochLen = 14;
  const rsiSlice = rsiArr.slice(-stochLen);
  const rsiLow = Math.min(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const rsiHigh = Math.max(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const stochVal = +(rsiHigh === rsiLow ? 0 : (rsiVal - rsiLow) / (rsiHigh - rsiLow)).toFixed(2);
  const stochCond = stochVal > 0.8 ? "Overbought" : stochVal < 0.2 ? "Oversold" : "Neutral";
  const stochSign = stochCond === "Overbought" ? "❌" : stochCond === "Oversold" ? "✅" : "⚪";

  // Trend logic
  const trend = ema9 > ema21 ? "Bullish 🚨" : "Bearish 🚨";
  const tpSl = calcTP(price, highs, lows, ema9 > ema21 ? "bullish" : "bearish");

  return buildMessage({
    symbol,
    timeframe,
    trend,
    entryPrice: tpSl.entry,
    tp1: tpSl.tp1,
    tp2: tpSl.tp2,
    sl: tpSl.sl,
    emaCross: ema9 > ema21 ? "EMA9 > EMA21 ✅" : "EMA9 < EMA21 ❌",
    priceVsEma: price > ema9 ? "Price > EMA9 ✅" : "Price < EMA9 ❌",
    emaVsBB: ema9 > bb.middle ? "EMA above BB mid ✅" : "EMA below BB mid ❌",
    bb: {
      upper: bb.upper ? bb.upper.toFixed(2) : "n/a",
      middle: bb.middle ? bb.middle.toFixed(2) : "n/a",
      lower: bb.lower ? bb.lower.toFixed(2) : "n/a",
    },
    bollMsg: price >= bb.upper ? "Near Upper BB ❌" : price <= bb.lower ? "Near Lower BB ✅" : "Near Middle BB",
    macdText: macd.histogram > 0 ? "MACD: Bullish ✅" : "MACD: Bearish ❌",
    rsiVal,
    rsiSignal: rsiVal > 70 ? "Overbought 🔥" : rsiVal < 30 ? "Oversold ❌" : "Neutral",
    rsiSmaText: rsiVal > rsiSmaVal ? "RSI > SMA5 ✅" : "RSI < SMA5 ❌",
    volObvText: volumes[volumes.length - 1] > volumes[volumes.length - 2] && obv > obvArr[obvArr.length - 2] ? "Volume+OBV rising ✅" : "Mixed Volume/OBV",
    adxText: adxVal !== null ? (adxVal > 25 ? `ADX: ${adxVal.toFixed(2)} Strong ✅` : `ADX: ${adxVal.toFixed(2)} Weak ❌`) : "ADX: n/a",
    stochVal,
    stochCond,
    stochSign,
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
