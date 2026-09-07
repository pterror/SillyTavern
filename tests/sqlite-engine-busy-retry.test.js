/**
 * Regression tests for the dropped-write bug behind the 2026-09-07 crash.
 *
 * What actually happened: a bulk backfill process held the write lock while local-import's
 * writeRowSync() ran. writeRowSync() reads (SELECT fav/active_chat) and then writes (UPSERT) inside
 * one transaction, and that transaction was DEFERRED - so it took a read snapshot first and then had
 * to upgrade to a write lock. In WAL mode that upgrade fails immediately with SQLITE_BUSY_SNAPSHOT if
 * another connection committed in between, and SQLite deliberately does NOT invoke the busy handler
 * for it (waiting could only deadlock), so `busy_timeout` was irrelevant. The write was dropped and
 * the caller logged "the reconciler will catch it", which was false.
 *
 * Two independent fixes are asserted here:
 *   1. transactions are BEGIN IMMEDIATE, which removes the upgrade step entirely - the real fix;
 *   2. bounded retry-with-backoff around a whole transaction for the residual races - the backstop.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openNativeDatabase } from '../src/endpoints/sqlite-engine.js';

/** Builds a fake better-sqlite3 constructor so retry behaviour can be driven deterministically. */
function makeFakeCtor({ transactionImpl }) {
    const calls = { immediateUsed: 0, deferredUsed: 0, pragmas: [] };
    const ctor = function () {
        return {
            pragma: (p) => { calls.pragmas.push(p); },
            prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }),
            exec: () => {},
            function: () => {},
            close: () => {},
            transaction: (fn) => {
                const deferred = () => { calls.deferredUsed++; return fn(); };
                deferred.immediate = () => { calls.immediateUsed++; return transactionImpl(fn); };
                return deferred;
            },
        };
    };
    return { ctor, calls };
}

function busyError() {
    const err = new Error('database is locked');
    // @ts-ignore - mirroring better-sqlite3's own error shape
    err.code = 'SQLITE_BUSY_SNAPSHOT';
    return err;
}

describe('sqlite-engine lock handling', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-engine-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('uses BEGIN IMMEDIATE for transactions, never a deferred one', () => {
        const { ctor, calls } = makeFakeCtor({ transactionImpl: (fn) => fn() });
        const handle = openNativeDatabase(/** @type {any} */(ctor), path.join(tmpDir, 'a.sqlite'));

        handle.transaction(() => {});

        expect(calls.immediateUsed).toBe(1);
        expect(calls.deferredUsed).toBe(0);
    });

    it('sets an explicit busy_timeout rather than relying on the 5s default', () => {
        const { ctor, calls } = makeFakeCtor({ transactionImpl: (fn) => fn() });
        openNativeDatabase(/** @type {any} */(ctor), path.join(tmpDir, 'b.sqlite'));

        const busy = calls.pragmas.find(p => String(p).startsWith('busy_timeout'));
        expect(busy).toBeDefined();
        // Must be meaningfully longer than better-sqlite3's 5s default: the lock here is routinely held
        // by a long bulk pass over a 366k-row library.
        expect(Number(String(busy).split('=')[1].trim())).toBeGreaterThan(5000);
    });

    it('retries a transaction that fails with a lock error, and returns the eventual success', () => {
        let attempts = 0;
        const { ctor } = makeFakeCtor({
            transactionImpl: (fn) => {
                attempts++;
                if (attempts < 3) throw busyError();
                return fn();
            },
        });
        const handle = openNativeDatabase(/** @type {any} */(ctor), path.join(tmpDir, 'c.sqlite'));

        let ran = 0;
        handle.transaction(() => { ran++; });

        expect(attempts).toBe(3);
        // The body runs only on the attempt that actually commits - the failed attempts rolled back.
        expect(ran).toBe(1);
    });

    it('gives up after a bounded number of attempts instead of hanging forever', () => {
        let attempts = 0;
        const { ctor } = makeFakeCtor({
            transactionImpl: () => { attempts++; throw busyError(); },
        });
        const handle = openNativeDatabase(/** @type {any} */(ctor), path.join(tmpDir, 'd.sqlite'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => handle.transaction(() => {})).toThrow(/database is locked/);
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThanOrEqual(6);
        // A give-up is a real unrecovered failure and must be loud.
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it('does not retry errors that are not lock contention', () => {
        let attempts = 0;
        const { ctor } = makeFakeCtor({
            transactionImpl: () => {
                attempts++;
                const err = new Error('no such column: nonsense');
                // @ts-ignore
                err.code = 'SQLITE_ERROR';
                throw err;
            },
        });
        const handle = openNativeDatabase(/** @type {any} */(ctor), path.join(tmpDir, 'e.sqlite'));

        expect(() => handle.transaction(() => {})).toThrow(/no such column/);
        expect(attempts).toBe(1);
    });

    describe('against a real database', () => {
        /**
         * Pins the actual SQLite behaviour this fix exists for, so the reasoning above can't silently rot:
         * a DEFERRED read-then-write transaction really does fail unretryably when another connection
         * commits in between. If a future SQLite/better-sqlite3 ever stopped doing this, this test failing
         * is the signal to revisit - not a reason to weaken the fix.
         */
        it('a deferred read-then-upgrade transaction fails when another connection commits first', () => {
            const dbPath = path.join(tmpDir, 'real.sqlite');
            const a = new Database(dbPath);
            a.pragma('journal_mode = WAL');
            a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
            a.prepare('INSERT INTO t (id, v) VALUES (1, \'seed\')').run();

            const b = new Database(dbPath);
            b.pragma('busy_timeout = 100');

            // A: deferred transaction, read first (this is writeRowSync()'s shape).
            a.exec('BEGIN');
            a.prepare('SELECT v FROM t WHERE id = 1').get();

            // B: commits while A holds only a read snapshot.
            b.prepare('UPDATE t SET v = \'from-b\' WHERE id = 1').run();

            // A: now tries to upgrade. This is the failure the crash was made of.
            let upgradeError;
            try {
                a.prepare('UPDATE t SET v = \'from-a\' WHERE id = 1').run();
            } catch (err) {
                upgradeError = err;
            }
            a.exec('ROLLBACK');

            expect(upgradeError).toBeDefined();
            expect(String(upgradeError.code)).toMatch(/^SQLITE_BUSY/);

            a.close();
            b.close();
        });

        it('the engine handle commits a read-then-write transaction against a real file', () => {
            const dbPath = path.join(tmpDir, 'real2.sqlite');
            const handle = openNativeDatabase(Database, dbPath);
            handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
            handle.run('INSERT INTO t (id, v) VALUES (@id, @v)', { id: 1, v: 'seed' });

            handle.transaction(() => {
                const row = handle.get('SELECT v FROM t WHERE id = @id', { id: 1 });
                handle.run('UPDATE t SET v = @v WHERE id = @id', { id: 1, v: `${row.v}-updated` });
            });

            expect(handle.get('SELECT v FROM t WHERE id = @id', { id: 1 }).v).toBe('seed-updated');
            handle.close();
        });
    });
});
