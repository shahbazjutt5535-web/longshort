const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const ti = require('technicalindicators');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8493857966:AAHKNW-ZMTbDo3XRhQf6AKRA92ulAbxT7_U';
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES) || 1; // minute(s)

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes('8493857966:AAHKNW-ZMTbDo3XRhQf6AKRA92ulAbxT7_U')) {
  console.warn('WARNING: TELEGRAM_TOKEN not set. Set process.env.TELEGRAM_TOKEN before running.');
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(express.json());

// Simple health endpoint so you can expose a port and verify the bot is alive
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Supported symbols mapping (Binance symbol format)
const SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  LINK: 'LINKUSDT',
  DOT: 'DOTUSDT',
  SUI: 'SUIUSDT'
};

// Indicators configuration
const INDICATOR_CONFIG = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false },
  obv: true,
  lookback: 200 // number of candles to fetch
};

// Utility: fetch klines from Binance public API
async function fetchKlines(symbol, interval = '1h', limit = 200) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await axios.get(url, { timeout: 10000 });
    // Binance returns array of arrays; structure: [ openTime, open, high, low, close, volume, ... ]
    return resp.data.map(k => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    }));
  } catch (err) {
    console.error('fetchKlines error', err.message || err);
    throw err;
  }
}

// Compute indicators and signals
function computeIndicatorsAndSignal(klines) {
  // arrays for indicator library
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const volumes = klines.map(k => k.volume);

  // EMA
  const emaFast = ti.EMA.calculate({ period: INDICATOR_CONFIG.emaFast, values: closes });
  const emaSlow = ti.EMA.calculate({ period: INDICATOR_CONFIG.emaSlow, values: closes });

  // We need the last aligned values: ema arrays are shorter than closes
  const alignOffset = closes.length - emaFast.length;
  const emaFastFull = new Array(alignOffset).fill(null).concat(emaFast);
  const emaSlowFull = new Array(closes.length - emaSlow.length).fill(null).concat(emaSlow);

  // RSI
  const rsi = ti.RSI.calculate({ period: INDICATOR_CONFIG.rsiPeriod, values: closes });
  const rsiFull = new Array(closes.length - rsi.length).fill(null).concat(rsi);

  // MACD
  const macdInput = { values: closes, ...INDICATOR_CONFIG.macd };
  const macdResult = ti.MACD.calculate(macdInput);
  const macdFull = new Array(closes.length - macdResult.length).fill(null).concat(macdResult);

  // OBV simple calculation
  const obv = ti.OBV.calculate({ close: closes, volume: volumes });
  const obvFull = new Array(closes.length - obv.length).fill(null).concat(obv);

  // Volume moving average (for simple spike detection)
  const volSMA = ti.SMA.calculate({ period: 20, values: volumes });
  const volSMAFull = new Array(closes.length - volSMA.length).fill(null).concat(volSMA);

  // Simple Fibonacci levels (use last swing high/low from lookback window)
  const lookbackWindow = 50;
  const windowHigh = Math.max(...highs.slice(-lookbackWindow));
  const windowLow = Math.min(...lows.slice(-lookbackWindow));
  const fibLevels = {
    '0.0': windowHigh,
    '0.236': windowHigh - (windowHigh - windowLow) * 0.236,
    '0.382': windowHigh - (windowHigh - windowLow) * 0.382,
    '0.5': windowHigh - (windowHigh - windowLow) * 0.5,
    '0.618': windowHigh - (windowHigh - windowLow) * 0.618,
    '0.786': windowHigh - (windowHigh - windowLow) * 0.786,
    '1.0': windowLow
  };

  // Last candle index
  const i = closes.length - 1;

  const last = {
    time: klines[i].openTime,
    price: closes[i],
    emaFast: emaFastFull[i],
    emaSlow: emaSlowFull[i],
    rsi: rsiFull[i],
    macd: macdFull[i],
    obv: obvFull[i],
    volume: volumes[i],
    volSMA: volSMAFull[i]
  };

  // Heuristic signal scoring
  const signals = {
    emaBull: last.emaFast !== null && last.emaSlow !== null && last.emaFast > last.emaSlow,
    emaBear: last.emaFast !== null && last.emaSlow !== null && last.emaFast < last.emaSlow,
    rsiBull: last.rsi !== null && last.rsi > 50,
    rsiOverbought: last.rsi !== null && last.rsi > 70,
    macdBull: last.macd !== null && last.macd.histogram > 0,
    obvRising: last.obv !== null && obvFull[i] > obvFull[Math.max(0, i - 5)],
    volSpike: last.volSMA !== null && last.volume > last.volSMA * 1.5
  };

  // Confidence scoring: count positive signals for long / short
  const longConditions = ['emaBull', 'rsiBull', 'macdBull', 'obvRising'];
  const shortConditions = ['emaBear', 'rsiBull' /* placeholder false */, 'macdBull' /* placeholder false */];

  let longCount = 0;
  if (signals.emaBull) longCount++;
  if (signals.rsiBull) longCount++;
  if (signals.macdBull) longCount++;
  if (signals.obvRising) longCount++;
  // treat volume spike as booster
  if (signals.volSpike) longCount += 0.5;

  let shortCount = 0;
  if (signals.emaBear) shortCount++;
  if (last.rsi !== null && last.rsi < 50) shortCount++;
  if (last.macd !== null && last.macd.histogram < 0) shortCount++;
  if (signals.obvRising === false) shortCount++;
  if (signals.volSpike) shortCount += 0.5;

  const longConfidence = Math.min(100, Math.round((longCount / 4.5) * 100));
  const shortConfidence = Math.min(100, Math.round((shortCount / 4.5) * 100));

  // entry/SL/TP logic (basic):
  // If long: entry = price (current close), SL = recent low - small buffer, TP1 = entry + (entry-SL)*1.5
  const recentLow = Math.min(...lows.slice(-10));
  const recentHigh = Math.max(...highs.slice(-10));

  const entries = {};
  if (longConfidence > shortConfidence) {
    const entry = last.price;
    const sl = recentLow - (recentLow * 0.002); // 0.2% buffer
    const tp1 = entry + (entry - sl) * 1.5;
    const tp2 = entry + (entry - sl) * 2.5;
    entries.signal = 'LONG';
    entries.entry = entry;
    entries.stopLoss = sl;
    entries.takeProfits = [tp1, tp2];
    entries.confidence = longConfidence;
  } else if (shortConfidence > longConfidence) {
    const entry = last.price;
    const sl = recentHigh + (recentHigh * 0.002);
    const tp1 = entry - (sl - entry) * 1.5;
    const tp2 = entry - (sl - entry) * 2.5;
    entries.signal = 'SHORT';
    entries.entry = entry;
    entries.stopLoss = sl;
    entries.takeProfits = [tp1, tp2];
    entries.confidence = shortConfidence;
  } else {
    entries.signal = 'NEUTRAL';
    entries.confidence = Math.round((longConfidence + shortConfidence) / 2);
  }

  return {
    last,
    signals,
    entries,
    fibLevels,
    datetime: new Date(last.time).toISOString()
  };
}

