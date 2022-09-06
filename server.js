const Binance = require('node-binance-api');
const Express = require("express");
const Monitor = require('ping-monitor');
const {Client} = require('pg');
const app = Express();
const server = require("http").Server(app);
const io = require('socket.io')(server);

app.use(Express.static("./public"));
const port = process.env.PORT;
process.env.UV_THREADPOOL_SIZE = 128;
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

let binance;
let ping = new Monitor({
    website: 'https://con-bot-ngu.herokuapp.com',
    interval: 20 // minutes
});

let configs = {
    id: 1,
    symbol: 'BTCBUSD',
    run: false,
    amount: 0.001,
    range: 20,
    long: true,
    short: true,
}
let listMess = [];
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
        //console.log("CLOSE SHORT " + price + " " + amount);
        if (data[0].code)
            console.log(data[0]);
        closeShortId = data[0].orderId;
    }).catch(console.log);
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
        //console.log("CLOSE LONG " + price + " " + amount);
        if (data[0].code)
            console.log(data[0]);
        closeLongId = data[0].orderId;
    }).catch(console.log);
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
        //console.log("OPEN SHORT LIMIT " + price);
        orderShortId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(console.log);
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
        //console.log("OPEN LONG LIMIT " + price);
        orderLongId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(console.log);
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
        //console.log("OPEN SHORT MARKET " + price);
        orderShortMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(console.log);
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
        //console.log("OPEN LONG MARKET " + price);
        orderLongMId = data[0].orderId;
        if (data[0].code)
            console.log(data[0]);
    }).catch(console.log);
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

    //console.log(socket.id + " Da ket noi!");
    io.to(socket.id).emit("configs", configs);
    io.to(socket.id).emit("listMess", listMess);

    socket.on('clientSendMessage', function (data) {
        listMess.push(data);
        //console.log(socket.id + ": " + data);
        socket.broadcast.emit("serverSendMessage", data);

        if (data.value === 'clear') {
            //if (configs.run)
            //    serverSendMessage('Server is runing!');
            //else
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
        postgres.query(`update config set run=${data.run}, amount=${data.amount}, range=${data.range}, long=${data.long}, short=${data.short} where id = ${configs.id};`, async (err, res) => {
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
            await tick();
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
    let price;
    while (configs.run) {
        await binance.futuresPrices().then(async prices => {
            if (price !== prices[configs.symbol]) {
                price = prices[configs.symbol];
                // console.log(price);
                await binance.futuresPositionRisk({symbol: configs.symbol}).then(position => {
                    if (position) {
                        let x = (Number(position[1].positionAmt) + Number(position[0].positionAmt)).toFixed(3);
                        if (configs.long) {
                            // close long
                            if (closeLongId !== -1 && position[0].positionAmt > 0) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${closeLongId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.origQty - position[0].positionAmt !== 0)
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`}).then(value => {
                                                if (value.status === 'CANCELED') {
                                                    //console.log('CANCEL CLOSE LONG ' + value.price + " " + value.origQty);
                                                    closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                                                }
                                            });
                                    } else {
                                        closeLong(Math.round(position[0].entryPrice) + configs.range, position[0].positionAmt);
                                    }
                                });
                            }
                            // open long limit
                            if (orderLongId !== -1) {
                                let botLong = Number(position[0].entryPrice) - configs.range * (position[0].positionAmt / configs.amount - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (position[0].positionAmt === '0.000' || price < botLong) {
                                            if ((order.price - price) / configs.range <= -2) {
                                                openLong(Math.round(price) - configs.range, order.origQty);
                                            }
                                        } else if (order.price < Math.floor(botLong) - configs.range) {
                                            openLong(Math.round(botLong) - configs.range, order.origQty);
                                        }
                                    } else {
                                        if (x >= 0)
                                            openLong(Math.round(price) - configs.range, configs.amount);
                                        else if (position[0].positionAmt === '0.000')
                                            openLong(Math.round(price) - configs.range, -x / 2);
                                    }
                                });
                            }
                            // open long market
                            if (orderLongMId !== -1) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderLongMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.stopPrice - configs.range * 2 >= price) {
                                            openLongM(Math.round(price) + configs.range, order.origQty);
                                        }
                                    } else {
                                        //if (order.status === 'FILLED' || position[1].positionAmt < 0)
                                        openLongM(Math.round(price) + configs.range, configs.amount);
                                    }
                                });
                            }
                        }

                        //---------------------------------------//

                        if (configs.short) {
                            // close short
                            if (closeShortId !== -1 && position[1].positionAmt < 0) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${closeShortId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (order.origQty - (0 - position[1].positionAmt) !== 0)
                                            binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`}).then(value => {
                                                if (value.status === 'CANCELED') {
                                                    //console.log('CANCEL CLOSE SHORT ' + value.price + " " + value.origQty);
                                                    closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                                                }
                                            });
                                    } else {
                                        closeShort(Math.round(position[1].entryPrice) - configs.range, 0 - position[1].positionAmt);
                                    }
                                });
                            }
                            // open short limit
                            if (orderShortId !== -1) {
                                let topShort = Number(position[1].entryPrice) + configs.range * (position[1].positionAmt / -configs.amount - 1) / 2;
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (position[1].positionAmt === '0.000' || price > topShort) {
                                            if ((price - order.price) / configs.range <= -2) {
                                                openShort(Math.round(price) + configs.range, order.origQty);
                                            }
                                        } else if (order.price > Math.ceil(topShort) + configs.range) {
                                            openShort(Math.round(topShort) + configs.range, order.origQty);
                                        }
                                    } else {
                                        if (x <= 0)
                                            openShort(Math.round(price) + configs.range, configs.amount);
                                        else if (position[1].positionAmt === '0.000')
                                            openShort(Math.round(price) + configs.range, x / 2);
                                    }
                                });
                            }
                            // open short market
                            if (orderShortMId !== -1) {
                                binance.futuresOrderStatus(configs.symbol, {orderId: `${orderShortMId}`}).then(order => {
                                    if (order.status === 'NEW') {
                                        if (price - configs.range * 2 >= order.stopPrice) {
                                            openShortM(Math.round(price) - configs.range, order.origQty);
                                        }
                                    } else {
                                        //if (order.status === 'FILLED' || position[0].positionAmt > 0)
                                        openShortM(Math.round(price) - configs.range, configs.amount);
                                    }
                                });
                            }
                        }
                    }
                });
            } else if (orderLongId !== -1 && orderShortId !== -1 && orderLongMId !== -1 && orderShortMId !== -1)
                await binance.futuresOpenOrders(configs.symbol).then(orders => {
                    if (orders) {
                        orders.filter(o => o.side + o.positionSide === 'BUYLONG' || o.side + o.positionSide === 'SELLSHORT').forEach(order => {
                            switch (order.orderId) {
                                case orderLongId:
                                    break;
                                case orderShortId:
                                    break;
                                case orderLongMId:
                                    break;
                                case orderShortMId:
                                    break;
                                //case closeLongId:
                                //    break;
                                //case closeShortId:
                                //    break;
                                default:
                                    //console.log('CANCEL ORDER ' + (order.price - order.stopPrice) + " " + order.origQty);
                                    binance.futuresCancel(configs.symbol, {orderId: `${order.orderId}`});
                                    break;
                            }
                        });
                    }
                });
        });
    }
}

