import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite, getCharacterCardJson, streamLinkedWorlds, streamCharactersLinkedToWorld, isWorldLinkedByAnyCharacter, isMigrationMarkedComplete, markMigrationComplete, isBootstrapComplete, addMigrationPending, setMigrationPendingSettled, clearMigrationPending, hasMigrationPending, streamMigrationPending, commitMigrationSettled, flushBatchImport, countCharactersLinkedToAWorld } from '../character-metadata-db.js';
import { NoticeCollector, noticeKey, readNoticeRaw, parseNotice, serializeNotice, replaceNotice, mergeRetryNotice } from './migration-notices.js';
import { MigrationReport } from './migration-report.js';
import { ProgressLog } from '../progress-log.js';

/**
 * One-time reversal for characters auto-linked to a World file by the old importEmbeddedWorldInfo()
 * flow, from before embedded character_book could be activated directly and before
 * charUpdatePrimaryWorld() stopped deleting character_book on unlink.
 *
 * A World only qualifies if it carries `originalData` (set by convertCharacterBook() and persisted
 * verbatim by every path that saves an auto-imported book to a World file) - a structural marker that
 * a World was born from an embedded book, never set on a hand-created/hand-picked World.
 *
 * `originalData` doesn't prove the currently-linked character is the original source, or that nothing
 * has diverged since (deliberate sharing, edits to either copy, or a since-deleted character_book are
 * all possible). Only acts when unambiguous: exactly one linker, and either the character's
 * character_book content-matches `originalData` (unlink only) or the character has no character_book at
 * all (restore from `originalData` and unlink). Anything else is left untouched and reported.
 *
 * Never deletes/renames the World file itself - it may still be referenced elsewhere this migration
 * can't reliably enumerate. `run()` just reports orphaned worlds for manual cleanup.
 *
 * findCandidates() never walks the full character corpus - it starts from streamLinkedWorlds() (indexed
 * on `world`) and only opens a character PNG per remaining candidate. An earlier full-corpus-read version
 * OOM-crashed on this repo's own character library; this design replaced it. Nothing is gathered up front
 * either: run() handles each world as soon as it is classified, a page of worlds at a time, with no
 * database read open while it writes.
 *
 * runOnceAtBoot() (called by server-main.js, unawaited, after initializeMetadataStores()) keeps three
 * markers per user, through isMigrationMarkedComplete()/markMigrationComplete(): BOOT_MIGRATION_KEY (the
 * migration is done), PASS_COMPLETED_KEY (its full pass ran) and SKIPPED_REPORTED_KEY (its skipped cards
 * were reported). Each card whose write fails in the full pass gets a row in the metadata store's
 * migration_pending table; a boot after a pass with failed writes retries only those cards, and the
 * migration is marked done only once none is left. On an install where the migration had already
 * finished, a report-only pass runs once and lists the skipped cards without writing anything. Skipped
 * and failed cards are kept in a notice for the UI (migration-notices.js) until the user dismisses it; every card the
 * pass looked at, and what it did with it, is written to the user's full report (migration-report.js), which the
 * notice links. The console gets progress and a finished line (progress-log.js), and only failed writes by name. Before reading the index it waits for isBootstrapComplete(), since that index
 * isn't populated until the metadata backfill finishes; on timeout it retries next boot without marking done.
 *
 * `run()`/`findCandidates()` also work as a manual CLI: `node src/migrations/unimport-embedded-lore.js
 * [--handle X] [--apply]` (defaults to dry run).
 */

/** Recursively sorts object keys so structurally-equal values serialize identically. */
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = canonicalize(value[key]);
            return acc;
        }, {});
    }
    return value;
}

/** Compares only `entries` (order-insensitive) - top-level book metadata drift shouldn't block an unlink. */
function characterBookEntriesMatch(characterBook, originalData) {
    if (!characterBook || !originalData) return false;
    return JSON.stringify(canonicalize(characterBook.entries ?? [])) === JSON.stringify(canonicalize(originalData.entries ?? []));
}

const STORE_UNAVAILABLE_MESSAGE = 'Character metadata store is unavailable on this install (no usable SQLite backend) - cannot find candidates without an indexed lookup, and this migration deliberately refuses to fall back to a full-corpus scan to get one. Aborting.';

/** The notice id, and the `migration` value of this migration's rows in the pending table. */
const NOTICE_ID = 'unimport-embedded-lore';

