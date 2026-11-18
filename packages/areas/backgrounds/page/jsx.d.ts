import '@solidjs/web';

declare module '@solidjs/web' {
    // oxlint-disable-next-line typescript/no-namespace -- the JSX namespace is how TypeScript reads JSX types.
    namespace JSX {
        interface HTMLAttributes<T> {
            bgfile?: string;
            custom?: string;
            animated?: string;
        }
    }
}
