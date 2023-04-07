const Binance = require('node-binance-api');
const Express = require("express");
const {Telegraf} = require("telegraf");
const Monitor = require('ping-monitor');
const fs = require('fs');

const app = Express();
const server = require("http").Server(app);
const io = require('socket.io')(server);
require('dotenv').config();
app.use(Express.static("./public"));
app.set("view engine", "ejs").set("views", "./public");

const port = process.env.PORT;
const url = process.env.URL;
const chatId = process.env.TELEGRAM_ID;
server.listen(port || 3000);

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const configPath = './config.json';
const binance = new Binance().options({
    APIKEY: process.env.APIKEY,
    APISECRET: process.env.APISECRET,
    // useServerTime: true,
    test: true,
    urls: {
        base: 'https://testnet.binance.vision/api/',
        combineStream: 'wss://testnet.binance.vision/stream?streams=',
        stream: 'wss://testnet.binance.vision/ws/'
    }
});
let ping = new Monitor({
    website: url,
    interval: 10 // minutes
});

let configs = {}
let orderLongId;
let orderShortId;
let orderLongMId;
let orderShortMId;
let closeLongId;
let closeShortId;

function closeShort(price, amount) {
    closeShortId = -1;
    binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: configs.symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTC",
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("CLOSE SHORT " + price + " " + amount);
        if (data[0].code)
            console.log(data[0]);
        closeShortId = data[0].orderId;
    }).catch(e => console.log(e.code));
}

