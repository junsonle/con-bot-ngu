const Binance = require('node-binance-api');
const Express = require("express");
const {Client} = require('pg');
const {Telegraf} = require("telegraf");
const bodyParser = require('body-parser');

const app = Express();
const server = require("http").Server(app);

app.use(Express.static("./public"));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

const port = process.env.PORT;
const botId = process.env.ID || 2;
server.listen(port || 3001);

const YOUR_TOKEN = "6215665987:AAEd_mSldUN39BvsNhmksVNORAromu5RZNY";
const bot = new Telegraf(YOUR_TOKEN);

const postgres = new Client({
    user: 'bot',
    host: 'dpg-cfgvcb9a6gdvgkl9i1hg-a.frankfurt-postgres.render.com',
    database: 'bot_k3zu',
    password: 'XSX2LR61vQri7WUEQybgCzdTG1E3es6x',
    port: 5432,
    ssl: {
        rejectUnauthorized: false
    }
});
postgres.connect(function (err) {
    if (err) throw err;
    console.log("Connected Postgres Database!");
});

let binance;
let chatId = 1312093738;

let configs = {}
let maxOrder = 10;
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

bot.start((ctx) => {
    chatId = ctx.message.chat.id;
    ctx.reply("Welcome to bot");
});

// bot.command('run', async (ctx) => {
//
//     postgres.query(`update config
//                         set run=${data.run},
//                             amount=${data.amount},
//                             range=${data.range},
//                             long=${data.long},
//                             short=${data.short}
//                         where id = ${configs.id};`, async (err, res) => {
//         if (err) throw err;
//         configs = data;
//         configs.amount = Number(data.amount);
//         configs.range = Number(data.range);
//
//         bot.telegram.sendMessage(chatId, "Trade " + (configs.run ? 'on' : 'off'));
//
//         console.log('Configs: ', data);
//         console.log("Trade " + (configs.run ? 'on' : 'off'));
//         await tick();
//     });
// });
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
    res.render("index");
});

app.get("/configs", function (req, res) {
    postgres.query(`select *
                    from config
                    where id = ${botId};`, (err, res) => {
        if (err) throw err;
        configs = res.rows[0];
    });
    res.send(configs);
});

