// native node modules
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import net from 'node:net';
import dns from 'node:dns';
import process from 'node:process';
import http from 'node:http';
import https from 'node:https';

import cors from 'cors';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import cookieSession from 'cookie-session';
import multer from 'multer';
import responseTime from 'response-time';
import helmet from 'helmet';
import bodyParser from 'body-parser';

// local library imports
import './fetch-patch.js';
import { serverDirectory } from './server-directory.js';

import { serverEvents, EVENT_NAMES } from './server-events.js';
import { loadPlugins } from './plugin-loader.js';
import {
    initUserStorage,
    getCookieSecret,
    getCookieSessionName,
    ensurePublicDirectoriesExist,
    getUserDirectoriesList,
    getAllUserHandles,
    getUserDirectories,
    migrateSystemPrompts,
    migrateUserData,
    requireLoginMiddleware,
    setUserDataMiddleware,
    shouldRedirectToLogin,
    cleanUploads,
    getSessionCookieAge,
    verifySecuritySettings,
    loginPageMiddleware,
    migratePublicOverrides,
} from './users.js';

import { startGroupChatMigrations, migrateAllCharacterChats } from './message-tree-migration.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import getWebpackServeMiddleware from './middleware/webpack-serve.js';
import basicAuthMiddleware from './middleware/basicAuth.js';
import getWhitelistMiddleware from './middleware/whitelist.js';
import accessLoggerMiddleware, { getAccessLogPath, migrateAccessLog } from './middleware/accessLogWriter.js';
import multerMonkeyPatch from './middleware/multerMonkeyPatch.js';
import initRequestProxy from './request-proxy.js';
import initPrivateRequestFilter from './private-request-filter.js';
import cacheBuster from './middleware/cacheBuster.js';
import corsProxyMiddleware from './middleware/corsProxy.js';
import hostWhitelistMiddleware from './middleware/hostWhitelist.js';
import userCssMiddleware from './middleware/userCss.js';
import { FrontendAssets, frontendAssetMiddleware } from './frontend-assets.js';
import getPublicLibConfig from '../webpack.config.js';
import compressionMiddleware from './middleware/compression.js';
import {
    getVersion,
    color,
    removeColorFormatting,
    getSeparator,
    safeReadFileSync,
    setupLogLevel,
    setWindowTitle,
    getConfigValue,
} from './util.js';
import { UPLOADS_DIRECTORY } from './constants.js';

// Routers
import { router as usersPublicRouter } from './endpoints/users-public.js';
import { init as statsInit, onExit as statsOnExit } from './endpoints/stats.js';
import { checkForNewContent } from './endpoints/content-manager.js';
import { init as settingsInit } from './endpoints/settings.js';
import { redirectDeprecatedEndpoints, ServerStartup, setupPrivateEndpoints } from './server-startup.js';
import { diskCache } from './endpoints/characters.js';
import { CharacterStoreLayoutError, initializeMetadataStores, disposeMetadataStores, startChatStatsReconcile } from './character-metadata-db.js';
import { startMetadataMigrations, disposeMetadataMigrationWorkers } from './metadata-migration-coordinator.js';
import { startSearchWorkerIfIndexed } from './endpoints/characters-search-index.js';
import { initializeLocalImportScan, disposeLocalImportScan } from './local-import-scan.js';
import { disposeMessageTreeStores } from './message-tree-db.js';
import { installOwnerChatStatsHook } from './owner-chat-stats.js';
import { migrateFlatSecrets } from './endpoints/secrets.js';
import { maybeStartGroupChatRestore } from './migrations/restore-group-chat-migration-losses.js';
import { wasBrowserRecentlyConnected } from './browser-presence.js';
import { startTokenCountMaintenance } from './token-count-store.js';

// Work around a node v20.0.0, v20.1.0, and v20.2.0 bug. The issue was fixed in v20.3.0.
// https://github.com/nodejs/node/issues/47822#issuecomment-1564708870
// Safe to remove once support for Node v20 is dropped.
if (process.versions && process.versions.node && process.versions.node.match(/20\.[0-2]\.0/)) {
    // @ts-ignore
    if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);
}

