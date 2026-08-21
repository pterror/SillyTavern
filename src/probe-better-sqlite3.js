#!/usr/bin/env node

/**
 * Standalone launch-time probe for the launch scripts (start.sh, Start.bat) - not imported by the running
 * server. Those scripts run with --ignore-scripts (see e2d8c0200), so better-sqlite3's native .node addon
 * never gets auto-built/rebuilt on install; without this, a missing/broken binding stays silently broken
 * forever and the app quietly runs the slower Fuse.js search fallback every launch.
 *
 * Reuses getBetterSqlite3() from native-sqlite.js - the exact same "construct a real Database" check the
 * server itself uses at runtime - so this can never drift out of sync with what actually determines the
 * fallback. Exit code communicates the outcome to the calling shell script: 0 = binding works, no action
 * needed; 1 = binding is missing/broken, caller should attempt `npm rebuild better-sqlite3`.
 */
import { getBetterSqlite3 } from './endpoints/native-sqlite.js';

const ctor = await getBetterSqlite3();
process.exit(ctor ? 0 : 1);
