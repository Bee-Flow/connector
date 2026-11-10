// Preloaded (node --require) into a connector process under test. It observes
// the network at the lowest layer every client shares (fetch, http, https and
// the proxies all end in net.Socket.prototype.connect): a TCP connection to
// anything but the addresses in NETGUARD_ALLOW is sent to NETGUARD_SINK
// instead, a local listener the test counts connections on, and reported to
// the parent process. No name is resolved for a diverted connection, so
// nothing leaves the machine.
//
//   NETGUARD_ALLOW  comma-separated host:port list (the fake Nextcloud)
//   NETGUARD_SINK   host:port of the listener standing in for any other host

const net = require('node:net');

const allow = new Set(String(process.env.NETGUARD_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
const [sinkHost, sinkPort] = String(process.env.NETGUARD_SINK || '').split(':');
if (!sinkHost || !sinkPort) throw new Error('netGuard: NETGUARD_SINK=host:port is required');

const diverted = [];

function divert(options) {
    const host = options.host || 'localhost';
    const key = `${host}:${options.port}`;
    if (allow.has(key)) return;
    diverted.push(key);
    if (process.send) process.send({ diverted: key });
    options.host = sinkHost;
    options.port = Number(sinkPort);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect() passes its normalised [options, callback] array, tls.connect()
    // an options object, and direct callers may pass (port, host).
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') {
        if (!first.path) divert(first); // a unix socket path is not a network connection
    } else if (typeof first === 'number' || typeof first === 'string') {
        const options = { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
        divert(options);
        args[0] = options.port;
        if (typeof args[1] === 'string') args[1] = options.host;
        else args.splice(1, 0, options.host);
    }
    return connect.apply(this, args);
};

module.exports = { diverted };
