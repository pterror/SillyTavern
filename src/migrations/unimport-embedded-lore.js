import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite, getCharacterCardJson, streamLinkedWorlds, streamCharactersLinkedToWorld, isWorldLinkedByAnyCharacter, isMigrationMarkedComplete, markMigrationComplete, isBootstrapComplete, addMigrationPending, setMigrationPendingSettled, clearMigrationPending, hasMigrationPending, streamMigrationPending, commitMigrationSettled } from '../character-metadata-db.js';
import { NoticeCollector, noticeKey, readNoticeRaw, parseNotice, serializeNotice, replaceNotice, mergeRetryNotice } from './migration-notices.js';

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
 * and failed cards are listed on the console and kept in a notice for the UI (migration-notices.js) until
 * the user dismisses it. Before reading the index it waits for isBootstrapComplete(), since that index
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
 * The console line for a card left untouched because it couldn't be checked.
 * @param {string} avatar
 * @param {string} worldName
 * @param {SkippedCard['reason']} reason
 * @param {string} [detail]
 * @returns {string}
 */
function skippedLine(avatar, worldName, reason, detail) {
    let text;
    switch (reason) {
        case 'world-missing':
            text = 'its World file doesn\'t exist, so whether it came from an embedded-lore import can\'t be told';
            break;
        case 'world-unreadable':
            text = `its World file couldn't be read (${detail}), so whether it came from an embedded-lore import can't be told`;
            break;
        case 'world-snapshot-unusable':
            text = 'its World came from an embedded-lore import but its originalData snapshot has no entries list, so it can\'t be compared or restored';
            break;
        case 'card-unreadable':
            text = `its card couldn't be read (${detail})`;
            break;
    }
    return `[unimport-embedded-lore] SKIPPED, not touched: ${avatar} (linked to "${worldName}") - ${text}`;
}

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
        log(color.red(`[unimport-embedded-lore] Failed to read candidate ${avatar}, skipping: ${err.message}`));
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
        world = readWorldInfoFile(directories, worldName, false);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to read World "${worldName}": ${err.message}`));
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
 * Unlinks `extensions.world`, restoring `character_book` from `originalData` first if missing. Never touches the World file.
 * @returns {Promise<'unimported' | 'not-linked' | 'failed'>}
 */
async function unimportOne(directories, candidate, log, writeCard) {
    const { avatar, worldName, action } = candidate;
    const avatarPath = path.join(directories.characters, avatar);

    try {
        const parked = await getCharacterCardJson(directories, avatar);
        const rawJson = parked ?? await parseCharacterCard(avatarPath, 'png');
        const card = getCharaCardV2(JSON.parse(rawJson), directories, false);

        if (card?.data?.extensions?.world !== worldName) {
            log(color.yellow(`[unimport-embedded-lore] ${avatar} no longer links to "${worldName}" (changed since candidates were computed) - skipping.`));
            return 'not-linked';
        }

        if (action === 'restore-and-unlink') {
            const world = readWorldInfoFile(directories, worldName, false);
            if (!Array.isArray(world?.originalData?.entries)) {
                log(color.red(`[unimport-embedded-lore] ${avatar}: World "${worldName}" no longer has a restorable originalData snapshot - skipping.`));
                return 'failed';
            }
            card.data.character_book = world.originalData;
        }

        card.data.extensions.world = undefined;

        const updated = JSON.stringify(card);
        await writeCard(directories, avatar, updated, parked);

        log(color.green(`[unimport-embedded-lore] ${avatar}: unlinked from "${worldName}"${action === 'restore-and-unlink' ? ' and restored its embedded lorebook' : ''}.`));
        return 'unimported';
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to unimport ${avatar}: ${err.message}`));
        return 'failed';
    }
}

const ORPHANED_WORLDS_PER_LINE = 100;

/**
 * Logs the Worlds carrying the originalData marker that no character links as its primary world any more, for
 * manual review, at most ORPHANED_WORLDS_PER_LINE names per line. Streams the worlds folder and asks the index
 * about one World at a time, so neither the folder listing nor the linked Worlds are ever held.
 * @returns {Promise<number>} how many there were
 */
