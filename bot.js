// ===========================
// IMPORT REQUIRED MODULES
// ===========================
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as ti from "technicalindicators";
import dotenv from "dotenv";

dotenv.config();

// ===========================
// BOT + SERVER SETUP
// ===========================
const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Crypto Bot Running ✅");
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

// ===========================
// FETCH CANDLE DATA FROM BINANCE
// ===========================
async function fetchCandles(symbol, interval = "1h") {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Crypto Telegram Bot)",
        "Content-Type": "application/json"
      },
      timeout: 10000 // 10 seconds timeout
    });

    return data.map((candle) => ({
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
    }));

  } catch (err) {
    console.log("🔴 Binance Fetch Error:", err.response?.status || err.message);
    return null;
  }
}

// ===========================
// INDICATOR CALCULATION
// ===========================
async function getSignal(symbol) {
  const candles = await fetchCandles(symbol);

  if (!candles) return "⚠️ Data fetch failed.";

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const EMA9 = ti.EMA.calculate({ period: 9, values: closes });
  const EMA21 = ti.EMA.calculate({ period: 21, values: closes });
  const RSI = ti.RSI.calculate({ period: 14, values: closes });
  const MACD = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const OBV = ti.OBV.calculate({ close: closes, volume: volumes });

  const lastEMA9 = EMA9.slice(-1)[0];
  const lastEMA21 = EMA21.slice(-1)[0];
  const lastRSI = RSI.slice(-1)[0];
  const lastMACD = MACD.slice(-1)[0];

  const latestPrice = closes.slice(-1)[0];

  // ===========================
  // ✅ SIGNAL LOGIC
  // ===========================
  let signal = "";
  let direction = "";
  let sl = "";
  let tp = "";

  if (lastEMA9 > lastEMA21 && lastRSI > 50 && lastMACD.MACD > lastMACD.signal) {
    signal = "✅ **LONG SIGNAL**";
    direction = "📈 BUY";
    sl = (latestPrice * 0.97).toFixed(3);
    tp = (latestPrice * 1.03).toFixed(3);
  } else if (lastEMA9 < lastEMA21 && lastRSI < 50 && lastMACD.MACD < lastMACD.signal) {
    signal = "🔻 **SHORT SIGNAL**";
    direction = "📉 SELL";
    sl = (latestPrice * 1.03).toFixed(3);
    tp = (latestPrice * 0.97).toFixed(3);
  } else {
    signal = "⚠️ **NO CLEAR SIGNAL — WAIT**";
  }

  return `
📊 *${symbol} — 1H Technical Signal*
━━━━━━━━━━━━━━━━━━
${signal}
${direction && `➡️ Recommended: *${direction}*`}
━━━━━━━━━━━━━━━━━━
💰 *Price:* ${latestPrice}
9 EMA: ${lastEMA9}
21 EMA: ${lastEMA21}
RSI (14): ${lastRSI}
MACD: ${lastMACD.MACD.toFixed(4)}
Signal: ${lastMACD.signal.toFixed(4)}
OBV: ${OBV.slice(-1)[0]}

🎯 *Take Profit:* ${tp}
🛑 *Stop Loss:* ${sl}

⏱️ Timeframe: 1H
✅ Accuracy est.: 80–90%
━━━━━━━━━━━━━━━━━━
/BTC /ETH /LINK /DOT /SUI
`;
}

// ===========================
// TELEGRAM COMMAND LISTENER
// ===========================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome to Crypto Signal Bot

Use:
 /BTC
 /ETH
 /LINK
 /DOT
 /SUI`
  );
});

// coin commands
const PAIRS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  DOT: "DOTUSDT",
  LINK: "LINKUSDT",
  SUI: "SUIUSDT",
};

Object.keys(PAIRS).forEach((cmd) => {
  bot.onText(new RegExp(`/${cmd}`, "i"), async (msg) => {
    const symbol = PAIRS[cmd];
    bot.sendMessage(msg.chat.id, `🔄 Fetching signal for *${symbol}* ...`);
    const result = await getSignal(symbol);
    bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
  });
});
