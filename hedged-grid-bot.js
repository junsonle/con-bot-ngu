/**
 * ============================================================
 *  4-SLOT GRID BOT v3.0 - Binance Futures Testnet
 *  Pair: BTCUSDC | Hedge Mode
 * ============================================================
 *  Architecture: Exactly 4 limit orders at all times
 *    - nearBuy:  BUY LONG   at base - spacing       (lưới gần - dưới)
 *    - nearSell: SELL SHORT  at base + spacing       (lưới gần - trên)
 *    - farBuy:   BUY LONG   at base - spacing * catch (bắt giá giảm mạnh)
 *    - farSell:  SELL SHORT  at base + spacing * catch (bắt giá tăng mạnh)
 *
 *  After any TP fills → recenter grid at current price
 *  Profit = Current Equity - Start Equity (100% accurate)
 * ============================================================
 */

const Binance = require('node-binance-api');
const Express = require('express');
const { Telegraf } = require('telegraf');
const { ATR } = require('technicalindicators');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

// ===================== CONSTANTS =====================
const CONFIG_PATH = './grid-config.json';
const STATE_PATH = './grid-state.json';
const FUTURES_TESTNET = 'https://testnet.binancefuture.com';
const PORT = 3001;

// ===================== CLIENTS =====================
const binance = new Binance().options({
    APIKEY: process.env.APIKEY,
    APISECRET: process.env.APISECRET,
    test: true,
    urls: {
        base: 'https://testnet.binance.vision/api/',
        combineStream: 'wss://testnet.binance.vision/stream?streams=',
        stream: 'wss://fstream.binancefuture.com'
    }
});

const tgBot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_ID;
const app = Express();
const server = require('http').Server(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

// ===================== STATE =====================
let config = {};
let running = false;
let basePrice = 0;
let tickCount = 0;

// Equity tracking
let startEquity = 0;
let realProfit = 0;
let peakEquity = 0;

// ATR
let currentATR = 0;
let avgATR = 0;
let lastATRUpdate = 0;

let botStatus = 'IDLE';
let cycleCount = 0; // Total completed TP cycles

/**
 * 4 ORDER SLOTS - the entire grid engine
 * Each slot: { name, entrySide, posSide, direction, distMult,
 *              entryPrice, tpPrice, orderId, status, fillPrice }
 * 
 * Status: IDLE → ENTRY → FILLED → TP → (TP fills) → IDLE (auto-recycle)
 * direction: -1 = buy below base, +1 = sell above base
 */
const slots = [];

// ===================== HELPERS =====================
const delay = ms => new Promise(r => setTimeout(r, ms));
const roundPrice = p => Math.round(p * 100) / 100;
const roundQty = q => Math.round(q * 1000) / 1000;
const now = () => new Date().toLocaleTimeString('vi-VN');

function log(tag, msg) {
    const line = `[${now()}] [${tag}] ${msg}`;
    console.log(line);
    io.emit('log', line);
    return line;
}

function notify(msg) {
    log('TG', msg);
    tgBot.telegram.sendMessage(chatId, msg).catch(() => {});
}

// ===================== CONFIG =====================
function loadConfig() {
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (!config.catchMultiplier) config.catchMultiplier = 3;
        if (!config.tickIntervalMs) config.tickIntervalMs = 3000;
        if (!config.drawdown) config.drawdown = { maxPercent: 15, trailingEnabled: true };
        if (!config.atr) config.atr = { period: 14, klineInterval: '1h', updateIntervalMs: 300000, defaultValue: 300 };
        return true;
    } catch (e) {
        log('CFG', `Error: ${e.message}`);
        return false;
    }
}

function saveConfig() {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {}
}

// ===================== STATE PERSISTENCE =====================
function saveState() {
    try {
        const state = {
            basePrice, startEquity, peakEquity, realProfit, cycleCount,
            botStatus, savedAt: Date.now(),
            slots: slots.map(s => ({
                name: s.name, entrySide: s.entrySide, tpSide: s.tpSide,
                posSide: s.posSide, direction: s.direction, distMult: s.distMult,
                entryPrice: s.entryPrice, tpPrice: s.tpPrice,
                orderId: s.orderId, status: s.status, fillCount: s.fillCount
            }))
        };
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        log('STATE', `Save error: ${e.message}`);
    }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_PATH)) return null;
        const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!state.slots || !state.basePrice) return null;
        return state;
    } catch (e) {
        log('STATE', `Load error: ${e.message}`);
        return null;
    }
}

function clearState() {
    try { if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH); } catch (e) {}
}

/**
 * RECOVERY: Reconstruct slots from saved state + real Binance data
 * Called when bot restarts with config.run = true
 * 
 * Logic per slot:
 *   Saved ENTRY → check if orderId still in openOrders
 *     - yes → keep ENTRY (order still waiting)
 *     - no  → order filled while down → check position → FILLED or IDLE
 *   Saved TP → check if orderId still in openOrders
 *     - yes → keep TP (waiting for TP fill)
 *     - no  → TP filled while down → IDLE (cycle completed)
 *   Saved FILLED → has position, needs TP → stay FILLED
 *   Saved IDLE → just place new entry
 */
