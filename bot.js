// bot.js (ES module)
// Crypto signals bot using CryptoCompare + many indicators
// Manual commands + auto 15-min updates for last requested coin per-chat

import dotenv from "dotenv";
import axios from "axios";
import { Telegraf } from "telegraf";
import {
  EMA,
  SMA,
  RSI,
  MACD,
  BollingerBands,
  StochasticRSI,
  ADX,
  ATR,
  OBV,
} from "technicalindicators";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const AUTO_INTERVAL_MINUTES = 15; // auto update interval
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN missing in .env");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// map to store last requested { symbol, tf } per chat id
const lastRequested = new Map(); // chatId -> { symbol: 'ETH', tf: 60, tfLabel: '1H' }

// symbol list (use uppercase coin tickers for CryptoCompare)
const SYMBOLS = {
  BTC: "BTC",
  ETH: "ETH",
  LINK: "LINK",
  DOT: "DOT",
  SUI: "SUI",
};

// supported commands mapping: "/eth5m" => { symbol: "ETH", tf: 5, label: "5m" }
function buildCommands() {
  const cmds = {};
  const tfs = [
    { key: "5m", minutes: 5, label: "5m" },
    { key: "15m", minutes: 15, label: "15m" },
    { key: "1h", minutes: 60, label: "1H" },
  ];
  for (const [symKey, symVal] of Object.entries(SYMBOLS)) {
    for (const tf of tfs) {
      cmds[`/${symKey.toLowerCase()}${tf.key}`] = {
        symbol: symVal,
        tfMinutes: tf.minutes,
        tfLabel: tf.label,
      };
    }
  }
  return cmds;
}
const COMMANDS = buildCommands();

// ------------ CryptoCompare fetch helpers ------------
async function fetchCandles(symbol, tfMinutes, limit = 200) {
  // symbol e.g. 'ETH'
  try {
    let url;
    if (tfMinutes === 60) {
      url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=${limit}`;
    } else {
      // for 5m/15m use histominute with aggregate
      url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${tfMinutes}`;
    }
    const resp = await axios.get(url, { timeout: 15000 });
    if (!resp.data || !resp.data.Data || !resp.data.Data.Data) return null;
    // fields: time, open, high, low, close, volumefrom, volumeto
    return resp.data.Data.Data.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeto || c.volumefrom || 0,
    }));
  } catch (err) {
    console.log("Fetch candles error:", err.message || err.toString());
    return null;
  }
}

// fetch previous FULL DAY high/low via histoday (we'll take yesterday's high/low)
async function fetchPrevDayHighLow(symbol) {
  try {
    const resp = await axios.get(
      `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${symbol}&tsym=USDT&limit=2`
    ); // returns today & yesterday (if available)
    if (!resp.data || !resp.data.Data || !resp.data.Data.Data) return null;
    const arr = resp.data.Data.Data;
    // arr last is today (partial), arr[arr.length-2] is previous full day
    if (arr.length < 2) return null;
    const prev = arr[arr.length - 2];
    return { high: prev.high, low: prev.low };
  } catch (err) {
    console.log("Fetch prev day high/low error:", err.message || err.toString());
    return null;
  }
}

// ------------ Indicators calculation ------------
function safeLast(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}

function calcIndicatorsFromCandles(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // EMAs on price
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });

  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const sma9_rsi = SMA.calculate({ period: 9, values: rsiArr });
  const stochRsiArr = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });
  const obvArr = OBV.calculate({ close: closes, volume: volumes });
  const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const volEMA = EMA.calculate({ period: 20, values: volumes });

  return {
    price: safeLast(closes),
    ema9: safeLast(ema9),
    ema21: safeLast(ema21),
    ema50: safeLast(ema50),
    ema200: safeLast(ema200),
    bb: safeLast(bb), // object { lower, middle, upper }
    macd: safeLast(macd), // object { MACD, signal, histogram }
    rsi: safeLast(rsiArr),
    sma9_rsi: safeLast(sma9_rsi),
    stochRsi: safeLast(stochRsiArr), // object { k, d }
    obv: safeLast(obvArr),
    adx: safeLast(adxArr), // object { adx, pdi, mdi }
    atr: safeLast(atrArr),
    volEMA: safeLast(volEMA),
    raw: { closes, highs, lows, volumes },
  };
}