// Unrestrict console logs display limit
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.maxStringLength = null;
util.inspect.defaultOptions.depth = 4;

/** @type {import('./command-line.js').CommandLineArguments} */
const cliArgs = globalThis.COMMAND_LINE_ARGS;

if (!cliArgs.enableIPv6 && !cliArgs.enableIPv4) {
    console.error('error: You can\'t disable all internet protocols: at least IPv6 or IPv4 must be enabled.');
    process.exit(1);
}

// Set keep-alive preference for all HTTP/HTTPS requests.
http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive });
https.globalAgent = new https.Agent({ keepAlive: cliArgs.enableKeepAlive });

const app = express();
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compressionMiddleware);
app.use(responseTime());

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// CORS Settings //
const corsEnabled = getConfigValue('cors.enabled', true, 'boolean');
if (corsEnabled) {
    const corsOrigin = getConfigValue('cors.origin', 'null');
    const corsMethods = getConfigValue('cors.methods', ['OPTIONS']);
    const corsAllowedHeaders = getConfigValue('cors.allowedHeaders', []);
    const corsExposedHeaders = getConfigValue('cors.exposedHeaders', []);
    const corsCredentials = getConfigValue('cors.credentials', false, 'boolean');
    const corsMaxAge = getConfigValue('cors.maxAge', null, 'number');

    /** @type {cors.CorsOptions} */
    const corsOptions = {
        origin: corsOrigin,
        methods: corsMethods,
        credentials: corsCredentials,
    };
    if (Array.isArray(corsAllowedHeaders) && corsAllowedHeaders.length > 0) {
        corsOptions.allowedHeaders = corsAllowedHeaders;
    }
    if (Array.isArray(corsExposedHeaders) && corsExposedHeaders.length > 0) {
        corsOptions.exposedHeaders = corsExposedHeaders;
    }
    if (corsMaxAge !== null && Number.isInteger(corsMaxAge)) {
        corsOptions.maxAge = corsMaxAge;
    }
    app.use(cors(corsOptions));
}

if (cliArgs.listen && cliArgs.basicAuthMode) {
    app.use(basicAuthMiddleware);
}

if (cliArgs.whitelistMode) {
    const whitelistMiddleware = await getWhitelistMiddleware();
    app.use(whitelistMiddleware);
}

app.use(hostWhitelistMiddleware);

if (cliArgs.listen) {
    app.use(accessLoggerMiddleware());
}

app.use(cookieSession({
    name: getCookieSessionName(),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
}));

app.use(setUserDataMiddleware);

// CSRF Protection //
if (!cliArgs.disableCsrf) {
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => {
            if (!req.session) {
                console.error('(CSRF error) getTokenFromState: Session object not initialized');
                return;
            }
            return req.session.csrfToken;
        },
        getTokenFromRequest: (req) => {
            return req.headers['x-csrf-token']?.toString();
        },
        storeTokenInState: (req, token) => {
            if (!req.session) {
                console.error('(CSRF error) storeTokenInState: Session object not initialized');
                return;
            }
            req.session.csrfToken = token;
        },
        skipCsrfProtection: (req) => {
            return cliArgs.enableCorsProxy ? /^\/proxy\//.test(req.path) : false;
        },
        size: 32,
    });

    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': csrfSyncProtection.generateToken(req),
        });
    });

    // Customize the error message
    csrfSyncProtection.invalidCsrfTokenError.message = color.red('Invalid CSRF token. Please refresh the page and try again.');
    csrfSyncProtection.invalidCsrfTokenError.stack = undefined;

    app.use(csrfSyncProtection.csrfSynchronisedProtection);
} else {
    console.warn('\nCSRF protection is disabled. This will make your server vulnerable to CSRF attacks.\n');
    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': 'disabled',
        });
    });
}

