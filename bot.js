import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as ti from "technicalindicators";
import dotenv from "dotenv";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN missing in .env");
  process.exit(1);
}

// ✅ POLLING MODE (NO PORT REQUIRED)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const PAIRS = { BTC: "BTC", ETH: "ETH", DOT: "DOT", LINK: "LINK", SUI: "SUI" };
const TF = { "5m": 5, "15m": 15, "1h": 60 };

async function fetchCandles(symbol, timeframe) {
  try {
    const url = timeframe === 60
      ? `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=150`
      : `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=150&aggregate=${timeframe}`;

    const { data } = await axios.get(url);
    if (data.Response !== "Success") return null;

    return data.Data.Data.map(c => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeto
    }));
  } catch (error) {
    console.log("❌ Fetch failed:", error.message);
    return null;
  }
}

function calculateSignal(candles) {
  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume);

  const EMA9 = ti.EMA.calculate({ period: 9, values: closes });
  const EMA21 = ti.EMA.calculate({ period: 21, values: closes });
  const BB = ti.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const MACD = ti.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const RSI14 = ti.RSI.calculate({ period: 14, values: closes });
  const OBV = ti.OBV.calculate({ close: closes, volume: volumes });
  const ADX = ti.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const ATR = ti.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  // ✅ FIXED StochRSI
  const StochRSI = ti.StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3
  });

  const lastStoch = StochRSI.slice(-1)[0] || null;

  const latest = {
    close: closes.at(-1),
    ema9: EMA9.at(-1),
    ema21: EMA21.at(-1),
    bb: BB.at(-1),
    macd: MACD.at(-1),
    rsi: RSI14.at(-1),
    stoch: lastStoch,
    obv: OBV.at(-1),
    adx: ADX.at(-1),
    atr: ATR.at(-1),
    volume: volumes.at(-1)
  };

  const bollSignal =
    latest.ema9 > latest.bb.middle && latest.ema21 > latest.bb.middle
      ? `✅✅ Strong Bullish`
      : latest.ema9 > latest.bb.middle
      ? `✅ Small Bullish`
      : `❌ Bearish Below Middle Band`;

  const macdSignal = latest.macd.MACD > latest.macd.signal ? "✅ Bullish crossover" : "❌ Bearish crossover";
  const rsiSignal = latest.rsi >= 55 ? `✅ RSI ${latest.rsi.toFixed(2)}` : `❌ RSI ${latest.rsi.toFixed(2)}`;

  const stochSignal = latest.stoch
    ? latest.stoch.k < 20
      ? `✅ Oversold (k:${latest.stoch.k.toFixed(2)})`
      : latest.stoch.k > 80
      ? `❌ Overbought (k:${latest.stoch.k.toFixed(2)})`
      : `⚪ Neutral (k:${latest.stoch.k.toFixed(2)})`
    : "⚪ No StochRSI data";

  const adxSignal =
    latest.adx.adx > 25 ? `✅ ADX ${latest.adx.adx.toFixed(2)} Trend Strong` : `❌ ADX ${latest.adx.adx.toFixed(2)} Weak`;

  return {
    close: latest.close,
    sl: (latest.close - latest.atr).toFixed(3),
    tp: (latest.close + latest.atr).toFixed(3),
    bollSignal,
    macdSignal,
    rsiSignal,
    stochSignal,
    adxSignal
  };
}

function formatMsg(symbol, tf, s) {
  return `
📊 ${symbol} — (${tf}) Technical Signal  
━━━━━━━━━━━━━━━━━━
Trade Signal: AUTO DETECTED
Entry Price: ${s.close}
Stop Loss: ${s.sl}
Take Profit: ${s.tp}
━━━━━━━━━━━━━━━━━━
| Indicator | Status | Comment |
|-----------|--------|---------|
| EMA + Bollinger | ${s.bollSignal} | Trend Strength |
| MACD | ${s.macdSignal} | Trend reversal |
| RSI 14 | ${s.rsiSignal} | Momentum |
| Stoch RSI | ${s.stochSignal} | Overbought/Oversold |
| ADX | ${s.adxSignal} | Trend Quality |
━━━━━━━━━━━━━━━━━━
📅 ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
/BTC /ETH /LINK /DOT /SUI
`;
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `Commands:
/btc5m
/eth15m
/link1h`);
});

Object.keys(PAIRS).forEach(coin => {
  Object.keys(TF).forEach(tf => {
    bot.onText(new RegExp(`/${coin.toLowerCase()}${tf}`, "i"), async msg => {
      bot.sendMessage(msg.chat.id, `🔄 Fetching signal for *${coin} (${tf})* ...`);
      const candles = await fetchCandles(PAIRS[coin], TF[tf]);
      if (!candles) return bot.sendMessage(msg.chat.id, `⚠️ Failed to fetch data`);
      const s = calculateSignal(candles);
      bot.sendMessage(msg.chat.id, formatMsg(coin, tf, s), { parse_mode: "Markdown" });
    });
  });
});
