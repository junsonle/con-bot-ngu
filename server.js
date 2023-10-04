const Binance = require('node-binance-api');
const Express = require("express");
const {Telegraf} = require("telegraf");
const fs = require('fs');
const os = require("os");
const e = require("express");

const app = Express();
const server = require("http").Server(app);
const io = require('socket.io')(server);
require('dotenv').config();
app.use(Express.static("./public"));
app.set("view engine", "ejs").set("views", "./public");

const port = process.env.PORT;
const url = process.env.URL;
const chatId = process.env.TELEGRAM_ID;
server.listen(port);

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const envPath = './.env';
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

function setEnvValue(key, value) {
    // read file from hdd & split if from a linebreak to a array
    const ENV_VARS = fs.readFileSync(envPath, "utf8").split(os.EOL);
    // find the env we want based on the key
    const target = ENV_VARS.indexOf(ENV_VARS.find((line) => {
        return line.match(new RegExp(key));
    }));
    // replace the key/value with the new value
    ENV_VARS.splice(target, 1, `${key}=${value}`);
    // write everything back to the file system
    fs.writeFileSync(envPath, ENV_VARS.join(os.EOL));
}

let balanceCoin = 'BUSD';
let configs = {};
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
    }).catch(e => {
        closeShortId = null;
        console.log("Error Close Short:", price, e);
    });
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
    }).catch(e => {
        closeLongId = null;
        console.log("Error Close Long:", price, e);
    });
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
    }).catch(e => {
        orderShortId = null;
        console.log("Error Open Short:", price, e);
    });
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
    }).catch(e => {
        orderLongId = null;
        console.log("Error Open Long:", price, e);
    });
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
    }).catch(e => {
        orderShortMId = null;
        console.log("Error Open Short Maket:", price, e);
    });
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
    }).catch(e => {
        orderLongMId = null;
        console.log("Error Open Long Maket:", price, e);
    });
}

