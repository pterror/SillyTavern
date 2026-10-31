#!/usr/bin/env node

import { getBetterSqlite3 } from './endpoints/native-sqlite.js';

const ctor = await getBetterSqlite3();
process.exit(ctor ? 0 : 1);
