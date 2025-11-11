// bot.js
import axios from "axios";
import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import {
  EMA,
  RSI,
  SMA,
  MACD,
  BollingerBands,
  ADX,
  ATR,
  OBV,
} from "technicalindicators";

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

// Utilities
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

// Optional Advanced Indicators
function calculateVWAP(klines) {
  const cumPV = [];
  const cumVolume = [];
  let pvSum = 0;
  let volSum = 0;
  klines.forEach((k) => {
    const typicalPrice = (k.high + k.low + k.close) / 3;
    pvSum += typicalPrice * k.volume;
    volSum += k.volume;
    cumPV.push(pvSum / volSum);
    cumVolume.push(volSum);
  });
  return last(cumPV);
}

// SuperTrend calculation (simplified)
function calculateSuperTrend(klines, period = 10, multiplier = 3) {
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const closes = klines.map((k) => k.close);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period });
  if (!atrArr || atrArr.length === 0) return null;

  const finalUpper = [];
  const finalLower = [];
  const trend = [];
  for (let i = 0; i < atrArr.length; i++) {
    const hl2 = (highs[i + period] + lows[i + period]) / 2;
    finalUpper.push(hl2 + multiplier * atrArr[i]);
    finalLower.push(hl2 - multiplier * atrArr[i]);
    if (i === 0) trend.push(closes[period] > finalUpper[i] ? "bull" : "bear");
    else trend.push(closes[i + period] > finalUpper[i] ? "bull" : "bear");
  }
  return last(trend);
}

