import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const binary = new URL('../dist/activity-overlay', import.meta.url);
test('native overlay holds during calls, hides for captures, resets expiry and exits on EOF', {
  skip: process.platform !== 'darwin' || !existsSync(binary), timeout: 40000,
}, async () => {
  const proc = spawn(binary.pathname);
  const lines = createInterface({ input: proc.stdout });
  const waiting = new Map();
  let sequence = 0;
  lines.on('line', line => {
    const [id, ...fields] = line.split(' ');
    waiting.get(id)?.(fields.map(Number));
  });
  const command = action => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => reject(new Error(`No reply for ${action}`)), 8000);
    waiting.set(id, fields => { clearTimeout(timer); waiting.delete(id); resolve(fields); });
    proc.stdin.write(`${id} ${action}\n`);
  });
  try {
    const [visible, active, hidden, displays] = await command('begin');
    assert.equal(visible, 1); assert.equal(active, 1); assert.equal(hidden, 0); assert.ok(displays > 0);
    await delay(10100);
    assert.equal((await command('status'))[0], 1, 'long call remains visible');
    assert.equal((await command('hide'))[0], 0);
    assert.equal((await command('hide'))[0], 0);
    assert.equal((await command('show'))[0], 0, 'nested capture remains hidden');
    assert.equal((await command('show'))[0], 1);
    await command('end');
    await delay(1000);
    await command('begin'); await command('end');
    await delay(9200);
    assert.equal((await command('status'))[0], 1, 'second call resets ten-second expiry');
    await delay(1000);
    assert.equal((await command('status'))[0], 0, 'indicator disappears after expiry');
    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.stdin.end(); await exited;
  } finally { proc.kill(); lines.close(); }
});