async function recoverFromState() {
    const state = loadState();
    if (!state) return false;

    const ageMs = Date.now() - (state.savedAt || 0);
    const ageMin = Math.round(ageMs / 60000);
    log('RECOVER', `Found state from ${ageMin} min ago | Base:$${state.basePrice} | Cycles:${state.cycleCount}`);

    // Fetch real data from Binance
    const [orders, positions] = await Promise.all([
        binance.futuresOpenOrders(config.symbol).catch(() => []),
        binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => [])
    ]);

    const openOrderIds = new Set(orders.map(o => o.orderId));
    const openOrderMap = new Map(orders.map(o => [o.orderId, o]));

    // Get actual position quantities
    const longQty = Math.abs(Number(positions.find(p => p.positionSide === 'LONG')?.positionAmt || 0));
    const shortQty = Math.abs(Number(positions.find(p => p.positionSide === 'SHORT')?.positionAmt || 0));

    log('RECOVER', `Binance: ${orders.length} orders | LONG:${longQty} SHORT:${shortQty}`);

    // Restore global state
    basePrice = state.basePrice;
    startEquity = state.startEquity;
    peakEquity = state.peakEquity || 0;
    cycleCount = state.cycleCount || 0;
    realProfit = state.realProfit || 0;

    // Reconstruct slots
    slots.length = 0;
    for (const saved of state.slots) {
        const slot = {
            name: saved.name, entrySide: saved.entrySide, tpSide: saved.tpSide,
            posSide: saved.posSide, direction: saved.direction, distMult: saved.distMult,
            entryPrice: saved.entryPrice, tpPrice: saved.tpPrice,
            orderId: saved.orderId, status: saved.status, fillCount: saved.fillCount || 0
        };

        const hasPos = (slot.posSide === 'LONG' && longQty >= config.orderSize * 0.9)
                    || (slot.posSide === 'SHORT' && shortQty >= config.orderSize * 0.9);

        switch (saved.status) {
            case 'ENTRY':
                if (saved.orderId && openOrderIds.has(saved.orderId)) {
                    // Order still open → keep as-is
                    log('RECOVER', `  ${slot.name}: ENTRY ✓ (order ${saved.orderId} still open)`);
                } else if (hasPos) {
                    // Order gone + position exists → entry filled while down
                    log('RECOVER', `  ${slot.name}: ENTRY → FILLED (pos exists, order gone)`);
                    slot.status = 'FILLED';
                    slot.orderId = null;
                } else {
                    // Order gone + no position → entry expired or cancelled
                    log('RECOVER', `  ${slot.name}: ENTRY → IDLE (order gone, no pos)`);
                    slot.status = 'IDLE';
                    slot.orderId = null;
                }
                break;

            case 'TP':
                if (saved.orderId && openOrderIds.has(saved.orderId)) {
                    // TP order still open → waiting for fill
                    log('RECOVER', `  ${slot.name}: TP ✓ (order ${saved.orderId} still open)`);
                } else if (hasPos) {
                    // TP gone but still has position → TP cancelled? → re-place TP
                    log('RECOVER', `  ${slot.name}: TP → FILLED (pos exists, TP order gone)`);
                    slot.status = 'FILLED';
                    slot.orderId = null;
                } else {
                    // TP gone + no position → TP filled! Cycle complete
                    log('RECOVER', `  ${slot.name}: TP → IDLE (TP filled while down)`);
                    slot.status = 'IDLE';
                    slot.orderId = null;
                    slot.fillCount++;
                    cycleCount++;
                }
                break;

            case 'FILLED':
                if (hasPos) {
                    // Has position, needs TP → keep FILLED
                    log('RECOVER', `  ${slot.name}: FILLED ✓ (pos exists, will place TP)`);
                } else {
                    // No position → already closed somehow
                    log('RECOVER', `  ${slot.name}: FILLED → IDLE (no pos found)`);
                    slot.status = 'IDLE';
                    slot.orderId = null;
                }
                break;

            case 'IDLE':
            default:
                log('RECOVER', `  ${slot.name}: IDLE ✓`);
                slot.status = 'IDLE';
                slot.orderId = null;
                break;
        }

        slots.push(slot);
    }

    // Clean up any orphan orders not tracked by slots
    const trackedIds = new Set(slots.filter(s => s.orderId).map(s => s.orderId));
    for (const order of orders) {
        if (!trackedIds.has(order.orderId)) {
            log('RECOVER', `  Cancelling orphan order ${order.orderId} ${order.side} @ ${order.price}`);
            await cancelOrder(order.orderId);
        }
    }

    log('RECOVER', `✅ Recovery complete | Base:$${basePrice} | Cycles:${cycleCount}`);
    notify(`🔄 Bot RECOVERED\nBase: $${basePrice} | Cycles: ${cycleCount}\nStart Eq: $${startEquity.toFixed(2)}`);
    saveState();
    return true;
}

