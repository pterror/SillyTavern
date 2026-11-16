import { describe, test, expect } from '@jest/globals';
import { cardGreetingOf, composedOpeningNodeId, isProvisionalNodeId, isStoredNodeId, unstoredGreetingNodeId } from '../public/scripts/node-identity.js';
import { targetsOf } from '../src/message-counts.js';

describe('an unstored card greeting\'s node id', () => {
    test('is its character and its greeting id: a member\'s by its avatar, else the chat\'s character', () => {
        expect(cardGreetingOf({ original_avatar: 'Bo.png', extra: { greeting_id: 2 } }, null)).toEqual({ greeting: 2, avatar: 'Bo.png' });
        expect(cardGreetingOf({ extra: { greeting_id: 0 } }, 'Ada.png')).toEqual({ greeting: 0, avatar: 'Ada.png' });
        expect(cardGreetingOf({ extra: {} }, 'Ada.png')).toBeNull();
        expect(cardGreetingOf({ extra: { greeting_id: 1 } }, null)).toBeNull();
        expect(unstoredGreetingNodeId({ extra: { greeting_id: 3 } }, 'Ada.png')).toBe(unstoredGreetingNodeId({ original_avatar: 'Ada.png', extra: { greeting_id: 3 } }, null));
    });

    test('is the same for one greeting whatever its text or speaker name, and differs between characters of one name', () => {
        const ann = { name: 'Ann', mes: 'Hi', original_avatar: 'Ann.png', extra: { greeting_id: 0 } };
        const twin = { ...ann, original_avatar: 'Ann1.png' };
        expect(unstoredGreetingNodeId(ann, null)).not.toBe(unstoredGreetingNodeId(twin, null));
        expect(unstoredGreetingNodeId({ ...ann, name: 'Renamed', mes: 'Hello' }, null)).toBe(unstoredGreetingNodeId(ann, null));
        expect(unstoredGreetingNodeId({ ...ann, extra: { greeting_id: 1 } }, null)).not.toBe(unstoredGreetingNodeId(ann, null));
    });

    test('is unstored, as is a composed opening\'s, each composed one its own', () => {
        const greeting = unstoredGreetingNodeId({ extra: { greeting_id: 0 } }, 'Ada.png');
        const composed = composedOpeningNodeId();
        for (const id of [greeting, composed]) {
            expect(isProvisionalNodeId(id)).toBe(true);
            expect(isStoredNodeId(id)).toBe(false);
        }
        expect(composedOpeningNodeId()).not.toBe(composed);
    });

    test('keys the server\'s counts of unstored openings as the page names them', () => {
        const alternatives = [
            { node_id: null, mes: 'Hi', name: 'Ann', original_avatar: 'Ann.png', extra: { greeting_id: 0 } },
            { node_id: null, mes: 'Hi', name: 'Ann', original_avatar: 'Ann1.png', extra: { greeting_id: 0 } },
            { node_id: null, mes: 'Own', name: 'Ada', extra: { greeting_id: 4 } },
            { node_id: 'n9', mes: 'Stored', name: 'Ada', extra: { greeting_id: 4 } },
        ];
        expect(targetsOf({ alternatives, avatar: 'Ada.png' }).map(t => t.key)).toEqual([
            unstoredGreetingNodeId(alternatives[0], null),
            unstoredGreetingNodeId(alternatives[1], null),
            unstoredGreetingNodeId({ extra: { greeting_id: 4 } }, 'Ada.png'),
            'n9',
        ]);
    });
});
