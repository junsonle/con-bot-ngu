const Binance = require('node-binance-api');
const express = require("express");
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io").listen(server);
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

const symbol = 'BTCBUSD';
const amount = 0.001;
const biendo = 20;

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
    console.log(socket.id+" Da ket noi!");

    socket.on('disconnect', function () {
        console.log(socket.id+" Da ngat ket noi!");
    });

    socket.on('Chat', function(data){
        console.log(socket.id+": "+data);
        socket.broadcast.emit("sChat",data);
    });
});

app.get("/", function (req, res) {
    res.render("index");
});

async function main() {

    let prices = await binance.futuresPrices();
    let lastPrice = prices[symbol];
    console.log(symbol + ": " + lastPrice);

    let positionLong = '0.000';
    let positionShort = '0.000';

    await startOrders(Math.round(lastPrice));

    // await binance.futuresPositionRisk({symbol: symbol}).then(value => {
    //     positionLong = value[0].positionAmt;
    //     positionShort = value[1].positionAmt;
    // });

    while (true) {
        try {
            await binance.futuresPrices().then(async prices => {
                let price = prices[symbol];

                if (price !== lastPrice) {
                    console.log(symbol + ": " + price);

                    if (price > lastPrice)
                        // kiem tra lenh short
                        await binance.futuresOrderStatus(symbol, {orderId: `${orderShort.orderId}`}).then(order => {
                            let tileShort = (price - orderShort.price) / biendo;
                            if (order.status !== 'NEW') {
                                // mo lenh short
                                openShort(Number(orderShort.price) + biendo * Math.floor(tileShort + 1), amount);
                            } else if (positionShort === '0.000' && tileShort <= -2) {
                                // dong lenh short
                                binance.futuresCancel(symbol, {orderId: `${orderShort.orderId}`});
                                // mo lenh short
                                openShort(Math.floor(price) + biendo, amount);
                            }
                        });
                    else
                        // kiem tra lenh long
                        await binance.futuresOrderStatus(symbol, {orderId: `${orderLong.orderId}`}).then(order => {
                            let tileLong = (orderLong.price - price) / biendo;
                            if (order.status !== 'NEW') {
                                // mo lenh long
                                openLong(Number(orderLong.price) - biendo * Math.floor(tileLong + 1), amount);
                            } else if (positionLong === '0.000' && tileLong <= -2) {
                                // dong lenh long
                                binance.futuresCancel(symbol, {orderId: `${orderLong.orderId}`});
                                // mo lenh long
                                openLong(Math.ceil(price) - biendo, amount);
                            }
                        });

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
                                        // mo lenh close short
                                        openCloseShort(Math.floor(position[1].entryPrice) - biendo, position[1].positionAmt);
                                    });
                            }
                            positionShort = position[1].positionAmt;
                        }
                    });

                    lastPrice = price;
                }
            });
        } catch (e) {
            console.log(e);
        }
    }

}

main();
