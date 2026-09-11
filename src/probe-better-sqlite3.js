#!/usr/bin/env node

// Standalone launch-time check (start.sh/Start.bat run with --ignore-scripts, so the native addon
// never auto-rebuilds on install). Exit 0 = binding works, 1 = caller should `npm rebuild better-sqlite3`.
import { getBetterSqlite3 } from './endpoints/native-sqlite.js';

const ctor = await getBetterSqlite3();
process.exit(ctor ? 0 : 1);