/**
 * @typedef {{ avatar: string, worldName: string, action: 'restore-and-unlink' | 'unlink-only' }} SafeCandidate
 * @typedef {{ avatar: string, worldName: string, reason: string }} AmbiguousCandidate
 * @typedef {{ avatar: string, worldName: string, reason: 'world-missing'|'world-unreadable'|'world-snapshot-unusable'|'card-unreadable', detail?: string }} SkippedCard
 * @typedef {{ avatar: string, worldName: string }} NotLinkedCard
 * @typedef {{ safe: SafeCandidate[], ambiguous: AmbiguousCandidate[], skipped: SkippedCard[], notLinked: NotLinkedCard[] }} Findings
 */

/**
 * The report line for a card left as it was without being compared.
 * @param {string} avatar
 * @param {string} worldName
 * @param {SkippedCard['reason']} reason
 * @param {string} [detail]
 * @returns {string}
 */
function skippedLine(avatar, worldName, reason, detail) {
    switch (reason) {
        case 'world-missing':
            return `left as it was: ${avatar} links the lorebook "${worldName}", which isn't in your worlds folder, so there was nothing to undo`;
        case 'world-unreadable':
            return `couldn't be checked, left as it was: ${avatar} links the lorebook "${worldName}", which couldn't be read (${detail})`;
        case 'world-snapshot-unusable':
            return `couldn't be checked, left as it was: ${avatar} links the lorebook "${worldName}", which was made from an embedded lorebook but has no usable copy of the original`;
        case 'card-unreadable':
            return `couldn't be checked, left as it was: ${avatar}: its card couldn't be read (${detail})`;
    }
    return `left as it was: ${avatar}`;
}

/**
 * Where a pass puts what it did with each card.
 * @typedef {{ add: (line: string) => void }} ReportSink
 */

/** @type {ReportSink} */
const NO_REPORT = { add: () => {} };

/**
 * Classifies the only character linking a World that carries the originalData marker.
 * @returns {Promise<Findings>}
 */
async function classifySoleLinker(directories, avatar, worldName, world, log) {
    let card;
    try {
        // Prefer the metadata db's parked copy over the PNG - classifying against stale content
        // would misjudge a card the user already edited.
        const rawJson = await getCharacterCardJson(directories, avatar)
            ?? await parseCharacterCard(path.join(directories.characters, avatar), 'png');
        card = getCharaCardV2(JSON.parse(rawJson), directories, false);
    } catch (err) {
        return { safe: [], ambiguous: [], skipped: [{ avatar, worldName, reason: 'card-unreadable', detail: err.message }], notLinked: [] };
    }

    // Metadata row can lag a live edit.
    if (card?.data?.extensions?.world !== worldName) {
        return { safe: [], ambiguous: [], skipped: [], notLinked: [{ avatar, worldName }] };
    }

    const characterBook = card?.data?.character_book;
    if (!characterBook) {
        return { safe: [{ avatar, worldName, action: 'restore-and-unlink' }], ambiguous: [], skipped: [], notLinked: [] };
    }

    if (characterBookEntriesMatch(characterBook, world.originalData)) {
        return { safe: [{ avatar, worldName, action: 'unlink-only' }], ambiguous: [], skipped: [], notLinked: [] };
    }

    return { safe: [], ambiguous: [{ avatar, worldName, reason: 'Character has its own embedded lorebook that no longer matches the linked World\'s original import snapshot - cannot tell which version to keep' }], skipped: [], notLinked: [] };
}

/**
 * One linked World's findings, one page of linkers per yield: nothing for a World without the originalData
 * marker; every linker as skipped when the World file is missing or unreadable, or its originalData has no
 * entries list; otherwise its sole linker classified, or every linker of a shared World as ambiguous.
 * @returns {AsyncGenerator<Findings, void, undefined>}
 */
