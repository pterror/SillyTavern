const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A message timestamp in milliseconds, 0 when it can't be read. Takes what upstream chats have held: epoch numbers,
 * ISO strings, `Month DD, YYYY H:MMam`, and the `YYYY-MM-DD@HHhMMmSSsMSms` forms.
 * @param {unknown} timestamp
 * @returns {number}
 */
export function parseTimestamp(timestamp) {
    if (!timestamp) return 0;
    if (timestamp instanceof Date) return timestamp.getTime();
    if (typeof timestamp === 'number' || (typeof timestamp === 'string' && /^\d+$/.test(timestamp))) {
        const unixTime = Number(timestamp);
        return Number.isFinite(unixTime) && unixTime >= 0 ? unixTime : 0;
    }
    if (typeof timestamp !== 'string') return 0;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)) return new Date(timestamp).getTime();

    const meridiem = timestamp.match(/(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i);
    if (meridiem) {
        const [, month, day, year, hour, minute, ampm] = meridiem;
        const hour24 = ampm.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
        const t = new Date(`${year}-${String(monthNames.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour24).padStart(2, '0')}:${minute.padStart(2, '0')}:00`).getTime();
        return Number.isFinite(t) ? t : 0;
    }
    const humanized = timestamp.match(/(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m ?(\d{1,2})s ?(?:(\d{1,3})ms)?/);
    if (humanized) {
        const [, year, month, day, hour, min, sec, ms] = humanized;
        const t = new Date(`${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}${ms ? `.${ms.padStart(3, '0')}` : ''}Z`).getTime();
        return Number.isFinite(t) ? t : 0;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}
