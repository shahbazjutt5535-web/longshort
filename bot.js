import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as ti from "technicalindicators";
import dotenv from "dotenv";

dotenv.config();

// =================== CONFIG ===================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN missing!");
  process.exit(1);
}

// =================== INIT BOT (POLLING MODE) ===================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// =================== SYMBOLS & TIMEFRAMES ===================
const PAIRS = { BTC: "BTC", ETH: "ETH", DOT: "DOT", LINK: "LINK", SUI: "SUI" };
const INTERVAL_MAP = { "5m": 5, "15m": 15, "1h": 60 };

// =================== FETCH CANDLES ===================
async function fetchCandles(symbol, timeframe) {
  try {
    const limit = 150;
    let url = "";
    if (timeframe === 60) {
      url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USDT&limit=${limit}`;
    } else {
      url = `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${symbol}&tsym=USDT&limit=${limit}&aggregate=${timeframe}`;
    }
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
    console.log("❌ Fetch failed:", err.message);
    return null;
  }
}

// =================== CALCULATE SIGNAL ===================
function calculateSignal(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // EMA 9/21/50/200
  const EMA9 = ti.EMA.calculate({ period: 9, values: closes });
  const EMA21 = ti.EMA.calculate({ period: 21, values: closes });
  const EMA50 = ti.EMA.calculate({ period: 50, values: closes });
  const EMA200 = ti.EMA.calculate({ period: 200, values: closes });

  // Bollinger Bands
  const BB = ti.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });

  // MACD
  const MACD = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  // RSI 14
  const RSI14 = ti.RSI.calculate({ period: 14, values: closes });

  // Stochastic RSI
  const StochRSI = ti.StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3
  });

  // OBV
  const OBV = ti.OBV.calculate({ close: closes, volume: volumes });

  // ADX
  const ADX = ti.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

  // ATR
  const ATR = ti.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

  // Volume EMA
  const volumeEMA = ti.EMA.calculate({ period: 20, values: volumes });

  const latest = {
    close: closes.slice(-1)[0],
    ema9: EMA9.slice(-1)[0],
    ema21: EMA21.slice(-1)[0],
    ema50: EMA50.slice(-1)[0],
    ema200: EMA200.slice(-1)[0],
    bb: BB.slice(-1)[0],
    macd: MACD.slice(-1)[0],
    rsi: RSI14.slice(-1)[0],
    stochRsi: StochRSI.slice(-1)[0],
    obv: OBV.slice(-1)[0],
    adx: ADX.slice(-1)[0],
    atr: ATR.slice(-1)[0],
    volumeEMA: volumeEMA.slice(-1)[0],
    volume: volumes.slice(-1)[0]
  };

  // =================== TRADE SIGNAL ===================
  let tradeSignal = "", sl="", tp="";

  const ema9 = latest.ema9, ema21 = latest.ema21, bbMiddle = latest.bb ? latest.bb.middle : null;
  const close = latest.close;

  // Bollinger / EMA logic
  let bollEmaSignal = "";
  if (ema9 > bbMiddle && ema21 > bbMiddle) bollEmaSignal = "✅✅ Strong Bullish";
  else if (ema9 > bbMiddle) bollEmaSignal = "✅ Small Bullish";
  else if (ema9 < bbMiddle && ema21 > bbMiddle) bollEmaSignal = "❌ Bearish";
  else bollEmaSignal = "⚪ Neutral";

  // Price touching bands
  const priceBandSignal = close <= latest.bb.lower ? "✅ Price at Lower Band → Potential LONG" :
                          close >= latest.bb.upper ? "❌ Price at Upper Band → Potential SHORT" : "⚪ Price in middle band";

  // MACD
  const macdSignal = latest.macd.MACD > latest.macd.signal ? "✅ Bullish crossover" : "❌ Bearish crossover";

  // RSI
  const rsiSignal = latest.rsi >= 55 ? `✅ RSI ${latest.rsi.toFixed(2)}` : `❌ RSI ${latest.rsi.toFixed(2)}`;

  // Stoch RSI
  let stochSignal = "⚪ Neutral";
  if (latest.stochRsi) {
    const k = latest.stochRsi.k.slice(-1)[0];
    const d = latest.stochRsi.d.slice(-1)[0];
    if (k < 20) stochSignal = `✅ StochRSI Oversold (k:${k.toFixed(2)}, d:${d.toFixed(2)})`;
    else if (k > 80) stochSignal = `❌ StochRSI Overbought (k:${k.toFixed(2)}, d:${d.toFixed(2)})`;
    else stochSignal = `⚪ StochRSI (k:${k.toFixed(2)}, d:${d.toFixed(2)})`;
  }

  // ADX
  let adxSignal = "⚪ Neutral";
  if (latest.adx) {
    const adxValue = latest.adx.adx;
    adxSignal = adxValue > 25 ? `✅ ADX ${adxValue.toFixed(2)} Strong Trend` : `❌ ADX ${adxValue.toFixed(2)} Weak Trend`;
  }

  // Volume EMA
  const volumeSignal = latest.volume > latest.volumeEMA ? `✅ Volume Increasing` : `❌ Volume Decreasing`;

  // ATR-based SL/TP
  const atr = latest.atr ? latest.atr : 0;
  sl = (close - atr).toFixed(3);
  tp = (close + atr).toFixed(3);

  // Trade signal logic
  if (ema9 > ema21 && macdSignal.includes("✅") && latest.rsi > 55 && adxSignal.includes("✅")) tradeSignal = "LONG ✅";
  else if (ema9 < ema21 && macdSignal.includes("❌") && latest.rsi < 55 && adxSignal.includes("❌")) tradeSignal = "SHORT ❌";
  else tradeSignal = "NO CLEAR SIGNAL ⚠️";

  return {
    close, tradeSignal, sl, tp, bollEmaSignal, priceBandSignal, macdSignal, rsiSignal, stochSignal, adxSignal, volumeSignal
  };
}

// =================== FORMAT MESSAGE ===================
function formatMessage(symbol, timeframe, signal) {
  return `
📊 ${symbol} — (${timeframe}) Technical Signal
━━━━━━━━━━━━━━━━━━
Trade Signal: ${signal.tradeSignal}
Entry Price: ${signal.close}
Stop Loss: ${signal.sl}
Take Profit: ${signal.tp}
━━━━━━━━━━━━━━━━━━
| Indicator | Status | Comment |
|-----------|--------|---------|
| EMA + Bollinger | ${signal.bollEmaSignal} | EMA/Bollinger alignment |
| Price vs Bands | ${signal.priceBandSignal} | Price touching bands |
| MACD | ${signal.macdSignal} | Trend confirmation |
| RSI 14 | ${signal.rsiSignal} | Momentum strength |
| Stoch RSI | ${signal.stochSignal} | Overbought/Oversold |
| ADX | ${signal.adxSignal} | Trend strength |
| Volume EMA | ${signal.volumeSignal} | Volume confirmation |
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
