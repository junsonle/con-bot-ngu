const Binance = require('node-binance-api');
const express = require("express");
const Monitor = require('ping-monitor');
const app = express();
app.use(express.static("./public"));
const server = require("http").Server(app);
const io = require("socket.io")(server);
const port = process.env.PORT;
server.listen(port || 3000);

const binance = new Binance().options({
    APIKEY: '0b38ce7ec75f99cf6e98e013637c8ec7c7bcfcc10a39190fc4bde8f5419ba39d',
    APISECRET: '152d54c08d961cb72fce5348968452c4fc5034b140e9417e51859af8a6ac00e3',
    useServerTime: true,
    test: true,
    urls: {
        base: 'https://testnet.binance.vision/api/', // remove this to trade on mainnet
        combineStream: 'wss://testnet.binance.vision/stream?streams=',
        stream: 'wss://testnet.binance.vision/ws/'
    },
});

const ping = new Monitor({
    website: 'https://con-bot-ngu.herokuapp.com',
    interval: 10 // minutes
});

var run = false;
var symbol = 'BTCBUSD';
var amount = 0.001;
var biendo = 20;

var listMess = [];

let orderLong;
let orderShort;
let closeLong;
let closeShort;

async function openCloseShort(price, amount) {
    closeShort = {...closeShort, price: `${price}`};
    await binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${-amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTC",
            //newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        closeShort = data[0];
        console.log("DONG VI THE SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openCloseLong(price, amount) {
    closeLong = {...closeLong, price: `${price}`};
    await binance.futuresMultipleOrders([
        {   // dong lenh long
            symbol: symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTC",
            //newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        closeLong = data[0];
        console.log("DONG VI THE LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function openShort(price, amount) {
    orderShort = {...orderShort, price: `${price}`};
    await binance.futuresMultipleOrders([
        {   //mo lenh short
            symbol: symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTX",
            //newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        orderShort = data[0];
        console.log("MO LENH SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openLong(price, amount) {
    orderLong = {...orderLong, price: `${price}`};
    await binance.futuresMultipleOrders([
        {   //mo lenh long
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTX",
            //newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        orderLong = data[0];
        console.log("MO LENH LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function startOrders(price) {
    openLong(price - biendo, amount);
    openShort(price + biendo, amount);
}

io.on('connect', function (socket) {

    console.log(socket.id + " Da ket noi!");
    io.to(socket.id).emit("configs", {run: run, symbol: symbol, amount: amount, biendo: biendo});
    io.to(socket.id).emit("listMess", listMess);

    socket.on('clientSendMessage', function (data) {
        listMess.unshift(data);
        console.log(socket.id + ": " + data);
        socket.broadcast.emit("serverSendMessage", data);
        if (data.value === 'clear') {
            // dong tat ca cac lenh
            binance.futuresCancelAll().then(value => {
                if (value.code === 200) {
                    listMess = [];
                    orderLong = null;
                    orderShort = null;
                    closeLong = null;
                    closeShort = null;
                    socket.emit("serverSendMessage", {...data, value: 'Done!'});
                } else
                    socket.emit("serverSendMessage", {...data, value: 'Error!'});
            });
        }
    });

    socket.on('run', function (data) {
        run = data.run;
        symbol = data.symbol;
        amount = Number(data.amount);
        biendo = Number(data.biendo);

        console.log('Config: ', data);
        console.log("Service " + (run ? 'on' : 'off'));
        socket.emit("configs", data);

        tick();
    });

    socket.on('disconnect', function () {
        console.log(socket.id + " Da ngat ket noi!");
    });

});

app.get("/", function (req, res) {
    res.render("index");
});

ping.on('up', function (res, state) {
    console.log('Service is up');
});

async function tick() {
    let lastPrice = 0;
    let positionLong = '0.000';
    let positionShort = '0.000';
    while (run) {
        try {
            await binance.futuresPrices().then(async prices => {
                let price = prices[symbol];

                if (price !== lastPrice) {
                    console.log(symbol + ": " + price);

                    // kiem tra vi the
                    await binance.futuresPositionRisk({symbol: symbol}).then(position => {
                        if (position) {
                            if (position[0].positionAmt !== '0.000' && position[0].positionAmt !== positionLong) {
                                if (positionLong === '0.000')
                                    // mo lenh close long
                                    openCloseLong(Math.ceil(position[0].entryPrice) + biendo, position[0].positionAmt);
                                else
                                    // dong lenh close long
                                    binance.futuresCancel(symbol, {orderId: `${closeLong.orderId}`}).then(value => {
                                        if (value.status === 'CANCELED')
                                            // mo lenh close long
                                            openCloseLong(Math.ceil(position[0].entryPrice) + biendo, position[0].positionAmt);
                                    });
                            }
                            positionLong = position[0].positionAmt;
                            if (position[1].positionAmt !== '0.000' && position[1].positionAmt !== positionShort) {
                                if (positionShort === '0.000')
                                    // mo lenh close short
                                    openCloseShort(Math.floor(position[1].entryPrice) - biendo, position[1].positionAmt);
                                else
                                    // dong lenh close short
                                    binance.futuresCancel(symbol, {orderId: `${closeShort.orderId}`}).then(value => {
                                        if (value.status === 'CANCELED')
                                            // mo lenh close short
                                            openCloseShort(Math.floor(position[1].entryPrice) - biendo, position[1].positionAmt);
                                    });
                            }
                            positionShort = position[1].positionAmt;
                        }

                        if (price > lastPrice) {
                            if (positionShort === '0.000' && !orderShort) {
                                // mo lenh short
                                openShort(Math.floor(price) + biendo, amount);
                            } else {
                                let topShort = biendo * (positionShort / amount - 1) / 2;
                                if (orderShort) {
                                    // kiem tra lenh short
                                    binance.futuresOrderStatus(symbol, {orderId: `${orderShort.orderId}`}).then(order => {
                                        if (order) {
                                            let tileShort = (price - orderShort.price) / biendo;
                                            if (order.status !== 'NEW') {
                                                // mo lenh short
                                                openShort(Number(orderShort.price) + biendo * Math.floor(tileShort + 1), amount);
                                            } else if (tileShort <= -2 && price >= Number(position[1].entryPrice) + topShort) {
                                                // dong lenh short
                                                binance.futuresCancel(symbol, {orderId: `${orderShort.orderId}`}).then(value => {
                                                    if (value.status === 'CANCELED')
                                                        // mo lenh short
                                                        openShort(Math.floor(price) + biendo, amount);
                                                });
                                            }
                                        }
                                    });
                                } else {
                                    let tileShort = ((price - position[1].entryPrice) + topShort) / biendo;
                                    // mo lenh short
                                    openShort(Math.floor(position[1].entryPrice) + topShort + biendo * Math.floor(tileShort + 1), amount);
                                }
                            }
                        } else {
                            if (positionLong !== '0.000' && !orderLong) {
                                // mo lenh long
                                openLong(Math.ceil(price) - biendo, amount);
                            } else {
                                let botLong = biendo * (positionLong / amount - 1) / 2;
                                if (orderLong) {
                                    // kiem tra lenh long
                                    binance.futuresOrderStatus(symbol, {orderId: `${orderLong.orderId}`}).then(order => {
                                        if (order) {
                                            let tileLong = (orderLong.price - price) / biendo;
                                            if (order.status !== 'NEW') {
                                                // mo lenh long
                                                openLong(Number(orderLong.price) - biendo * Math.floor(tileLong + 1), amount);
                                            } else if (tileLong <= -2 && price < position[0].entryPrice - botLong) {
                                                // dong lenh long
                                                binance.futuresCancel(symbol, {orderId: `${orderLong.orderId}`}).then(value => {
                                                    if (value.status === 'CANCELED')
                                                        // mo lenh long
                                                        openLong(Math.ceil(price) - biendo, amount);
                                                });
                                            }
                                        }
                                    });
                                } else {
                                    let tileLong = (position[0].entryPrice - price - botLong) / biendo;
                                    // mo lenh long
                                    openLong(Math.ceil(position[0].entryPrice) - botLong - biendo * Math.floor(tileLong + 1), amount);
                                }
                            }
                        }
                    });

                    lastPrice = price;
                }
            });
        } catch (e) {
            console.log(e);
            io.emit("serverSendMessage", e);
            listMess.unshift({value: e, time: new Date().toLocaleString(), userId: 'server'});
        }
    }
    // if(!run)
    //     // dong tat ca cac lenh
    //     await binance.futuresCancelAll().then(value => {
    //         listMess = [];
    //         orderLong = null;
    //         orderShort = null;
    //         closeLong = null;
    //         closeShort = null;
    //     });
}

async function main() {

    binance.futuresMiniTickerStream(symbol, data => {
        //console.log(data.close);
        io.emit("price", `${symbol}: ${data.close}`);
    });

}

main();
