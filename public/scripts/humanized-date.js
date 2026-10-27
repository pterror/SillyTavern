/**
 * A time as upstream names chats and files by it, in this clock's zone: `YYYY-MM-DD@HHhMMmSSsMSms`. One definition,
 * for the page and the server (which names chats by it).
 * @param {number} [timestamp] Milliseconds.
 * @returns {string}
 */
export function humanizedDateTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dt = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
    };
    for (const key in dt) {
        const padLength = key === 'millisecond' ? 3 : 2;
        dt[key] = dt[key].toString().padStart(padLength, '0');
    }
    return `${dt.year}-${dt.month}-${dt.day}@${dt.hour}h${dt.minute}m${dt.second}s${dt.millisecond}ms`;
}

const HUMANIZED_TAIL = /(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d{3})ms$/;

/**
 * The time a name ends with, as `humanizedDateTime()` writes it, and the text before it; null when it ends with none.
 * @param {string} name
 * @returns {{ head: string, time: number } | null}
 */
export function humanizedTail(name) {
    const m = HUMANIZED_TAIL.exec(name);
    if (!m) return null;
    const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
    return { head: name.slice(0, m.index), time: new Date(y, mo - 1, d, h, mi, s, ms).getTime() };
}
