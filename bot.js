import dotenv from "dotenv";
import axios from "axios";
import { Telegraf } from "telegraf";
import express from "express";
import {
  EMA, RSI, MACD, BollingerBands, StochasticRSI, ADX, ATR, OBV
} from "technicalindicators";

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ Fetch candles from CryptoCompare OPEN API
async function fetchData(symbol, timeframe) {
  try {
    const limit = timeframe === 60 ? 200 : 200;
    let url;

    if (timeframe === 60) {
      url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=${limit}`;
    } else {
      url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${timeframe}`;
    }

    const { data } = await axios.get(url);

    if (!data?.Data?.Data) return null;

    return data.Data.Data.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumefrom,
    }));
  } catch (err) {
    return null;
  }
}

function analyze(data) {
  const closes = data.map(x => x.close);
  const highs = data.map(x => x.high);
  const lows = data.map(x => x.low);
  const volumes = data.map(x => x.volume);

  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

  const macd = MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    values: closes,
  });

  const rsi = RSI.calculate({ period: 14, values: closes });

  const sma9_rsi = EMA.calculate({ period: 9, values: rsi });

  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2,
  });

  const stochRsi = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });

  const obv = OBV.calculate({ close: closes, volume: volumes });

  const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

  const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  let last = {
    ema9: ema9.slice(-1)[0],
    ema21: ema21.slice(-1)[0],
    macd: macd.slice(-1)[0],
    rsi: rsi.slice(-1)[0],
    sma9_rsi: sma9_rsi.slice(-1)[0],
    bb: bb.slice(-1)[0],
    atr: atr.slice(-1)[0],
    adx: adx.slice(-1)[0],
    stochRsi: stochRsi.slice(-1)[0],
    obv: obv.slice(-1)[0],
    price: closes.slice(-1)[0],
  };

  return last;
}

function formatSignal(symbol, tfLabel, x) {
  const bullish = "✅";
  const bearish = "❌";

  const emaTrend =
    x.ema9 > x.ema21
      ? `${bullish} EMA9 above EMA21 (Bullish)`
      : `${bearish} EMA9 below EMA21 (Bearish)`;

  const macdTrend =
    x.macd.MACD > x.macd.signal
      ? `${bullish} MACD Bullish Crossover`
      : `${bearish} MACD Bearish Crossover`;

  const rsiSignal =
    x.rsi > x.sma9_rsi
      ? `${bullish} RSI above SMA9 (${x.rsi.toFixed(2)})`
      : `${bearish} RSI below SMA9 (${x.rsi.toFixed(2)})`;

  const bollingerSignal =
    x.price < x.bb.lower
      ? `${bullish} Price touching LOWER band (Long setup)`
      : x.price > x.bb.upper
      ? `${bearish} Price touching UPPER band (Short setup)`
      : `➖ Inside Bollinger Bands`;

  const adxSignal =
    x.adx.adx > 25
      ? `${bullish} ADX Strong Trend (${x.adx.adx.toFixed(1)})`
      : `${bearish} ADX Weak Trend (${x.adx.adx.toFixed(1)})`;

  const obvSignal =
    x.obv > x.obv - 5 ? `${bullish} Volume Increasing` : `${bearish} Weak Volume`;

  const sl = (x.price - x.atr * 1.5).toFixed(2);
  const tp = (x.price + x.atr * 2).toFixed(2);

  return `
📊 *${symbol} — ${tfLabel} Technical Signal*
━━━━━━━━━━━━━━━━━━
Entry Price: *${x.price}*
Stop Loss: *${sl}*
Take Profit: *${tp}*
━━━━━━━━━━━━━━━━━━
| Indicator      | Status |
|----------------|--------|
| EMA 9/21       | ${emaTrend} |
| MACD           | ${macdTrend} |
| RSI + SMA9     | ${rsiSignal} |
| Bollinger      | ${bollingerSignal} |
| ADX            | ${adxSignal} |
| OBV / Volume   | ${obvSignal} |
━━━━━━━━━━━━━━━━━━
📅 Time: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━
/BTC /ETH /LINK /DOT /SUI
`;
}

// ✅ Telegram Commands Mapping
const coins = {
  "/btc1h": { symbol: "BTC", tf: 60, label: "1 Hour" },
  "/eth1h": { symbol: "ETH", tf: 60, label: "1 Hour" },
  "/dot1h": { symbol: "DOT", tf: 60, label: "1 Hour" },
  "/link1h": { symbol: "LINK", tf: 60, label: "1 Hour" },
  "/sui1h": { symbol: "SUI", tf: 60, label: "1 Hour" },

  "/btc5m": { symbol: "BTC", tf: 5, label: "5 Min" },
  "/eth5m": { symbol: "ETH", tf: 5, label: "5 Min" },
  "/dot5m": { symbol: "DOT", tf: 5, label: "5 Min" },
  "/link5m": { symbol: "LINK", tf: 5, label: "5 Min" },
  "/sui5m": { symbol: "SUI", tf: 5, label: "5 Min" },

  "/btc15m": { symbol: "BTC", tf: 15, label: "15 Min" },
  "/eth15m": { symbol: "ETH", tf: 15, label: "15 Min" },
  "/dot15m": { symbol: "DOT", tf: 15, label: "15 Min" },
  "/link15m": { symbol: "LINK", tf: 15, label: "15 Min" },
  "/sui15m": { symbol: "SUI", tf: 15, label: "15 Min" },
};

bot.on("text", async (ctx) => {
  const cmd = ctx.message.text.toLowerCase();

  if (!coins[cmd]) return;

  const { symbol, tf, label } = coins[cmd];

  ctx.reply(`⏳ Fetching signal for *${symbol}* (${label}) ...`);

  const candles = await fetchData(symbol, tf);
  if (!candles) return ctx.reply("❌ Failed to fetch data.");

  const analysis = analyze(candles);
  const result = formatSignal(symbol, label, analysis);

  ctx.reply(result, { parse_mode: "Markdown" });
});

// ✅ Required by Render: Start Express server
app.get("/", (req, res) => res.send("✅ Bot is running"));
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));

// ✅ Activate Telegram Webhook
bot.launch();