// ===================== SIGNED API HELPER =====================
async function signedRequest(method, path, params = {}) {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };
    const query = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join('&');
    const signature = crypto.createHmac('sha256', process.env.APISECRET).update(query).digest('hex');
    const url = `${FUTURES_TESTNET}${path}?${query}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': process.env.APIKEY };
    if (method === 'GET') return (await axios.get(url, { headers })).data;
    return (await axios.post(url, null, { headers })).data;
}

// ===================== ACCOUNT SETUP =====================
async function setupAccount() {
    try {
        await signedRequest('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'true' });
        log('SETUP', 'Hedge mode ENABLED');
    } catch (e) {
        if (e.response?.data?.code === -4059) log('SETUP', 'Hedge mode ✓');
        else log('SETUP', `Hedge error: ${e.response?.data?.msg || e.message}`);
    }
    try { await binance.futuresLeverage(config.symbol, config.leverage); log('SETUP', `Leverage ${config.leverage}x ✓`); } catch (e) {}
    try { await binance.futuresMarginType(config.symbol, 'CROSSED'); log('SETUP', 'Margin CROSSED ✓'); } catch (e) {}
}

// ===================== ATR =====================
async function updateATR() {
    if (Date.now() - lastATRUpdate < config.atr.updateIntervalMs) return;
    try {
        const candles = await signedRequest('GET', '/fapi/v1/klines', {
            symbol: config.symbol, interval: config.atr.klineInterval, limit: 50
        });
        if (!candles || candles.length < config.atr.period + 1) return;
        const atrValues = ATR.calculate({
            high: candles.map(c => parseFloat(c[2])),
            low: candles.map(c => parseFloat(c[3])),
            close: candles.map(c => parseFloat(c[4])),
            period: config.atr.period
        });
        if (atrValues.length > 0) {
            currentATR = atrValues[atrValues.length - 1];
            avgATR = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
        }
    } catch (e) {
        if (currentATR === 0) { currentATR = config.atr.defaultValue; avgATR = config.atr.defaultValue; }
    }
    lastATRUpdate = Date.now();
}

// ===================== ORDER PLACEMENT =====================
async function placeLimit(side, posSide, price, qty) {
    const params = {
        symbol: config.symbol, side, type: 'LIMIT', positionSide: posSide,
        quantity: `${roundQty(qty)}`, price: `${roundPrice(price)}`,
        timeInForce: 'GTC', newOrderRespType: 'ACK'
    };
    try {
        const data = await binance.futuresMultipleOrders([params]);
        const r = data[0];
        if (r.code) { log('ORDER', `❌ ${side} ${posSide} @ ${price}: ${r.msg}`); return null; }
        log('ORDER', `✅ ${side} ${posSide} LIMIT @ ${price} qty=${qty} id=${r.orderId}`);
        return r.orderId;
    } catch (e) { log('ORDER', `❌ ${side} ${posSide} @ ${price}: ${e.message}`); return null; }
}

async function placeMarket(side, posSide, qty) {
    const params = {
        symbol: config.symbol, side, type: 'MARKET', positionSide: posSide,
        quantity: `${roundQty(qty)}`, newOrderRespType: 'ACK'
    };
    try {
        const data = await binance.futuresMultipleOrders([params]);
        const r = data[0];
        if (r.code) { log('ORDER', `❌ MKT ${side} ${posSide}: ${r.msg}`); return null; }
        log('ORDER', `✅ MKT ${side} ${posSide} qty=${qty}`);
        return r.orderId;
    } catch (e) { log('ORDER', `❌ MKT ${side} ${posSide}: ${e.message}`); return null; }
}

async function cancelOrder(orderId) {
    try {
        await binance.futuresCancel(config.symbol, { orderId: `${orderId}` });
        return true;
    } catch (e) { return false; }
}

async function cancelAllOrders() {
    try { await binance.futuresCancelAll(config.symbol); log('ORDER', '🗑 ALL cancelled'); } catch (e) {}
}

// ===================== SLOT SYSTEM =====================

function initSlots(price) {
    basePrice = roundPrice(price);
    const spacing = config.gridSpacing;
    const catchMult = config.catchMultiplier || 3;

    slots.length = 0;
    slots.push({
        name: 'nearBuy', entrySide: 'BUY', tpSide: 'SELL', posSide: 'LONG',
        direction: -1, distMult: 1,
        entryPrice: roundPrice(basePrice - spacing),
        tpPrice: roundPrice(basePrice),
        orderId: null, status: 'IDLE', fillCount: 0
    });
    slots.push({
        name: 'nearSell', entrySide: 'SELL', tpSide: 'BUY', posSide: 'SHORT',
        direction: +1, distMult: 1,
        entryPrice: roundPrice(basePrice + spacing),
        tpPrice: roundPrice(basePrice),
        orderId: null, status: 'IDLE', fillCount: 0
    });
    slots.push({
        name: 'farBuy', entrySide: 'BUY', tpSide: 'SELL', posSide: 'LONG',
        direction: -1, distMult: catchMult,
        entryPrice: roundPrice(basePrice - spacing * catchMult),
        tpPrice: roundPrice(basePrice - spacing * (catchMult - 1)),
        orderId: null, status: 'IDLE', fillCount: 0
    });
    slots.push({
        name: 'farSell', entrySide: 'SELL', tpSide: 'BUY', posSide: 'SHORT',
        direction: +1, distMult: catchMult,
        entryPrice: roundPrice(basePrice + spacing * catchMult),
        tpPrice: roundPrice(basePrice + spacing * (catchMult - 1)),
        orderId: null, status: 'IDLE', fillCount: 0
    });

    log('GRID', `Base: $${basePrice} | Spacing: $${spacing} | Catch: ${catchMult}x`);
    for (const s of slots) {
        log('GRID', `  ${s.name}: entry=${s.entryPrice} → tp=${s.tpPrice}`);
    }
}

function recenterSlots(newPrice) {
    const oldBase = basePrice;
    basePrice = roundPrice(newPrice);
    const spacing = config.gridSpacing;
    const catchMult = config.catchMultiplier || 3;

    for (const s of slots) {
        if (s.status !== 'IDLE') continue;
        if (s.direction === -1) {
            s.entryPrice = roundPrice(basePrice - spacing * s.distMult);
            s.tpPrice = roundPrice(basePrice - spacing * (s.distMult - 1));
        } else {
            s.entryPrice = roundPrice(basePrice + spacing * s.distMult);
            s.tpPrice = roundPrice(basePrice + spacing * (s.distMult - 1));
        }
    }

    log('GRID', `📐 Recenter: $${oldBase} → $${basePrice}`);
    saveState();
}

// ===================== SLOT RECONCILIATION =====================

async function processSlots(openOrderIds) {
    let stateChanged = false;

    for (const slot of slots) {
        const prevStatus = slot.status;

        switch (slot.status) {
            case 'IDLE': {
                const oid = await placeLimit(slot.entrySide, slot.posSide, slot.entryPrice, config.orderSize);
                if (oid) {
                    slot.orderId = oid;
                    slot.status = 'ENTRY';
                }
                break;
            }

            case 'ENTRY': {
                if (!openOrderIds.has(slot.orderId)) {
                    log('GRID', `📦 ${slot.name} ENTRY FILLED @ ${slot.entryPrice}`);
                    notify(`📦 ${slot.name} filled @ ${slot.entryPrice}`);
                    slot.status = 'FILLED';
                    slot.orderId = null;
                }
                break;
            }

            case 'FILLED': {
                const oid = await placeLimit(slot.tpSide, slot.posSide, slot.tpPrice, config.orderSize);
                if (oid) {
                    slot.orderId = oid;
                    slot.status = 'TP';
                    log('GRID', `🎯 ${slot.name} TP placed @ ${slot.tpPrice}`);
                } else {
                    log('GRID', `⚠ ${slot.name} TP rejected, closing via market`);
                    await placeMarket(slot.tpSide, slot.posSide, config.orderSize);
                    slot.status = 'IDLE';
                    slot.orderId = null;
                }
                break;
            }

            case 'TP': {
                if (!openOrderIds.has(slot.orderId)) {
                    slot.fillCount++;
                    cycleCount++;
                    log('GRID', `💰 ${slot.name} TP FILLED @ ${slot.tpPrice} (cycle #${cycleCount})`);
                    notify(`💰 ${slot.name} cycle complete @ ${slot.tpPrice} (#${cycleCount})`);
                    slot.status = 'IDLE';
                    slot.orderId = null;
                }
                break;
            }
        }

        if (slot.status !== prevStatus) stateChanged = true;
    }

    // Persist state after any change
    if (stateChanged) saveState();
}