app.post("/run", function (req, res) {
    let data = req.body;
    postgres.query(`update config
                    set run=${data.run},
                        amount=${data.amount},
                        range=${data.range},
                        long=${data.long},
                        short=${data.short}
                    where id = ${botId};`, async (err, res) => {
        if (err) throw err;
        configs = {id: botId, ...data};
        configs.amount = Number(data.amount);
        configs.range = Number(data.range);

        bot.telegram.sendMessage(chatId, "Trade " + (configs.run ? 'on' : 'off'));

        console.log('Configs: ', data);
        console.log("Trade " + (configs.run ? 'on' : 'off'));
        await tick();
    });
    res.send(configs);
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
//                console.log(price);

                await binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
                    if (position) {
                        //let x = (Number(position[1].positionAmt) + Number(position[0].positionAmt)).toFixed(3);
                        if (configs.long) {
                            // close long
                            if (closeLongId !== -1 && position[0].positionAmt >= configs.amount) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${closeLongId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.price - configs.range * 2 > price && price > position[0].entryPrice - 5)
                                            closeLong(Math.round(order.price) - configs.range, order.origQty);
                                        //closeLong(Math.round(order.price) - configs.range, Math.max((order.origQty - configs.amount).toFixed(3), configs.amount));
                                    } else if (order.status === 'FILLED') {
                                        //closeLong(Math.round(price) + configs.range, Math.min(configs.amount, position[0].positionAmt));
                                        closeLong(Math.round(price) + configs.range, Math.min(configs.amount, position[0].positionAmt));
                                    } else {
                                        closeLong(Math.round(Math.max(position[0].entryPrice, price)) + configs.range, position[0].positionAmt);
                                    }
                                }).catch(e => console.log(e.code));
                            }
                            // open long limit
                            if (orderLongId !== -1) {
                                let count = position[0].positionAmt / configs.amount;
                                let botLong = Number(position[0].entryPrice) - configs.range * (count - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongId}`}).then(order => {
                                    if (count > maxOrder) {
                                        if (order.status !== 'NEW')
                                            openLong(Math.min(Math.round(position[0].entryPrice) - configs.range * count, Math.round(price) - configs.range), configs.amount);
                                    } else if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.price && (price - 5 < botLong || position[0].entryPrice == 0)) {
                                            openLong(Math.round(price) - configs.range, order.origQty);
                                        }
                                    } else {
                                        openLong(Math.round(position[0].entryPrice > 0 && botLong < price ? botLong : price) - configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeLong(Math.round(position[0].entryPrice) + configs.range, configs.amount);
                                    // closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                                }).catch(e => console.log(e.code));
                            }
                            // open long market
                            if (orderLongMId !== -1) {
                                let topLong = Number(position[0].entryPrice) + configs.range * (position[0].positionAmt / configs.amount - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.stopPrice - configs.range * 2 > price && price > topLong - 5) {
                                            openLongM(Math.round(price) + configs.range, order.origQty);
                                        }
                                    } else {
                                        // openLongM(Math.round(Math.max(price, position[0].entryPrice)) + configs.range, configs.amount);
                                        // openLongM(Math.round(position[0].entryPrice > price ? position[0].entryPrice : price) + configs.range, configs.amount);
                                        openLongM(Math.round(topLong > price ? topLong : price) + configs.range, configs.amount);
                                    }
                                }).catch(e => console.log(e.code));
                            }
                        }

                        //---------------------------------------//

                        if (configs.short) {
                            // close short
                            if (closeShortId !== -1 && position[1].positionAmt <= -configs.amount) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${closeShortId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.price && price - 5 < position[1].entryPrice)
                                            closeShort(Math.round(order.price) + configs.range, order.origQty);
                                        //closeShort(Math.round(order.price) + configs.range, Math.max((order.origQty - configs.amount).toFixed(3), configs.amount));
                                    } else if (order.status === 'FILLED') {
                                        //closeShort(Math.round(price) - configs.range, Math.min(configs.amount, position[0].positionAmt));
                                        closeShort(Math.round(price) - configs.range, Math.min(configs.amount, -position[1].positionAmt));
                                    } else {
                                        closeShort(Math.round(Math.min(position[1].entryPrice, price)) - configs.range, -position[1].positionAmt);
                                    }
                                }).catch(e => console.log(e.code));
                            }
                            // open short limit
                            if (orderShortId !== -1) {
                                let count = position[1].positionAmt / -configs.amount;
                                let topShort = Number(position[1].entryPrice) + configs.range * (count - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortId}`}).then(order => {
                                    if (count > maxOrder) {
                                        if (order.status !== 'NEW')
                                            openShort(Math.max(Math.round(position[1].entryPrice) + configs.range * count, Math.round(price) + configs.range), configs.amount);
                                    } else if (order.status === 'NEW') {
                                        if (order.price - configs.range * 2 > price && price > topShort - 5) {
                                            openShort(Math.round(price) + configs.range, order.origQty);
                                        }
                                    } else {
                                        openShort(Math.round(topShort > price ? topShort : price) + configs.range, configs.amount);
                                    }
                                    if (order.status === 'FILLED')
                                        closeShort(Math.round(position[1].entryPrice) - configs.range, configs.amount);
                                    // closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                                }).catch(e => console.log(e.code));
                            }
                            //open short market
                            if (orderShortMId !== -1) {
                                let botShort = Number(position[1].entryPrice) - configs.range * (position[1].positionAmt / -configs.amount - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.stopPrice && price - 5 < botShort) {
                                            openShortM(Math.round(price) - configs.range, order.origQty);
                                        }
                                    } else {
                                        // openShortM(Math.round(Math.min(price, position[1].entryPrice)) - configs.range, configs.amount);
                                        //openShortM(Math.round(position[1].entryPrice > 0 && position[1].entryPrice < price ? position[1].entryPrice : price) - configs.range, configs.amount);
                                        openShortM(Math.round(position[1].entryPrice > 0 && botShort < price ? botShort : price) - configs.range, configs.amount);
                                    }
                                }).catch(e => console.log(e.code));
                            }
                        }
                    }
                }).catch(e => console.log(e.code));
            } else if (orderLongId !== -1 && orderShortId !== -1 && orderLongMId !== -1 && orderShortMId !== -1 && closeLongId !== -1 && closeShortId !== -1)
                await binance.futuresOpenOrders(configs.symbol).then(orders => {
                    if (orders.length > 0) {
                        orders.forEach(order => {
                            switch (order.orderId) {
                                case orderLongId:
                                    break;
                                case orderShortId:
                                    break;
                                case orderLongMId:
                                    break;
                                case orderShortMId:
                                    break;
                                case closeLongId:
                                    break;
                                case closeShortId:
                                    break;
                                default:
                                    console.log('CANCEL ORDER ' + (order.price - order.stopPrice) + " " + order.origQty);
                                    binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                    break;
                            }
                        });
                    }
                }).catch(e => console.log(e.code));
        }).catch(e => console.log(e.code));
        await delay(200);
    }
}

async function main() {
    try {
        await postgres.query(`select *
                              from binance
                              where id = ${botId};`, (err, res) => {
            if (res.rows[0].testnet)
                binance = new Binance().options({
                    APIKEY: `${res.rows[0].key}`,
                    APISECRET: `${res.rows[0].secret}`,
                    // useServerTime: true,
                    test: true,
                    urls: {
                        base: 'https://testnet.binance.vision/api/',
                        combineStream: 'wss://testnet.binance.vision/stream?streams=',
                        stream: 'wss://testnet.binance.vision/ws/'
                    }
                });
            else
                binance = new Binance().options({
                    APIKEY: `${res.rows[0].key}`,
                    APISECRET: `${res.rows[0].secret}`
                });
        });

        await postgres.query(`select *
                              from config
                              where id = ${botId};`, (err, res) => {
            if (err) throw err;
            configs = res.rows[0];
            if (configs.run) {

                bot.telegram.sendMessage(chatId, "Trade " + (configs.run ? 'on' : 'off'));

                console.log("Trade " + (configs.run ? 'on' : 'off'));
                tick();
            }
        });
    } catch (e) {
        console.log(e.code);
    }
}

bot.launch();

main();
