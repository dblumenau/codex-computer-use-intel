import test from 'node:test';
import assert from 'node:assert/strict';
import { typingTimeoutMs, typeText } from '../dist/macos.js';

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
