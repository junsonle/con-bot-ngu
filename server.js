const Binance = require('node-binance-api');
const Express = require("express");
const Monitor = require('ping-monitor');
const {Client} = require('pg');
const app = Express();
const server = require("http").Server(app);
const io = require('socket.io')(server);

app.use(Express.static("./public"));
const port = process.env.PORT;
server.listen(port || 3000);

const postgres = new Client({
    user: 'bznnfglwutbcjf',
    host: 'ec2-3-229-252-6.compute-1.amazonaws.com',
    database: 'dcisecurskg7nf',
    password: '58acdda7669a5493ae9d51f3751a4e5fefbbc592257e3383c2f716283042b186',
    port: 5432,
    ssl: {
        rejectUnauthorized: false
    }
});

postgres.connect(function (err) {
    if (err) throw err;
    console.log("Connected Postgres Database!");
});

const binance = new Binance().options({
    APIKEY: '0b38ce7ec75f99cf6e98e013637c8ec7c7bcfcc10a39190fc4bde8f5419ba39d',
    APISECRET: '152d54c08d961cb72fce5348968452c4fc5034b140e9417e51859af8a6ac00e3',
    useServerTime: true,
    test: true,
    urls: {
        base: 'https://testnet.binance.vision/api/',
        combineStream: 'wss://testnet.binance.vision/stream?streams=',
        stream: 'wss://testnet.binance.vision/ws/'
    },
});

const ping = new Monitor({
    website: 'https://con-bot-dot.herokuapp.com',
    interval: 20 // minutes
});

let configs = {
    symbol: 'BTCBUSD',
    run: false,
    amount: 0.001,
    range: 20,
    sideLong: true,
    sideShort: true,
}

let listMess = [];

let orderLongId;
let orderShortId;
let orderLongMId;
let orderShortMId;
let closeLongId;
let closeShortId;

function closeShort(price, amount, oldOrderId) {
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
    }).catch(reason => {
        closeShortId = null;
        console.log(reason);
    });
}

function closeLong(price, amount, oldOrderId) {
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
    }).catch(reason => {
        closeLongId = null;
        console.log(reason);
    });
}