async function reportOrphanedWorlds(directories, log) {
    if (!fs.existsSync(directories.worlds)) return 0;

    let count = 0;
    /** @type {string[]} */
    let names = [];
    const flush = () => {
        if (names.length === 0) return;
        log(color.cyan(`[unimport-embedded-lore] ${names.length} World file(s) came from an embedded-lore import and now have no character linking to them - left in place, review/delete manually if wanted: ${names.join(', ')}`));
        names = [];
    };

    for await (const dirent of await fsPromises.opendir(directories.worlds)) {
        if (!dirent.name.endsWith('.json')) continue;
        const name = path.parse(dirent.name).name;
        const linked = await isWorldLinkedByAnyCharacter(directories, name);
        if (linked === null) {
            throw new Error(STORE_UNAVAILABLE_MESSAGE);
        }
        if (linked) continue;
        const world = readWorldInfoFile(directories, name, false);
        if (world?.originalData?.entries) {
            names.push(name);
            count++;
            if (names.length >= ORPHANED_WORLDS_PER_LINE) flush();
        }
        // Each World is a synchronous file read on the main thread; let requests in between.
        await new Promise(resolve => setImmediate(resolve));
    }
    flush();
    return count;
}

/**
 * @typedef {{ safe: number, migrated: number, failed: number, ambiguous: number, skipped: number, notLinked: number }} PassCounts
 */

const DRY_RUN_SUFFIX = ' (dry run, nothing written - pass --apply to write)';
const REPORT_ONLY_SUFFIX = ' (report only, nothing written)';

/**
 * Logs the pass's closing line.
 * @param {(line: string) => void} log
 * @param {PassCounts} counts
 * @param {string} suffix
 */
function logDone(log, counts, suffix) {
    const { safe, migrated, failed, ambiguous, skipped, notLinked } = counts;
    log(color.green(`[unimport-embedded-lore] Done${suffix}: ${migrated}/${safe} unimported, ${failed} failed, ${ambiguous} left ambiguous, ${skipped} skipped${notLinked > 0 ? `, ${notLinked} no longer linked by their card` : ''}.`));
}

/**
 * One pass over every linked World: logs each ambiguous, skipped and not-linked card, adds the skipped ones to
 * `notice`, and handles each safe card - nothing with `reportOnly`, a DRY RUN line without `apply`, otherwise a
 * write, where a failed write is added to `notice` and passed to `onFailed`.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ apply: boolean, reportOnly: boolean, log: (line: string) => void, notice: NoticeCollector, onFailed: (avatar: string) => Promise<void>, writeCard: typeof writeUnimportedCard }} options
 * @returns {Promise<PassCounts>}
 */
async function runPass(directories, { apply, reportOnly, log, notice, onFailed, writeCard }) {
    let safe = 0;
    let migrated = 0;
    let failed = 0;
    let ambiguous = 0;
    let skipped = 0;
    let notLinked = 0;

    for await (const findings of findCandidates(directories, log)) {
        for (const { avatar, worldName, reason } of findings.ambiguous) {
            log(color.yellow(`[unimport-embedded-lore] AMBIGUOUS, not touched: ${avatar} (linked to "${worldName}") - ${reason}`));
        }
        ambiguous += findings.ambiguous.length;
        for (const card of findings.skipped) {
            log(color.yellow(skippedLine(card.avatar, card.worldName, card.reason, card.detail)));
            notice.addSkipped({ avatar: card.avatar, world: card.worldName, reason: card.reason });
        }
        skipped += findings.skipped.length;
        for (const { avatar, worldName } of findings.notLinked) {
            log(color.yellow(`[unimport-embedded-lore] ${avatar}: the character index lists it as linked to "${worldName}" but its card doesn't link it - nothing to unlink.`));
        }
        notLinked += findings.notLinked.length;
        safe += findings.safe.length;

        for (const candidate of findings.safe) {
            if (reportOnly) continue;
            if (!apply) {
                const { avatar, worldName, action } = candidate;
                log(color.cyan(`[unimport-embedded-lore] DRY RUN would ${action === 'restore-and-unlink' ? 'restore character_book and unlink' : 'unlink'}: ${avatar} from "${worldName}"`));
                continue;
            }
            const outcome = await unimportOne(directories, candidate, log, writeCard);
            if (outcome === 'unimported') {
                migrated++;
            } else if (outcome === 'not-linked') {
                notLinked++;
            } else {
                failed++;
                notice.addFailing({ avatar: candidate.avatar, world: candidate.worldName });
                await onFailed(candidate.avatar);
            }
        }
    }

    return { safe, migrated, failed, ambiguous, skipped, notLinked };
}

/**
 * Runs the full unimport pass for one user. Dry run by default - pass `{ apply: true }` to actually write.
 * @param {typeof writeUnimportedCard} [options.writeCard] Test hook only.
 * @returns {Promise<{ safe: number, migrated: number, failed: number, ambiguous: number, skipped: number, notLinked: number, orphanedWorlds: number }>} counts
 */
