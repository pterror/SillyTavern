import 'solid-js';

declare module 'solid-js' {
    // oxlint-disable-next-line typescript/no-namespace -- the JSX namespace is how TypeScript reads JSX types.
    namespace JSX {
        interface ExplicitAttributes {
            'data-topic': string;
        }
        interface IntrinsicElements {
            tt: HTMLAttributes<HTMLElement>;
        }
    }
}