function openShort(price, oldOrderId) {
    orderShortId = -1;
    binance.futuresMultipleOrders([
        {   //mo lenh short
            symbol: configs.symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${configs.amount}`,
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
        else if (oldOrderId) {
            binance.futuresCancel(configs.symbol, {orderId: `${oldOrderId}`});
        }
    }).catch(reason => {
        orderShortId = null;
        console.log(reason);
    });
}

function openLong(price, oldOrderId) {
    orderLongId = -1;
    binance.futuresMultipleOrders([
        {   //mo lenh long
            symbol: configs.symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${configs.amount}`,
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
        else if (oldOrderId) {
            binance.futuresCancel(configs.symbol, {orderId: `${oldOrderId}`});
        }
    }).catch(reason => {
        orderLongId = null;
        console.log(reason);
    });
}

function openShortM(price, oldOrderId) {
    orderShortMId = -1;
    binance.futuresMultipleOrders([
        {   // mo lenh short
            symbol: configs.symbol,
            side: "SELL",
            type: "STOP_MARKET",
            quantity: `${configs.amount}`,
            positionSide: "SHORT",
            stopPrice: `${price}`,
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN LONG MAKET " + price);
        orderShortMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
        else if (oldOrderId) {
            binance.futuresCancel(configs.symbol, {orderId: `${oldOrderId}`});
        }
    }).catch(reason => {
        orderShortMId = null;
        console.log(reason);
    });
}

function openLongM(price, oldOrderId) {
    orderLongMId = -1;
    binance.futuresMultipleOrders([
        {   // mo lenh long
            symbol: configs.symbol,
            side: "BUY",
            type: "STOP_MARKET",
            quantity: `${configs.amount}`,
            positionSide: "LONG",
            stopPrice: `${price}`,
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        console.log("OPEN SHORT MAKET " + price);
        orderLongMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
        else if (oldOrderId) {
            binance.futuresCancel(configs.symbol, {orderId: `${oldOrderId}`});
        }
    }).catch(reason => {
        orderLongMId = null;
        console.log(reason);
    });
}

function serverSendMessage(message) {
    let mess = {
        value: message,
        time: new Date().toLocaleString(),
        userId: 'server'
    };
    io.emit("serverSendMessage", mess);
    listMess.push(mess);
}

function serverSendBalance() {
    binance.futuresBalance().then(values => {
        let mess = '';
        for (let value of values.filter(f => f.balance != 0)) {
            mess += `${value.asset}: ${value.balance} | ${value.crossUnPnl}<br/>`;
        }
        serverSendMessage(mess);
    });
}

io.on('connect', function (socket) {

    console.log(socket.id + " Da ket noi!");
    io.to(socket.id).emit("configs", configs);
    io.to(socket.id).emit("listMess", listMess);

    socket.on('clientSendMessage', function (data) {
        listMess.push(data);
        //console.log(socket.id + ": " + data);
        socket.broadcast.emit("serverSendMessage", data);

        if (data.value === 'clear') {
            if (configs.run)
                serverSendMessage('Server is runing!');
            else
                // dong tat ca cac lenh
                binance.futuresCancelAll(configs.symbol).then(value => {
                    if (value.code === 200) {
                        //listMess = [];
                        orderLongId = orderShortId = orderLongMId = orderShortMId = closeLongId = closeShortId = null;
                        serverSendMessage('Done!');
                    } else
                        serverSendMessage('Error!');
                });
        } else if (data.value === 'order') {
            binance.futuresOpenOrders(configs.symbol).then(value => {
                value.forEach(data => {
                    serverSendMessage(
                        `${configs.symbol}: 
                        ${(data.side === 'BUY' && data.positionSide === 'LONG') || (data.side === 'SELL' && data.positionSide === 'SHORT') ? 'OPEN' : 'CLOSE'} | 
                        ${data.positionSide} | 
                        ${data.price}`
                    );
                });
            });
        } else if (data.value === 'balance') {
            serverSendBalance();
        } else if (data.value === 'position') {
            binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
                position.forEach(data => {
                    serverSendMessage(`${data.symbol}: ${data.positionSide} | ${Math.abs(data.positionAmt)} | ${Number(data.entryPrice).toFixed(2)} | ${Number(data.unRealizedProfit).toFixed(3)}`);
                });
            });
        }
    });

    socket.on('run', function (data) {
        postgres.query(`update config set run=${data.run}, amount=${data.amount}, range=${data.range} where id = 2;`, (err, res) => {
            if (err) throw err;
            configs = data;
            configs.amount = Number(data.amount);
            configs.range = Number(data.range);

            if (configs.run)
                ping.restart();
            else
                ping.stop();

            console.log('Configs: ', data);
            console.log("Trade " + (configs.run ? 'on' : 'off'));
            socket.emit("configs", data);
            serverSendMessage("Trade " + (configs.run ? 'on' : 'off'));
            serverSendBalance();
            tick();
        });
    });

    socket.on('disconnect', function () {
        console.log(socket.id + " Da ngat ket noi!");
    });

});

app.get("/", function (req, res) {
    res.render("index");
});

app.get('/robot.png', (req, res) => res.status(200));

ping.on('up', function (res, state) {
    console.log('Service is up');
});

ping.on('stop', function (res, state) {
    console.log('Service is stop');
});

async function tick() {
    let price, position, positionLong = '0.000', positionShort = '0.000';
    while (configs.run) {
        try {
            await binance.futuresPrices().then(prices => {
                price = prices[configs.symbol];
            });

            position = await binance.futuresPositionRisk({symbol: configs.symbol});

            if (price && position) {
                if (position[0].positionAmt !== '0.000' && position[0].positionAmt !== positionLong) {
                    if (positionLong === '0.000')
                        closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                    else
                        binance.futuresCancel(configs.symbol, {orderId: `${closeLongId}`}).then(value => {
                            closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                        });
                }
                positionLong = position[0].positionAmt;

                if (position[1].positionAmt !== '0.000' && position[1].positionAmt !== positionShort) {
                    if (positionShort === '0.000')
                        closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                    else
                        binance.futuresCancel(configs.symbol, {orderId: `${closeShortId}`}).then(value => {
                            closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                        });
                }
                positionShort = position[1].positionAmt;

                if (configs.sideLong) {
                    let botLong = Number(position[0].entryPrice) - configs.range * (positionLong / configs.amount - 1) / 2;
                    // if (orderLongId !== -1)
                    //     binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongId}`}).then(order => {
                    //         if (order.orderId) {
                    //             if (order.status === 'NEW') {
                    //                 if (positionLong === '0.000' || price < botLong) {
                    //                     if ((order.price - price) / configs.range <= -2) {
                    //                         binance.futuresCancel(configs.symbol, {orderId: `${orderLongId}`});
                    //                         openLong(Math.round(price) - configs.range);
                    //                     }
                    //                 } else if (order.price < Math.floor(botLong) - configs.range) {
                    //                     binance.futuresCancel(configs.symbol, {orderId: `${orderLongId}`});
                    //                     openLong(Math.round(botLong) - configs.range);
                    //                 }
                    //             } else {
                    //                 if (order.status === 'FILLED') {
                    //                     closeLong(Number(order.price) + configs.range, configs.amount);
                    //                 }
                    //                 openLong(Math.round(Math.min(price, order.price)) - configs.range);
                    //             }
                    //         } else if (positionLong === '0.000' || botLong > price) {
                    //             openLong(Math.round(price) - configs.range);
                    //         } else {
                    //             openLong(Math.round(botLong) - configs.range);
                    //         }
                    //     });
                    if (orderLongMId !== -1)
                        binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongMId}`}).then(order => {
                            if (order.orderId) {
                                if (order.status === 'NEW') {
                                    if (order.stopPrice - configs.range * 2 >= price) {
                                        //openLongM(Math.round(order.stopPrice) - configs.range, order.orderId);
                                    }
                                } else {
                                    openLongM(Math.round(order.avgPrice) + configs.range);
                                }
                            } else {
                                openLongM(Math.round(price) + configs.range);
                            }
                        });
                }

                if (configs.sideShort) {
                    let topShort = Number(position[1].entryPrice) + configs.range * (positionShort / -configs.amount - 1) / 2;
                    // if (orderShortId !== -1)
                    //     binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortId}`}).then(order => {
                    //         if (order.orderId)
                    //             if (order.status === 'NEW') {
                    //                 if (positionShort === '0.000' || price > topShort) {
                    //                     if ((price - order.price) / configs.range <= -2) {
                    //                         binance.futuresCancel(configs.symbol, {orderId: `${orderShortId}`});
                    //                         openShort(Math.round(price) + configs.range);
                    //                     }
                    //                 } else if (order.price > Math.ceil(topShort) + configs.range) {
                    //                     binance.futuresCancel(configs.symbol, {orderId: `${orderShortId}`});
                    //                     openShort(Math.round(topShort) + configs.range);
                    //                 }
                    //             } else {
                    //                 if (order.status === 'FILLED') {
                    //                     closeShort(Number(order.price) - configs.range, configs.amount);
                    //                 }
                    //                 openShort(Math.round(Math.max(price, order.price)) + configs.range);
                    //             }
                    //         else if (positionShort === '0.000' || price > topShort) {
                    //             openShort(Math.round(price) + configs.range);
                    //         } else {
                    //             openShort(Math.round(topShort) + configs.range);
                    //         }
                    //     });
                    if (orderShortMId !== -1)
                        binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortMId}`}).then(order => {
                            if (order.orderId) {
                                if (order.status === 'NEW') {
                                    if (price - configs.range * 2 >= order.stopPrice) {
                                        //openShortM(Math.round(order.stopPrice) + configs.range, order.orderId);
                                    }
                                } else {
                                    openShortM(Math.round(order.avgPrice) - configs.range);
                                }
                            } else {
                                openShortM(Math.round(price) - configs.range);
                            }
                        });
                }
            }
        } catch (e) {
            console.log(e.code);
            serverSendMessage(e.code);
        }
    }
}

async function main() {

    await postgres.query('select * from config where id = 2;', (err, res) => {
        if (err) throw err;
        configs.run = res.rows[0].run;
        configs.symbol = res.rows[0].symbol;
        configs.amount = res.rows[0].amount;
        configs.range = res.rows[0].range;
        if (configs.run) {
            // dong tat ca cac lenh
            binance.futuresCancelAll(configs.symbol).then(value => {
                if (value.code === 200) {
                    //listMess = [];
                    orderLongId = orderShortId = closeLongId = closeShortId = null;

                    console.log("Trade " + (configs.run ? 'on' : 'off'));
                    serverSendMessage("Trade " + (configs.run ? 'on' : 'off'));
                    serverSendBalance();
                    tick();
                }
            });
        } else
            ping.stop;
    });

    binance.futuresMiniTickerStream(configs.symbol, data => {
        //console.log(data.close);
        io.emit("price", `${configs.symbol}: ${data.close}`);
        binance.futuresBalance().then(values => {
            if (values.length > 0)
                io.emit("balance", `${Number(values[2].balance).toFixed(2)} ${values[2].crossUnPnl > 0 ? '+' : ''}${Number(values[2].crossUnPnl).toFixed(2)} | BUSD`);
        });
    });
}

main();