// ------------ Decision logic & message formatting ------------
function buildSignalMessage(symbol, tfLabel, ind, fibLevels) {
  const now = new Date();
  const price = ind.price ?? NaN;
  const formatNumber = (n, dp = 2) => (n == null || Number.isNaN(n) ? "n/a" : Number(n).toFixed(dp));

  // EMA-BB logic
  let emaBbLine = "";
  if (ind.ema9 != null && ind.ema21 != null && ind.bb != null) {
    if (ind.ema9 > ind.bb.middle && ind.ema21 > ind.bb.middle) {
      emaBbLine = "✅✅ Strong Bullish — EMA9 & EMA21 above BB middle";
    } else if (ind.ema9 > ind.bb.middle) {
      emaBbLine = "✅ Small Bullish — EMA9 above BB middle";
    } else if (ind.ema9 < ind.bb.middle && ind.ema21 > ind.bb.middle) {
      emaBbLine = "⚠️ Mixed — EMA9 below & EMA21 above BB middle";
    } else {
      emaBbLine = "❌ Bearish — EMA9 & EMA21 below BB middle";
    }
  } else emaBbLine = "⚪ Insufficient EMA/BB data";

  // Price vs bands
  let priceBandLine = "➖ Price inside bands";
  if (ind.bb) {
    if (price <= ind.bb.lower) priceBandLine = "🟢 Price touching LOWER band → Potential LONG";
    else if (price >= ind.bb.upper) priceBandLine = "🔴 Price touching UPPER band → Potential SHORT";
  }

  // MACD line
  let macdLine = "⚪ MACD data n/a";
  if (ind.macd) macdLine = ind.macd.MACD > ind.macd.signal ? "✅ MACD bullish crossover" : "❌ MACD bearish crossover";

  // RSI vs SMA9
  let rsiLine = "⚪ RSI data n/a";
  if (ind.rsi != null && ind.sma9_rsi != null) {
    if (ind.rsi > ind.sma9_rsi) rsiLine = `✅ RSI ${formatNumber(ind.rsi, 2)} above SMA9(${formatNumber(ind.sma9_rsi, 2)}) — bullish`;
    else rsiLine = `❌ RSI ${formatNumber(ind.rsi, 2)} below SMA9(${formatNumber(ind.sma9_rsi, 2)}) — bearish`;
  }

  // StochRSI
  let stochLine = "⚪ StochRSI n/a";
  if (ind.stochRsi && typeof ind.stochRsi.k === "number") {
    const k = ind.stochRsi.k;
    const d = ind.stochRsi.d;
    if (k < 20) stochLine = `✅ StochRSI oversold (k:${formatNumber(k, 2)}, d:${formatNumber(d, 2)}) — possible bounce`;
    else if (k > 80) stochLine = `❌ StochRSI overbought (k:${formatNumber(k, 2)}, d:${formatNumber(d, 2)}) — caution`;
    else stochLine = `⚪ StochRSI neutral (k:${formatNumber(k, 2)}, d:${formatNumber(d, 2)})`;
  }

  // ADX
  let adxLine = "⚪ ADX n/a";
  if (ind.adx && typeof ind.adx.adx === "number") {
    adxLine =
      ind.adx.adx > 25
        ? `✅ ADX ${formatNumber(ind.adx.adx, 2)} — Strong Trend`
        : `❌ ADX ${formatNumber(ind.adx.adx, 2)} — Weak Trend`;
  }

  // Volume & OBV
  let volLine = "⚪ Volume n/a";
  if (typeof ind.volEMA === "number" && typeof ind.raw.volumes !== "undefined") {
    const lastVol = ind.raw.volumes[ind.raw.volumes.length - 1];
    volLine = lastVol > ind.volEMA ? `✅ Volume increasing (VolEMA ${formatNumber(ind.volEMA, 0)})` : `❌ Volume weak (VolEMA ${formatNumber(ind.volEMA, 0)})`;
  }
  const obvLine = typeof ind.obv === "number" ? `OBV: ${formatNumber(ind.obv, 0)}` : "OBV n/a";

  // Fibonacci (0.618) from previous full-day high/low
  let fibLine = "Fibonacci n/a";
  if (fibLevels) {
    fibLine = `0.618: ${formatNumber(fibLevels["0.618"], 4)} (${price > fibLevels["0.618"] ? "✅ Above" : price < fibLevels["0.618"] ? "❌ Below" : "⚪ At"})`;
  }

  // ATR-based SL/TP
  let slTpLine = "ATR n/a";
  if (ind.atr) {
    // Use ATR multipliers for SL/TP (example multipliers)
    const sl = Number(price) - ind.atr * 1.5;
    const tp1 = Number(price) + ind.atr * 1.5;
    const tp2 = Number(price) + ind.atr * 3;
    slTpLine = `SL:${formatNumber(sl, 4)}  TP1:${formatNumber(tp1, 4)}  TP2:${formatNumber(tp2, 4)}  (ATR:${formatNumber(ind.atr, 6)})`;
  }

  // Determine trade bias summary (simple)
  let bias = "⚪ Neutral";
  const bullishVotes =
    (ind.ema9 > ind.ema21 ? 1 : 0) +
    (ind.macd && ind.macd.MACD > ind.macd.signal ? 1 : 0) +
    (ind.rsi > ind.sma9_rsi ? 1 : 0) +
    (ind.adx && ind.adx.adx > 25 ? 1 : 0) +
    (ind.raw && ind.raw.volumes[ind.raw.volumes.length - 1] > ind.volEMA ? 1 : 0);

  const bearishVotes =
    (ind.ema9 < ind.ema21 ? 1 : 0) +
    (ind.macd && ind.macd.MACD < ind.macd.signal ? 1 : 0) +
    (ind.rsi < ind.sma9_rsi ? 1 : 0) +
    (ind.adx && ind.adx.adx > 25 ? 0 : 0) +
    (ind.raw && ind.raw.volumes[ind.raw.volumes.length - 1] < ind.volEMA ? 1 : 0);

  if (bullishVotes >= 4) bias = "🟢 Strong Bullish";
  else if (bullishVotes >= 2) bias = "🟡 Mild Bullish";
  else if (bearishVotes >= 3) bias = "🔴 Bearish";
  else bias = "⚪ Neutral / Mixed";

  // Final formatted message (mobile-friendly)
  const lines = [
    `*${symbol}* (${tfLabel}) — ${bias}`,
    `Price: *${formatNumber(price, 6)}*`,
    ``,
    `*Signal details*`,
    `• EMA/Bollinger: ${emaBbLine}`,
    `• Price vs Bands: ${priceBandLine}`,
    `• MACD: ${macdLine}`,
    `• RSI+SMA9: ${rsiLine}`,
    `• StochRSI: ${stochLine}`,
    `• ADX: ${adxLine}`,
    `• Volume: ${volLine} | ${obvLine}`,
    `• Fibonacci(0.618): ${fibLine}`,
    `• ATR SL/TP: ${slTpLine}`,
    ``,
    `📅 ${now.toLocaleString()} (UTC ${-now.getTimezoneOffset() / 60})`,
    ``,
    `/btc5m /eth5m /link5m /dot5m /sui5m`,
    `/btc15m /eth15m /link15m /dot15m /sui15m`,
    `/btc1h /eth1h /link1h /dot1h /sui1h`,
  ];

  return lines.join("\n");
}