async function main() {
    try {
        await postgres.query(`select * from binance where id = ${configs.id};`, (err, res) => {
            if (res.rows[0].testnet)
                binance = new Binance().options({
                    APIKEY: `${res.rows[0].key}`,
                    APISECRET: `${res.rows[0].secret}`,
                    useServerTime: true,
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

            binance.futuresMiniTickerStream(configs.symbol, async data => {
                if (data) {
                    //console.log(data.close);
                    io.emit("price", `${configs.symbol}: ${data.close}`);
                    await binance.futuresBalance().then(values => {
                        if (values) {
                            values.filter(o => o.asset === 'BUSD').forEach(value => {
                                io.emit("balance", `${Number(value.balance).toFixed(2)} ${value.crossUnPnl > 0 ? '+' : ''}${Number(value.crossUnPnl).toFixed(2)} | BUSD`);
                            });
                        }
                    });
                }
            });
        });

        await postgres.query(`select * from config where id = ${configs.id};`, (err, res) => {
            if (err) throw err;
            configs = res.rows[0];
            if (configs.run) {
                console.log("Trade " + (configs.run ? 'on' : 'off'));
                serverSendMessage("Trade " + (configs.run ? 'on' : 'off'));
                serverSendBalance();
                tick();
            } else
                ping.stop();
        });
    } catch (e) {
        console.log(e.code);
        serverSendMessage(e.code);
    }
}

main();
