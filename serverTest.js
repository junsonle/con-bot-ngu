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

var symbol = 'BTCBUSD';

async function main() {

    binance.futuresSubscribe('btcbusd@markPrice ',data => {
        console.log(data);
    });

    // binance.futuresMiniTickerStream(symbol, data => {
    //     //console.log(data.close);
    //     io.emit("price", `${symbol}: ${data.close}`);
    //     binance.futuresBalance().then(values => {
    //         io.emit("balance", `${Number(values[2].balance).toFixed(2)} ${values[2].crossUnPnl > 0 ? '+' : ''}${Number(values[2].crossUnPnl).toFixed(2)} | BUSD`);
    //     });
    // });

}

main();
