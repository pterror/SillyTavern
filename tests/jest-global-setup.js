// Opens the run root before any test worker starts; the workers inherit TMPDIR pointing into it.
import { openRunRoot } from './util/temp-run-root.js';

export default function globalSetup() {
    openRunRoot('jest');
}