// ===================== DRAWDOWN SHIELD =====================
async function checkDrawdown(equity) {
    if (!config.drawdown?.trailingEnabled) return false;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity === 0) return false;
    const dd = ((peakEquity - equity) / peakEquity) * 100;
    if (dd >= config.drawdown.maxPercent) {
        log('SHIELD', `🚨 DRAWDOWN ${dd.toFixed(1)}% → EMERGENCY CLOSE`);
        notify(`🚨 Drawdown ${dd.toFixed(1)}%! Closing ALL!`);
        botStatus = 'EMERGENCY';
        await cancelAllOrders();
        const positions = await binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => []);
        for (const pos of positions) {
            const amt = Math.abs(Number(pos.positionAmt));
            if (amt > 0) await placeMarket(pos.positionSide === 'LONG' ? 'SELL' : 'BUY', pos.positionSide, amt);
        }
        running = false; config.run = false; saveConfig();
        return true;
    }
    return false;
}

// ===================== MAIN TICK LOOP =====================
async function tick() {
    log('ENGINE', '🚀 Tick loop started');
    let lastRecenter = basePrice;

    while (running) {
        try {
            tickCount++;

            // Fetch state in parallel
            const [balances, prices, orders] = await Promise.all([
                binance.futuresBalance().catch(() => null),
                binance.futuresPrices().catch(() => null),
                binance.futuresOpenOrders(config.symbol).catch(() => [])
            ]);

            if (!prices || !prices[config.symbol]) { await delay(config.tickIntervalMs); continue; }
            const price = parseFloat(prices[config.symbol]);

            // Equity
            let equity = 0;
            if (balances?.length > 0) {
                const coin = balances.find(b => config.symbol.indexOf(b.asset) > 0);
                if (coin) {
                    equity = parseFloat(coin.balance) + parseFloat(coin.crossUnPnl);
                    if (peakEquity === 0) peakEquity = equity;
                }
            }
            if (startEquity > 0 && equity > 0) realProfit = equity - startEquity;

            // Drawdown
            if (await checkDrawdown(equity)) break;

            // ATR (periodic)
            await updateATR();

            // Build set of open order IDs
            const openOrderIds = new Set(orders.map(o => o.orderId));

            // Check if any slot just completed → recenter
            const beforeIdleCount = slots.filter(s => s.status === 'IDLE').length;

            // Process all slots
            await processSlots(openOrderIds);

            // After processing, check if new cycles completed
            const afterIdleCount = slots.filter(s => s.status === 'IDLE').length;
            if (afterIdleCount > beforeIdleCount && Math.abs(price - basePrice) > config.gridSpacing * 0.5) {
                // A cycle completed AND price moved significantly → recenter
                recenterSlots(price);
            }

            // Count stats
            const entryCount = slots.filter(s => s.status === 'ENTRY').length;
            const filledCount = slots.filter(s => s.status === 'FILLED' || s.status === 'TP').length;
            const totalOrders = orders.length;

            // Emit to dashboard
            io.emit('status', {
                price, equity: equity.toFixed(2), startEquity: startEquity.toFixed(2),
                realProfit: realProfit.toFixed(2), peakEquity: peakEquity.toFixed(2),
                drawdown: peakEquity > 0 ? ((peakEquity - equity) / peakEquity * 100).toFixed(1) : '0.0',
                basePrice, spacing: config.gridSpacing, catchMult: config.catchMultiplier || 3,
                atr: currentATR.toFixed(1), botStatus, totalOrders, cycleCount,
                slots: slots.map(s => ({
                    name: s.name, status: s.status,
                    entry: s.entryPrice, tp: s.tpPrice,
                    fills: s.fillCount
                })),
                tickCount
            });

            // Summary log
            if (tickCount % 15 === 0) {
                const slotSummary = slots.map(s => `${s.name[0].toUpperCase()}${s.name.includes('far')?'F':'N'}:${s.status[0]}`).join(' ');
                log('SUM', `$${price} | Eq:$${equity.toFixed(2)} | P:$${realProfit.toFixed(2)} | Base:$${basePrice} | Ord:${totalOrders} | Cycles:${cycleCount} | ${slotSummary}`);
            }

        } catch (e) {
            log('ERROR', e.message);
        }
        await delay(config.tickIntervalMs);
    }
    log('ENGINE', '🛑 Stopped');
}

