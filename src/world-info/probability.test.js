import assert from 'node:assert/strict';
import { verifyProbability } from './probability.js';

// No probability configured -> always true
assert.equal(verifyProbability({}, false), true);
assert.equal(verifyProbability({ useProbability: true, probability: 100 }, false), true);

// Sticky entries skip the re-roll
assert.equal(verifyProbability({ useProbability: true, probability: 1 }, true, () => 0.99), true);

// Injected RNG controls the roll deterministically
assert.equal(verifyProbability({ useProbability: true, probability: 50 }, false, () => 0.1), true, '10 <= 50 passes');
assert.equal(verifyProbability({ useProbability: true, probability: 50 }, false, () => 0.9), false, '90 > 50 fails');
assert.equal(verifyProbability({ useProbability: true, probability: 50 }, false, () => 0.5), true, '50 <= 50 passes (boundary)');

console.log('probability.test.js: all assertions passed');
