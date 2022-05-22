const ccxt = require('ccxt');
const delay = require("delay");

const binance = new ccxt.binance({
    apiKey: 'vtmhPJuV9pf3eJHr98mGkPeJFG4iPikAIDfvsQ0eyNDG3eS68qMvLYvZRGOEJHiD',
    secret: 'nKwGKhYxIm4Ol7aA7h4SnZvThRQAMz3pzza2Wu5Nsxw5sX4mcJ7eD3ehFXo6cAoz',
});
binance.setSandboxMode(true);

async function pintBalance(btcPrice) {
    const balance = await binance.fetchBalance();
    const total = balance.total;
    console.log("Total USSDT: " + ((total.BTC - 1) * btcPrice + total.USDT));
}

let btcPricePoint = 0;
let btcPrice = 0;
let amount = 0;

const costTaker = 0.1 / 100; // %
const costMaker = 0.1 / 100; // %
const stopLoss = 1 / 100; //%
const symbol = 'BTC/BUSD';
const tradeSize = 1000;
const muonLai = 1; // $

async function tick() {
    const balance = await binance.fetchBalance();
    const total = balance.total;

    const tick = await binance.fetchTicker(symbol);
    if (btcPrice != tick.close) {
        if (btcPricePoint == 0) {
            binance.createMarketOrder(symbol, 'buy', tradeSize / btcPrice)
                .then((buy) => {
                    btcPricePoint = buy.average;
                    amount = buy.amount * btcPricePoint;
                })
                .catch((err) => {
                    console.log(err.data);
                });
        } else if (btcPrice <= btcPricePoint - btcPricePoint * stopLoss) {
            if (total.BUSD >= tradeSize) {
                binance.createMarketOrder(symbol, 'buy', tradeSize / btcPrice)
                    .then((buy) => {
                        btcPricePoint = ((btcPricePoint + buy.average) / 2);
                        amount += (buy.amount * btcPricePoint);
                    })
                    .catch((err) => {
                        console.log(err.data);
                    });
            }
        } else if (btcPrice >= btcPricePoint + (btcPricePoint * costTaker) + ((btcPricePoint + (muonLai * btcPricePoint / amount)) * costMaker) + (muonLai * btcPricePoint / amount)) {
            binance.createMarketOrder(symbol, 'sell', (total.BTC - 1))
                .then((sell) => {
                    btcPricePoint = 0;
                })
                .catch((err) => {
                    console.log(err.data);
                });
        }

        console.log("Time: " + new Date().toLocaleTimeString());
        console.log("BTC Price: " + btcPrice + " - BTC Price Point: " + btcPricePoint);
        console.log("Chenh lech: " + (btcPrice - btcPricePoint).toFixed(6) +
            " - Ti le: " + (((btcPrice - btcPricePoint) / btcPrice) * 100).toFixed(4) + '%');
        console.log("Total BTC: " + total.BTC + " Total BUSD: " + total.BUSD);
        console.log("Tong: " + ((total.BTC - 1) * btcPrice + total.BUSD) + '\n');

        btcPrice = tick.close;
    }
}

async function main() {

    // await binance.createMarketOrder(symbol, 'sell', (total.BTC - 1))
    //     .then((data) => {
    //         console.log(data);
    //     })
    //     .catch((err) => {
    //         console.log(err.data);
    //     });

    const balance = await binance.fetchBalance();
    const total = balance.total;
    console.log(total);

    console.log("Time: " + new Date().toLocaleTimeString() + " Total BTC: " + total.BTC);
    console.log("Total BUSD: " + total.BUSD + '\n');

    // while (true) {
    //     await tick();
    //     await delay(100);
    // }
}

main()



