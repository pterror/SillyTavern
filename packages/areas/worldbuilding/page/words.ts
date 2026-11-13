// A translated sentence with its `${0}`, `${1}`… filled in.
export const fill = (text: string, ...values: string[]): string =>
    values.reduce((filled, value, at) => filled.replaceAll(`\${${at}}`, value), text);

export const count = (n: number): string => n.toLocaleString('en-US');