async function* classifyWorld(directories, worldName, linkers, log) {
    let world = null;
    /** @type {SkippedCard['reason'] | null} */
    let skipReason = null;
    /** @type {string | undefined} */
    let detail;
    try {
        world = readWorldInfoFile(directories, worldName, false, { logMissing: false });
    } catch (err) {
        skipReason = 'world-unreadable';
        detail = err.message;
    }
    if (skipReason === null) {
        if (world === null || world === undefined) {
            skipReason = 'world-missing';
        } else if (typeof world !== 'object' || Array.isArray(world)) {
            skipReason = 'world-unreadable';
            detail = 'not a JSON object';
        } else if (!world.originalData) {
            return;
        } else if (!Array.isArray(world.originalData.entries)) {
            skipReason = 'world-snapshot-unusable';
        }
    }

    const linkerPages = await streamCharactersLinkedToWorld(directories, worldName);
    if (linkerPages === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }

    if (skipReason !== null) {
        const reason = skipReason;
        for await (const page of linkerPages) {
            yield {
                safe: [],
                ambiguous: [],
                skipped: page.map(avatar => (detail === undefined ? { avatar, worldName, reason } : { avatar, worldName, reason, detail })),
                notLinked: [],
            };
            await new Promise(resolve => setImmediate(resolve));
        }
        return;
    }

    // Shared once the world list or this World's own linkers show more than one; a World that became shared
    // since the world list was read is never treated as a sole link.
    let sharedBy = linkers > 1 ? linkers : 0;
    for await (const avatars of linkerPages) {
        if (!sharedBy && avatars.length > 1) {
            sharedBy = avatars.length;
        }
        if (!sharedBy) {
            const findings = await classifySoleLinker(directories, avatars[0], worldName, world, log);
            yield findings;
            continue;
        }
        const reason = `World is currently linked by ${sharedBy} characters - treated as deliberate sharing, not touched`;
        yield { safe: [], ambiguous: avatars.map(avatar => ({ avatar, worldName, reason })), skipped: [], notLinked: [] };
    }
}

/**
 * Works out, without mutating anything, which characters are safe to unimport vs. ambiguous, skipped or no longer
 * linked by their own card (see module header), one World at a time. Holds at most one page of the world list and
 * one page of a World's linkers, and no database read is open while the consumer holds a yield, so it may write
 * before asking for the next.
 * @returns {AsyncGenerator<Findings, void, undefined>}
 */
export async function* findCandidates(directories, log) {
    const linkedWorlds = await streamLinkedWorlds(directories);
    if (linkedWorlds === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }

    for await (const worlds of linkedWorlds) {
        for (const { world: worldName, linkers } of worlds) {
            yield* classifyWorld(directories, worldName, Number(linkers), log);
            // Each World is a synchronous file read on the main thread; let requests in between.
            await new Promise(resolve => setImmediate(resolve));
        }
    }
}

/**
 * Writes an unimported card back where it lives.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {string} updated The card JSON to write.
 * @param {string | null} parked The card's parked copy in the metadata db, or null when the card lives in its PNG.
 */
async function writeUnimportedCard(directories, avatar, updated, parked) {
    const avatarPath = path.join(directories.characters, avatar);
    if (parked !== null) {
        // Card lives in the db - don't rewrite the PNG (would retire the parked copy via the
        // default upsert).
        await upsertCharacterFromWrite(directories, avatar, updated, null, null);
    } else {
        await writeCardToFile(avatarPath, avatarPath, updated);
        await upsertCharacterFromWrite(directories, avatar, updated);
    }
}

/**
 * Unlinks `extensions.world`, restoring `character_book` from `originalData` first if missing. Never touches the World
 * file. A failed write is named on the console; everything else goes to `report`.
 * @param {(line: string) => void} log
 * @param {ReportSink} report
 * @returns {Promise<'unimported' | 'not-linked' | 'failed'>}
 */
async function unimportOne(directories, candidate, log, report, writeCard) {
    const { avatar, worldName, action } = candidate;
    const avatarPath = path.join(directories.characters, avatar);

    try {
        const parked = await getCharacterCardJson(directories, avatar);
        const rawJson = parked ?? await parseCharacterCard(avatarPath, 'png');
        const card = getCharaCardV2(JSON.parse(rawJson), directories, false);

        if (card?.data?.extensions?.world !== worldName) {
            report.add(`nothing to do: ${avatar} no longer links the lorebook "${worldName}"`);
            return 'not-linked';
        }

        if (action === 'restore-and-unlink') {
            const world = readWorldInfoFile(directories, worldName, false, { logMissing: false });
            if (!Array.isArray(world?.originalData?.entries)) {
                log(color.red(`[unimport-embedded-lore] ${avatar}: the lorebook "${worldName}" no longer has a copy of the original to restore from, so it wasn't changed.`));
                report.add(`failed, left as it was: ${avatar}: the lorebook "${worldName}" no longer has a copy of the original to restore from`);
                return 'failed';
            }
            card.data.character_book = world.originalData;
        }

        card.data.extensions.world = undefined;

        const updated = JSON.stringify(card);
        await writeCard(directories, avatar, updated, parked);

        report.add(action === 'restore-and-unlink'
            ? `undone: ${avatar} got its embedded lorebook back from "${worldName}" and no longer links it`
            : `undone: ${avatar} no longer links "${worldName}" (its own embedded lorebook is the same)`);
        return 'unimported';
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] ${avatar} couldn't be written: ${err.message}`));
        report.add(`failed, left as it was: ${avatar} couldn't be written (${err.message}); tried again on the next server start`);
        return 'failed';
    }
}

