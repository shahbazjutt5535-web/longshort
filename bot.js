// bot.js
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

// EMA Crossover per timeframe
function getEmaCrossoverSignal(closes, timeframe, bbMid) {
  const ema9 = safeLast(EMA.calculate({ period: 9, values: closes }));
  const ema21 = safeLast(EMA.calculate({ period: 21, values: closes }));
  const ema50 = safeLast(EMA.calculate({ period: 50, values: closes }));
  const ema200 = safeLast(EMA.calculate({ period: 200, values: closes }));

  let emaCrossText = "";
  let trendText = "";
  let emaVsBBText = "";

  // EMA vs Middle Bollinger
  if (ema9 > bbMid && ema21 > bbMid) emaVsBBText = "EMA9 & EMA21 above BB mid ✅✅ Strong Bullish";
  else if (ema9 > bbMid && ema21 < bbMid) emaVsBBText = "EMA9 above BB mid & EMA21 below BB mid ✅ Small Bullish";

  // EMA Crossover logic per timeframe
  if (timeframe === "5m") {
    if (ema9 > ema21) { emaCrossText = "EMA9 > EMA21 ✅"; trendText = "Bullish 🚨"; }
    else { emaCrossText = "EMA9 < EMA21 ❌"; trendText = "Bearish 🚨"; }
  } else if (timeframe === "15m") {
    if (ema9 > ema21 && ema21 > ema50) { emaCrossText = "Strong Bullish ✅✅"; trendText = "Bullish 🚨"; }
    else if (ema9 > ema21 && ema21 < ema50) { emaCrossText = "Small Bullish ✅"; trendText = "Bullish 🚨"; }
    else if (ema9 < ema21 && ema21 > ema50) { emaCrossText = "Small Bearish ❌"; trendText = "Bearish 🚨"; }
    else if (ema9 < ema21 && ema21 < ema50) { emaCrossText = "Strong Bearish ❌❌"; trendText = "Bearish 🚨"; }
  } else if (timeframe === "1h") {
    if (ema50 > ema200) { emaCrossText = "EMA50 > EMA200 ✅"; trendText = "Bullish 🚨"; }
    else { emaCrossText = "EMA50 < EMA200 ❌"; trendText = "Bearish 🚨"; }
  }

  return { emaCrossText, trendText, emaVsBBText };
}

// Build Telegram message
function buildMessage({ symbol, timeframe, trendText, emaCrossText, priceVsEmaText, emaVsBBText, bb, price, bollMsg, macdText, rsiVal, rsiSignal, stochK, stochCondition, volObvText, adxText, tpSl }) {
  return [
    `🚨 ${symbol} (${timeframe.toUpperCase()})`,
    ``,
    `Trend: ${trendText}`,
    `EMA Crossover: ${emaCrossText}`,
    `EMA vs BB Mid: ${emaVsBBText}`,
    `EMA vs Price: ${priceVsEmaText}`,
    ``,
    `Bollinger Bands:`,
    `Price: ${price}`,
    `UP: ${bb.upper}`,
    `MB: ${bb.middle}`,
    `LB: ${bb.lower}`,
    `${bollMsg}`,
    ``,
    `MACD: ${macdText}`,
    `RSI(14): ${rsiVal} → ${rsiSignal}`,
    `Stoch RSI: ${stochK.toFixed(2)} → ${stochCondition}`,
    `${volObvText}`,
    `${adxText}`,
    ``,
    `Entry: ${tpSl.entry}`,
    `TP1: ${tpSl.tp1}`,
    `TP2: ${tpSl.tp2}`,
    `SL: ${tpSl.sl}`,
    ``,
    `Available commands: /eth5m /eth15m /eth1h /sol5m /sol15m /sol1h /link5m /link15m /link1h`
  ].join("\n");
}

// Compute signal
async function computeSignal(symbol, timeframe) {
  const fetchLimit = 200;
  const klines = await fetchKlines(symbol, timeframe, fetchLimit);
  if (!klines || klines.length === 0) throw new Error("No klines");

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const volumes = klines.map(k => k.volume);

  const price = +last(closes).toFixed(6);

  const bb = safeLast(BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })) || { upper: null, middle: null, lower: null };
  const macd = safeLast(MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes })) || { histogram: 0 };
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsiVal = +(safeLast(rsiArr) || 0).toFixed(2);
  const rsiSignal = rsiVal > 70 ? "Overbought 🔥" : rsiVal < 30 ? "Oversold ✅" : "Neutral";

  const stochLen = 14;
  const rsiSlice = rsiArr.slice(-stochLen);
  const rsiLow = Math.min(...rsiSlice);
  const rsiHigh = Math.max(...rsiSlice);
  const stochRaw = rsiHigh === rsiLow ? 0 : (rsiVal - rsiLow) / (rsiHigh - rsiLow);
  const stochK = +(stochRaw * 100).toFixed(2);
  const stochCondition = stochK < 20 ? "Oversold BUY" : stochK > 80 ? "Overbought SELL" : "Neutral";

  const volumeRising = volumes[volumes.length - 1] > volumes[volumes.length - 2];
  const obv = safeLast(OBV.calculate({ close: closes, volume: volumes })) || 0;
  const volObvText = volumeRising ? "Volume+OBV rising ✅" : "Volume+OBV falling ❌";

  const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const adxVal = safeLast(adxArr)?.adx || 0;
  const adxText = adxVal > 25 ? `ADX: ${adxVal.toFixed(2)} Strong ✅` : `ADX: ${adxVal.toFixed(2)} Weak ❌`;

  const priceVsEmaText = price > safeLast(EMA.calculate({ period: 9, values: closes })) ? "Price > EMA9 ✅" : "Price < EMA9 ❌";
  
  const { emaCrossText, trendText, emaVsBBText } = getEmaCrossoverSignal(closes, timeframe, bb.middle);

  // Custom TP/SL calculation (example: 0.5% / 1% move)
  let tpSl = {};
  if (trendText.includes("Bullish")) {
    tpSl.entry = price;
    tpSl.tp1 = +(price * 1.005).toFixed(6);
    tpSl.tp2 = +(price * 1.01).toFixed(6);
    tpSl.sl = +(price * 0.995).toFixed(6);
  } else {
    tpSl.entry = price;
    tpSl.tp1 = +(price * 0.995).toFixed(6);
    tpSl.tp2 = +(price * 0.99).toFixed(6);
    tpSl.sl = +(price * 1.005).toFixed(6);
  }

  const macdText = macd.histogram > 0 ? "Bullish ✅" : "Bearish ❌";
  
  return buildMessage({ symbol, timeframe, trendText, emaCrossText, priceVsEmaText, emaVsBBText, bb, price, bollMsg: "", macdText, rsiVal, rsiSignal, stochK, stochCondition, volObvText, adxText, tpSl });
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