// Build Telegram message
function buildMessage(params) {
  const {
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
    stochText,
    stochVal,
    stochTrendText,
    tpSlLong,
    tpSlShort,
    fibLevelsMsg,
    optionalIndicators,
  } = params;

  let msg = [
    `🚨 ${symbol} (${timeframe.toUpperCase()})`,
    ``,
    `Trend: ${trendText}`,
    ``,
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
    `Stoch RSI: ${stochVal} → ${stochText} (${stochTrendText})`,
    ``,
    `Fibonacci Levels:`,
    `Fib 0.382: ${fibLevelsMsg.fib382}`,
    `Fib 0.618: ${fibLevelsMsg.fib618}`,
    ``,
    `Entry Price: ${price}`,
  ];

  if (trendText.toLowerCase().includes("bull")) {
    msg.push(
      `Target TP1: ${tpSlLong.tp1}`,
      `Target TP2: ${tpSlLong.tp2}`,
      `Stop Loss: ${tpSlLong.sl}`
    );
  } else {
    msg.push(
      `Support TP1: ${tpSlShort.tp1}`,
      `Support TP2: ${tpSlShort.tp2}`,
      `Stop Loss: ${tpSlShort.sl}`
    );
  }

  // Optional indicators
  if (optionalIndicators && optionalIndicators.length > 0) {
    msg.push(`\nOptional Indicators:`);
    optionalIndicators.forEach((ind) => {
      msg.push(`${ind.name}: ${ind.value}`);
    });
  }

  msg.push(
    ``,
    `Commands:`,
    `/eth5m /eth15m /eth1h`,
    `/sol5m /sol15m /sol1h`,
    `/link5m /link15m /link1h`
  );

  return msg.join("\n");
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
  const bb =
    safeLast(
      BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })
    ) || { upper: null, middle: null, lower: null };

  // MACD
  const macd =
    safeLast(MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes })) ||
    { histogram: 0 };

  // RSI & SMA
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsiVal = +(safeLast(rsiArr) || 0).toFixed(2);
  const rsiSmaVal = +(safeLast(SMA.calculate({ period: 9, values: rsiArr.length ? rsiArr : [rsiVal] })) || 0).toFixed(2);

  // OBV
  const obv = safeLast(OBV.calculate({ close: closes, volume: volumes })) || 0;

  // ADX
  let adxVal = null;
  try {
    const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const aobj = safeLast(adxArr);
    adxVal = aobj ? +(aobj.adx || aobj) : null;
  } catch (e) {
    adxVal = null;
  }

  // ATR
  const atr = +(safeLast(ATR.calculate({ high: highs, low: lows, close: closes, period: 14 })) || 0).toFixed(6);

  // Stoch RSI
  const stochLen = 14;
  const rsiSlice = rsiArr.slice(-stochLen);
  const rsiLow = Math.min(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const rsiHigh = Math.max(...(rsiSlice.length ? rsiSlice : [rsiVal]));
  const stochRaw = rsiHigh === rsiLow ? 0 : (rsiVal - rsiLow) / (rsiHigh - rsiLow);
  const stochK = +(stochRaw * 100).toFixed(2);
  const stochText = stochK < 20 ? "Oversold BUY" : stochK > 80 ? "Overbought SELL" : "Neutral";

  // EMA Crossover logic based on timeframe
  let emaCrossText = "";
  let trendText = "";
  if (timeframe === "5m") {
    emaCrossText = ema9 > ema21 ? "Bullish ✅" : "Bearish ❌";
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
    } else {
      emaCrossText = "Strong Bearish ❌❌";
      trendText = "Bearish 🚨";
    }
  } else if (timeframe === "1h") {
    emaCrossText = ema50 > ema200 ? "Bullish ✅" : "Bearish ❌";
    trendText = ema50 > ema200 ? "Bullish 🚨" : "Bearish 🚨";
  }

  // EMA vs BB Mid
  let emaVsBBText = "";
  if (ema9 > bb.middle && ema21 > bb.middle) emaVsBBText = "Strong Bullish ✅✅";
  else if (ema9 > bb.middle && ema21 < bb.middle) emaVsBBText = "Small Bullish ✅";
  else if (ema9 < bb.middle && ema21 < bb.middle) emaVsBBText = "Bearish ❌";
  else emaVsBBText = "Neutral";

  // Price vs EMA9
  const priceVsEmaText = price > ema9 ? "Price > EMA9 ✅" : "Price < EMA9 ❌";

  // Bollinger message
  const bollMsg =
    price >= bb.upper
      ? "Near Upper BB ❌"
      : price <= bb.lower
      ? "Near Lower BB ✅"
      : "Near Middle BB";

  // MACD message
  const macdText = macd.histogram > 0 ? "MACD Bullish ✅" : "MACD Bearish ❌";

  // RSI Signal
  let rsiSignal =
    rsiVal > 76
      ? "OVERBOUGHT 🔥"
      : rsiVal > 70
      ? "Extreme Strong ✅✅"
      : rsiVal > 55
      ? "Bullish ✅"
      : rsiVal < 50
      ? "Bearish ❌"
      : "Neutral";
  const rsiSmaText = rsiVal > rsiSmaVal ? "RSI > SMA9 ✅" : "RSI < SMA9 ❌";

  const volObvText = "Mixed Volume/OBV";
  const adxText =
    adxVal !== null
      ? adxVal > 25
        ? `ADX: ${adxVal.toFixed(2)} Strong ✅`
        : `ADX: ${adxVal.toFixed(2)} Weak ❌`
      : `ADX: n/a`;

  // TP/SL (Optional formula based on recent swings)
  const tpSlLong = { tp1: +(price * 1.004).toFixed(6), tp2: +(price * 1.008).toFixed(6), sl: +(price * 0.995).toFixed(6) };
  const tpSlShort = { tp1: +(price * 0.996).toFixed(6), tp2: +(price * 0.992).toFixed(6), sl: +(price * 1.005).toFixed(6) };

  const fibLevelsMsg = fibLevels(highs, lows, Math.min(200, closes.length));

  // Optional indicators
  const optionalIndicators = [
    { name: "VWAP", value: calculateVWAP(klines) },
    { name: "SuperTrend", value: calculateSuperTrend(klines) },
  ];

  return buildMessage({
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
    stochText,
    stochVal: stochK,
    stochTrendText: stochText,
    tpSlLong,
    tpSlShort,
    fibLevelsMsg,
    optionalIndicators,
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
