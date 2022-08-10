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
    APIKEY: 'qOEo1dShWcyPpWLjQoXtnrDOs4CWl1jIraojtdySSMIKHEhDQKsAKxe9kkOLvQb2',
    APISECRET: 'kc7oXwBFGjG5mDv2vPns9MufcBqn1DwtC2gFTF8bqCFBzVz5u1UyBM4Q0gGo6T5L'
});

const ping = new Monitor({
    website: 'https://con-bot-ngu.herokuapp.com',
    interval: 20 // minutes
});

let run = false;
let symbol = 'BTCBUSD';
let amount = 0.001;
let range = 20;

let listMess = [];

let orderLongId;
let orderShortId;
let closeLongId;
let closeShortId;

async function openCloseShort(price, amount) {
    await binance.futuresMultipleOrders([
        {   // dong lenh short
            symbol: symbol,
            side: "BUY",
            type: "LIMIT",
            quantity: `${-amount}`,
            positionSide: "SHORT",
            price: `${price}`,
            timeInForce: "GTC",
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        closeShortId = data[0].orderId;
        console.log("DONG VI THE SHORT");
        //console.log(data[0]);
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
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        closeLongId = data[0].orderId;
        console.log("DONG VI THE LONG");
        //console.log(data[0]);
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
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        orderShortId = data[0].orderId;
        console.log("MO LENH SHORT");
        //console.log(data[0]);
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
            newOrderRespType: "ACK"
        }
    ]).then((data) => {
        orderLongId = data[0].orderId;
        console.log("MO LENH LONG");
        //console.log(data[0]);
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

    console.log(socket.id + " Da ket noi!");
    io.to(socket.id).emit("configs", {run: run, symbol: symbol, amount: amount, range: range});
    io.to(socket.id).emit("listMess", listMess);

    socket.on('clientSendMessage', function (data) {
        listMess.push(data);
        //console.log(socket.id + ": " + data);
        socket.broadcast.emit("serverSendMessage", data);

        if (data.value === 'clear') {
            if (run)
                serverSendMessage('Server is runing!');
            else
                // dong tat ca cac lenh
                binance.futuresCancelAll(symbol).then(value => {
                    if (value.code === 200) {
                        //listMess = [];
                        orderLongId = orderShortId = closeLongId = closeShortId = null;
                        serverSendMessage('Done!');
                    } else
                        serverSendMessage('Error!');
                });
        } else if (data.value === 'order') {
            binance.futuresOpenOrders(symbol).then(value => {
                value.forEach(data => {
                    serverSendMessage(
                        `${symbol}: 
                        ${(data.side === 'BUY' && data.positionSide === 'LONG') || (data.side === 'SELL' && data.positionSide === 'SHORT') ? 'OPEN' : 'CLOSE'} | 
                        ${data.positionSide} | 
                        ${data.price}`
                    );
                });
            });
        } else if (data.value === 'balance') {
            serverSendBalance();
        } else if (data.value === 'position') {
            binance.futuresPositionRisk({symbol: symbol}).then(position => {
                position.forEach(data => {
                    serverSendMessage(`${data.symbol}: ${data.positionSide} | ${Math.abs(data.positionAmt)} | ${Number(data.entryPrice).toFixed(2)} | ${Number(data.unRealizedProfit).toFixed(3)}`);
                });
            });
        }
    });

    socket.on('run', function (data) {
        postgres.query(`update config set run=${data.run}, amount=${data.amount}, range=${data.range} where id = 1;`, (err, res) => {
            if (err) throw err;
            run = data.run;
            symbol = data.symbol;
            amount = Number(data.amount);
            range = Number(data.range);

            if (run)
                ping.restart();
            else
                ping.stop();

            console.log('Config: ', data);
            console.log("Trade " + (run ? 'on' : 'off'));
            socket.emit("configs", data);
            serverSendMessage("Trade " + (run ? 'on' : 'off'));
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
    let lastPrice = 0;
    let positionLong = '0.000';
    let positionShort = '0.000';
    while (run) {
        try {
            await binance.futuresPrices().then(async prices => {
                let price = prices[symbol];

                if (price !== lastPrice) {
                    //console.log(symbol + ": " + price);

                    // kiem tra vi the
                    await binance.futuresPositionRisk({symbol: symbol}).then(async position => {
                        if (position[0].positionAmt !== '0.000' && position[0].positionAmt !== positionLong) {
                            if (positionLong === '0.000')
                                // mo lenh close long
                                openCloseLong(Math.ceil(position[0].entryPrice) + range, position[0].positionAmt);
                            else
                                // dong lenh close long
                                binance.futuresCancel(symbol, {orderId: `${closeLongId}`}).then(value => {
                                    // mo lenh close long
                                    openCloseLong(Math.ceil(position[0].entryPrice) + range, position[0].positionAmt);
                                });
                        }
                        positionLong = position[0].positionAmt;
                        if (position[1].positionAmt !== '0.000' && position[1].positionAmt !== positionShort) {
                            if (positionShort === '0.000')
                                // mo lenh close short
                                openCloseShort(Math.floor(position[1].entryPrice) - range, position[1].positionAmt);
                            else
                                // dong lenh close short
                                binance.futuresCancel(symbol, {orderId: `${closeShortId}`}).then(value => {
                                    // mo lenh close short
                                    openCloseShort(Math.floor(position[1].entryPrice) - range, position[1].positionAmt);
                                });
                        }
                        positionShort = position[1].positionAmt;

                        if (price > lastPrice) {
                            let botLong = Number(position[0].entryPrice) - range * (positionLong / amount - 1) / 2;
                            // kiem tra lenh long
                            await binance.futuresOrderStatus(symbol, {orderId: `${orderLongId}`}).then(async order => {
                                if (order.orderId)
                                    if (order.status === 'NEW') {
                                        if (positionLong === '0.000' || price < botLong) {
                                            if ((order.price - price) / range <= -2) {
                                                // dong lenh long
                                                binance.futuresCancel(symbol, {orderId: `${orderLongId}`});
                                                // mo lenh long
                                                await openLong(Math.round(price) - range, amount);
                                            }
                                        } else if (order.price < Math.floor(botLong) - range) {
                                            // dong lenh long
                                            binance.futuresCancel(symbol, {orderId: `${orderLongId}`});
                                            // mo lenh long
                                            await openLong(Math.round(botLong) - range, amount);
                                        }
                                    } else {
                                        // mo lenh long
                                        await openLong(Math.round(Math.min(price, order.price)) - range, amount);
                                    }
                                else if (positionLong === '0.000' || botLong > price) {
                                    // mo lenh long
                                    await openLong(Math.round(price) - range, amount);
                                } else {
                                    // mo lenh long
                                    await openLong(Math.round(botLong) - range, amount);
                                }
                            });
                        } else {
                            let topShort = Number(position[1].entryPrice) + range * (positionShort / -amount - 1) / 2;
                            // kiem tra lenh short
                            await binance.futuresOrderStatus(symbol, {orderId: `${orderShortId}`}).then(async order => {
                                if (order.orderId)
                                    if (order.status === 'NEW') {
                                        if (positionShort === '0.000' || price > topShort) {
                                            if ((price - order.price) / range <= -2) {
                                                // dong lenh short
                                                binance.futuresCancel(symbol, {orderId: `${orderShortId}`});
                                                // mo lenh short
                                                await openShort(Math.round(price) + range, amount);
                                            }
                                        } else if (order.price > Math.ceil(topShort) + range) {
                                            // dong lenh short
                                            binance.futuresCancel(symbol, {orderId: `${orderShortId}`});
                                            // mo lenh short
                                            await openShort(Math.round(topShort) + range, amount);
                                        }
                                    } else {
                                        // mo lenh short
                                        await openShort(Math.round(Math.max(price, order.price)) + range, amount);
                                    }
                                else if (positionShort === '0.000' || price > topShort) {
                                    // mo lenh short
                                    await openShort(Math.round(price) + range, amount);
                                } else {
                                    // mo lenh short
                                    await openShort(Math.round(topShort) + range, amount);
                                }
                            });
                        }
                    });

                    lastPrice = price;
                }
            });
        } catch (e) {
            console.log(e.code);
            serverSendMessage(e.code);
        }
    }
}

async function main() {

    await postgres.query('select * from config where id = 1;', (err, res) => {
        if (err) throw err;
        run = res.rows[0].run;
        symbol = res.rows[0].symbol;
        amount = res.rows[0].amount;
        range = res.rows[0].range;
        if (run) {
            // dong tat ca cac lenh
            binance.futuresCancelAll(symbol).then(value => {
                if (value.code === 200) {
                    //listMess = [];
                    orderLongId = orderShortId = closeLongId = closeShortId = null;

                    console.log("Trade " + (run ? 'on' : 'off'));
                    serverSendMessage("Trade " + (run ? 'on' : 'off'));
                    serverSendBalance();
                    tick();
                }
            });
        } else
            ping.stop;
    });

    binance.futuresMiniTickerStream(symbol, data => {
        //console.log(data.close);
        io.emit("price", `${symbol}: ${data.close}`);
        binance.futuresBalance().then(values => {
            io.emit("balance", `${Number(values[9].balance).toFixed(2)} ${values[9].crossUnPnl > 0 ? '+' : ''}${Number(values[9].crossUnPnl).toFixed(2)} | BUSD`);
        });
    });

}

main();
