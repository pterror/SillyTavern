import { describe, test, expect } from '@jest/globals';
import moment from 'moment';
import { substituteParams } from '../src/macro-substitution.js';

// The time macros (public/scripts/macros/definitions/time-macros.js) give the user's time, wherever they run: the
// server may be in another time zone than the page.

describe('time macros in the user\'s time zone', () => {
    test('{{isotime}}, {{isodate}} and {{datetimeformat}} use the offset given', () => {
        // An offset 13 hours from this process's own puts the user on a different hour, whatever the zone here.
        const utcOffset = moment().utcOffset() + 13 * 60 > 14 * 60 ? moment().utcOffset() - 13 * 60 : moment().utcOffset() + 13 * 60;
        const theirs = moment().utcOffset(utcOffset);
        const shown = substituteParams('{{isotime}} {{isodate}} {{datetimeformat::Z}}', { utcOffset });
        expect(shown).toBe(`${theirs.format('HH:mm')} ${theirs.format('YYYY-MM-DD')} ${theirs.format('Z')}`);
        expect(shown.slice(0, 2)).not.toBe(moment().format('HH'));
    });

    test('with no offset, this process\'s own', () => {
        expect(substituteParams('{{datetimeformat::Z}}')).toBe(moment().format('Z'));
    });
});
