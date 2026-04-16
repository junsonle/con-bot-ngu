/**
 * HYBRID GRID ENGINE v5.0 - Binance Futures Testnet
 * Multi-tier Position Management + Floating Grid + STOP_MARKET Hedge
 */
const Binance = require('node-binance-api');
const Express = require('express');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const CONFIG_PATH = './grid-config.json';
const STATE_PATH = './grid-state.json';
const FUTURES_TESTNET = 'https://testnet.binancefuture.com';
const PORT = 3001;

const binance = new Binance().options({
    APIKEY: process.env.APIKEY, APISECRET: process.env.APISECRET, test: true,
    urls: { base: 'https://testnet.binance.vision/api/', combineStream: 'wss://testnet.binance.vision/stream?streams=', stream: 'wss://fstream.binancefuture.com' }
});
const tgBot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_ID;
const app = Express();
const server = require('http').Server(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

// ===================== STATE =====================
let config = {};
let running = false;
let tickCount = 0;
let startEquity = 0, realProfit = 0, peakEquity = 0;
let configVersion = 0, configWatcher = null;
let botStatus = 'IDLE', cycleCount = 0;

// Volatility tracking
let prevTickPrice = 0, prevTradeCount = 0;
let rsPriceEma = 0, rsTradeEma = 0, volatileTicksRemaining = 0;

/**
 * POSITION CLUSTER: Dynamic collection of orders per side
 * longCluster: { layers: [{price, qty, orderId, status, type}], tpOrders: [...], stopOrderId }
 * shortCluster: same structure
 */
let longCluster = { layers: [], tpOrders: [], stopOrderId: null, avgPrice: 0 };
let shortCluster = { layers: [], tpOrders: [], stopOrderId: null, avgPrice: 0 };
let farBuyOrder = { price: 0, orderId: null, status: 'IDLE' };
let farSellOrder = { price: 0, orderId: null, status: 'IDLE' };
let anchorPrice = 0; // center of the grid

// ===================== HELPERS =====================
const delay = ms => new Promise(r => setTimeout(r, ms));
const roundPrice = p => Math.round(p * 100) / 100;
const roundQty = q => Math.round(q * 1000) / 1000;
const now = () => new Date().toLocaleTimeString('vi-VN');
function log(tag, msg) { const line = `[${now()}] [${tag}] ${msg}`; console.log(line); io.emit('log', line); return line; }
function notify(msg) { log('TG', msg); tgBot.telegram.sendMessage(chatId, msg).catch(() => {}); }

// ===================== CONFIG =====================
const DEFAULTS = {
    symbol: 'BTCUSDC', run: false, leverage: 20,
    gridSpacing: 50, catchMultiplier: 6, orderSize: 0.01,
    nearDirection: 'BOTH', enableFarBuy: true, enableFarSell: true,
    recenterThreshold: 2.5, slMultiplier: 4,
    
    // New Advanced Parameters added directly
    maxNearLayers: 3, 
    farAdjustThreshold: 0.5,
    takeProfit: { slowExitSpacing: 1, fastScaleOut: [0.5, 0.3, 0.2], minProfitToClose: 0.5 },
    hedge: { enableStopMarket: true, stopMarketSpacing: 1, autoHedgeThreshold: 2, hedgeUnlockMinProfit: 1.5 },
    volatility: { priceSurgeMultiplier: 4, volumeSurgeMultiplier: 5, minPriceSurgeRatio: 0.4, minVolumeDelta: 150, pauseTicks: 5 },
    drawdown: { trailingEnabled: true, maxPercent: 15 },
    tickIntervalMs: 3000
};

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        config = { ...DEFAULTS, ...raw };
        config.takeProfit = { ...DEFAULTS.takeProfit, ...(raw.takeProfit || {}) };
        config.hedge = { ...DEFAULTS.hedge, ...(raw.hedge || {}) };
        config.volatility = { ...DEFAULTS.volatility, ...(raw.volatility || {}) };
        config.drawdown = { ...DEFAULTS.drawdown, ...(raw.drawdown || {}) };
        configVersion++;
        return true;
    } catch (e) { log('CFG', `Error: ${e.message}`); return false; }
}
function saveConfig() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) {} }

function startConfigWatcher() {
    if (configWatcher) return;
    let debounce = null;
    configWatcher = fs.watch(CONFIG_PATH, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { if (loadConfig()) log('CFG', `🔄 Hot-reload v${configVersion}`); }, 500);
    });
    log('CFG', '👁 Watcher started');
}

// ===================== STATE PERSISTENCE =====================
function saveState() {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify({
            anchorPrice, startEquity, peakEquity, realProfit, cycleCount, botStatus, savedAt: Date.now(),
            longCluster: { layers: longCluster.layers, stopOrderId: longCluster.stopOrderId, avgPrice: longCluster.avgPrice },
            shortCluster: { layers: shortCluster.layers, stopOrderId: shortCluster.stopOrderId, avgPrice: shortCluster.avgPrice },
            farBuyOrder, farSellOrder
        }, null, 2));
    } catch (e) { log('STATE', `Save err: ${e.message}`); }
}
function clearState() { try { if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH); } catch (e) {} }

// ===================== SIGNED API =====================
async function signedRequest(method, path, params = {}) {
    const ts = Date.now();
    const allP = { ...params, timestamp: ts };
    const q = Object.entries(allP).map(([k, v]) => `${k}=${v}`).join('&');
    const sig = crypto.createHmac('sha256', process.env.APISECRET).update(q).digest('hex');
    const url = `${FUTURES_TESTNET}${path}?${q}&signature=${sig}`;
    const h = { 'X-MBX-APIKEY': process.env.APIKEY };
    return method === 'GET' ? (await axios.get(url, { headers: h })).data : (await axios.post(url, null, { headers: h })).data;
}