export async function run(directories, options = {}) {
    const log = options.log ?? console.log;
    const apply = options.apply === true;

    const counts = await runPass(directories, {
        apply,
        reportOnly: false,
        log,
        notice: new NoticeCollector(),
        onFailed: async () => {},
        writeCard: options.writeCard ?? writeUnimportedCard,
    });

    const orphanedWorlds = await reportOrphanedWorlds(directories, log);

    logDone(log, counts, apply ? '' : DRY_RUN_SUFFIX);
    return { ...counts, orphanedWorlds };
}

/**
 * Retries one card whose write failed on an earlier boot, checking it again as the full pass would.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {(line: string) => void} log
 * @param {typeof writeUnimportedCard} writeCard
 * @returns {Promise<{ kind: 'unimported' } | { kind: 'resolved' } | { kind: 'skipped', worldName: string, reason: SkippedCard['reason'] } | { kind: 'failed', worldName: string }>}
 */
async function retryOne(directories, avatar, log, writeCard) {
    const avatarPath = path.join(directories.characters, avatar);

    let rawJson = await getCharacterCardJson(directories, avatar);
    if (rawJson === null && !fs.existsSync(avatarPath)) {
        log(color.yellow(`[unimport-embedded-lore] ${avatar}: no longer exists - nothing to retry.`));
        return { kind: 'resolved' };
    }
    let card;
    try {
        if (rawJson === null) {
            rawJson = await parseCharacterCard(avatarPath, 'png');
        }
        card = getCharaCardV2(JSON.parse(rawJson), directories, false);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to read ${avatar} for retry: ${err.message}`));
        log(color.yellow(skippedLine(avatar, '', 'card-unreadable', err.message)));
        return { kind: 'skipped', worldName: '', reason: 'card-unreadable' };
    }

    const worldName = card?.data?.extensions?.world;
    if (!worldName) {
        log(color.yellow(`[unimport-embedded-lore] ${avatar}: no longer linked to a World - nothing to retry.`));
        return { kind: 'resolved' };
    }

    let world = null;
    /** @type {SkippedCard['reason'] | null} */
    let skipReason = null;
    /** @type {string | undefined} */
    let detail;
    try {
        world = readWorldInfoFile(directories, worldName, false);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to read World "${worldName}": ${err.message}`));
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
            log(color.yellow(`[unimport-embedded-lore] ${avatar}: its World "${worldName}" isn't an embedded-lore import (no originalData) - nothing to retry.`));
            return { kind: 'resolved' };
        } else if (!Array.isArray(world.originalData.entries)) {
            skipReason = 'world-snapshot-unusable';
        }
    }
    if (skipReason !== null) {
        log(color.yellow(skippedLine(avatar, worldName, skipReason, detail)));
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
        log(color.yellow(`[unimport-embedded-lore] AMBIGUOUS, not touched: ${avatar} (linked to "${worldName}") - World is currently linked by more than one character - treated as deliberate sharing, not touched`));
        return { kind: 'resolved' };
    }

    const findings = await classifySoleLinker(directories, avatar, worldName, world, log);
    if (findings.skipped[0]) {
        const skippedCard = findings.skipped[0];
        log(color.yellow(skippedLine(skippedCard.avatar, skippedCard.worldName, skippedCard.reason, skippedCard.detail)));
        return { kind: 'skipped', worldName, reason: skippedCard.reason };
    }
    if (findings.notLinked[0]) {
        log(color.yellow(`[unimport-embedded-lore] ${avatar}: the character index lists it as linked to "${worldName}" but its card doesn't link it - nothing to unlink.`));
        return { kind: 'resolved' };
    }
    if (findings.ambiguous[0]) {
        log(color.yellow(`[unimport-embedded-lore] AMBIGUOUS, not touched: ${avatar} (linked to "${worldName}") - ${findings.ambiguous[0].reason}`));
        return { kind: 'resolved' };
    }
    const outcome = await unimportOne(directories, findings.safe[0], log, writeCard);
    if (outcome === 'unimported') return { kind: 'unimported' };
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
                } else if (outcome.kind === 'skipped') {
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
    } else if (previous !== null && JSON.stringify({ skipped: merged.skipped, failing: merged.failing }) === JSON.stringify({ skipped: previous.skipped, failing: previous.failing })) {
        value = undefined;
    } else {
        value = serializeNotice(previous, merged);
    }
    if (anySettled || value !== undefined) {
        await commitMigrationSettled(directories, NOTICE_ID, noticeKey(NOTICE_ID), value);
    }
    return { retried, migrated, failed, skipped, resolved };
}

const BOOT_MIGRATION_KEY = 'unimport_embedded_lore_completed';
const PASS_COMPLETED_KEY = 'unimport_embedded_lore_pass_completed';
const SKIPPED_REPORTED_KEY = 'unimport_embedded_lore_skipped_reported';
// Generous: a library large enough for this migration to matter can still have its bootstrap backfill
// running well after the server started listening.
const BOOTSTRAP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOTSTRAP_POLL_INTERVAL_MS = 5000;

