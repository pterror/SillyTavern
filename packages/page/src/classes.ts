export function classes(fixed: string, on: Record<string, boolean>): string {
    return [fixed, ...Object.entries(on).flatMap(([name, isOn]) => (isOn ? [name] : []))].join(' ');
}