/**
 * Writes to the report the Worlds made from an embedded lorebook that no character links as its primary world any
 * more, for manual review. Streams the worlds folder and asks the index about one World at a time, so neither the
 * folder listing nor the linked Worlds are ever held. An unlinked World file that can't be read is reported too, and
 * the listing goes on past it.
 * @param {ReportSink} report
 * @returns {Promise<number>} how many there were
 */
async function reportOrphanedWorlds(directories, report) {
    if (!fs.existsSync(directories.worlds)) return 0;

    let count = 0;
    for await (const dirent of await fsPromises.opendir(directories.worlds)) {
        if (!dirent.name.endsWith('.json')) continue;
        const name = path.parse(dirent.name).name;
        const linked = await isWorldLinkedByAnyCharacter(directories, name);
        if (linked === null) {
            throw new Error(STORE_UNAVAILABLE_MESSAGE);
        }
        if (linked) continue;
        let world;
        try {
            world = readWorldInfoFile(directories, name, false, { logMissing: false });
        } catch (err) {
            report.add(`lorebook not checked: "${dirent.name}" couldn't be read (${err.message}); left in place`);
            await new Promise(resolve => setImmediate(resolve));
            continue;
        }
        if (world?.originalData?.entries) {
            report.add(`lorebook no character links any more: "${name}" was made from an embedded lorebook; left in place, delete it yourself if you don't need it`);
            count++;
        }
        // Each World is a synchronous file read on the main thread; let requests in between.
        await new Promise(resolve => setImmediate(resolve));
    }
    return count;
}

/**
 * @typedef {{ safe: number, migrated: number, failed: number, ambiguous: number, skipped: number, noWorld: number, notLinked: number }} PassCounts
 */

/**
 * The finished line's summary, in plain words. Cards linking a World file that doesn't exist aren't mentioned: nothing
 * was or could be done to them. The report's path is named only when the line says something happened to a card.
 * @param {PassCounts} counts
 * @param {{ apply: boolean, reportOnly: boolean }} mode
 * @param {string} reportPath
 * @returns {string}
 */
function summary(counts, { apply, reportOnly }, reportPath) {
    const { safe, migrated, failed, ambiguous, skipped } = counts;
    const parts = [];
    if (reportOnly) parts.push('report only, nothing written');
    else if (!apply) parts.push(`dry run, nothing written: ${safe} would be undone`);
    else parts.push(`${migrated} undone`);
    if (failed > 0) parts.push(`${failed} couldn't be written`);
    if (skipped > 0) parts.push(`${skipped} couldn't be checked`);
    if (ambiguous > 0) parts.push(`${ambiguous} left alone because they can't be told apart safely`);
    const anything = failed > 0 || skipped > 0 || ambiguous > 0 || (reportOnly ? false : apply ? migrated > 0 : safe > 0);
    return anything ? `${parts.join(', ')}. Full list: ${reportPath}` : 'nothing to undo';
}

/**
 * One pass over every linked World: writes what happens to each card to `report` and adds the skipped ones to
 * `notice`, and handles each safe card - nothing with `reportOnly`, a "would" line without `apply`, otherwise a
 * write, where a failed write is named on the console, added to `notice` and passed to `onFailed`.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ apply: boolean, reportOnly: boolean, log: (line: string) => void, report: ReportSink, progress: ProgressLog, notice: NoticeCollector, onFailed: (avatar: string) => Promise<void>, writeCard: typeof writeUnimportedCard }} options
 * @returns {Promise<PassCounts>}
 */