// ===================== BOT CONTROL =====================
async function startBot() {
    if (running) return 'Already running';
    loadConfig();
    await setupAccount();

    const prices = await binance.futuresPrices();
    const price = parseFloat(prices[config.symbol]);
    if (!price) return 'Cannot get price';

    // ===== TRY RECOVERY FIRST =====
    const recovered = await recoverFromState();
    if (recovered) {
        log('START', '🔄 Resumed from saved state');
        tickCount = 0;
        running = true; botStatus = 'RUNNING'; config.run = true; saveConfig();
        tick();
        return `🔄 Bot RECOVERED | Base: $${basePrice} | Cycles: ${cycleCount} | Start Eq: $${startEquity.toFixed(2)}`;
    }

    // ===== FRESH START (no state file) =====
    log('START', '🆕 Fresh start (no saved state)');
    await cancelAllOrders();
    const positions = await binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => []);
    for (const pos of positions) {
        const amt = Math.abs(Number(pos.positionAmt));
        if (amt > 0) {
            await placeMarket(pos.positionSide === 'LONG' ? 'SELL' : 'BUY', pos.positionSide, amt);
            log('START', `Closed existing ${pos.positionSide} ${amt}`);
        }
    }
    await delay(1000);

    // Save start equity
    const bal = await binance.futuresBalance().catch(() => null);
    if (bal?.length > 0) {
        const coin = bal.find(b => config.symbol.indexOf(b.asset) > 0);
        if (coin) startEquity = parseFloat(coin.balance) + parseFloat(coin.crossUnPnl);
    }

    initSlots(price);
    realProfit = 0; peakEquity = 0; tickCount = 0; cycleCount = 0;
    running = true; botStatus = 'RUNNING'; config.run = true; saveConfig();
    saveState();

    const msg = `🤖 Grid Bot v3.0 STARTED (fresh)\n` +
        `Symbol: ${config.symbol} | Lev: ${config.leverage}x\n` +
        `Base: $${basePrice} | Spacing: $${config.gridSpacing}\n` +
        `Catch: ${config.catchMultiplier}x ($${config.gridSpacing * config.catchMultiplier})\n` +
        `Start Equity: $${startEquity.toFixed(2)}\n` +
        `Max Orders: 4 (2 near + 2 far)`;
    notify(msg);
    tick();
    return msg;
}

async function stopBot() {
    running = false; botStatus = 'IDLE'; config.run = false; saveConfig();
    saveState(); // Save state before stopping (for potential recovery later)
    await cancelAllOrders();
    clearState(); // Clean state on intentional stop (no recovery needed)
    const msg = `🛑 STOPPED | Profit: $${realProfit.toFixed(2)} | Cycles: ${cycleCount}`;
    notify(msg); return msg;
}

async function emergencyClose() {
    running = false; botStatus = 'EMERGENCY'; config.run = false; saveConfig();
    clearState();
    await cancelAllOrders();
    const positions = await binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => []);
    for (const pos of positions) {
        const amt = Math.abs(Number(pos.positionAmt));
        if (amt > 0) await placeMarket(pos.positionSide === 'LONG' ? 'SELL' : 'BUY', pos.positionSide, amt);
    }
    const msg = `🚨 EMERGENCY CLOSE | Profit: $${realProfit.toFixed(2)}`;
    notify(msg); return msg;
}

