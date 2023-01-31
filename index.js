const Express = require("express");
const app = Express();
const server = require("http").Server(app);

app.use(Express.static("./public"));
const port = process.env.PORT;
server.listen(port || 3000);

app.get("/", function (req, res) {
    res.render("index");
});

app.get('/robot.png', (req, res) => res.status(200));

function main() {
    console.log("run");
}

main();