async function runPass(directories, { apply, reportOnly, log, report, progress, notice, onFailed, writeCard }) {
    const counts = { safe: 0, migrated: 0, failed: 0, ambiguous: 0, skipped: 0, noWorld: 0, notLinked: 0 };

    for await (const findings of findCandidates(directories, log)) {
        for (const { avatar, worldName, reason } of findings.ambiguous) {
            report.add(`left alone: ${avatar} links "${worldName}": ${reason}`);
        }
        counts.ambiguous += findings.ambiguous.length;
        for (const card of findings.skipped) {
            report.add(skippedLine(card.avatar, card.worldName, card.reason, card.detail));
            if (card.reason === 'world-missing') {
                counts.noWorld++;
            } else {
                counts.skipped++;
                notice.addSkipped({ avatar: card.avatar, world: card.worldName, reason: card.reason });
            }
        }
        for (const { avatar, worldName } of findings.notLinked) {
            report.add(`nothing to do: ${avatar} is listed as linking "${worldName}", but its card doesn't link it`);
        }
        counts.notLinked += findings.notLinked.length;
        counts.safe += findings.safe.length;

        for (const candidate of findings.safe) {
            if (reportOnly) continue;
            if (!apply) {
                const { avatar, worldName, action } = candidate;
                report.add(`would be undone: ${avatar} from "${worldName}"${action === 'restore-and-unlink' ? ', getting its embedded lorebook back' : ''}`);
                continue;
            }
            const outcome = await unimportOne(directories, candidate, log, report, writeCard);
            if (outcome === 'unimported') {
                counts.migrated++;
                notice.addUndone({ avatar: candidate.avatar, world: candidate.worldName });
            } else if (outcome === 'not-linked') {
                counts.notLinked++;
            } else {
                counts.failed++;
                notice.addFailing({ avatar: candidate.avatar, world: candidate.worldName });
                await onFailed(candidate.avatar);
            }
        }
        progress.add(findings.ambiguous.length + findings.skipped.length + findings.notLinked.length + findings.safe.length);
    }

    return counts;
}

/** What every progress and finished line of this pass says it is doing. */
const PROGRESS_WHAT = '[unimport-embedded-lore] checking characters linked to a lorebook';

/** The report's first line. */
const REPORT_HEADING = 'Embedded lorebook migration: every character it looked at, and what it did. Only the lines starting with "undone" changed anything; nothing in this list was lost.';

/**
 * A progress log for one pass over the world-linked characters.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(line: string) => void} log
 * @returns {Promise<ProgressLog>}
 */
async function openProgress(directories, log) {
    return new ProgressLog({ what: PROGRESS_WHAT, total: await countCharactersLinkedToAWorld(directories), log });
}

/**
 * Runs the full unimport pass for one user. Dry run by default - pass `{ apply: true }` to actually write. The full
 * list goes to the user's report.
 * @param {typeof writeUnimportedCard} [options.writeCard] Test hook only.
 * @returns {Promise<{ safe: number, migrated: number, failed: number, ambiguous: number, skipped: number, noWorld: number, notLinked: number, orphanedWorlds: number, reportPath: string }>} counts
 */
export async function run(directories, options = {}) {
    const log = options.log ?? console.log;
    const apply = options.apply === true;
    const report = new MigrationReport(directories, NOTICE_ID, REPORT_HEADING);
    const progress = await openProgress(directories, log);

    let counts;
    let orphanedWorlds;
    try {
        counts = await runPass(directories, {
            apply,
            reportOnly: false,
            log,
            report,
            progress,
            notice: new NoticeCollector(),
            onFailed: async () => {},
            writeCard: options.writeCard ?? writeUnimportedCard,
        });
        orphanedWorlds = await reportOrphanedWorlds(directories, report);
    } catch (err) {
        await report.abandon();
        throw err;
    }
    await report.close();

    progress.finish(summary(counts, { apply, reportOnly: false }, report.path));
    return { ...counts, orphanedWorlds, reportPath: report.path };
}

/**
 * Retries one card whose write failed on an earlier boot, checking it again as the full pass would.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {(line: string) => void} log
 * @param {typeof writeUnimportedCard} writeCard
 * @returns {Promise<{ kind: 'unimported', worldName: string } | { kind: 'resolved' } | { kind: 'skipped', worldName: string, reason: SkippedCard['reason'] } | { kind: 'failed', worldName: string }>}
 */