// ------------ Main command handler & auto logic ------------
bot.on("text", async (ctx) => {
  const txt = (ctx.message.text || "").trim().toLowerCase();
  if (!txt) return;

  // stop auto updates for this chat
  if (txt === "/stopauto") {
    lastRequested.delete(ctx.chat.id);
    await ctx.reply("Auto updates stopped for this chat.");
    return;
  }

  // start auto updates for this chat manually? we'll set it automatically when they ask a command
  // handle supported commands
  if (!COMMANDS[txt]) return; // ignore unknown text

  const { symbol, tfMinutes, tfLabel } = COMMANDS[txt];

  await ctx.replyWithMarkdown(`⏳ Fetching ${symbol} (${tfLabel}) — please wait...`);

  const candles = await fetchCandles(symbol, tfMinutes, 200);
  if (!candles || !candles.length) {
    await ctx.reply("❌ Failed to fetch candle data. Try again later.");
    return;
  }

  // prev day high/low for Fibonacci
  const prevDay = await fetchPrevDayHighLow(symbol);
  const fibLevels = prevDay
    ? (() => {
        const high = prevDay.high;
        const low = prevDay.low;
        const range = high - low;
        return {
          "0.0": high,
          "0.236": high - range * 0.236,
          "0.382": high - range * 0.382,
          "0.5": high - range * 0.5,
          "0.618": high - range * 0.618,
          "0.786": high - range * 0.786,
          "1.0": low,
        };
      })()
    : null;

  const indicators = calcIndicatorsFromCandles(candles);
  const message = buildSignalMessage(symbol, tfLabel, indicators, fibLevels);

  // reply now
  await ctx.replyWithMarkdown(message);

  // register chat for auto updates (user requested manual; set it as last requested)
  lastRequested.set(ctx.chat.id, { symbol, tfMinutes, tfLabel });
});

// Auto-sender: every AUTO_INTERVAL_MINUTES, send update to each chat with lastRequested entry
setInterval(async () => {
  if (!lastRequested.size) return;
  for (const [chatId, info] of lastRequested.entries()) {
    try {
      const candles = await fetchCandles(info.symbol, info.tfMinutes, 200);
      if (!candles || !candles.length) {
        // skip if failed
        continue;
      }
      const prevDay = await fetchPrevDayHighLow(info.symbol);
      const fibLevels = prevDay
        ? (() => {
            const high = prevDay.high;
            const low = prevDay.low;
            const range = high - low;
            return {
              "0.0": high,
              "0.236": high - range * 0.236,
              "0.382": high - range * 0.382,
              "0.5": high - range * 0.5,
              "0.618": high - range * 0.618,
              "0.786": high - range * 0.786,
              "1.0": low,
            };
          })()
        : null;
      const indicators = calcIndicatorsFromCandles(candles);
      const message = buildSignalMessage(info.symbol, info.tfLabel, indicators, fibLevels);
      await bot.telegram.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
      // don't crash; continue
      console.log("Auto send error:", err?.message || err);
    }
  }
}, AUTO_INTERVAL_MINUTES * 60 * 1000);

// helper: set bot commands list in Telegram UI (optional)
(async function setCommands() {
  try {
    const cmds = Object.keys(COMMANDS).map((c) => ({ command: c.replace("/", ""), description: "Get signal " + c }));
    await bot.telegram.setMyCommands(cmds);
  } catch (e) {
    /* ignore */
  }
})();

// start polling
bot.launch().then(() => console.log("Bot launched (polling)")).catch((e) => console.log("Launch error:", e));

// graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
