const Express = require("express");
const  fs = require('fs');
const app = Express();
const server = require("http").Server(app);

app.use(Express.static("./public"));
const port = process.env.PORT;
// server.listen(port || 3000);

const arrayPath = './config.json';
let orders = [];

app.get("/", function (req, res) {
    res.render("index");
});

app.get('/robot.png', (req, res) => res.status(200));

fs.readFile(arrayPath, 'utf8', (err, data) => {
    if (err) throw err;
    orders = JSON.parse(data);
    console.log(orders);
    orders = orders.filter(f => f.id !== 1);
    // const jsonString = JSON.stringify(customer);
    fs.writeFile(arrayPath, JSON.stringify(orders), err => {
        if (err) {
            console.log('Error writing file', err)
        } else {
            console.log('Successfully wrote file')
        }
    });
});

function main() {
    // console.log("run");
}

main();