async function retryOne(directories, avatar, log, writeCard) {
    const avatarPath = path.join(directories.characters, avatar);

    let rawJson = await getCharacterCardJson(directories, avatar);
    if (rawJson === null && !fs.existsSync(avatarPath)) {
        return { kind: 'resolved' };
    }
    let card;
    try {
        if (rawJson === null) {
            rawJson = await parseCharacterCard(avatarPath, 'png');
        }
        card = getCharaCardV2(JSON.parse(rawJson), directories, false);
    } catch {
        return { kind: 'skipped', worldName: '', reason: 'card-unreadable' };
    }

    const worldName = card?.data?.extensions?.world;
    if (!worldName) {
        return { kind: 'resolved' };
    }

    let world = null;
    /** @type {SkippedCard['reason'] | null} */
    let skipReason = null;
    try {
        world = readWorldInfoFile(directories, worldName, false, { logMissing: false });
    } catch {
        skipReason = 'world-unreadable';
    }
    if (skipReason === null) {
        if (world === null || world === undefined) {
            skipReason = 'world-missing';
        } else if (typeof world !== 'object' || Array.isArray(world)) {
            skipReason = 'world-unreadable';
        } else if (!world.originalData) {
            return { kind: 'resolved' };
        } else if (!Array.isArray(world.originalData.entries)) {
            skipReason = 'world-snapshot-unusable';
        }
    }
    if (skipReason !== null) {
        return { kind: 'skipped', worldName, reason: skipReason };
    }

    const linkerPages = await streamCharactersLinkedToWorld(directories, worldName);
    if (linkerPages === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }
    /** @type {string[]} */
    let firstPage = [];
    for await (const ids of linkerPages) {
        firstPage = ids;
        break;
    }
    if (firstPage.some(id => id !== avatar)) {
        return { kind: 'resolved' };
    }

    const findings = await classifySoleLinker(directories, avatar, worldName, world, log);
    if (findings.skipped[0]) {
        return { kind: 'skipped', worldName, reason: findings.skipped[0].reason };
    }
    if (findings.notLinked[0] || findings.ambiguous[0]) {
        return { kind: 'resolved' };
    }
    const outcome = await unimportOne(directories, findings.safe[0], log, NO_REPORT, writeCard);
    if (outcome === 'unimported') return { kind: 'unimported', worldName };
    if (outcome === 'not-linked') return { kind: 'resolved' };
    return { kind: 'failed', worldName };
}

/**
 * Retries each card in the pending table, a page at a time, marking each one it is done with settled; then, in one
 * transaction, deletes the settled rows and stores the notice (skipped cards added to the stored ones, the failing
 * list replaced by the cards that failed again).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ log: (line: string) => void, writeCard: typeof writeUnimportedCard }} options
 * @returns {Promise<{ retried: number, migrated: number, failed: number, skipped: number, resolved: number }>}
 */
