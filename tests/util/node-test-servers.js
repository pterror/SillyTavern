import http from 'node:http';
import { after } from 'node:test';

if (process.env.NODE_TEST_CONTEXT) {
    /** @type {Set<http.Server>} */
    const servers = new Set();
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
        servers.add(this);
        this.once('close', () => servers.delete(this));
        return listen.apply(this, args);
    };
    after(() => Promise.all([...servers].map(server => new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
    }))));
}