// ===================== TELEGRAM =====================
tgBot.start(ctx => ctx.reply('🤖 Grid Bot v3 | /grid_start /grid_stop /grid_status /grid_emergency'));
tgBot.command('grid_start', async ctx => ctx.reply(await startBot()));
tgBot.command('grid_stop', async ctx => ctx.reply(await stopBot()));
tgBot.command('grid_emergency', async ctx => ctx.reply(await emergencyClose()));
tgBot.command('grid_status', async ctx => {
    let slotInfo = slots.map(s => `  ${s.name}: ${s.status} | E:${s.entryPrice} T:${s.tpPrice} | Fills:${s.fillCount}`).join('\n');
    ctx.reply(`📊 ${botStatus} | Base: $${basePrice}\n${slotInfo}\nProfit: $${realProfit.toFixed(2)} | Cycles: ${cycleCount}`);
});
tgBot.command('grid_pos', async ctx => {
    try {
        const pos = await binance.futuresPositionRisk({ symbol: config.symbol });
        ctx.reply(pos.map(p => `${p.positionSide}: ${Number(p.positionAmt)} @ ${Number(p.entryPrice).toFixed(2)} | PnL: ${Number(p.unRealizedProfit).toFixed(2)}`).join('\n') || 'No pos');
    } catch (e) { ctx.reply(e.message); }
});

// ===================== DASHBOARD =====================
app.use(Express.static('./public'));
app.use(Express.json());