function closeLong(price, amount) {
    closeLongId = -1;
    binance.futuresMultipleOrders([
        {   // dong lenh long
            symbol: configs.symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTC",
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("CLOSE LONG " + price + " " + amount);
        if (data[0].code)
            console.log(data[0]);
        closeLongId = data[0].orderId;
    }).catch(e => console.log(e.code));
}

function openShort(price, amount) {
    orderShortId = -1;
    binance.futuresMultipleOrders([
        {   //mo lenh short
            symbol: configs.symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTX",
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN SHORT LIMIT " + price);
        orderShortId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(e => console.log(e.code));
}

function openLong(price, amount) {
    orderLongId = -1;
    binance.futuresMultipleOrders([
        {   //mo lenh long
            symbol: configs.symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTX",
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN LONG LIMIT " + price);
        orderLongId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(e => console.log(e.code));
}

function openShortM(price, amount) {
    orderShortMId = -1;
    binance.futuresMultipleOrders([
        {   // mo lenh short
            symbol: configs.symbol,
            side: "SELL",
            type: "STOP_MARKET",
            quantity: `${amount}`,
            positionSide: "SHORT",
            stopPrice: `${price}`,
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN SHORT MARKET " + price);
        orderShortMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(e => console.log(e.code));
}

function openLongM(price, amount) {
    orderLongMId = -1;
    binance.futuresMultipleOrders([
        {   // mo lenh long
            symbol: configs.symbol,
            side: "BUY",
            type: "STOP_MARKET",
            quantity: `${amount}`,
            positionSide: "LONG",
            stopPrice: `${price}`,
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN LONG MARKET " + price);
        orderLongMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(e => console.log(e.code));
}

io.on('connect', function (socket) {

    io.to(socket.id).emit("configs", configs);

    socket.on('run', function (data) {
        configs = data;
        configs.amount = Number(data.amount);
        configs.range = Number(data.range);

        fs.writeFile(configPath, JSON.stringify(configs), async err => {
            if (err) throw err;

            if (configs.run)
                ping.start();
            else
                ping.stop();

            console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs: ", configs);
            bot.telegram.sendMessage(chatId, "Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
            socket.emit("configs", configs);
            if (configs.run) {
                await tick();
            }
        });
    });

    socket.on('clear', function (data) {
        bot.telegram.sendMessage(chatId, '/clear');
        binance.futuresCancelAll(configs.symbol).then(value => {
            if (value.code === 200) {
                orderLongId = orderShortId = orderLongMId = orderShortMId = closeLongId = closeShortId = null;
                bot.telegram.sendMessage(chatId, 'Done!');
            } else
                bot.telegram.sendMessage(chatId, 'Error!');
        }).catch(e => console.log(e.code));
    });

    socket.on('bot', function (data) {
        bot.launch().then(r => {
            bot.telegram.sendMessage(chatId, 'Bot telegram start');
        }).catch(e => console.log(e));
    });

});

bot.start((ctx) => {
    ctx.reply("Welcome to bot");
});
bot.command('run', async (ctx) => {
    configs.run = !configs.run;
    fs.writeFile(configPath, JSON.stringify(configs), async err => {
        if (err) throw err;

        if (configs.run)
            ping.start();
        else
            ping.stop();

        console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs: ", configs);
        ctx.reply(chatId, "Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
        socket.emit("configs", configs);
        if (configs.run) {
            await tick();
        }
    });
});
bot.command("web", async (ctx) => {
    ctx.reply(url);
});
bot.command("price", async (ctx) => {
    binance.futuresPrices().then(prices => {
        ctx.reply(prices[configs.symbol]);
    }).catch(e => console.log(e.code));
});
bot.command("clear", async (ctx) => {
    binance.futuresCancelAll(configs.symbol).then(value => {
        if (value.code === 200) {
            orderLongId = orderShortId = orderLongMId = orderShortMId = closeLongId = closeShortId = null;
            ctx.reply('Done!');
        } else
            ctx.reply('Error!');
    }).catch(e => console.log(e.code));
});
bot.command("order", async (ctx) => {
    binance.futuresOpenOrders(configs.symbol).then(values => {
        if (values.length > 0)
            values.forEach(data => {
                ctx.reply(
                    `${configs.symbol}: ${(data.side === 'BUY' && data.positionSide === 'LONG') || (data.side === 'SELL' && data.positionSide === 'SHORT') ? 'OPEN' : 'CLOSE'} | ${data.positionSide} | ${data.price}`
                );
            });
    }).catch(e => console.log(e.code));
});
bot.command("balance", async (ctx) => {
    binance.futuresBalance().then(values => {
        if (values.length > 0) {
            let mess = '';
            for (let value of values.filter(f => f.balance != 0)) {
                mess += `${value.asset}: ${value.balance} | ${value.crossUnPnl} \n`;
            }
            ctx.reply(mess);
        }
    }).catch(e => console.log(e.code));
});
bot.command("position", async (ctx) => {
    binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
        if (position.length > 0)
            position.forEach(data => {
                ctx.reply(`${data.symbol}: ${data.positionSide} | ${Math.abs(data.positionAmt)} | ${Number(data.entryPrice).toFixed(2)} | ${Number(data.unRealizedProfit).toFixed(3)}`);
            });
    }).catch(e => console.log(e.code));
});

app.get("/", function (req, res) {
    res.render("index", {url: url});
});

app.get('/robot.png', (req, res) => res.status(200));

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function tick() {
    let price;
    while (configs.run) {
        await binance.futuresPrices().then(async prices => {
            if (price !== prices[configs.symbol]) {
                price = prices[configs.symbol];
                io.emit("price", `${configs.symbol}: ${price}`);
                binance.futuresBalance().then(values => {
                    if (values.length > 0) {
                        values.filter(o => o.asset === 'BUSD').forEach(value => {
                            io.emit("balance", `${Number(value.balance).toFixed(2)} ${value.crossUnPnl > 0 ? '+' : ''}${Number(value.crossUnPnl).toFixed(2)} | BUSD`);
                        });
                    }
                }).catch(e => console.log(e.code));

                await binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
                    if (position) {
                        if (configs.long) {
                            // open long limit
                            if (orderLongId !== -1) {
                                let count = position[0].positionAmt / configs.amount;
                                let botLong = Number(position[0].entryPrice) - configs.range * (count - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.price && price < botLong) {
                                            openLong(Math.round(price) - configs.range, order.origQty);
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                        }
                                    } else {
                                        openLong(Math.round(position[0].entryPrice > 0 && botLong < price ? botLong : price) - configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeLong(Math.round(order.avgPrice) + configs.range, order.executedQty);
                                }).catch(e => console.log(e.code));
                            }
                            // open long market
                            if (orderLongMId !== -1) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.stopPrice - configs.range * 2 > price && price > position[0].entryPrice) {
                                            openLongM(Math.round(price) + configs.range, order.origQty);
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                        }
                                    } else {
                                        openLongM(Math.round(position[0].entryPrice > price ? position[0].entryPrice : price) + configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeLong(Math.round(order.avgPrice) + configs.range, order.executedQty);
                                }).catch(e => console.log(e.code));
                            }
                        }

                        //---------------------------------------//

                        if (configs.short) {
                            // open short limit
                            if (orderShortId !== -1) {
                                let count = position[1].positionAmt / -configs.amount;
                                let topShort = Number(position[1].entryPrice) + configs.range * (count - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.price - configs.range * 2 > price && price > topShort) {
                                            openShort(Math.round(price) + configs.range, order.origQty);
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                        }
                                    } else {
                                        openShort(Math.round(topShort > price ? topShort : price) + configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeShort(Math.round(order.avgPrice) - configs.range, order.executedQty);
                                }).catch(e => console.log(e.code));
                            }
                            //open short market
                            if (orderShortMId !== -1) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.stopPrice && price < position[1].entryPrice) {
                                            openShortM(Math.round(price) - configs.range, order.origQty);
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                        }
                                    } else {
                                        openShortM(Math.round(position[1].entryPrice > 0 && position[1].entryPrice < price ? position[1].entryPrice : price) - configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeShort(Math.round(order.avgPrice) - configs.range, order.executedQty);
                                }).catch(e => console.log(e.code));
                            }
                        }
                    }
                }).catch(e => console.log(e.code));
            }
        }).catch(e => console.log(e.code));
        await delay(200);
    }
}

async function main() {
    try {
        await fs.readFile(configPath, 'utf8', (err, data) => {
            if (err) throw err;
            configs = JSON.parse(data);

            if (configs.run) {
                ping.start();
                tick();
            } else
                ping.stop();

            console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs: ", configs);
            bot.telegram.sendMessage(chatId, "Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
        });
        //await binance.futuresOrderStatus('BTCBUSD', {orderId: 98725860}).then(e => console.log(e)).catch(e => console.log(e.code));
    } catch (e) {
        console.log(e);
    }
}

// bot.launch().then(r => {
// }).catch(e => console.log(e));

main().then(r => {
}).catch(e => console.log(e));