// ===================== ACCOUNT SETUP =====================
async function setupAccount() {
    try { await signedRequest('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'true' }); log('SETUP', 'Hedge ON'); }
    catch (e) { if (e.response?.data?.code === -4059) log('SETUP', 'Hedge ✓'); }
    try { await binance.futuresLeverage(config.symbol, config.leverage); } catch (e) {}
    try { await binance.futuresMarginType(config.symbol, 'CROSSED'); } catch (e) {}
}

// ===================== ORDER API =====================
async function placeLimit(side, posSide, price, qty) {
    const params = {
        symbol: config.symbol, side, type: 'LIMIT', positionSide: posSide,
        quantity: `${roundQty(qty)}`, price: `${roundPrice(price)}`,
        timeInForce: 'GTX', newOrderRespType: 'ACK'
    };
    try {
        const data = await binance.futuresMultipleOrders([params]);
        const r = data[0];
        if (r.code) {
            if (Number(r.code) === -2010 || (r.msg && r.msg.indexOf('Post Only') !== -1)) {
                log('ORDER', `🛡 GTX reject ${side} ${posSide} @ ${price}`);
                return 'REJECTED_GTX';
            }
            log('ORDER', `❌ LIMIT ${side} ${posSide} @ ${price}: ${r.msg}`); return null;
        }
        log('ORDER', `✅ LIMIT ${side} ${posSide} @ ${price} qty=${qty} id=${r.orderId}`);
        return r.orderId;
    } catch (e) { log('ORDER', `❌ LIMIT err: ${e.message}`); return null; }
}

async function placeStopMarket(side, posSide, stopPrice, qty) {
    try {
        const data = await binance.futuresMultipleOrders([{
            symbol: config.symbol, side, type: 'STOP_MARKET', positionSide: posSide,
            quantity: `${roundQty(qty)}`, stopPrice: `${roundPrice(stopPrice)}`, closePosition: 'false'
        }]);
        const r = data[0];
        if (r.code) { log('ORDER', `❌ STOP_MKT ${side} ${posSide} @ ${stopPrice}: ${r.msg}`); return null; }
        log('ORDER', `✅ STOP_MKT ${side} ${posSide} @ ${stopPrice} qty=${qty} id=${r.orderId}`);
        return r.orderId;
    } catch (e) { log('ORDER', `❌ STOP_MKT err: ${e.message}`); return null; }
}

async function placeMarket(side, posSide, qty) {
    try {
        const data = await binance.futuresMultipleOrders([{
            symbol: config.symbol, side, type: 'MARKET', positionSide: posSide,
            quantity: `${roundQty(qty)}`, newOrderRespType: 'ACK'
        }]);
        const r = data[0];
        if (r.code) { log('ORDER', `❌ MKT ${side} ${posSide}: ${r.msg}`); return null; }
        log('ORDER', `✅ MKT ${side} ${posSide} qty=${qty}`);
        return r.orderId;
    } catch (e) { log('ORDER', `❌ MKT err: ${e.message}`); return null; }
}

async function cancelOrder(orderId) {
    try { await binance.futuresCancel(config.symbol, { orderId: `${orderId}` }); return true; } catch (e) { return false; }
}
async function cancelAllOrders() {
    try { await binance.futuresCancelAll(config.symbol); log('ORDER', '🗑 ALL cancelled'); } catch (e) {}
}

// ===================== CLUSTER HELPERS =====================
function clusterQty(cluster) {
    return cluster.layers.filter(l => l.status === 'FILLED').reduce((s, l) => s + l.qty, 0);
}
function clusterAvgPrice(cluster) {
    const filled = cluster.layers.filter(l => l.status === 'FILLED');
    if (filled.length === 0) return 0;
    const totalCost = filled.reduce((s, l) => s + l.price * l.qty, 0);
    const totalQty = filled.reduce((s, l) => s + l.qty, 0);
    return roundPrice(totalCost / totalQty);
}
function clusterPendingCount(cluster) {
    return cluster.layers.filter(l => l.status === 'PENDING').length;
}
function clusterFilledCount(cluster) {
    return cluster.layers.filter(l => l.status === 'FILLED').length;
}

// ===================== CORE ENGINE =====================

/**
 * MODULE 1: Near Grid (Floating Limit Grid)
 * - Place 2 limit orders bracketing current price
 * - On fill: add new layer in same direction + move opposite order closer
 * - Max layers controlled by config.grid.maxNearLayers
 */
async function processNearGrid(price, openOrderIds) {
    const spacing = config.gridSpacing;
    const maxLayers = config.maxNearLayers;
    let changed = false;

    // === LONG SIDE ===
    if (config.nearDirection !== 'SHORT_ONLY') {
        const pendingLongs = longCluster.layers.filter(l => l.status === 'PENDING');
        const filledLongs = longCluster.layers.filter(l => l.status === 'FILLED');

        // Check fills
        for (const layer of pendingLongs) {
            if (!openOrderIds.has(layer.orderId)) {
                layer.status = 'FILLED';
                log('GRID', `📦 LONG filled @ ${layer.price} (layer ${filledLongs.length + 1})`);
                notify(`📦 LONG filled @ ${layer.price}`);
                changed = true;
            }
        }

        // Place new entry if room
        const totalLongLayers = longCluster.layers.filter(l => l.status === 'PENDING' || l.status === 'FILLED').length;
        if (totalLongLayers === 0) {
            // No orders at all - place first buy below price
            const buyPrice = roundPrice(price - spacing);
            const oid = await placeLimit('BUY', 'LONG', buyPrice, config.orderSize);
            if (oid && oid !== 'REJECTED_GTX') {
                longCluster.layers.push({ price: buyPrice, qty: config.orderSize, orderId: oid, status: 'PENDING', type: 'LIMIT' });
                changed = true;
            }
        } else if (changed) {
            // Just had a fill - place next layer deeper if under max
            const newFilledLongs = longCluster.layers.filter(l => l.status === 'FILLED');
            if (newFilledLongs.length < maxLayers) {
                const deepest = Math.min(...newFilledLongs.map(l => l.price));
                const nextPrice = roundPrice(deepest - spacing);
                const oid = await placeLimit('BUY', 'LONG', nextPrice, config.orderSize);
                if (oid && oid !== 'REJECTED_GTX') {
                    longCluster.layers.push({ price: nextPrice, qty: config.orderSize, orderId: oid, status: 'PENDING', type: 'LIMIT' });
                }
            }
        }
    }

    // === SHORT SIDE ===
    if (config.nearDirection !== 'LONG_ONLY') {
        const pendingShorts = shortCluster.layers.filter(l => l.status === 'PENDING');
        const filledShorts = shortCluster.layers.filter(l => l.status === 'FILLED');

        for (const layer of pendingShorts) {
            if (!openOrderIds.has(layer.orderId)) {
                layer.status = 'FILLED';
                log('GRID', `📦 SHORT filled @ ${layer.price} (layer ${filledShorts.length + 1})`);
                notify(`📦 SHORT filled @ ${layer.price}`);
                changed = true;
            }
        }

        const totalShortLayers = shortCluster.layers.filter(l => l.status === 'PENDING' || l.status === 'FILLED').length;
        if (totalShortLayers === 0) {
            const sellPrice = roundPrice(price + spacing);
            const oid = await placeLimit('SELL', 'SHORT', sellPrice, config.orderSize);
            if (oid && oid !== 'REJECTED_GTX') {
                shortCluster.layers.push({ price: sellPrice, qty: config.orderSize, orderId: oid, status: 'PENDING', type: 'LIMIT' });
                changed = true;
            }
        } else if (changed) {
            const newFilledShorts = shortCluster.layers.filter(l => l.status === 'FILLED');
            if (newFilledShorts.length < maxLayers) {
                const highest = Math.max(...newFilledShorts.map(l => l.price));
                const nextPrice = roundPrice(highest + spacing);
                const oid = await placeLimit('SELL', 'SHORT', nextPrice, config.orderSize);
                if (oid && oid !== 'REJECTED_GTX') {
                    shortCluster.layers.push({ price: nextPrice, qty: config.orderSize, orderId: oid, status: 'PENDING', type: 'LIMIT' });
                }
            }
        }
    }

    // Update avg prices
    longCluster.avgPrice = clusterAvgPrice(longCluster);
    shortCluster.avgPrice = clusterAvgPrice(shortCluster);

    if (changed) saveState();
    return changed;
}

/**
 * MODULE 2: Far Orders (Anchor Catchers)
 * - Sit far from price, catch flash wicks
 * - Only adjust when price drifts > 50% of distance
 */
async function processFarOrders(price, openOrderIds) {
    if (!config.enableFarBuy && !config.enableFarSell) return;
    const farDist = config.gridSpacing * config.catchMultiplier;
    const adjustThreshold = config.farAdjustThreshold;

    // Far Buy
    if (config.enableFarBuy) {
        if (farBuyOrder.status === 'IDLE' || !farBuyOrder.orderId) {
            const fbPrice = roundPrice(price - farDist);
            const oid = await placeLimit('BUY', 'LONG', fbPrice, config.orderSize);
            if (oid && oid !== 'REJECTED_GTX') {
                farBuyOrder = { price: fbPrice, orderId: oid, status: 'PENDING' };
            }
        } else if (farBuyOrder.status === 'PENDING') {
            if (!openOrderIds.has(farBuyOrder.orderId)) {
                // Far buy filled! Add to long cluster
                log('GRID', `🎣 FAR BUY filled @ ${farBuyOrder.price}!`);
                notify(`🎣 FAR BUY filled @ ${farBuyOrder.price}!`);
                longCluster.layers.push({ price: farBuyOrder.price, qty: config.orderSize, orderId: null, status: 'FILLED', type: 'FAR' });
                longCluster.avgPrice = clusterAvgPrice(longCluster);
                farBuyOrder = { price: 0, orderId: null, status: 'IDLE' };
            } else {
                // Check if needs adjustment (price moved 50%+ toward far order)
                const distToOrder = price - farBuyOrder.price;
                if (distToOrder > farDist * (1 + adjustThreshold)) {
                    await cancelOrder(farBuyOrder.orderId);
                    farBuyOrder = { price: 0, orderId: null, status: 'IDLE' };
                } else if (distToOrder < farDist * (1 - adjustThreshold) && distToOrder > 0) {
                    await cancelOrder(farBuyOrder.orderId);
                    farBuyOrder = { price: 0, orderId: null, status: 'IDLE' };
                }
            }
        }
    }

    // Far Sell
    if (config.enableFarSell) {
        if (farSellOrder.status === 'IDLE' || !farSellOrder.orderId) {
            const fsPrice = roundPrice(price + farDist);
            const oid = await placeLimit('SELL', 'SHORT', fsPrice, config.orderSize);
            if (oid && oid !== 'REJECTED_GTX') {
                farSellOrder = { price: fsPrice, orderId: oid, status: 'PENDING' };
            }
        } else if (farSellOrder.status === 'PENDING') {
            if (!openOrderIds.has(farSellOrder.orderId)) {
                log('GRID', `🎣 FAR SELL filled @ ${farSellOrder.price}!`);
                notify(`🎣 FAR SELL filled @ ${farSellOrder.price}!`);
                shortCluster.layers.push({ price: farSellOrder.price, qty: config.orderSize, orderId: null, status: 'FILLED', type: 'FAR' });
                shortCluster.avgPrice = clusterAvgPrice(shortCluster);
                farSellOrder = { price: 0, orderId: null, status: 'IDLE' };
            } else {
                const distToOrder = farSellOrder.price - price;
                if (distToOrder > farDist * (1 + adjustThreshold)) {
                    await cancelOrder(farSellOrder.orderId);
                    farSellOrder = { price: 0, orderId: null, status: 'IDLE' };
                } else if (distToOrder < farDist * (1 - adjustThreshold) && distToOrder > 0) {
                    await cancelOrder(farSellOrder.orderId);
                    farSellOrder = { price: 0, orderId: null, status: 'IDLE' };
                }
            }
        }
    }

    saveState();
}

/**
 * MODULE 3: Dynamic Take Profit
 * - Slow market + many layers: TP at avg price + spacing (escape at breakeven+)
 * - Fast market / wick bounce: Scale out in tiers for max profit
 * - Hedged: Hold profitable side to offset losing side
 */
async function processTakeProfit(price, isVolatile) {
    const tp = config.takeProfit;
    const spacing = config.gridSpacing;

    const longFilled = clusterFilledCount(longCluster);
    const shortFilled = clusterFilledCount(shortCluster);
    const longQty = clusterQty(longCluster);
    const shortQty = clusterQty(shortCluster);
    const isHedged = longFilled > 0 && shortFilled > 0;

    // === LONG TAKE PROFIT ===
    if (longFilled > 0 && price > longCluster.avgPrice) {
        const profitDist = price - longCluster.avgPrice;

        if (isHedged) {
            // Hedged mode: only close if profit covers the losing hedge side's loss
            const shortLoss = shortFilled > 0 ? (price - shortCluster.avgPrice) * shortQty : 0;
            const longProfit = profitDist * longQty;
            if (longProfit > Math.abs(shortLoss) * config.hedge.hedgeUnlockMinProfit) {
                log('TP', `🔓 Hedge unlock LONG: profit $${longProfit.toFixed(2)} > loss $${Math.abs(shortLoss).toFixed(2)}`);
                await closeCluster(longCluster, 'SELL', 'LONG');
                await closeCluster(shortCluster, 'BUY', 'SHORT');
                cycleCount++;
            }
        } else if (isVolatile && longFilled >= 2) {
            // Fast market: scale out in tiers
            if (profitDist >= spacing * 2) {
                const closeQty = roundQty(longQty * (tp.fastScaleOut[0] || 0.5));
                if (closeQty >= config.orderSize) {
                    log('TP', `🚀 Fast TP LONG: closing ${closeQty} @ MKT (profit $${profitDist.toFixed(0)})`);
                    await placeMarket('SELL', 'LONG', closeQty);
                    removeLayersFromCluster(longCluster, closeQty);
                    cycleCount++;
                }
            }
        } else {
            // Slow market: close all at avg + spacing
            if (profitDist >= spacing * tp.slowExitSpacing) {
                log('TP', `💰 Slow TP LONG: avg=${longCluster.avgPrice} profit=$${profitDist.toFixed(0)}`);
                await closeCluster(longCluster, 'SELL', 'LONG');
                cycleCount++;
            }
        }
    }

    // === SHORT TAKE PROFIT ===
    if (shortFilled > 0 && price < shortCluster.avgPrice) {
        const profitDist = shortCluster.avgPrice - price;

        if (isHedged) {
            const longLoss = longFilled > 0 ? (longCluster.avgPrice - price) * longQty : 0;
            const shortProfit = profitDist * shortQty;
            if (shortProfit > Math.abs(longLoss) * config.hedge.hedgeUnlockMinProfit) {
                log('TP', `🔓 Hedge unlock SHORT: profit $${shortProfit.toFixed(2)} > loss $${Math.abs(longLoss).toFixed(2)}`);
                await closeCluster(shortCluster, 'BUY', 'SHORT');
                await closeCluster(longCluster, 'SELL', 'LONG');
                cycleCount++;
            }
        } else if (isVolatile && shortFilled >= 2) {
            if (profitDist >= spacing * 2) {
                const closeQty = roundQty(shortQty * (tp.fastScaleOut[0] || 0.5));
                if (closeQty >= config.orderSize) {
                    log('TP', `🚀 Fast TP SHORT: closing ${closeQty} @ MKT (profit $${profitDist.toFixed(0)})`);
                    await placeMarket('BUY', 'SHORT', closeQty);
                    removeLayersFromCluster(shortCluster, closeQty);
                    cycleCount++;
                }
            }
        } else {
            if (profitDist >= spacing * tp.slowExitSpacing) {
                log('TP', `💰 Slow TP SHORT: avg=${shortCluster.avgPrice} profit=$${profitDist.toFixed(0)}`);
                await closeCluster(shortCluster, 'BUY', 'SHORT');
                cycleCount++;
            }
        }
    }
}

async function closeCluster(cluster, side, posSide) {
    // Cancel pending orders
    for (const l of cluster.layers) {
        if (l.status === 'PENDING' && l.orderId) await cancelOrder(l.orderId);
    }
    const qty = clusterQty(cluster);
    if (qty > 0) await placeMarket(side, posSide, qty);
    cluster.layers = [];
    cluster.avgPrice = 0;
    cluster.tpOrders = [];
    notify(`💰 ${posSide} cluster closed | qty=${qty}`);
    saveState();
}

function removeLayersFromCluster(cluster, qtyToRemove) {
    let remaining = qtyToRemove;
    // Remove oldest filled layers first
    cluster.layers = cluster.layers.filter(l => {
        if (l.status === 'FILLED' && remaining > 0) {
            remaining = roundQty(remaining - l.qty);
            return false;
        }
        return true;
    });
    cluster.avgPrice = clusterAvgPrice(cluster);
    saveState();
}

/**
 * MODULE 4: STOP_MARKET Hedge Protection
 * - When market moves fast against position, place STOP_MARKET to hedge
 * - Prevents account blowup by locking loss
 */
async function processHedgeProtection(price, isVolatile, openOrderIds) {
    if (!config.hedge.enableStopMarket) return;
    const h = config.hedge;
    const spacing = config.gridSpacing;

    const longFilled = clusterFilledCount(longCluster);
    const shortFilled = clusterFilledCount(shortCluster);

    // If holding LONG but no SHORT protection and market dropping fast
    if (longFilled > 0 && shortFilled === 0 && isVolatile) {
        if (!shortCluster.stopOrderId || !openOrderIds.has(shortCluster.stopOrderId)) {
            const stopPrice = roundPrice(longCluster.avgPrice - spacing * h.autoHedgeThreshold);
            if (price < longCluster.avgPrice && price > stopPrice) {
                const hedgeQty = clusterQty(longCluster);
                const oid = await placeStopMarket('SELL', 'SHORT', stopPrice, hedgeQty);
                if (oid) {
                    shortCluster.stopOrderId = oid;
                    log('HEDGE', `🛡 STOP_MKT SELL placed @ ${stopPrice} qty=${hedgeQty} (protect LONG)`);
                }
            }
        }
    }

    // If holding SHORT but no LONG protection and market pumping fast
    if (shortFilled > 0 && longFilled === 0 && isVolatile) {
        if (!longCluster.stopOrderId || !openOrderIds.has(longCluster.stopOrderId)) {
            const stopPrice = roundPrice(shortCluster.avgPrice + spacing * h.autoHedgeThreshold);
            if (price > shortCluster.avgPrice && price < stopPrice) {
                const hedgeQty = clusterQty(shortCluster);
                const oid = await placeStopMarket('BUY', 'LONG', stopPrice, hedgeQty);
                if (oid) {
                    longCluster.stopOrderId = oid;
                    log('HEDGE', `🛡 STOP_MKT BUY placed @ ${stopPrice} qty=${hedgeQty} (protect SHORT)`);
                }
            }
        }
    }

    // Check if stop orders got filled (became positions)
    if (longCluster.stopOrderId && !openOrderIds.has(longCluster.stopOrderId)) {
        log('HEDGE', `🔒 STOP_MKT BUY FILLED - LONG hedge activated`);
        const hedgeQty = clusterQty(shortCluster);
        longCluster.layers.push({ price: price, qty: hedgeQty, orderId: null, status: 'FILLED', type: 'HEDGE' });
        longCluster.avgPrice = clusterAvgPrice(longCluster);
        longCluster.stopOrderId = null;
    }
    if (shortCluster.stopOrderId && !openOrderIds.has(shortCluster.stopOrderId)) {
        log('HEDGE', `🔒 STOP_MKT SELL FILLED - SHORT hedge activated`);
        const hedgeQty = clusterQty(longCluster);
        shortCluster.layers.push({ price: price, qty: hedgeQty, orderId: null, status: 'FILLED', type: 'HEDGE' });
        shortCluster.avgPrice = clusterAvgPrice(shortCluster);
        shortCluster.stopOrderId = null;
    }
}

// ===================== DRAWDOWN SHIELD =====================
async function checkDrawdown(equity) {
    if (!config.drawdown?.trailingEnabled) return false;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity === 0) return false;
    const dd = ((peakEquity - equity) / peakEquity) * 100;
    if (dd >= config.drawdown.maxPercent) {
        log('SHIELD', `🚨 DRAWDOWN ${dd.toFixed(1)}% → EMERGENCY`);
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

// ===================== VOLATILITY ENGINE =====================
function updateVolatility(price, ticker24) {
    const vc = config.volatility;
    if (prevTickPrice > 0 && ticker24) {
        const priceDelta = Math.abs(price - prevTickPrice);
        const count = parseInt(ticker24.count);
        const countDelta = count - (prevTradeCount || count);
        rsPriceEma = rsPriceEma === 0 ? priceDelta : (rsPriceEma * 0.95 + priceDelta * 0.05);
        rsTradeEma = rsTradeEma === 0 ? countDelta : (rsTradeEma * 0.95 + countDelta * 0.05);
        const priceSurge = priceDelta > Math.max(rsPriceEma * vc.priceSurgeMultiplier, config.gridSpacing * vc.minPriceSurgeRatio);
        const volumeSurge = countDelta > Math.max(rsTradeEma * vc.volumeSurgeMultiplier, vc.minVolumeDelta);
        if (priceSurge || volumeSurge) {
            volatileTicksRemaining = vc.pauseTicks;
            log('VOL', `⚡ SPIKE: PΔ${priceDelta.toFixed(1)}(avg:${rsPriceEma.toFixed(1)}) TΔ${countDelta}(avg:${rsTradeEma.toFixed(1)})`);
        } else if (volatileTicksRemaining > 0) { volatileTicksRemaining--; }
        prevTradeCount = count;
    }
    prevTickPrice = price;
    return volatileTicksRemaining > 0;
}

// ===================== MAIN TICK LOOP =====================
async function tick() {
    log('ENGINE', '🚀 Tick started');
    while (running) {
        try {
            tickCount++;
            const [balances, prices, orders, ticker24] = await Promise.all([
                binance.futuresBalance().catch(() => null),
                binance.futuresPrices().catch(() => null),
                binance.futuresOpenOrders(config.symbol).catch(() => []),
                signedRequest('GET', '/fapi/v1/ticker/24hr', { symbol: config.symbol }).catch(() => null)
            ]);
            if (!prices || !prices[config.symbol]) { await delay(config.tickIntervalMs); continue; }
            const price = parseFloat(prices[config.symbol]);

            let equity = 0;
            if (balances?.length > 0) {
                const coin = balances.find(b => config.symbol.indexOf(b.asset) > 0);
                if (coin) { equity = parseFloat(coin.balance) + parseFloat(coin.crossUnPnl); if (peakEquity === 0) peakEquity = equity; }
            }
            if (startEquity > 0 && equity > 0) realProfit = equity - startEquity;
            if (await checkDrawdown(equity)) break;

            const isVolatile = updateVolatility(price, ticker24);
            const openOrderIds = new Set(orders.map(o => o.orderId));

            // Core modules
            await processNearGrid(price, openOrderIds);
            await processFarOrders(price, openOrderIds);
            await processTakeProfit(price, isVolatile);
            await processHedgeProtection(price, isVolatile, openOrderIds);

            // Create simulated slots array for backward compatibility
            const getStatus = (c) => c.layers.length > 0 ? (c.layers.some(l=>l.status==='PENDING')?'ENTRY':'FILLED') : 'IDLE';
            const simulatedSlots = [];
            simulatedSlots.push({ name: 'nearBuy', status: getStatus(longCluster), entry: longCluster.avgPrice, tp: longCluster.avgPrice+config.gridSpacing, fills: clusterFilledCount(longCluster) });
            simulatedSlots.push({ name: 'nearSell', status: getStatus(shortCluster), entry: shortCluster.avgPrice, tp: shortCluster.avgPrice-config.gridSpacing, fills: clusterFilledCount(shortCluster) });
            simulatedSlots.push({ name: 'farBuy', status: config.enableFarBuy ? farBuyOrder.status : 'DISABLED', entry: farBuyOrder.price, tp: farBuyOrder.price+config.gridSpacing, fills: 0 });
            simulatedSlots.push({ name: 'farSell', status: config.enableFarSell ? farSellOrder.status : 'DISABLED', entry: farSellOrder.price, tp: farSellOrder.price-config.gridSpacing, fills: 0 });

            // Dashboard emit
            io.emit('status', {
                price, equity: equity.toFixed(2), startEquity: startEquity.toFixed(2),
                realProfit: realProfit.toFixed(2), peakEquity: peakEquity.toFixed(2),
                drawdown: peakEquity > 0 ? ((peakEquity - equity) / peakEquity * 100).toFixed(1) : '0.0',
                anchorPrice, spacing: config.gridSpacing, botStatus, cycleCount,
                isVolatile, totalOrders: orders.length,
                longLayers: longCluster.layers.length, longFilled: clusterFilledCount(longCluster), longAvg: longCluster.avgPrice,
                shortLayers: shortCluster.layers.length, shortFilled: clusterFilledCount(shortCluster), shortAvg: shortCluster.avgPrice,
                farBuy: farBuyOrder, farSell: farSellOrder, tickCount,
                nearDirection: config.nearDirection,
                slots: simulatedSlots
            });

            if (tickCount % 15 === 0) {
                const lf = clusterFilledCount(longCluster), sf = clusterFilledCount(shortCluster);
                log('SUM', `$${price} | Eq:$${equity.toFixed(2)} | P:$${realProfit.toFixed(2)} | L:${lf}/${longCluster.layers.length} S:${sf}/${shortCluster.layers.length} | Far:${farBuyOrder.status}/${farSellOrder.status} | Vol:${isVolatile?'⚡':'🌤'} | Cy:${cycleCount}`);
            }
        } catch (e) { log('ERR', e.message); }
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

    await cancelAllOrders();
    
    // Initialize clusters
    longCluster = { layers: [], tpOrders: [], stopOrderId: null, avgPrice: 0 };
    shortCluster = { layers: [], tpOrders: [], stopOrderId: null, avgPrice: 0 };
    
    // Adopt existing positions instead of closing them!
    const positions = await binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => []);
    for (const pos of positions) {
        const amt = Math.abs(Number(pos.positionAmt));
        if (amt > 0) { 
            const entryPrice = parseFloat(pos.entryPrice);
            log('START', `Adopting existing ${pos.positionSide} position: ${amt} @ ${entryPrice}`);
            if (pos.positionSide === 'LONG') {
                longCluster.layers.push({ price: entryPrice, qty: amt, orderId: null, status: 'FILLED', type: 'ADOPTED' });
            } else if (pos.positionSide === 'SHORT') {
                shortCluster.layers.push({ price: entryPrice, qty: amt, orderId: null, status: 'FILLED', type: 'ADOPTED' });
            }
        }
    }
    longCluster.avgPrice = clusterAvgPrice(longCluster);
    shortCluster.avgPrice = clusterAvgPrice(shortCluster);
    await delay(1000);

    const bal = await binance.futuresBalance().catch(() => null);
    if (bal?.length > 0) {
        const coin = bal.find(b => config.symbol.indexOf(b.asset) > 0);
        if (coin) startEquity = parseFloat(coin.balance) + parseFloat(coin.crossUnPnl);
    }

    anchorPrice = roundPrice(price);
    farBuyOrder = { price: 0, orderId: null, status: 'IDLE' };
    farSellOrder = { price: 0, orderId: null, status: 'IDLE' };
    realProfit = 0; peakEquity = 0; tickCount = 0; cycleCount = 0;
    running = true; botStatus = 'RUNNING'; config.run = true; saveConfig(); saveState();

    const msg = `🤖 Hybrid Grid v5.0 STARTED\nSymbol: ${config.symbol} | Lev: ${config.leverage}x\nAnchor: $${anchorPrice} | Spacing: $${config.gridSpacing}\nMax Layers: ${config.maxNearLayers} | Far: ${config.catchMultiplier}x\nEquity: $${startEquity.toFixed(2)}`;
    notify(msg); tick(); return msg;
}

async function stopBot() {
    running = false; botStatus = 'IDLE'; config.run = false; saveConfig(); saveState();
    await cancelAllOrders(); clearState();
    const msg = `🛑 STOPPED | P:$${realProfit.toFixed(2)} | Cycles:${cycleCount}`;
    notify(msg); return msg;
}

async function emergencyClose() {
    running = false; botStatus = 'EMERGENCY'; config.run = false; saveConfig(); clearState();
    await cancelAllOrders();
    const positions = await binance.futuresPositionRisk({ symbol: config.symbol }).catch(() => []);
    for (const pos of positions) {
        const amt = Math.abs(Number(pos.positionAmt));
        if (amt > 0) await placeMarket(pos.positionSide === 'LONG' ? 'SELL' : 'BUY', pos.positionSide, amt);
    }
    const msg = `🚨 EMERGENCY CLOSE | P:$${realProfit.toFixed(2)}`;
    notify(msg); return msg;
}

// ===================== TELEGRAM =====================
tgBot.start(ctx => ctx.reply('🤖 Hybrid Grid v5 | /start_bot /stop_bot /status /emergency'));
tgBot.command('start_bot', async ctx => ctx.reply(await startBot()));
tgBot.command('stop_bot', async ctx => ctx.reply(await stopBot()));
tgBot.command('emergency', async ctx => ctx.reply(await emergencyClose()));
tgBot.command('status', async ctx => {
    const lf = clusterFilledCount(longCluster), sf = clusterFilledCount(shortCluster);
    ctx.reply(`📊 ${botStatus}\nLONG: ${lf} layers | avg:$${longCluster.avgPrice}\nSHORT: ${sf} layers | avg:$${shortCluster.avgPrice}\nP:$${realProfit.toFixed(2)} | Cy:${cycleCount}`);
});

// ===================== DASHBOARD =====================
app.use(Express.static('./public'));
app.use(Express.json());

app.get('/grid', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
<title>Hybrid Grid v5</title><meta charset="utf-8">
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
.btn-start{background:#00d4aa;color:#0a0e17}.btn-stop{background:#ffa502;color:#0a0e17}.btn-emergency{background:#ff4757;color:#fff}
.btn-save{background:#5b8def;color:#fff;padding:10px 28px;font-size:14px;margin-top:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px}
.stat{background:#131a2a;border:1px solid #1e2940;border-radius:10px;padding:12px}
.stat h4{color:#5b8def;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.stat .v{font-size:18px;font-weight:700;color:#fff}
.green{color:#00d4aa!important}.red{color:#ff4757!important}.yellow{color:#ffa502!important}.purple{color:#a855f7!important}
.cluster{background:#131a2a;border:1px solid #1e2940;border-radius:10px;padding:14px;margin-bottom:10px}
.cluster h3{font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.cluster .info{font-size:12px;color:#8b9cc0;line-height:1.8}
.cluster .info span{color:#fff;font-weight:600}
#log{background:#0d1117;border:1px solid #1e2940;border-radius:8px;padding:10px;margin-top:12px;max-height:250px;overflow-y:auto;font-family:monospace;font-size:10px;line-height:1.4}
/* Config */
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px}
.cfg-section{background:#131a2a;border:1px solid #1e2940;border-radius:12px;padding:16px}
.cfg-section h3{color:#5b8def;font-size:12px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e2940;text-transform:uppercase;letter-spacing:1px}
.cfg-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e294030}
.cfg-label{color:#8b9cc0;font-size:12px;flex:1}
.cfg-input{background:#0d1117;border:1px solid #1e2940;border-radius:6px;color:#e1e5ea;padding:6px 10px;font-size:13px;width:100px;text-align:right;}
.cfg-toggle{position:relative;width:44px;height:24px;cursor:pointer}
.cfg-toggle input{display:none}
.cfg-toggle .slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#1e2940;border-radius:12px;transition:.3s}
.cfg-toggle .slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#6b7a99;border-radius:50%;transition:.3s}
.cfg-toggle input:checked+.slider{background:#00d4aa30}
.cfg-toggle input:checked+.slider:before{transform:translateX(20px);background:#00d4aa}
</style></head><body>
<h1>🤖 Hybrid Grid Engine v5.0</h1>
<div class="tabs">
    <div class="tab active" onclick="switchTab('monitor')">📊 Monitor</div>
    <div class="tab" onclick="switchTab('config')">⚙️ Config</div>
</div>

<div id="tab-monitor" class="tab-content active">
<div class="controls">
    <button class="btn btn-start" onclick="api('start')">▶ START</button>
    <button class="btn btn-stop" onclick="api('stop')">⏹ STOP</button>
    <button class="btn btn-emergency" onclick="if(confirm('Close ALL?'))api('emergency')">🚨 EMERGENCY</button>
</div>
<div class="stats">
    <div class="stat"><h4>Price</h4><div class="v" id="price">-</div></div>
    <div class="stat"><h4>Status</h4><div class="v" id="status">IDLE</div></div>
    <div class="stat"><h4>Profit</h4><div class="v green" id="profit">$0.00</div></div>
    <div class="stat"><h4>Equity</h4><div class="v" id="equity">-</div></div>
    <div class="stat"><h4>Drawdown</h4><div class="v green" id="drawdown">0.0%</div></div>
    <div class="stat"><h4>Volatility</h4><div class="v" id="vol">🌤</div></div>
    <div class="stat"><h4>Cycles</h4><div class="v purple" id="cycles">0</div></div>
    <div class="stat"><h4>Orders</h4><div class="v" id="orders">0</div></div>
</div>
<div class="cluster"><h3>📈 LONG Cluster</h3><div class="info" id="longInfo">-</div></div>
<div class="cluster"><h3>📉 SHORT Cluster</h3><div class="info" id="shortInfo">-</div></div>
<div class="cluster"><h3>🏹 Far Orders</h3><div class="info" id="farInfo">-</div></div>
<div id="log"></div>
</div>

<div id="tab-config" class="tab-content">
<div class="cfg-grid">
    <div class="cfg-section"><h3>🔲 Grid</h3>
        <div class="cfg-row"><div class="cfg-label">Symbol</div><input class="cfg-input" id="c-symbol" style="width:120px"></div>
        <div class="cfg-row"><div class="cfg-label">Spacing ($)</div><input class="cfg-input" id="c-gridSpacing" type="number" step="10"></div>
        <div class="cfg-row"><div class="cfg-label">Catch Multiplier</div><input class="cfg-input" id="c-catchMultiplier" type="number" step="0.5"></div>
        <div class="cfg-row"><div class="cfg-label">Order Size</div><input class="cfg-input" id="c-orderSize" type="number" step="0.001"></div>
        <div class="cfg-row"><div class="cfg-label">Max Layers</div><input class="cfg-input" id="c-maxNearLayers" type="number" step="1"></div>
    </div>
    <div class="cfg-section"><h3>🧭 Direction</h3>
        <div class="cfg-row"><div class="cfg-label">Near Direction</div><input class="cfg-input" id="c-nearDirection" style="width:120px"></div>
        <div class="cfg-row"><div class="cfg-label">Enable Far Buy</div><label class="cfg-toggle"><input type="checkbox" id="c-enableFarBuy"><span class="slider"></span></label></div>
        <div class="cfg-row"><div class="cfg-label">Enable Far Sell</div><label class="cfg-toggle"><input type="checkbox" id="c-enableFarSell"><span class="slider"></span></label></div>
        <div class="cfg-row"><div class="cfg-label">Enable Stop Hedge</div><label class="cfg-toggle"><input type="checkbox" id="c-hedge-enableStopMarket"><span class="slider"></span></label></div>
    </div>
    <div class="cfg-section"><h3>🛡 Protection</h3>
        <div class="cfg-row"><div class="cfg-label">Max Drawdown %</div><input class="cfg-input" id="c-dd-max" type="number" step="1"></div>
        <div class="cfg-row"><div class="cfg-label">Drawdown Enabled</div><label class="cfg-toggle"><input type="checkbox" id="c-dd-enabled"><span class="slider"></span></label></div>
        <div class="cfg-row"><div class="cfg-label">Tick Interval (ms)</div><input class="cfg-input" id="c-tickIntervalMs" type="number" step="500"></div>
    </div>
</div>
<div style="text-align:center;margin-top:16px">
    <button class="btn btn-save" onclick="saveCfg()">💾 Lưu cấu hình</button>
</div>
<div id="saveMsg" style="text-align:center;margin-top:8px;font-size:12px;"></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket=io(),logEl=document.getElementById('log');
function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));
    document.getElementById('tab-'+name).classList.add('active');
    event.target.classList.add('active');
    if(name==='config')loadCfg();
}
function api(a){fetch('/api/'+a,{method:'POST'}).then(r=>r.json()).then(d=>d.msg&&addLog(d.msg))}
function addLog(m){logEl.innerHTML+=m+'<br>';logEl.scrollTop=logEl.scrollHeight}
socket.on('status',d=>{
    document.getElementById('price').textContent='$'+Number(d.price).toLocaleString();
    const p=parseFloat(d.realProfit);
    document.getElementById('profit').textContent=(p>=0?'+$':'-$')+Math.abs(p).toFixed(2);
    document.getElementById('profit').className='v '+(p>=0?'green':'red');
    document.getElementById('equity').textContent='$'+d.equity;
    const dd=parseFloat(d.drawdown);
    document.getElementById('drawdown').textContent=dd.toFixed(1)+'%';
    document.getElementById('drawdown').className='v '+(dd>10?'red':dd>5?'yellow':'green');
    document.getElementById('status').textContent=d.botStatus;
    document.getElementById('status').className='v '+(d.botStatus==='RUNNING'?'green':'red');
    document.getElementById('vol').textContent=d.isVolatile?'⚡ FAST':'🌤 Calm';
    document.getElementById('vol').className='v '+(d.isVolatile?'yellow':'green');
    document.getElementById('cycles').textContent=d.cycleCount;
    document.getElementById('orders').textContent=d.totalOrders;
    document.getElementById('longInfo').innerHTML=
        'Layers: <span>'+d.longFilled+'/'+d.longLayers+'</span> | Avg: <span>$'+d.longAvg+'</span>';
    document.getElementById('shortInfo').innerHTML=
        'Layers: <span>'+d.shortFilled+'/'+d.shortLayers+'</span> | Avg: <span>$'+d.shortAvg+'</span>';
    document.getElementById('farInfo').innerHTML=
        'Buy: <span>'+d.farBuy.status+(d.farBuy.price?' @ $'+d.farBuy.price:'')+'</span> | '+
        'Sell: <span>'+d.farSell.status+(d.farSell.price?' @ $'+d.farSell.price:'')+'</span>';
});
socket.on('log',m=>addLog(m));

// Config Logic
const cfgFields = [
    {id:'c-symbol',path:'symbol'},{id:'c-gridSpacing',path:'gridSpacing',t:'n'},{id:'c-catchMultiplier',path:'catchMultiplier',t:'n'},
    {id:'c-orderSize',path:'orderSize',t:'n'}, {id:'c-maxNearLayers',path:'maxNearLayers',t:'n'},
    {id:'c-nearDirection',path:'nearDirection'},{id:'c-enableFarBuy',path:'enableFarBuy',t:'b'},{id:'c-enableFarSell',path:'enableFarSell',t:'b'},
    {id:'c-hedge-enableStopMarket',path:'hedge.enableStopMarket',t:'b'},
    {id:'c-dd-max',path:'drawdown.maxPercent',t:'n'},{id:'c-dd-enabled',path:'drawdown.trailingEnabled',t:'b'},
    {id:'c-tickIntervalMs',path:'tickIntervalMs',t:'n'},
];
function gv(o,p){return p.split('.').reduce((a,k)=>a&&a[k],o)}
function sv(o,p,v){const k=p.split('.');const l=k.pop();k.reduce((a,k)=>{if(!a[k])a[k]={};return a[k]},o)[l]=v;}
async function loadCfg(){
    try{const r=await fetch('/api/config');const c=await r.json();
    cfgFields.forEach(f=>{const el=document.getElementById(f.id);const v=gv(c,f.path);
    if(f.t==='b')el.checked=!!v;else el.value=v??''});
    }catch(e){}
}
async function saveCfg(){
    const body={};cfgFields.forEach(f=>{const el=document.getElementById(f.id);
    let v;if(f.t==='b')v=el.checked;else if(f.t==='n')v=parseFloat(el.value);else v=el.value;sv(body,f.path,v)});
    try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();if(d.ok){document.getElementById('saveMsg').textContent='✅ Saved!';document.getElementById('saveMsg').style.color='#00d4aa';loadCfg()}
    else throw new Error(d.error)}catch(e){document.getElementById('saveMsg').textContent='❌ '+e.message;document.getElementById('saveMsg').style.color='#ff4757'}
}
loadCfg();
</script></body></html>`);
});

app.post('/api/start', async (req, res) => res.json({ ok: true, msg: await startBot() }));
app.post('/api/stop', async (req, res) => res.json({ ok: true, msg: await stopBot() }));
app.post('/api/emergency', async (req, res) => res.json({ ok: true, msg: await emergencyClose() }));
app.get('/api/config', (req, res) => { loadConfig(); res.json(config); });
app.post('/api/config', (req, res) => {
    try {
        function merge(t, s) { for (const k of Object.keys(s)) { if (s[k] && typeof s[k]==='object' && !Array.isArray(s[k]) && t[k]) merge(t[k],s[k]); else t[k]=s[k]; } }
        merge(config, req.body); saveConfig();
        log('CFG', 'Config updated'); res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/status', (req, res) => {
    const getStatus = (c) => c.layers.length > 0 ? (c.layers.some(l=>l.status==='PENDING')?'ENTRY':'FILLED') : 'IDLE';
    const slots = [];
    slots.push({ name: 'nearBuy', status: getStatus(longCluster), entry: longCluster.avgPrice, tp: longCluster.avgPrice+config.gridSpacing, fills: clusterFilledCount(longCluster) });
    slots.push({ name: 'nearSell', status: getStatus(shortCluster), entry: shortCluster.avgPrice, tp: shortCluster.avgPrice-config.gridSpacing, fills: clusterFilledCount(shortCluster) });
    slots.push({ name: 'farBuy', status: config.enableFarBuy ? farBuyOrder.status : 'DISABLED', entry: farBuyOrder.price, tp: 0, fills: 0 });
    slots.push({ name: 'farSell', status: config.enableFarSell ? farSellOrder.status : 'DISABLED', entry: farSellOrder.price, tp: 0, fills: 0 });

    res.json({ running, botStatus, anchorPrice, realProfit, startEquity, peakEquity, cycleCount, basePrice: anchorPrice,
        slots, 
        longCluster: { filled: clusterFilledCount(longCluster), qty: clusterQty(longCluster), avg: longCluster.avgPrice },
        shortCluster: { filled: clusterFilledCount(shortCluster), qty: clusterQty(shortCluster), avg: shortCluster.avgPrice }
    });
});

// ===================== STARTUP =====================
async function main() {
    loadConfig(); startConfigWatcher();
    log('MAIN', 'Hybrid Grid Engine v5.0');
    log('MAIN', `${config.symbol} | Spacing:$${config.gridSpacing} | MaxLayers:${config.maxNearLayers} | Far:${config.catchMultiplier}x`);
    server.listen(PORT, () => log('MAIN', `Dashboard: http://localhost:${PORT}/grid`));
    const launchTg = async () => {
        try { await tgBot.launch(); log('MAIN', '✅ TG launched'); }
        catch (e) { if (e.message.indexOf('409') >= 0) { log('MAIN', '⚠️ TG Conflict, retry 5s'); setTimeout(launchTg, 5000); } else log('MAIN', `TG: ${e.message}`); }
    };
    launchTg();
    if (config.run) { log('MAIN', 'Auto-start...'); await startBot(); }
    else log('MAIN', 'Waiting for START');
    process.once('SIGINT', async () => { if (configWatcher) configWatcher.close(); await stopBot(); tgBot.stop(); process.exit(0); });
    process.once('SIGTERM', async () => { if (configWatcher) configWatcher.close(); await stopBot(); tgBot.stop(); process.exit(0); });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