app.get('/grid', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
<title>Grid Bot v3</title><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#e1e5ea;font-family:'Segoe UI',sans-serif;padding:16px;max-width:1200px;margin:0 auto}
h1{color:#00d4aa;text-align:center;font-size:20px;margin-bottom:16px}
.tabs{display:flex;justify-content:center;gap:4px;margin-bottom:16px}
.tab{padding:8px 20px;border:1px solid #1e2940;border-radius:8px;background:#131a2a;color:#6b7a99;cursor:pointer;font-size:13px;font-weight:600;transition:all .2s}
.tab.active{background:#5b8def22;color:#5b8def;border-color:#5b8def}
.tab:hover{border-color:#5b8def}
.tab-content{display:none}.tab-content.active{display:block}
.controls{text-align:center;margin:12px 0}
.btn{padding:8px 20px;border:none;border-radius:8px;cursor:pointer;font-weight:600;margin:3px;font-size:12px}
.btn:hover{opacity:0.85}
.btn-start{background:#00d4aa;color:#0a0e17}
.btn-stop{background:#ffa502;color:#0a0e17}
.btn-emergency{background:#ff4757;color:#fff}
.btn-save{background:#5b8def;color:#fff;padding:10px 28px;font-size:14px;margin-top:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.stat{background:#131a2a;border:1px solid #1e2940;border-radius:10px;padding:12px}
.stat h4{color:#5b8def;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.stat .v{font-size:20px;font-weight:700;color:#fff}
.stat .sub{font-size:11px;color:#6b7a99;margin-top:2px}
.green{color:#00d4aa!important}.red{color:#ff4757!important}.yellow{color:#ffa502!important}.purple{color:#a855f7!important}
.slot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:12px}
.slot{background:#131a2a;border:1px solid #1e2940;border-radius:10px;padding:14px;position:relative}
.slot h4{font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.slot .badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge-idle{background:#6b7a9922;color:#6b7a99}
.badge-entry{background:#5b8def22;color:#5b8def}
.badge-filled{background:#ffa50222;color:#ffa502}
.badge-tp{background:#a855f722;color:#a855f7}
.slot .info{font-size:12px;color:#8b9cc0;line-height:1.8}
.slot .info span{color:#fff;font-weight:600}
#log{background:#0d1117;border:1px solid #1e2940;border-radius:8px;padding:10px;margin-top:12px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:10px;line-height:1.4}
/* Config */
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px}
.cfg-section{background:#131a2a;border:1px solid #1e2940;border-radius:12px;padding:16px}
.cfg-section h3{color:#5b8def;font-size:12px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e2940;text-transform:uppercase;letter-spacing:1px}
.cfg-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e294030}
.cfg-row:last-child{border:none}
.cfg-label{color:#8b9cc0;font-size:12px;flex:1}
.cfg-label .hint{display:block;color:#4a5568;font-size:10px;margin-top:1px}
.cfg-input{background:#0d1117;border:1px solid #1e2940;border-radius:6px;color:#e1e5ea;padding:6px 10px;font-size:13px;width:100px;text-align:right;font-family:'Segoe UI',sans-serif}
.cfg-input:focus{outline:none;border-color:#5b8def}
.cfg-toggle{position:relative;width:44px;height:24px;cursor:pointer}
.cfg-toggle input{display:none}
.cfg-toggle .slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#1e2940;border-radius:12px;transition:.3s}
.cfg-toggle .slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#6b7a99;border-radius:50%;transition:.3s}
.cfg-toggle input:checked+.slider{background:#00d4aa30}
.cfg-toggle input:checked+.slider:before{transform:translateX(20px);background:#00d4aa}
.save-msg{text-align:center;margin-top:8px;font-size:12px;min-height:18px}
.save-msg.ok{color:#00d4aa}.save-msg.err{color:#ff4757}
.cfg-json{background:#0d111780;border:1px solid #1e2940;border-radius:8px;padding:12px;margin-top:12px;font-family:monospace;font-size:11px;line-height:1.6;max-height:180px;overflow-y:auto;white-space:pre-wrap;color:#8b9cc0}
</style></head><body>
<h1>🤖 4-Slot Grid Bot v3.0</h1>
<div class="tabs">
    <div class="tab active" onclick="switchTab('monitor')">📊 Monitor</div>
    <div class="tab" onclick="switchTab('config')">⚙️ Config</div>
</div>

<!-- MONITOR -->
<div id="tab-monitor" class="tab-content active">
<div class="controls">
    <button class="btn btn-start" onclick="api('start')">▶ START</button>
    <button class="btn btn-stop" onclick="api('stop')">⏹ STOP</button>
    <button class="btn btn-emergency" onclick="if(confirm('Close ALL?'))api('emergency')">🚨 EMERGENCY</button>
</div>
<div class="stats">
    <div class="stat"><h4>Price</h4><div class="v" id="price">-</div></div>
    <div class="stat"><h4>Status</h4><div class="v" id="status">IDLE</div></div>
    <div class="stat"><h4>Profit</h4><div class="v green" id="profit">+$0.00</div><div class="sub" id="startEq">Start: -</div></div>
    <div class="stat"><h4>Equity</h4><div class="v" id="equity">-</div></div>
    <div class="stat"><h4>Drawdown</h4><div class="v green" id="drawdown">0.0%</div></div>
    <div class="stat"><h4>Base / Spacing</h4><div class="v" id="baseInfo">-</div></div>
    <div class="stat"><h4>ATR</h4><div class="v" id="atr">-</div></div>
    <div class="stat"><h4>Cycles</h4><div class="v purple" id="cycles">0</div><div class="sub" id="ordCount">Orders: 0</div></div>
</div>
<div class="slot-grid" id="slotGrid"></div>
<div id="log"></div>
</div>

<!-- CONFIG -->
<div id="tab-config" class="tab-content">
<div class="cfg-grid">
    <div class="cfg-section"><h3>🔲 Grid</h3>
        <div class="cfg-row"><div class="cfg-label">Symbol</div><input class="cfg-input" id="c-symbol" style="width:120px"></div>
        <div class="cfg-row"><div class="cfg-label">Spacing ($)<span class="hint">Khoảng cách lưới gần</span></div><input class="cfg-input" id="c-gridSpacing" type="number" step="10"></div>
        <div class="cfg-row"><div class="cfg-label">Catch Multiplier<span class="hint">Lần × spacing cho lệnh xa</span></div><input class="cfg-input" id="c-catchMultiplier" type="number" step="0.5"></div>
        <div class="cfg-row"><div class="cfg-label">Order Size<span class="hint">BTC mỗi lệnh</span></div><input class="cfg-input" id="c-orderSize" type="number" step="0.001"></div>
        <div class="cfg-row"><div class="cfg-label">Leverage</div><input class="cfg-input" id="c-leverage" type="number" step="1"></div>
    </div>
    <div class="cfg-section"><h3>🛡 Protection</h3>
        <div class="cfg-row"><div class="cfg-label">Max Drawdown %<span class="hint">% tối đa trước cắt lỗ</span></div><input class="cfg-input" id="c-dd-max" type="number" step="1"></div>
        <div class="cfg-row"><div class="cfg-label">Drawdown Enabled</div>
            <label class="cfg-toggle"><input type="checkbox" id="c-dd-enabled"><span class="slider"></span></label></div>
        <div class="cfg-row"><div class="cfg-label">Tick Interval (ms)<span class="hint">Chu kỳ check</span></div><input class="cfg-input" id="c-tickIntervalMs" type="number" step="500"></div>
    </div>
    <div class="cfg-section"><h3>📈 ATR</h3>
        <div class="cfg-row"><div class="cfg-label">Period</div><input class="cfg-input" id="c-atr-period" type="number" step="1"></div>
        <div class="cfg-row"><div class="cfg-label">Kline Interval</div><input class="cfg-input" id="c-atr-klineInterval" style="width:80px"></div>
    </div>
</div>
<div style="text-align:center;margin-top:16px">
    <button class="btn btn-save" id="saveBtn" onclick="saveCfg()">💾 Lưu cấu hình</button>
    <button class="btn" style="background:#1e2940;color:#6b7a99" onclick="loadCfg()">↻ Reset</button>
</div>
<div class="save-msg" id="saveMsg"></div>
<h4 style="color:#5b8def;font-size:11px;margin-top:16px;text-transform:uppercase;letter-spacing:1px">📋 JSON hiện tại</h4>
<div class="cfg-json" id="cfgJson">Loading...</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const logEl = document.getElementById('log');

function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));
    document.getElementById('tab-'+name).classList.add('active');
    event.target.classList.add('active');
    if(name==='config')loadCfg();
}
function api(a){fetch('/api/'+a,{method:'POST'}).then(r=>r.json()).then(d=>d.msg&&addLog(d.msg))}
function addLog(m){logEl.innerHTML+=m.replace(/\\n/g,'<br>')+'<br>';logEl.scrollTop=logEl.scrollHeight}

socket.on('status', d => {
    document.getElementById('price').textContent = '$' + Number(d.price).toLocaleString();
    const p = parseFloat(d.realProfit);
    document.getElementById('profit').textContent = (p>=0?'+$':'-$') + Math.abs(p).toFixed(2);
    document.getElementById('profit').className = 'v ' + (p>=0?'green':'red');
    document.getElementById('startEq').textContent = 'Start: $'+d.startEquity;
    document.getElementById('equity').textContent = '$'+d.equity;
    const dd = parseFloat(d.drawdown);
    document.getElementById('drawdown').textContent = dd.toFixed(1)+'%';
    document.getElementById('drawdown').className = 'v '+(dd>10?'red':dd>5?'yellow':'green');
    document.getElementById('status').textContent = d.botStatus;
    document.getElementById('status').className = 'v '+(d.botStatus==='RUNNING'?'green':d.botStatus==='EMERGENCY'?'red':'');
    document.getElementById('baseInfo').textContent = '$'+d.basePrice+' / $'+d.spacing;
    document.getElementById('atr').textContent = d.atr;
    document.getElementById('cycles').textContent = d.cycleCount;
    document.getElementById('ordCount').textContent = 'Orders: '+d.totalOrders;

    // Render slots
    const grid = document.getElementById('slotGrid');
    grid.innerHTML = d.slots.map(s => {
        const bc = {IDLE:'idle',ENTRY:'entry',FILLED:'filled',TP:'tp'}[s.status]||'idle';
        const icon = s.name.includes('far') ? '🏹' : '🎯';
        const dir = s.name.includes('Buy') ? '📉 BUY' : '📈 SELL';
        return '<div class="slot"><h4>'+icon+' '+s.name+' <span class="badge badge-'+bc+'">'+s.status+'</span></h4>' +
            '<div class="info">'+dir+'<br>Entry: <span>$'+s.entry+'</span><br>TP: <span>$'+s.tp+'</span><br>Fills: <span>'+s.fills+'</span></div></div>';
    }).join('');
});
socket.on('log', m => addLog(m));

// Config
const cfgFields = [
    {id:'c-symbol',path:'symbol'},{id:'c-gridSpacing',path:'gridSpacing',t:'n'},{id:'c-catchMultiplier',path:'catchMultiplier',t:'n'},
    {id:'c-orderSize',path:'orderSize',t:'n'},{id:'c-leverage',path:'leverage',t:'n'},
    {id:'c-dd-max',path:'drawdown.maxPercent',t:'n'},{id:'c-dd-enabled',path:'drawdown.trailingEnabled',t:'b'},
    {id:'c-tickIntervalMs',path:'tickIntervalMs',t:'n'},
    {id:'c-atr-period',path:'atr.period',t:'n'},{id:'c-atr-klineInterval',path:'atr.klineInterval'},
];
function gv(o,p){return p.split('.').reduce((a,k)=>a&&a[k],o)}
function sv(o,p,v){const k=p.split('.');const l=k.pop();k.reduce((a,k)=>{if(!a[k])a[k]={};return a[k]},o)[l]=v}
async function loadCfg(){
    try{const r=await fetch('/api/config');const c=await r.json();
    cfgFields.forEach(f=>{const el=document.getElementById(f.id);const v=gv(c,f.path);
    if(f.t==='b')el.checked=!!v;else el.value=v??''});
    document.getElementById('cfgJson').textContent=JSON.stringify(c,null,2);
    document.getElementById('saveMsg').textContent=''}catch(e){document.getElementById('saveMsg').textContent='Error';document.getElementById('saveMsg').className='save-msg err'}
}
async function saveCfg(){
    const body={};cfgFields.forEach(f=>{const el=document.getElementById(f.id);
    let v;if(f.t==='b')v=el.checked;else if(f.t==='n')v=parseFloat(el.value);else v=el.value;sv(body,f.path,v)});
    try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();if(d.ok){document.getElementById('saveMsg').textContent='✅ Saved!';document.getElementById('saveMsg').className='save-msg ok';loadCfg()}
    else throw new Error(d.error)}catch(e){document.getElementById('saveMsg').textContent='❌ '+e.message;document.getElementById('saveMsg').className='save-msg err'}
}
loadCfg();
</script></body></html>`);
});

// API
app.post('/api/start', async (req, res) => res.json({ ok: true, msg: await startBot() }));
app.post('/api/stop', async (req, res) => res.json({ ok: true, msg: await stopBot() }));
app.post('/api/emergency', async (req, res) => res.json({ ok: true, msg: await emergencyClose() }));

app.get('/api/config', (req, res) => { loadConfig(); res.json(config); });
app.post('/api/config', (req, res) => {
    try {
        function merge(t, s) { for (const k of Object.keys(s)) { if (s[k] && typeof s[k]==='object' && !Array.isArray(s[k]) && t[k]) merge(t[k],s[k]); else t[k]=s[k]; } }
        merge(config, req.body); saveConfig();
        log('CFG', 'Config updated from dashboard');
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/status', (req, res) => {
    res.json({ running, botStatus, basePrice, realProfit, startEquity, peakEquity, cycleCount,
        slots: slots.map(s => ({ name: s.name, status: s.status, entry: s.entryPrice, tp: s.tpPrice, fills: s.fillCount }))
    });
});

// ===================== STARTUP =====================
async function main() {
    loadConfig();
    log('MAIN', '4-Slot Grid Bot v3.0');
    log('MAIN', `${config.symbol} | Spacing: $${config.gridSpacing} | Catch: ${config.catchMultiplier}x`);
    server.listen(PORT, () => log('MAIN', `Dashboard: http://localhost:${PORT}/grid`));
    tgBot.launch().catch(e => log('MAIN', `TG: ${e.message}`));
    if (config.run) { log('MAIN', 'Auto-starting...'); await startBot(); }
    else log('MAIN', 'Waiting for START');
    process.once('SIGINT', async () => { await stopBot(); tgBot.stop(); process.exit(0); });
    process.once('SIGTERM', async () => { await stopBot(); tgBot.stop(); process.exit(0); });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
