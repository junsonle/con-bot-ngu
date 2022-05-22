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
const biendo = 25;
const solenh = 30;

let orders = [];

let orderCloseLong;
let orderCloseShort;

async function openCloseShort(price, amount) {
    binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${-amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTX",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            orderCloseShort = data[0];
        } else if (data[0].status === 'EXPIRED') {
            openCloseShort(price - 10, amount);
        }
        console.log("DONG VI THE SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openCloseLong(price, amount) {
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
            orderCloseLong = data[0];
        } else if (data[0].status === 'EXPIRED') {
            openCloseLong(price + 10, amount);
        }
        console.log("DONG VI THE LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function openShort(price, loop, success) {
    binance.futuresMultipleOrders([
        {   //mo lenh short
            symbol: symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTX",
            //stopPrice: "411.333",
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            orders.push(data[0]);
            if (loop > 1)
                openShort(price + biendo, loop - 1, true);
        } else if (success && data[0].status === 'EXPIRED') {
            openShort(price, loop, false);
        }
        console.log("MO LENH SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openLong(price, loop, success) {
    binance.futuresMultipleOrders([
        {   //mo lenh long
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTX",
            //stopPrice: "411.333",
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        if (data[0].status === 'NEW') {
            orders.push(data[0]);
            if (loop > 1)
                openLong(price - biendo, loop - 1, true)
        } else if (success && data[0].status === 'EXPIRED') {
            openLong(price, loop, false);
        }
        console.log("MO LENH LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function startOrders(price) {
    openLong(price - biendo / 2, solenh / 2, true);
    openShort(price + biendo / 2, solenh / 2, true);
}

async function main() {

    //console.info( await binance.futuresBalance() );

    //`${}`

    const price = await binance.futuresPrices();
    lastPrice = price[symbol];
    console.log(symbol + ": " + lastPrice);

    let positionLong;
    let positionShort;

    //await startOrders(Math.round(lastPrice));

    //orders = await binance.futuresOpenOrders(symbol);

    await binance.futuresPositionRisk({symbol: symbol}).then(value => {
        positionLong = value[0].positionAmt;
        positionShort = value[1].positionAmt;
    });

    // await binance.futuresMiniTickerStream(symbol, async (data) => {
    //     if (data.close !== lastPrice) {
    //         console.log(symbol + ": " + Number(data.close));
    //         // dat lenh dong vi the
    //         binance.futuresPositionRisk({symbol: symbol}).then(async value => {
    //             if (value[0].positionAmt !== positionLong) {
    //                 if (value[0].positionAmt !== '0.000') {
    //                     if (positionLong !== '0.000')
    //                         // dong lenh close long
    //                         await binance.futuresCancel(symbol, {orderId: `${orderCloseLong.orderId}`});
    //                     // mo lenh close long
    //                     await openCloseLong(Number(value[0].entryPrice) + biendo, Number(value[0].positionAmt));
    //                 }
    //                 positionLong = value[0].positionAmt;
    //             }
    //             if (value[1].positionAmt !== positionShort) {
    //                 if (value[1].positionAmt !== '0.000') {
    //                     if (positionShort !== '0.000')
    //                         // dong lenh close short
    //                         await binance.futuresCancel(symbol, {orderId: `${orderCloseShort.orderId}`});
    //                     // mo lenh close short
    //                     await openCloseShort(Number(value[1].entryPrice) - biendo, Number(value[1].positionAmt));
    //                 }
    //                 positionShort = value[1].positionAmt;
    //             }
    //         });
    //         let fromPrice = data.close > lastPrice ? lastPrice : data.close;
    //         let toPrice = data.close < lastPrice ? lastPrice : data.close;
    //
    //         await orders.filter(order => order.price >= fromPrice && order.price <= toPrice).forEach((order, index) => {
    //             // console.log("VAO LENH ");
    //             // console.log(order);
    //             if (order.side === 'BUY') {
    //                 if(orders.filter(value => Number(value.price) === Number(order.price) + biendo).length === 0)
    //                     // mo lenh short
    //                     openShort(Number(order.price) + biendo, 1, true);
    //             } else {
    //                 if(orders.filter(value => Number(value.price) === Number(order.price) - biendo).length === 0)
    //                     // mo lenh long
    //                     openLong(Number(order.price) - biendo, 1, true);
    //             }
    //             orders.splice(index, 1);
    //         });
    //         lastPrice = data.close;
    //     }
    // });

    let fromPrice;
    let toPrice;

    await binance.futuresMarkPriceStream('BTCUSDT', (data) => {
        console.log(data.markPrice);
        fromPrice = data.markPrice > lastPrice ? lastPrice : data.markPrice;
        toPrice = data.markPrice < lastPrice ? lastPrice : data.markPrice;



        // Math.round(data.markPrice);

        // if(data.markPrice - btcPrice > 0) {
        //     if(giam < 0)
        //         giam = 0;
        //     tang += data.markPrice - btcPrice;
        //     if(tang > tangMax) {
        //         tangMax = tang;
        //         console.log(`Tang max: ${tangMax}`);
        //     }
        // } else if(data.markPrice - btcPrice < 0) {
        //     if(tang > 0)
        //         tang = 0;
        //     giam += data.markPrice - btcPrice;
        //     if(giam < giamMax) {
        //         giamMax = giam;
        //         console.log(`Giam max: ${giamMax}`);
        //     }
        // }

        //console.log(`Chenh lech: ${data.markPrice - btcPrice}`);
        // if (Math.abs(data.markPrice - btcPrice) > btcPricePoint) {
        //     btcPricePoint = Math.abs(data.markPrice - btcPrice);
        //     console.log(`Chenh lech max: ${btcPricePoint}`);
        // }
        //btcPrice = data.markPrice;
        lastPrice = data.markPrice;
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
    //console.info( await binance.futuresOpenOrders( symbol ) );
    // console.info( await binance.futuresAllOrders( "BTCUSDT" ) );
    //console.info( await binance.futuresUserTrades( symbol ) );

}

main();
