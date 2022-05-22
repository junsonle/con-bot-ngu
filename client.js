module.exports = function (app) {
    app.get ("/", function(reg, res) {
        res.send("Hel1lo");
    });
}