// Static files
/** @type {import('webpack').Configuration|null} */
let publicLibConfig = null;
const libConfig = () => (publicLibConfig ??= getPublicLibConfig());
const frontendAssets = new FrontendAssets({
    publicDirectory: path.join(serverDirectory, 'public'),
    webpackOutputDirectory: () => libConfig().output?.path,
    webpackOutputFiles: () => Object.keys(libConfig().entry ?? {}).map(name => `${name}.js`),
    globalExtensionsDirectory: () => globalThis.GLOBAL_EXTENSIONS_PATH,
    userCssPath: () => path.join(globalThis.DATA_ROOT, '_css', 'user.css'),
    extensionsEnabled: () => !!getConfigValue('extensions.enabled', true, 'boolean'),
});

// Host index page
app.get('/', cacheBuster.middleware, async (request, response, next) => {
    if (shouldRedirectToLogin(request)) {
        const query = request.url.split('?')[1];
        const redirectUrl = query ? `/login?${query}` : '/login';
        return response.redirect(redirectUrl);
    }

    try {
        const { body, buildId } = await frontendAssets.renderIndex(path.join(serverDirectory, 'public', 'index.html'), request.user?.directories);
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('ETag', `"${buildId}"`);
        response.type('html');
        if (request.fresh) {
            return response.status(304).end();
        }
        return response.send(body);
    } catch (error) {
        return next(error);
    }
});

// The build id a fresh load of `/` would carry now: an open page compares it with its own to tell whether the
// server's files changed under it.
app.get('/api/frontend/build', async (request, response, next) => {
    if (shouldRedirectToLogin(request)) {
        return response.sendStatus(403);
    }
    try {
        const { buildId } = await frontendAssets.renderIndex(path.join(serverDirectory, 'public', 'index.html'), request.user?.directories);
        response.setHeader('Cache-Control', 'no-store');
        return response.json({ buildId });
    } catch (error) {
        return next(error);
    }
});

// Callback endpoint for OAuth PKCE flows (e.g. OpenRouter)
app.get('/callback/:source?', (request, response) => {
    const source = request.params.source;
    const query = request.url.split('?')[1];
    const searchParams = new URLSearchParams();
    source && searchParams.set('source', source);
    query && searchParams.set('query', query);
    const path = `/?${searchParams.toString()}`;
    return response.redirect(307, path);
});

// Host login page
app.get('/login', loginPageMiddleware);

// Host frontend assets
const webpackMiddleware = getWebpackServeMiddleware();
app.use(frontendAssetMiddleware(frontendAssets));
app.use(webpackMiddleware);
app.use(userCssMiddleware);
app.use(express.static(path.join(serverDirectory, 'public'), {}));

// Public API
app.use('/api/users', usersPublicRouter);

// Everything below this line requires authentication
app.use(requireLoginMiddleware);
app.post('/api/ping', (request, response) => {
    if (request.query.extend && request.session) {
        request.session.touch = Date.now();
    }

    response.sendStatus(204);
});

if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
} else {
    app.use('/proxy/:url(*)', async (_, res) => {
        const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
        res.status(404).send(message);
    });
}

