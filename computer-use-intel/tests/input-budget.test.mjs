import test from 'node:test';
import assert from 'node:assert/strict';
import { typingTimeoutMs, typeText, validateLongPressDuration } from '../dist/macos.js';

test('preserves a requested 5-second character interval in its timeout budget', () => {
  assert.equal(typingTimeoutMs('ab', 5000), 25010);
});

test('rejects oversized or excessive-delay typing before any input', async () => {
  await assert.rejects(typeText('a'.repeat(50000)), /no input was sent/);
  await assert.rejects(typeText('ab', 30000), /no input was sent/);
});

test('budgets Unicode conservatively and rejects invalid delays', () => {
  assert(typingTimeoutMs('Grüße 👩‍💻') < 16000);
  assert.throws(() => typingTimeoutMs('a', -1), /non-negative/);
  assert.throws(() => typingTimeoutMs('a', 0.5), /integer/);
});

test('accepts bounded long-press durations and rejects unsafe values', () => {
  assert.doesNotThrow(() => validateLongPressDuration(1));
  assert.doesNotThrow(() => validateLongPressDuration(60_000));
  assert.throws(() => validateLongPressDuration(0), /between 1 and 60000/);
  assert.throws(() => validateLongPressDuration(60_001), /between 1 and 60000/);
  assert.throws(() => validateLongPressDuration(1.5), /integer/);
});