/**
 * Auto-run entry point (server-main.js calls this, unawaited, after initializeMetadataStores()).
 * Keeps three markers per user: BOOT_MIGRATION_KEY (the migration is done), PASS_COMPLETED_KEY (its full pass
 * ran) and SKIPPED_REPORTED_KEY (its skipped cards were reported). The full pass runs once and records each card
 * whose write failed in the migration_pending table; a boot after a pass with failed writes retries only those
 * cards, and the migration is marked done only once none is left. On an install where the migration had already
 * finished, a report-only pass runs once and lists the skipped cards without writing anything. Skipped and failed
 * cards go to the console and into a notice kept for the UI until the user dismisses it.
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
                log(color.yellow(`[unimport-embedded-lore] (${directories.root}) Metadata bootstrap still not complete after ${Math.round(waitTimeoutMs / 60000)} minutes - giving up for this boot, will retry next boot.`));
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        return true;
    };

    if (await isMigrationMarkedComplete(directories, BOOT_MIGRATION_KEY)) {
        if (await isMigrationMarkedComplete(directories, SKIPPED_REPORTED_KEY)) {
            return { status: 'already-complete' };
        }
        if (!(await waitForBootstrap())) {
            return { status: 'bootstrap-timeout' };
        }
        log(color.cyan(`[unimport-embedded-lore] (${directories.root}) The migration already ran; listing the cards it skips (report only, nothing written)...`));
        const notice = new NoticeCollector();
        let counts;
        try {
            counts = await runPass(directories, { apply: false, reportOnly: true, log, notice, onFailed: async () => {}, writeCard });
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] (${directories.root}) Report-only pass failed, will retry next boot: ${err.message}`));
            return { status: 'error' };
        }
        await replaceNotice(directories, NOTICE_ID, notice);
        await markMigrationComplete(directories, SKIPPED_REPORTED_KEY);
        logDone(log, counts, REPORT_ONLY_SUFFIX);
        return { status: 'reported', result: counts };
    }

    if (!(await waitForBootstrap())) {
        return { status: 'bootstrap-timeout' };
    }

    if (await isMigrationMarkedComplete(directories, PASS_COMPLETED_KEY)) {
        log(color.cyan(`[unimport-embedded-lore] (${directories.root}) Retrying the cards whose writes failed on an earlier boot...`));
        let result;
        try {
            result = await retryPending(directories, { log, writeCard });
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] (${directories.root}) Retry of failed cards failed, will retry next boot: ${err.message}`));
            return { status: 'error' };
        }
        if (!(await hasMigrationPending(directories, NOTICE_ID))) {
            await markMigrationComplete(directories, BOOT_MIGRATION_KEY);
        }
        log(color.green(`[unimport-embedded-lore] Retry done: ${result.retried} retried, ${result.migrated} unimported, ${result.failed} still failed (retried next boot), ${result.skipped} skipped, ${result.resolved} no longer need it.`));
        return { status: 'retried', result };
    }

    log(color.cyan(`[unimport-embedded-lore] (${directories.root}) Running one-time boot migration...`));
    const notice = new NoticeCollector();
    let counts;
    try {
        if (await hasMigrationPending(directories, NOTICE_ID)) {
            await clearMigrationPending(directories, NOTICE_ID);
        }
        counts = await runPass(directories, {
            apply: true,
            reportOnly: false,
            log,
            notice,
            onFailed: avatar => addMigrationPending(directories, NOTICE_ID, avatar),
            writeCard,
        });
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] (${directories.root}) Boot migration run failed, will retry next boot: ${err.message}`));
        return { status: 'error' };
    }
    await replaceNotice(directories, NOTICE_ID, notice);
    await markMigrationComplete(directories, PASS_COMPLETED_KEY);
    await markMigrationComplete(directories, SKIPPED_REPORTED_KEY);
    if (await hasMigrationPending(directories, NOTICE_ID)) {
        log(color.yellow(`[unimport-embedded-lore] (${directories.root}) ${counts.failed} card(s) couldn't be written; the migration stays unfinished and retries them on the next boot.`));
    } else {
        await markMigrationComplete(directories, BOOT_MIGRATION_KEY);
    }
    let orphanedWorlds = null;
    try {
        orphanedWorlds = await reportOrphanedWorlds(directories, log);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] (${directories.root}) Listing orphaned World files failed: ${err.message}`));
    }
    logDone(log, counts, '');
    return { status: 'ran', result: { ...counts, orphanedWorlds } };
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