// Build message payload for Telegram
function buildTelegramMessage(symbolKey, result) {
  const s = result;
  let msg = `*${symbolKey}* (1H) — Signal: *${s.entries.signal}*\n`;
  msg += `Date/Time (UTC): ${s.datetime}\n`;
  msg += `Price: ${s.last.price}\n`;
  if (s.entries.signal !== 'NEUTRAL') {
    msg += `Entry: ${s.entries.entry}\n`;
    msg += `Stop Loss: ${s.entries.stopLoss}\n`;
    msg += `Take Profits: ${s.entries.takeProfits.map(t => t.toFixed(8)).join(' , ')}\n`;
    msg += `Confidence (est.): ${s.entries.confidence}%\n`;
  }
  msg += `\n*Indicators:*\n`;
  msg += `EMA${INDICATOR_CONFIG.emaFast}: ${s.last.emaFast?.toFixed(8) || 'n/a'}\n`;
  msg += `EMA${INDICATOR_CONFIG.emaSlow}: ${s.last.emaSlow?.toFixed(8) || 'n/a'}\n`;
  msg += `RSI(${INDICATOR_CONFIG.rsiPeriod}): ${s.last.rsi?.toFixed(2) || 'n/a'}\n`;
  msg += `MACD hist: ${s.last.macd?.histogram?.toFixed(8) || 'n/a'}\n`;
  msg += `OBV: ${s.last.obv?.toFixed(2) || 'n/a'}\n`;
  msg += `Volume: ${s.last.volume}\n`;
  msg += `\n_Fibonacci (from recent ${50} candles):_\n`;
  Object.keys(s.fibLevels).forEach(k => {
    msg += `${k}: ${s.fibLevels[k].toFixed(8)}\n`;
  });
  msg += '\n_Notes:_ Confidence is an estimated heuristic, NOT a guaranteed accuracy. Use proper risk management.';
  return msg;
}

// Command handler (symbolKey: BTC, ETH, etc.)
async function handleSymbol(ctxOrChatId, symbolKey) {
  try {
    const symbol = SYMBOLS[symbolKey];
    const klines = await fetchKlines(symbol, '1h', INDICATOR_CONFIG.lookback);
    const result = computeIndicatorsAndSignal(klines);
    const message = buildTelegramMessage(symbolKey, result);

    if (ctxOrChatId && ctxOrChatId.reply) {
      // ctx from Telegraf
      await ctxOrChatId.replyWithMarkdown(message);
    } else if (typeof ctxOrChatId === 'number' || typeof ctxOrChatId === 'string') {
      await bot.telegram.sendMessage(ctxOrChatId, message, { parse_mode: 'Markdown' });
    }
    return result;
  } catch (err) {
    console.error('handleSymbol error', err.message || err);
    if (ctxOrChatId && ctxOrChatId.reply) {
      await ctxOrChatId.reply('Error fetching data or computing signal.');
    }
  }
}

// Register Telegram commands
bot.start((ctx) => ctx.reply('Welcome! Use commands: /BTC /ETH /LINK /DOT /SUI')); 
bot.command('BTC', async (ctx) => await handleSymbol(ctx, 'BTC'));
bot.command('ETH', async (ctx) => await handleSymbol(ctx, 'ETH'));
bot.command('LINK', async (ctx) => await handleSymbol(ctx, 'LINK'));
bot.command('DOT', async (ctx) => await handleSymbol(ctx, 'DOT'));
bot.command('SUI', async (ctx) => await handleSymbol(ctx, 'SUI'));

// Start polling Telegram
bot.launch().then(() => console.log('Telegram bot launched')).catch(e => console.error('bot.launch error', e));

// Optional: poll all symbols periodically and log or send to admin channel
async function pollAllAndLog() {
  for (const key of Object.keys(SYMBOLS)) {
    try {
      const res = await handleSymbol(process.env.ADMIN_CHAT_ID || null, key);
      console.log(`${key} polled at ${res.datetime} signal=${res.entries.signal} conf=${res.entries.confidence}`);
    } catch (err) {
      console.error('pollAll error', err.message || err);
    }
  }
}

setInterval(pollAllAndLog, POLL_INTERVAL_MINUTES * 60 * 1000);

// Start express server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
