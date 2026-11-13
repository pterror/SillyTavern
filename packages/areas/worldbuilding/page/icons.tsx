const PATHS = {
    search: 'M16 16l4.5 4.5M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0',
    plus: 'M12 5v14M5 12h14',
    chevron: 'M6 9l6 6 6-6',
    check: 'M5 12l4 4 10-10',
    prompt: 'M5 4h10l4 4v12H5zM9 11h6M9 15h6',
    pencil: 'M14 4l6 6-8.5 8.5H5.5v-6zM12 6l6 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number }) {
    const size = () => `${props.size ?? 18}px`;
    return (
        <svg
            class="wb-ic"
            classList={{ 'wb-ic-dots': props.name === 'more' }}
            style={{ width: size(), height: size() }}
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            <path d={PATHS[props.name]} />
        </svg>
    );
}
