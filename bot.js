import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as ti from "technicalindicators";
import dotenv from "dotenv";

dotenv.config();

// =================== CONFIG ===================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !WEBHOOK_URL) {
  console.error("❌ TELEGRAM_TOKEN or WEBHOOK_URL missing!");
  process.exit(1);
}

// =================== INIT BOT ===================
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Crypto Bot Running ✅"));
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

// =================== SYMBOL MAPPING ===================
const PAIRS = {
  BTC: "BTC",
  ETH: "ETH",
  DOT: "DOT",
  LINK: "LINK",
  SUI: "SUI"
};

// =================== TIMEFRAME MAPPING ===================
const INTERVAL_MAP = {
  "5m": 5,
  "15m": 15,
  "1h": 60
};

// =================== FETCH CANDLES ===================
async function fetchCandles(symbol, timeframe) {
  try {
    const limit = 100;
    const url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${timeframe}`;
    const { data } = await axios.get(url);
    if (data.Response !== "Success") return null;

    return data.Data.Data.map(c => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeto
    }));
  } catch (err) {
    console.log("❌ CryptoCompare fetch failed:", err.message);
    return null;
  }
}

// =================== SIGNAL CALCULATION ===================
function calculateSignal(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const EMA9 = ti.EMA.calculate({ period: 9, values: closes });
  const EMA21 = ti.EMA.calculate({ period: 21, values: closes });
  const RSI14 = ti.RSI.calculate({ period: 14, values: closes });
  const MACD = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const OBV = ti.OBV.calculate({ close: closes, volume: volumes });

  const lastEMA9 = EMA9.slice(-1)[0];
  const lastEMA21 = EMA21.slice(-1)[0];
  const lastRSI = RSI14.slice(-1)[0];
  const lastMACD = MACD.slice(-1)[0];
  const lastOBV = OBV.slice(-1)[0];
  const latestPrice = closes.slice(-1)[0];

  // Fibonacci 0.618
  const recentHigh = Math.max(...highs.slice(-100));
  const recentLow = Math.min(...lows.slice(-100));
  const fibLevel = recentHigh - (recentHigh - recentLow) * 0.618;
  const fibComment = latestPrice > fibLevel ? "✅ Above 0.618" : latestPrice < fibLevel ? "❌ Below 0.618" : "⚪ At 0.618";

  // Signals table
  const emaSignal = lastEMA9 > lastEMA21 ? "✅ Bullish" : "❌ Bearish";
  const macdSignal = lastMACD.MACD > lastMACD.signal ? "✅ Bullish crossover" : "❌ Bearish crossover";
  const volObvSignal = OBV[OBV.length-1] > OBV[OBV.length-2] ? "✅ Increasing" : "❌ Decreasing";
  const rsiSignal = lastRSI >= 55 && lastRSI <= 57 ? `✅ RSI ${lastRSI.toFixed(2)}` : `❌ RSI ${lastRSI.toFixed(2)}`;

  let tradeSignal = "";
  let sl = "", tp = "";

  if (lastEMA9 > lastEMA21 && lastMACD.MACD > lastMACD.signal && lastRSI > 50) {
    tradeSignal = "LONG ✅";
    sl = (latestPrice * 0.97).toFixed(3);
    tp = (latestPrice * 1.03).toFixed(3);
  } else if (lastEMA9 < lastEMA21 && lastMACD.MACD < lastMACD.signal && lastRSI < 50) {
    tradeSignal = "SHORT ❌";
    sl = (latestPrice * 1.03).toFixed(3);
    tp = (latestPrice * 0.97).toFixed(3);
  } else {
    tradeSignal = "NO CLEAR SIGNAL ⚠️";
  }

  return { latestPrice, tradeSignal, sl, tp, emaSignal, macdSignal, volObvSignal, rsiSignal, fibComment };
}

// =================== FORMAT MESSAGE ===================
function formatMessage(symbol, timeframe, signal) {
  return `
📊 ${symbol} — (${timeframe}) Technical Signal
━━━━━━━━━━━━━━━━━━
Trade Signal: ${signal.tradeSignal}
Entry Price: ${signal.latestPrice}
Stop Loss: ${signal.sl}
Take Profit: ${signal.tp}
━━━━━━━━━━━━━━━━━━
| Indicator | Status | Comment |
|-----------|--------|---------|
| EMA 9/21 | ${signal.emaSignal} | EMA9 vs EMA21 |
| MACD | ${signal.macdSignal} | MACD crossover |
| Volume+OBV | ${signal.volObvSignal} | OBV trend |
| RSI 14 | ${signal.rsiSignal} | Momentum strength |
| Fibonacci 0.618 | ${signal.fibComment} | Price vs fib level |
━━━━━━━━━━━━━━━━━━
📅 Date/Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
/BTC /ETH /LINK /DOT /SUI
`;
}

// =================== TELEGRAM COMMANDS ===================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `👋 Welcome to Crypto Signal Bot
Use commands like:
/eth5m
/btc1h
/link15m
/dot5m
/sui1h`);
});

Object.keys(PAIRS).forEach(coin => {
  Object.keys(INTERVAL_MAP).forEach(tf => {
    const command = new RegExp(`/${coin.toLowerCase()}${tf}`, "i");
    bot.onText(command, async msg => {
      const symbol = PAIRS[coin];
      const timeframe = tf;
      bot.sendMessage(msg.chat.id, `🔄 Fetching signal for *${symbol} (${timeframe})* ...`);
      const candles = await fetchCandles(symbol, INTERVAL_MAP[tf]);
      if (!candles) {
        bot.sendMessage(msg.chat.id, `⚠️ Failed to fetch data for ${symbol} (${timeframe})`);
        return;
      }
      const signal = calculateSignal(candles);
      const message = formatMessage(symbol, timeframe, signal);
      bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
    });
  });
});