// File uploads
const uploadsPath = path.join(cliArgs.dataRoot, UPLOADS_DIRECTORY);
app.use(multer({ dest: uploadsPath, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar'));
app.use(multerMonkeyPatch);

app.get('/version', async function (_, response) {
    const data = await getVersion();
    response.send(data);
});

redirectDeprecatedEndpoints(app);
setupPrivateEndpoints(app);
installOwnerChatStatsHook();

/**
 * Tasks that need to be run before the server starts listening.
 * @returns {Promise<void>}
 */
async function preSetupTasks() {
    const version = await getVersion();

    // Print formatted header
    console.log();
    console.log(`SillyTavern ${version.pkgVersion}`);
    if (version.gitBranch && version.commitDate) {
        const date = new Date(version.commitDate);
        const localDate = date.toLocaleString('en-US', { timeZoneName: 'short' });
        console.log(`Running '${version.gitBranch}' (${version.gitRevision}) - ${localDate}`);
        if (!version.isLatest && ['staging', 'release'].includes(version.gitBranch)) {
            console.log('INFO: Currently not on the latest commit.');
            console.log('      Run \'git pull\' to update. If you have any merge conflicts, run \'git reset --hard\' and \'git pull\' to reset your branch.');
        }
    }
    console.log();

    const __t0 = process.hrtime.bigint();
    const __mark = (label) => {
        const now = process.hrtime.bigint();
        console.log(`[boot-timing] ${label}: +${Number(now - __t0) / 1e6}ms total`);
    };

    const directories = await getUserDirectoriesList();
    __mark('getUserDirectoriesList');
    await checkForNewContent(directories);
    __mark('checkForNewContent');
    // No boot-time diskCache.verify(): cache keys embed file mtime, so stale entries just miss on
    // next read rather than needing a full-library readdir+stat walk on every boot.
    migrateFlatSecrets(directories);
    __mark('migrateFlatSecrets');
    cleanUploads();
    __mark('cleanUploads');
    migrateAccessLog();
    __mark('migrateAccessLog');

    // Only schema creation is awaited; the bootstrap backfill runs in the background so a large
    // library doesn't delay the server from listening.
    try {
        await initializeMetadataStores(directories);
    } catch (err) {
        if (!(err instanceof CharacterStoreLayoutError)) throw err;
        console.error(color.red(err.message));
        process.exit(1);
    }
    __mark('initializeMetadataStores');

    // Fire-and-forget, so a user's first search doesn't wait for their search index worker to start.
    for (const handle of await getAllUserHandles()) {
        startSearchWorkerIfIndexed(handle, getUserDirectories(handle))
            .catch(err => console.error(color.red(`[search] Starting the search index worker for ${handle} failed:`), err));
    }

    // Inert unless localImport.directories is configured.
    await initializeLocalImportScan();
    __mark('initializeLocalImportScan');

    // Fire-and-forget: per-user settings backup IO must not gate the server starting to listen.
    {
        const __settingsStart = process.hrtime.bigint();
        settingsInit()
            .catch(err => console.error('Background settings backup failed:', err))
            .finally(() => console.log(`[boot-timing] settingsInit (background) took ${Number(process.hrtime.bigint() - __settingsStart) / 1e6}ms wall, finished at +${Number(process.hrtime.bigint() - __t0) / 1e6}ms total`));
    }
    await statsInit();
    __mark('statsInit');

    const pluginsDirectory = path.join(serverDirectory, 'plugins');
    const cleanupPlugins = await loadPlugins(app, pluginsDirectory);
    __mark('loadPlugins');
    const consoleTitle = process.title;

    let isExiting = false;
    const exitProcess = async () => {
        if (isExiting) return;
        isExiting = true;
        await statsOnExit();
        if (typeof cleanupPlugins === 'function') {
            await cleanupPlugins();
        }
        diskCache.dispose();
        await disposeMetadataMigrationWorkers();
        disposeMetadataStores();
        disposeLocalImportScan();
        disposeMessageTreeStores();
        setWindowTitle(consoleTitle);
        process.exit();
    };

    // Set up event listeners for a graceful shutdown
    process.on('SIGINT', exitProcess);
    process.on('SIGTERM', exitProcess);
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        exitProcess();
    });

    // Add private request filter.
    const requestFilterOptions = {
        listen: cliArgs.listen,
        enabled: !!getConfigValue('privateAddressWhitelist.enabled', false, 'boolean'),
        privateAddressWhitelist: getConfigValue('privateAddressWhitelist.allowedRanges', ['127.0.0.0/8', '::1/128']),
        logBlocked: !!getConfigValue('privateAddressWhitelist.log.blockedRequests', true, 'boolean'),
        logAllowed: !!getConfigValue('privateAddressWhitelist.log.allowedRequests', false, 'boolean'),
        allowUnresolvedHosts: !!getConfigValue('privateAddressWhitelist.allowUnresolvedHosts', false, 'boolean'),
        enableKeepAlive: cliArgs.enableKeepAlive,
        requestProxyEnabled: !!cliArgs.requestProxyEnabled,
    };
    initPrivateRequestFilter(requestFilterOptions);

    // Add request proxy.
    initRequestProxy({ enabled: cliArgs.requestProxyEnabled, url: cliArgs.requestProxyUrl, bypass: cliArgs.requestProxyBypass, enableKeepAlive: cliArgs.enableKeepAlive, privateRequestFilterEnabled: requestFilterOptions.enabled });

    // Wait for frontend libs to compile
    await webpackMiddleware.runWebpackCompiler({ pruneCache: true });
    __mark('runWebpackCompiler');
}

/**
 * Tasks that need to be run after the server starts listening.
 * @param {import('./server-startup.js').ServerStartupResult} result The result of the server startup
 * @returns {Promise<void>}
 */
async function postSetupTasks(result) {
    const browserLaunchHostname = await cliArgs.getBrowserLaunchHostname(result);
    const browserLaunchUrl = cliArgs.getBrowserLaunchUrl(browserLaunchHostname);
    const browserLaunchApp = String(getConfigValue('browserLaunch.browser', 'default') ?? '');

    if (cliArgs.browserLaunchEnabled && wasBrowserRecentlyConnected()) {
        console.log('A browser tab is already connected (or reconnecting after a restart) - not opening a new one.');
    } else if (cliArgs.browserLaunchEnabled) {
        try {
            // TODO: This should be converted to a regular import when support for Node 18 is dropped
            const openModule = await import('open');
            const { default: open, apps } = openModule;

            function getBrowsers() {
                const isAndroid = process.platform === 'android';
                if (isAndroid) {
                    return {};
                }
                return {
                    'firefox': apps.firefox,
                    'chrome': apps.chrome,
                    'edge': apps.edge,
                    'brave': apps.brave,
                };
            }

            const validBrowsers = getBrowsers();
            const appName = validBrowsers[browserLaunchApp.trim().toLowerCase()];
            const openOptions = appName ? { app: { name: appName } } : {};

            console.log(`Launching in a browser: ${browserLaunchApp}...`);
            await open(browserLaunchUrl.toString(), openOptions);
        } catch (error) {
            console.error('Failed to launch the browser. Open the URL manually.', error);
        }
    }

    if (cliArgs.heartbeatInterval > 0) {
        // Convert seconds to milliseconds for the timer
        const intervalMs = cliArgs.heartbeatInterval * 1000;
        const heartbeatPath = path.join(globalThis.DATA_ROOT, 'heartbeat.json');

        console.log(`Heartbeat enabled. Updating ${color.green(heartbeatPath)} every ${cliArgs.heartbeatInterval} seconds`);

        const writeHeartbeat = () => {
            try {
                fs.writeFileSync(heartbeatPath, JSON.stringify({ timestamp: Date.now() }));
            } catch (err) {
                console.error(`Failed to write heartbeat file at ${color.green(heartbeatPath)}:`, err.message);
            }
        };

        // Write immediately
        writeHeartbeat();

        // Loop using the converted milliseconds
        setInterval(writeHeartbeat, intervalMs).unref();
    }

    setWindowTitle('SillyTavern WebServer');

    let logListen = 'SillyTavern is listening on';

    if (result.useIPv6 && !result.v6Failed) {
        logListen += color.green(
            ' IPv6: ' + cliArgs.getIPv6ListenUrl().host,
        );
    }

    if (result.useIPv4 && !result.v4Failed) {
        logListen += color.green(
            ' IPv4: ' + cliArgs.getIPv4ListenUrl().host,
        );
    }

    const goToLog = `Go to: ${color.blue(browserLaunchUrl)} to open SillyTavern`;
    const plainGoToLog = removeColorFormatting(goToLog);

    console.log(logListen);
    if (cliArgs.listen) {
        console.log();
        console.log('To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".');
        console.log('Check the "access.log" file in the data directory to inspect incoming connections:', color.green(getAccessLogPath()));
    }
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');
    console.log(goToLog);
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');

    setupLogLevel();
    serverEvents.emit(EVENT_NAMES.SERVER_STARTED, { url: browserLaunchUrl });

    // Counts the chat stats of rows inserted before now, a small batch at a time on this thread.
    startChatStatsReconcile(await getUserDirectoriesList());

    // Not awaited. Each store's one-time metadata migration passes, in a worker per store, once its boot chain ends.
    startMetadataMigrations(await getUserDirectoriesList())
        .catch(err => console.error(color.red('[metadata-migrations] Starting the metadata migration workers failed:'), err));

    // Not awaited. Sets each store's token table row counts and prunes a table over its cap, in small batches on this thread.
    startTokenCountMaintenance(await getUserDirectoriesList())
        .catch(err => console.error(color.red('[token-count-store] Counting and pruning the token tables failed:'), err));

    // Not awaited. The restore reads what the group migration left, so it starts only once that has finished, and only
    // for users it left no chat file un-migrated for. Off unless config.yaml sets restoreGroupChatMigrationLosses: true.
    // Runs in a worker.
    startGroupChatMigrations({
        afterMigration: ({ migrated, unmigrated }) => {
            maybeStartGroupChatRestore(migrated, {
                enabled: getConfigValue('restoreGroupChatMigrationLosses', false, 'boolean'),
                held: unmigrated,
            });
        },
    });
}

/**
 * Chat data is stored as a message tree in SQLite (see message-tree-db.js). Without a usable engine,
 * every tree-storage function there silently returns null and every route in chats.js falls back to
 * legacy JSONL files instead - refusing to boot here means that degraded mode can never happen
 * silently at runtime.
 */
async function verifySqliteBackend() {
    const engine = await getSqliteEngine();
    if (engine) {
        return;
    }
    console.error(color.red('FATAL: No usable SQLite backend is available on this install.'));
    console.error(color.red('Both the native (better-sqlite3) and WebAssembly (node-sqlite3-wasm) SQLite engines failed to load - see the errors logged above by sqlite-engine.js for the specific cause.'));
    console.error(color.red('SillyTavern stores chat data as a message tree in SQLite and cannot run without one of these engines.'));
    process.exit(1);
}

/**
 * Registers a not-found error response if a not-found error page exists. Should only be called after all other middlewares have been registered.
 */
function apply404Middleware() {
    const notFoundWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'url-not-found.html')) ?? '';
    app.use((req, res) => {
        res.status(404).send(notFoundWebpage);
    });
}

/**
 * Sets the DNS resolution order based on the command line arguments.
 */
function setDnsResolutionOrder() {
    try {
        if (cliArgs.dnsPreferIPv6) {
            dns.setDefaultResultOrder('ipv6first');
            console.log('Preferring IPv6 for DNS resolution');
        } else {
            dns.setDefaultResultOrder('ipv4first');
            console.log('Preferring IPv4 for DNS resolution');
        }
    } catch (error) {
        console.warn('Failed to set DNS resolution order. Possibly unsupported in this Node version.');
    }
}

// User storage module needs to be initialized before starting the server
initUserStorage(globalThis.DATA_ROOT)
    .then(setDnsResolutionOrder)
    .then(ensurePublicDirectoriesExist)
    .then(migrateUserData)
    .then(migrateSystemPrompts)
    .then(migratePublicOverrides)
    .then(migrateAllCharacterChats)
    .then(verifySqliteBackend)
    .then(verifySecuritySettings)
    .then(preSetupTasks)
    .then(apply404Middleware)
    .then(() => new ServerStartup(app, cliArgs).start())
    .then(postSetupTasks);