async function retryPending(directories, { log, writeCard }) {
    const pages = await streamMigrationPending(directories, NOTICE_ID);
    if (pages === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }
    const notice = new NoticeCollector();
    let retried = 0;
    let migrated = 0;
    let failed = 0;
    let skipped = 0;
    let resolved = 0;
    let anySettled = false;

    for await (const rows of pages) {
        for (const { id: avatar, settled } of rows) {
            retried++;
            if (settled) anySettled = true;
            const outcome = await retryOne(directories, avatar, log, writeCard);
            if (outcome.kind === 'failed') {
                failed++;
                notice.addFailing({ avatar, world: outcome.worldName });
                if (settled) await setMigrationPendingSettled(directories, NOTICE_ID, avatar, false);
            } else {
                if (outcome.kind === 'unimported') {
                    migrated++;
                    notice.addUndone({ avatar, world: outcome.worldName });
                } else if (outcome.kind === 'skipped' && outcome.reason !== 'world-missing') {
                    skipped++;
                    notice.addSkipped({ avatar, world: outcome.worldName, reason: outcome.reason });
                } else {
                    resolved++;
                }
                if (!settled) {
                    await setMigrationPendingSettled(directories, NOTICE_ID, avatar, true);
                    anySettled = true;
                }
            }
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    const previousRaw = await readNoticeRaw(directories, NOTICE_ID);
    const previous = parseNotice(previousRaw);
    const merged = mergeRetryNotice(previous, notice);
    /** @type {string | null | undefined} undefined = leave the stored notice as it is */
    let value;
    if (merged === null) {
        value = previousRaw === null ? undefined : null;
    } else if (previous !== null && JSON.stringify(merged) === JSON.stringify({ skipped: previous.skipped, failing: previous.failing, undone: previous.undone })) {
        value = undefined;
    } else {
        value = serializeNotice(previous, merged);
    }
    if (anySettled || value !== undefined) {
        // The pass's own card writes are already in the table (only imports wait in the batch buffer); this commits
        // an open import's buffered rows before the settled rows are deleted.
        await flushBatchImport(directories);
        await commitMigrationSettled(directories, NOTICE_ID, noticeKey(NOTICE_ID), value);
    }
    return { retried, migrated, failed, skipped, resolved };
}

const BOOT_MIGRATION_KEY = 'unimport_embedded_lore_completed';
const PASS_COMPLETED_KEY = 'unimport_embedded_lore_pass_completed';
// The report-only pass runs once more under this key: the full list moved from the console to the report file.
const SKIPPED_REPORTED_KEY = 'unimport_embedded_lore_skipped_reported_v2';
// Generous: a library large enough for this migration to matter can still have its bootstrap backfill
// running well after the server started listening.
const BOOTSTRAP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOTSTRAP_POLL_INTERVAL_MS = 5000;

/**
 * Auto-run entry point (server-main.js calls this, unawaited, after initializeMetadataStores()).
 * Keeps three markers per user: BOOT_MIGRATION_KEY (the migration is done), PASS_COMPLETED_KEY (its full pass
 * ran) and SKIPPED_REPORTED_KEY (its report was written). The full pass runs once and records each card whose write
 * failed in the migration_pending table; a boot after a pass with failed writes retries only those cards, and the
 * migration is marked done only once none is left. On an install where the migration had already finished, a
 * report-only pass runs once and writes the report without changing any card. Skipped and failed cards go into a
 * notice kept for the UI until the user dismisses it.
 * Waits for isBootstrapComplete() before trusting streamLinkedWorlds(), since that index isn't populated until
 * the metadata backfill finishes; on timeout it returns without marking anything, so the next boot retries.
 * @param {number} [options.bootstrapWaitTimeoutMs] Test hook only.
 * @param {number} [options.bootstrapPollIntervalMs] Test hook only.
 * @param {typeof writeUnimportedCard} [options.writeCard] Test hook only.
 */
export async function runOnceAtBoot(directories, options = {}) {
    const log = options.log ?? console.log;
    const waitTimeoutMs = options.bootstrapWaitTimeoutMs ?? BOOTSTRAP_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.bootstrapPollIntervalMs ?? BOOTSTRAP_POLL_INTERVAL_MS;
    const writeCard = options.writeCard ?? writeUnimportedCard;

    /** @returns {Promise<boolean>} false when bootstrap didn't complete in time. */
    const waitForBootstrap = async () => {
        const deadline = Date.now() + waitTimeoutMs;
        while (!(await isBootstrapComplete(directories))) {
            if (Date.now() > deadline) {
                log(color.yellow(`[unimport-embedded-lore] (${directories.root}) The character index still isn't ready after ${Math.round(waitTimeoutMs / 60000)} minutes; trying again on the next server start.`));
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        return true;
    };

    /**
     * One pass with its report: the report replaces the previous one only if the pass finishes.
     * @param {{ apply: boolean, reportOnly: boolean, notice: NoticeCollector, onFailed: (avatar: string) => Promise<void> }} mode
     * @returns {Promise<{ counts: PassCounts, orphanedWorlds: number | null, report: MigrationReport, progress: ProgressLog }>}
     */
    const passWithReport = async ({ apply, reportOnly, notice, onFailed }) => {
        const report = new MigrationReport(directories, NOTICE_ID, REPORT_HEADING);
        const progress = await openProgress(directories, log);
        let counts;
        try {
            counts = await runPass(directories, { apply, reportOnly, log, report, progress, notice, onFailed, writeCard });
        } catch (err) {
            await report.abandon();
            throw err;
        }
        let orphanedWorlds = null;
        try {
            orphanedWorlds = await reportOrphanedWorlds(directories, report);
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] (${directories.root}) Listing the lorebooks no character links any more failed: ${err.message}`));
        }
        await report.close();
        return { counts, orphanedWorlds, report, progress };
    };

    if (await isMigrationMarkedComplete(directories, BOOT_MIGRATION_KEY)) {
        if (await isMigrationMarkedComplete(directories, SKIPPED_REPORTED_KEY)) {
            return { status: 'already-complete' };
        }
        if (!(await waitForBootstrap())) {
            return { status: 'bootstrap-timeout' };
        }
        const notice = new NoticeCollector();
        let result;
        try {
            result = await passWithReport({ apply: false, reportOnly: true, notice, onFailed: async () => {} });
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] (${directories.root}) Writing the report failed; trying again on the next server start: ${err.message}`));
            return { status: 'error' };
        }
        await replaceNotice(directories, NOTICE_ID, notice);
        await markMigrationComplete(directories, SKIPPED_REPORTED_KEY);
        result.progress.finish(summary(result.counts, { apply: false, reportOnly: true }, result.report.path));
        return { status: 'reported', result: result.counts };
    }

    if (!(await waitForBootstrap())) {
        return { status: 'bootstrap-timeout' };
    }

    if (await isMigrationMarkedComplete(directories, PASS_COMPLETED_KEY)) {
        let result;
        try {
            result = await retryPending(directories, { log, writeCard });
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] (${directories.root}) Retrying the cards that couldn't be written failed; trying again on the next server start: ${err.message}`));
            return { status: 'error' };
        }
        if (!(await hasMigrationPending(directories, NOTICE_ID))) {
            await markMigrationComplete(directories, BOOT_MIGRATION_KEY);
        }
        if (result.migrated > 0 || result.failed > 0 || result.skipped > 0) {
            log(color.green(`[unimport-embedded-lore] retried ${result.retried} card(s) that couldn't be written before: ${result.migrated} undone, ${result.failed} still couldn't be written (tried again next start), ${result.skipped} couldn't be checked, ${result.resolved} no longer need it.`));
        }
        return { status: 'retried', result };
    }

    const notice = new NoticeCollector();
    let result;
    try {
        if (await hasMigrationPending(directories, NOTICE_ID)) {
            await clearMigrationPending(directories, NOTICE_ID);
        }
        result = await passWithReport({
            apply: true,
            reportOnly: false,
            notice,
            onFailed: avatar => addMigrationPending(directories, NOTICE_ID, avatar),
        });
        // The pass's own card writes are already in the table (only imports wait in the batch buffer); this commits
        // an open import's buffered rows before the markers below are written.
        await flushBatchImport(directories);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] (${directories.root}) The migration failed; trying again on the next server start: ${err.message}`));
        return { status: 'error' };
    }
    await replaceNotice(directories, NOTICE_ID, notice);
    await markMigrationComplete(directories, PASS_COMPLETED_KEY);
    await markMigrationComplete(directories, SKIPPED_REPORTED_KEY);
    if (!(await hasMigrationPending(directories, NOTICE_ID))) {
        await markMigrationComplete(directories, BOOT_MIGRATION_KEY);
    }
    result.progress.finish(summary(result.counts, { apply: true, reportOnly: false }, result.report.path));
    return { status: 'ran', result: { ...result.counts, orphanedWorlds: result.orphanedWorlds } };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const { initConfig } = await import('../config-init.js');
    const { getUserDirectories, getAllUserHandles } = await import('../users.js');

    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };

    const dataRoot = getArg('data-root', './data');
    const handleArg = getArg('handle', null);
    const configPath = getArg('config', './config.yaml');
    const apply = args.includes('--apply');

    globalThis.DATA_ROOT = dataRoot;
    initConfig(configPath);

    const handles = handleArg ? [handleArg] : await getAllUserHandles();
    console.log(color.cyan(`[unimport-embedded-lore] Running for handle(s): ${handles.join(', ')} under data root "${dataRoot}"${apply ? '' : ' (dry run)'}...`));

    let anyFailed = false;
    for (const handle of handles) {
        const directories = getUserDirectories(handle);
        console.log(color.cyan(`[unimport-embedded-lore] --- ${handle} ---`));
        try {
            const result = await run(directories, { apply });
            if (result.failed > 0) anyFailed = true;
        } catch (err) {
            console.error(color.red(`[unimport-embedded-lore] Run failed for handle "${handle}":`), err);
            anyFailed = true;
        }
    }

    if (anyFailed) {
        process.exitCode = 1;
    }
}
