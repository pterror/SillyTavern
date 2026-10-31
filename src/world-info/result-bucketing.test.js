import assert from 'node:assert/strict';
import { bucketActivatedEntries, world_info_position, wi_anchor_position, extension_prompt_roles } from './result-bucketing.js';

const identity = { resolveContent: (entry) => entry.content };

{
    const entries = [
        { uid: 'b1', position: world_info_position.before, order: 10, content: 'low-order-before' },
        { uid: 'b2', position: world_info_position.before, order: 30, content: 'high-order-before' },
        { uid: 'b3', position: world_info_position.before, order: 20, content: 'mid-order-before' },
        { uid: 'a1', position: world_info_position.after, order: 5, content: 'low-order-after' },
        { uid: 'a2', position: world_info_position.after, order: 15, content: 'high-order-after' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoBefore, 'low-order-before\nmid-order-before\nhigh-order-before');
    assert.equal(result.worldInfoAfter, 'low-order-after\nhigh-order-after');
}

{
    const entries = [
        { uid: 'e1', position: world_info_position.before, order: 1, content: '' },
        { uid: 'e2', position: world_info_position.after, order: 1, content: null },
        { uid: 'e3', position: world_info_position.before, order: 1, content: 'kept' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoBefore, 'kept');
    assert.equal(result.worldInfoAfter, '');
}

{
    const entries = [
        { uid: 'r1', position: world_info_position.before, order: 1, content: 'raw-1' },
        { uid: 'r2', position: world_info_position.before, order: 2, content: 'raw-2' },
    ];
    const result = bucketActivatedEntries(entries, { resolveContent: (e) => (e.uid === 'r1' ? '' : `resolved-${e.content}`) });
    assert.equal(result.worldInfoBefore, 'resolved-raw-2');
}

{
    const entries = [
        { uid: 'em1', position: world_info_position.EMTop, order: 1, content: 'top-1' },
        { uid: 'em2', position: world_info_position.EMBottom, order: 2, content: 'bottom-1' },
        { uid: 'em3', position: world_info_position.EMTop, order: 3, content: 'top-2' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.deepEqual(result.worldInfoExamples, [
        { position: wi_anchor_position.before, content: 'top-1' },
        { position: wi_anchor_position.after, content: 'bottom-1' },
        { position: wi_anchor_position.before, content: 'top-2' },
    ]);
}

{
    const entries = [
        { uid: 'an1', position: world_info_position.ANTop, order: 1, content: 'an-top-1' },
        { uid: 'an2', position: world_info_position.ANTop, order: 2, content: 'an-top-2' },
        { uid: 'an3', position: world_info_position.ANBottom, order: 1, content: 'an-bottom-1' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.deepEqual(result.anBefore, ['an-top-1', 'an-top-2']);
    assert.deepEqual(result.anAfter, ['an-bottom-1']);
}

{
    const entries = [
        { uid: 'd1', position: world_info_position.atDepth, order: 1, depth: 2, role: extension_prompt_roles.SYSTEM, content: 'first-by-order' },
        { uid: 'd2', position: world_info_position.atDepth, order: 2, depth: 2, role: extension_prompt_roles.SYSTEM, content: 'second-by-order' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoDepth.length, 1);
    assert.equal(result.worldInfoDepth[0].depth, 2);
    assert.equal(result.worldInfoDepth[0].role, extension_prompt_roles.SYSTEM);
    assert.deepEqual(result.worldInfoDepth[0].entries, ['first-by-order', 'second-by-order']);
}

{
    const entries = [
        { uid: 'd1', position: world_info_position.atDepth, order: 1, depth: 1, role: extension_prompt_roles.SYSTEM, content: 'depth-1-content' },
        { uid: 'd2', position: world_info_position.atDepth, order: 2, depth: 2, role: extension_prompt_roles.SYSTEM, content: 'depth-2-content' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoDepth.length, 2);
}

{
    const entries = [
        { uid: 'd1', position: world_info_position.atDepth, order: 1, depth: 3, role: extension_prompt_roles.SYSTEM, content: 'sys-content' },
        { uid: 'd2', position: world_info_position.atDepth, order: 2, depth: 3, role: extension_prompt_roles.USER, content: 'user-content' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoDepth.length, 2);
    const sysEntry = result.worldInfoDepth.find((e) => e.role === extension_prompt_roles.USER);
    assert.deepEqual(sysEntry.entries, ['user-content']);
}

{
    const DEFAULT_DEPTH = 4;
    const entries = [
        { uid: 'd1', position: world_info_position.atDepth, order: 2, depth: undefined, role: extension_prompt_roles.SYSTEM, content: 'undefined-depth-content' },
        { uid: 'd2', position: world_info_position.atDepth, order: 1, depth: DEFAULT_DEPTH, role: extension_prompt_roles.SYSTEM, content: 'explicit-default-depth-content' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.equal(result.worldInfoDepth.length, 2, 'the raw-undefined stored depth never matches an explicit DEFAULT_DEPTH lookup, so no merge happens');
    const undefinedDepthEntry = result.worldInfoDepth.find((e) => e.entries.includes('undefined-depth-content'));
    assert.equal(undefinedDepthEntry.depth, undefined, 'stored .depth is the RAW depth (undefined) of the entry that created the bucket, not DEFAULT_DEPTH');
    const explicitDepthEntry = result.worldInfoDepth.find((e) => e.entries.includes('explicit-default-depth-content'));
    assert.equal(explicitDepthEntry.depth, DEFAULT_DEPTH);
}

{
    const entries = [
        { uid: 'o1', position: world_info_position.outlet, order: 1, outletName: 'sidebar', content: 'sidebar-1' },
        { uid: 'o2', position: world_info_position.outlet, order: 2, outletName: 'sidebar', content: 'sidebar-2' },
        { uid: 'o3', position: world_info_position.outlet, order: 1, outletName: 'footer', content: 'footer-1' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.deepEqual(result.outletEntries, {
        sidebar: ['sidebar-2', 'sidebar-1'],
        footer: ['footer-1'],
    });
}

{
    const entries = [
        { uid: 'o1', position: world_info_position.outlet, order: 1, outletName: '', content: 'orphan' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.deepEqual(result.outletEntries, {});
    assert.equal(result.worldInfoBefore, '');
    assert.equal(result.worldInfoAfter, '');
    assert.deepEqual(result.worldInfoExamples, []);
    assert.deepEqual(result.worldInfoDepth, []);
    assert.deepEqual(result.anBefore, []);
    assert.deepEqual(result.anAfter, []);
}

{
    const entries = [
        { uid: 'x1', position: 999, order: 1, content: 'nowhere' },
    ];
    const result = bucketActivatedEntries(entries, identity);
    assert.deepEqual(result, {
        worldInfoBefore: '',
        worldInfoAfter: '',
        worldInfoExamples: [],
        worldInfoDepth: [],
        anBefore: [],
        anAfter: [],
        outletEntries: {},
    });
}

{
    const entries = [
        { uid: 'p1', position: world_info_position.before, order: 1, content: 'plain-content' },
    ];
    const result = bucketActivatedEntries(entries);
    assert.equal(result.worldInfoBefore, 'plain-content');
}

console.log('All result-bucketing tests passed.');
