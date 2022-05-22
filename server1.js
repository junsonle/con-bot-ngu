var express = require("express");
const Binance = require('node-binance-api');
var fs = require("fs");
var app = express();
app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.static("public"));
var server = require("http").Server(app);
var io = require("socket.io")(server);
app.io = io;

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

var btcPricePoint = 0;
var btcPrice = 0;
var lastPrice = 0;

const stopLoss = 2 / 100; //%
const symbol = 'BTCBUSD';
const amount = 0.01;
const muonLai = 1; // $
const biendo = 10;
const solenh = 10;

var orders = [];
var long;
var short;

async function createShort(price) {
    binance.futuresMultipleOrders([
        {   // mo lenh short
            symbol: symbol,
            side: "SELL",
            type: "STOP_MARKET",
            quantity: `${amount}`,
            positionSide: "SHORT",
            //price: `${price}`,
            //timeInForce: "GTX",
            stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            short = data[0].orderId;
        }
        console.log(data[0]);
    }).catch(console.log);
}

async function createLong(price) {
    binance.futuresMultipleOrders([
        {   // mo lenh long
            symbol: symbol,
            side: "BUY",
            type: "STOP_MARKET",
            quantity: `${amount}`,
            positionSide: "LONG",
            //price: `${price}`,
            //timeInForce: "GTX",
            stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            long = data[0].orderId;
        }
        console.log(data[0]);
    }).catch(console.log);
}

async function closeShort(price) {
    binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTX",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            short = null;
        } else if (data[0].status === 'EXPIRED') {
            createShort(price - 10);
        }
        console.log(data[0]);
    }).catch(console.log);
}

async function closeLong(price) {
    binance.futuresMultipleOrders([
        {   // dong lenh long
            symbol: symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTX",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            long = null;
        } else if (data[0].status === 'EXPIRED') {
            createShort(price + 10);
        }
        console.log(data[0]);
    }).catch(console.log);
}

async function closeShortMk() {
    binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "MARKET",
            quantity: `${amount}`,
            positionSide: "SHORT",
            //price: `${price}`,
            //timeInForce: "GTX",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then(console.log).catch(console.log);
}

async function closeLongMk() {
    binance.futuresMultipleOrders([
        {   // dong lenh long
            symbol: symbol,
            side: "SELL",
            type: "MARKET",
            quantity: `${amount}`,
            positionSide: "LONG",
            //price: `${price}`,
            //timeInForce: "GTX",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then(console.log).catch(console.log);
}

async function main() {

    //console.info( await binance.futuresBalance() );

     console.info(await binance.futuresPositionRisk({symbol: symbol}));

    //`${}`

    // const price = await binance.futuresPrices();
    // btcPrice = Math.round(price.BTCUSDT);

    // console.log(symbol + ": " + price.BTCUSDT);
    //btcPricePoint = Math.round(price.BTCUSDT);
    //
    // const topPrice = (btcPricePoint + biendo);
    // const lowPrice = (btcPricePoint - biendo);
    // console.log("topPrice: " + topPrice);
    // console.log("lowPrice: " + lowPrice);

    //await start(btcPricePoint);

    let emptyLong;
    let emptyShort;

    await binance.futuresMiniTickerStream(symbol, async (data) => {
        btcPrice = Number(data.close);
        console.log(symbol + ": " + btcPrice);
        console.info(await binance.futuresPositionRisk({symbol: symbol}));
        // binance.futuresPositionRisk({symbol: symbol}).then(async value => {
        //     emptyLong = value[0].positionAmt === '0.000';
        //     emptyShort = value[1].positionAmt === '0.000';
        //
        //     if(emptyLong && emptyShort) {
        //         if(long == null || short == null) {
        //             // dong tat ca lenh
        //             await binance.futuresCancelAll(symbol).then(v => {
        //                 long = null;
        //                 short = null;
        //             });
        //             // mo lenh maket long
        //             await createLong(btcPrice + 5);
        //             // mo lenh maket short
        //             await createShort(btcPrice - 5);
        //         }
        //     } else {
        //         if(emptyLong) {
        //             if(long == null)
        //                 // mo lenh maket long
        //                 await createLong(btcPrice + 5);
        //         } else {
        //             if(long != null)
        //                 // dong lenh limit long
        //                 await closeLong(Number(value[0].entryPrice) + 20);
        //             else if(Number(value[0].entryPrice - btcPrice >= 500)) {
        //                 // dong lenh limit long
        //                 await closeLongMk();
        //             }
        //         }
        //         if(emptyShort) {
        //             if(short == null)
        //                 // mo lenh maket short
        //                 await createShort(btcPrice - 5);
        //         } else {
        //             if(short != null)
        //                 // dong lenh limit short
        //                 await closeShort(Number(value[1].entryPrice) - 20);
        //             else if(btcPrice - Number(value[0].entryPrice >= 500)) {
        //                 // dong lenh limit short
        //                 await closeShortMk();
        //             }
        //         }
        //     }
        // });
    });

    //console.log(symbol + ": " + Math.round((btcPricePoint / 10)) * 10);

    //map.set(topPrice, 1);
    //map.set(btcPricePoint, 1);
    //map.set(lowPrice, 1);

    //console.log(map);
    //console.log(map.get(Math.round((lowPrice))));

    //console.info(await binance.futuresPositionRisk({symbol: symbol}));
    //console.info( await binance.futuresPositionMargin(symbol, amount) );
    //console.info( await binance.futuresTrades( symbol ) );
    // console.info( await binance.futuresAggTrades( "XTZUSDT" ) );

    // console.info( await binance.futuresCancelAll( symbol ) );
    // console.info( await binance.futuresCancel( "BTCUSDT", {orderId: "1025137386"} ) );

    //console.info( await binance.futuresOrderStatus( symbol, {orderId: "3013381679"} ) );
    // console.info( await binance.futuresOpenOrders( symbol ) );
    // console.info( await binance.futuresAllOrders( "BTCUSDT" ) );
    //console.info( await binance.futuresUserTrades( symbol ) );

}

main();