io.on('connect', function (socket) {

    socket.emit("configs", configs);

    socket.on('run', async function (data) {
        configs = data;
        configs.amount = Number(data.amount);
        configs.range = Number(data.range);

        setEnvValue("config", JSON.stringify(configs));

        console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs:", configs);
        await bot.telegram.sendMessage(chatId, "Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
        socket.emit("configs", configs);
        if (configs.run) {
            await binance.futuresBalance().then(values => {
                if (values.length > 0) {
                    let balance = values.find(f => configs.symbol.indexOf(f.asset) > 0);
                    setEnvValue("profit", balance.balance);
                }
            }).catch(e => console.log("Error Get Balance:", e));
            await tick();
        } else {
            setEnvValue("profit", 0);
        }
    });

    socket.on('clear', function (data) {
        bot.telegram.sendMessage(chatId, '/clear');
        binance.futuresCancelAll(configs.symbol).then(value => {
            if (value.code === 200) {
                orderLongId = orderShortId = orderLongMId = orderShortMId = closeLongId = closeShortId = null;
                bot.telegram.sendMessage(chatId, 'Done!');
            } else
                bot.telegram.sendMessage(chatId, 'Error!');
        }).catch(e => console.log("Error Cancel All:", e));
    });

});

bot.start((ctx) => {
    ctx.reply("Welcome to bot");
});

bot.command('run', async (ctx) => {
    configs.run = !configs.run;

    setEnvValue("config", JSON.stringify(configs));

    console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs:", configs);
    ctx.reply("Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
    io.emit("configs", configs);
    if (configs.run) {
        await binance.futuresBalance().then(values => {
            if (values.length > 0) {
                let balance = values.find(f => configs.symbol.indexOf(f.asset) > 0);
                setEnvValue("profit", balance.balance);
            }
        }).catch(e => console.log("Error Get Balance:", e));
        await tick();
    } else {
        setEnvValue("profit", 0);
    }
});

bot.command("web", async (ctx) => {
    ctx.reply(url);
});

bot.command("price", async (ctx) => {
    binance.futuresPrices().then(prices => {
        ctx.reply(prices[configs.symbol]);
    }).catch(e => console.log("Error Get Prices:", e));
});

bot.command("clear", async (ctx) => {
    binance.futuresCancelAll(configs.symbol).then(value => {
        if (value.code === 200) {
            orderLongId = orderShortId = orderLongMId = orderShortMId = closeLongId = closeShortId = null;
            ctx.reply('Done!');
        } else
            ctx.reply('Error!');
    }).catch(e => console.log("Error Cancel All:", e));
});

bot.command("order", async (ctx) => {
    binance.futuresOpenOrders(configs.symbol).then(values => {
        if (values.length > 0)
            values.forEach(data => {
                ctx.reply(
                    `${configs.symbol}: ${(data.side === 'BUY' && data.positionSide === 'LONG') || (data.side === 'SELL' && data.positionSide === 'SHORT') ? 'OPEN' : 'CLOSE'} | ${data.positionSide} | ${data.price}`
                );
            });
        else
            ctx.reply("Null!");
    }).catch(e => console.log("Error Get Open Orders:", e));
});

bot.command("balance", async (ctx) => {
    binance.futuresBalance().then(values => {
        if (values.length > 0) {
            let mess = '';
            for (let value of values.filter(f => f.balance != 0)) {
                mess += `${value.asset}: ${value.balance} | ${value.crossUnPnl} \n`;
            }
            ctx.reply(mess);
        } else
            ctx.reply("Null!");
    }).catch(e => console.log("Error Get Balance:", e));
});

bot.command("profit", async (ctx) => {
    binance.futuresBalance().then(values => {
        if (values.length > 0) {
            let balance = values.find(f => configs.symbol.indexOf(f.asset) > 0);
            ctx.reply(`${balance.asset}: ${balance.balance - process.env.profit} | ${balance.crossUnPnl}`);
        } else
            ctx.reply("Null!");
    }).catch(e => console.log("Error Get Profit:", e));
});

bot.command("position", async (ctx) => {
    binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
        if (position.length > 0)
            position.forEach(data => {
                ctx.reply(`${data.symbol}: ${data.positionSide} | ${Math.abs(data.positionAmt)} | ${Number(data.entryPrice).toFixed(2)} | ${Number(data.unRealizedProfit).toFixed(3)}`);
            });
        else
            ctx.reply("Null!");
    }).catch(e => console.log("Error Get Position:", e));
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
                await binance.futuresBalance().then(values => {
                    if (values.length > 0) {
                        values.filter(o => o.asset === balanceCoin).forEach(value => {
                            io.emit("balance", `${Number(value.balance).toFixed(2)} ${value.crossUnPnl > 0 ? '+' : ''}${Number(value.crossUnPnl).toFixed(2)} | ${balanceCoin}`);
                        });
                    }
                }).catch(e => console.log("Error Get Balance:", e));

                await binance.futuresPositionRisk({symbol: configs.symbol}).then(async position => {
                    if (position) {
                        //let x = (Number(position[1].positionAmt) + Number(position[0].positionAmt)).toFixed(3);
                        if (configs.long) {
                            // close long
                            if (closeLongId !== -1 && position[0].positionAmt >= configs.amount) {
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${closeLongId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.price - configs.range * 2 > price && price > position[0].entryPrice)
                                            closeLong(Math.round(order.price) - configs.range, order.origQty);
                                        //closeLong(Math.round(order.price) - configs.range, Math.max((order.origQty - configs.amount).toFixed(3), configs.amount));
                                    } else if (order.status === 'FILLED') {
                                        closeLong(Math.round(price) + configs.range, Math.min(configs.amount, position[0].positionAmt));
                                    } else {
                                        closeLong(Math.round(Math.max(position[0].entryPrice, price)) + configs.range, configs.amount);
                                    }
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                            // open long limit
                            if (orderLongId !== -1) {
                                let count = position[0].positionAmt / configs.amount;
                                let botLong = Number(position[0].entryPrice) - configs.range * (count - 1) / 2;
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongId}`}).then(order => {
                                    if (count > maxOrder) {
                                        if (order.status !== 'NEW')
                                            openLong(Math.min(Math.round(position[0].entryPrice) - configs.range * count, Math.round(price) - configs.range), configs.amount);
                                    } else if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.price && (price < botLong || position[0].entryPrice == 0)) {
                                            openLong(Math.round(price) - configs.range, order.origQty);
                                        }
                                    } else {
                                        openLong(Math.round(position[0].entryPrice > 0 && botLong < price ? botLong : price) - configs.range, configs.amount);
                                    }
                                    // if (order.status === 'FILLED')
                                    //     closeLong(Math.round(position[0].entryPrice) + configs.range, configs.amount);
                                    // closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                            // open long market
                            if (orderLongMId !== -1) {
                                //let topLong = Number(position[0].entryPrice) + configs.range * (position[0].positionAmt / configs.amount - 1) / 2;
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.stopPrice - configs.range * 2 > price && price > position[0].entryPrice) {
                                            openLongM(Math.round(price) + configs.range, order.origQty);
                                        }
                                    } else {
                                        openLongM(Math.round(position[0].entryPrice > price ? position[0].entryPrice : price) + configs.range, configs.amount);
                                        // openLongM(Math.round(position[0].entryPrice > price ? position[0].entryPrice : price) + configs.range, configs.amount);
                                        // openLongM(Math.round(topLong > price ? topLong : price) + configs.range, configs.amount);
                                        // openLongM(Math.round(price) + configs.range, configs.amount);
                                    }
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                        }

                        //---------------------------------------//

                        if (configs.short) {
                            // close short
                            if (closeShortId !== -1 && position[1].positionAmt <= -configs.amount) {
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${closeShortId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.price && price < position[1].entryPrice)
                                            closeShort(Math.round(order.price) + configs.range, order.origQty);
                                        //closeShort(Math.round(order.price) + configs.range, Math.max((order.origQty - configs.amount).toFixed(3), configs.amount));
                                    } else if (order.status === 'FILLED') {
                                        closeShort(Math.round(price) - configs.range, Math.min(configs.amount, -position[1].positionAmt));
                                    } else {
                                        closeShort(Math.round(Math.min(position[1].entryPrice, price)) - configs.range, configs.amount);
                                    }
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                            // open short limit
                            if (orderShortId !== -1) {
                                let count = position[1].positionAmt / -configs.amount;
                                let topShort = Number(position[1].entryPrice) + configs.range * (count - 1) / 2;
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortId}`}).then(order => {
                                    if (count > maxOrder) {
                                        if (order.status !== 'NEW')
                                            openShort(Math.max(Math.round(position[1].entryPrice) + configs.range * count, Math.round(price) + configs.range), configs.amount);
                                    } else if (order.status === 'NEW') {
                                        if (order.price - configs.range * 2 > price && (price > topShort || position[1].entryPrice == 0)) {
                                            openShort(Math.round(price) + configs.range, order.origQty);
                                        }
                                    } else {
                                        openShort(Math.round(topShort > price ? topShort : price) + configs.range, configs.amount);
                                    }
                                    // if (order.status === 'FILLED')
                                    //     closeShort(Math.round(position[1].entryPrice) - configs.range, configs.amount);
                                    // closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                            //open short market
                            if (orderShortMId !== -1) {
                                //let botShort = Number(position[1].entryPrice) - configs.range * (position[1].positionAmt / -configs.amount - 1) / 2;
                                await binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 > order.stopPrice && price < position[1].entryPrice) {
                                            openShortM(Math.round(price) - configs.range, order.origQty);
                                        }
                                    } else {
                                        openShortM(Math.round(position[1].entryPrice > 0 && position[1].entryPrice < price ? position[1].entryPrice : price) - configs.range, configs.amount);
                                        //openShortM(Math.round(position[1].entryPrice > 0 && position[1].entryPrice < price ? position[1].entryPrice : price) - configs.range, configs.amount);
                                        //openShortM(Math.round(position[1].entryPrice > 0 && botShort < price ? botShort : price) - configs.range, configs.amount);
                                        // openShortM(Math.round(price) - configs.range, configs.amount);
                                    }
                                }).catch(e => console.log("Error Get Order Status:", e));
                            }
                        }
                    }
                }).catch(e => console.log("Error Get Position Risk:", e));
            } else //if (orderLongId !== -1 && orderShortId !== -1 && orderLongMId !== -1 && orderShortMId !== -1 && closeLongId !== -1 && closeShortId !== -1)
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
                }).catch(e => console.log("Error Get OpenOrders:", e));
        }).catch(e => console.log("Error Get Prices:", e));
        await delay(200);
    }
}

async function main() {
    configs = JSON.parse(process.env.config);

    if (configs.run)
        tick();

    console.log("Trade " + (configs.run ? 'on' : 'off') + "\nConfigs: ", configs);
    bot.telegram.sendMessage(chatId, "Bot " + (configs.run ? 'on' : 'off') + "\nConfigs: " + JSON.stringify(configs));
}

bot.launch().then(r => {
}).catch(e => console.log("Error Launch Bot:", e));

main().then(r => {
}).catch(e => console.log("Error Run Main:", e));
