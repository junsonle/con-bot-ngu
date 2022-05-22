const Binance = require('node-binance-api');

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

let lastPrice = 0;

const symbol = 'BTCBUSD';
const amount = 0.001;
const biendo = 20;

let orderLongId;
let orderShortId;

async function openCloseShort(price, amount) {
    await binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTC",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        console.log("DONG VI THE SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openCloseLong(price, amount) {
    await binance.futuresMultipleOrders([
        {   // dong lenh long
            symbol: symbol,
            side: "SELL",
            type: "LIMIT",
            quantity: `${amount}`,
            positionSide: "LONG",
            price: `${price}`,
            timeInForce: "GTC",
            //stopPrice: `${price}`,
            newOrderRespType: "RESULT"
        }
    ]).then((data) => {
        console.log("DONG VI THE LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function openShort(price, amount) {
    await binance.futuresMultipleOrders([
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
        orderShortId = data[0].orderId;
        console.log("MO LENH SHORT");
        console.log(data[0]);
    }).catch(console.log);
}

async function openLong(price, amount) {
    await binance.futuresMultipleOrders([
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
        orderLongId = data[0].orderId;
        console.log("MO LENH LONG");
        console.log(data[0]);
    }).catch(console.log);
}

async function startOrders(price) {
    openLong(price - biendo, amount);
    openShort(price + biendo, amount);
}

async function main() {

    //console.info( await binance.futuresBalance() );

    const price = await binance.futuresPrices();
    lastPrice = price[symbol];
    console.log(symbol + ": " + lastPrice);

    let positionLong;
    let positionShort;

    await startOrders(Math.round(lastPrice));

    //orders = await binance.futuresOpenOrders(symbol);

    await binance.futuresPositionRisk({symbol: symbol}).then(value => {
        positionLong = value[0].positionAmt;
        positionShort = value[1].positionAmt;
    });

    await binance.futuresMiniTickerStream(symbol, async (data) => {
        if (data.close !== lastPrice) {
            console.log(symbol + ": " + Number(data.close));

            // dat lenh dong vi the
            await binance.futuresPositionRisk({symbol: symbol}).then(async position => {
                if (position[0].positionAmt !== '0.000' && position[0].positionAmt !== positionLong) {
                    // dong tat ca lenh
                    await binance.futuresCancelAll(symbol).then(async v => {
                        if (position[0].positionAmt / amount < 11) {
                            // mo lenh close long
                            await openCloseLong(Math.round(position[0].entryPrice) + biendo, position[0].positionAmt);
                        }
                        // mo lenh short
                        await openShort(Math.round(position[0].entryPrice) + biendo, amount);
                    });
                }
                positionLong = position[0].positionAmt;
                if (position[1].positionAmt !== '0.000' && position[1].positionAmt !== positionShort) {
                    // dong tat ca lenh
                    await binance.futuresCancelAll(symbol).then(async v => {
                        if (-position[1].positionAmt / amount < 11) {
                            // mo lenh close short
                            await openCloseShort(Math.floor(position[1].entryPrice) - biendo, -position[1].positionAmt);
                        }
                        // mo lenh long
                        await openLong(Math.floor(position[1].entryPrice) - biendo, amount);
                    });
                }
                positionShort = position[1].positionAmt;
            });

            // kiem tra lenh long
            await binance.futuresOrderStatus(symbol, {orderId: `${orderLongId}`}).then(async order => {
                let tile = Math.floor((Number(order.price) - Number(data.close)) / biendo);
                if (order.status === 'FILLED') {
                    if (positionLong / amount > 10) {
                        // mo lenh close long
                        await openCloseLong(Number(order.price) + biendo, amount);
                    }
                    // mo lenh long
                    await openLong(Number(order.price) - biendo * (tile + 1), amount);
                    // mo lenh short
                    //openShort(Number(order.price) - biendo * (tile - 1), amount);
                } else if (order.status !== 'NEW') {
                    // mo lenh long
                    await openLong(Number(order.price) - biendo * (tile + 1), amount);
                }
            });

            // kiem tra lenh short
            await binance.futuresOrderStatus(symbol, {orderId: `${orderShortId}`}).then(async order => {
                let tile = Math.floor((Number(data.close) - Number(order.price)) / biendo);
                if (order.status === 'FILLED') {
                    if (-positionShort / amount > 10) {
                        // mo lenh close short
                        await openCloseShort(Number(order.price) - biendo, -amount);
                    }
                    // mo lenh short
                    await openShort(Number(order.price) + biendo * (tile + 1), amount);
                    // mo lenh long
                    //openLong(Number(order.price) + biendo * (tile - 1), amount);
                } else if (order.status !== 'NEW') {
                    // mo lenh short
                    await openShort(Number(order.price) + biendo * (tile + 1), amount);
                }
            });

            lastPrice = data.close;
        }
    });

}

main();
