import 'solid-js';

declare module 'solid-js' {
    // oxlint-disable-next-line typescript/no-namespace -- the JSX namespace is how TypeScript reads JSX types.
    namespace JSX {
        interface ExplicitAttributes {
            'data-family': string;
            'data-group': string;
            'data-settings-level': string | undefined;
            'data-field': string;
            'data-for': string;
            'data-level': string;
            'data-randomization-disabled': string;
        }
    }
}
