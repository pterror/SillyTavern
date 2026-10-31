import { openRunRoot } from './util/temp-run-root.js';

export default function globalSetup() {
    openRunRoot('jest');
}
