// Explicit opt-in integration smoke: opens only our temporary native fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.argv.includes('--run')) throw new Error('Use --run to open and operate the isolated test fixture.');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'cui-live-smoke-'));
const app = join(temp, 'ComputerUseIntelTest.app');
const bundle = 'local.computer-use-intel.testfixture';
const helper = join(root, 'dist/ax-helper');
const original = JSON.parse(execFileSync(helper, ['app-info'], { encoding: 'utf8' }));
const report = { checkedAt: new Date().toISOString(), outcome: 'failed', checks: [] };
let fixturePid;
const client = new Client({ name: 'computer-use-intel-live-smoke', version: '1.3.2' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/server.js')], stderr: 'pipe' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert(!r.isError, `${name}: ${r.content?.filter(c => c.type === 'text').map(c => c.text).join(' ')}`);
  const outArg = process.argv.indexOf('--report');
  const image = r.content?.find(c => c.type === 'image');
  if (args.region && image && outArg !== -1) {
    writeFileSync(resolve(process.argv[outArg + 1]).replace(/\.json$/, '.png'), Buffer.from(image.data, 'base64'));
  }
  return r.structuredContent ?? JSON.parse(r.content.find(c => c.type === 'text').text);
}
function checked(name, data = {}) { report.checks.push({ name, passed: true, ...data }); console.log(name); }
try {
  const displays = JSON.parse(execFileSync(join(root, 'dist/cgevent'), ['displays'], { encoding: 'utf8' }));
  assert(displays.displays?.length && original.bundleId !== 'com.apple.loginwindow', 'Wake and unlock the Mac before running the interactive smoke.');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleName</key><string>Computer Use Intel Test</string><key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', join(app, 'Contents/MacOS/fixture'), join(root, 'tests/fixture.swift'), '-framework', 'AppKit']);
  execFileSync('/usr/bin/open', ['-n', '--stdout', join(temp, 'events.log'), app, '--args', '--trace-events']);
  for (let i = 0; i < 40; i++) {
    const identity = JSON.parse(execFileSync(helper, ['app-info', '--app', bundle], { encoding: 'utf8' }));
    if (identity.ok) { fixturePid = identity.pid; break; }
    await sleep(100);
  }
  assert(fixturePid, 'fixture launched');
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some(t => t.name === 'act_and_observe'));
  checked('MCP initialization and new tools', { tools: tools.tools.length });
  await client.callTool({ name: 'focus_app', arguments: { name: bundle } }).then(r => assert(!r.isError, JSON.stringify(r.content)));
  const windows = await call('list_windows', { app: bundle });
  const f = windows.windows[0].frame;
  const region = { x: f.x, y: f.y, width: f.w, height: f.h };
  const state = await call('get_desktop_state', { region, max_width: 400 });
  assert.equal(state.metadata.frontmostApp.bundleId, bundle);
  assert.equal(state.metadata.imagePixels.width, 400);
  const target = state.ui.elements.find(e => e.title === 'Prüfung starten' && e.role === 'AXButton');
  assert(target, 'start button visible in compact AX state');
  const transform = state.metadata.imageToScreen;
  const pixels = { x: (target.x - transform.offsetX) / transform.scaleX, y: (target.y - transform.offsetY) / transform.scaleY };
  checked('Measured fixture input target', { target: { x: target.x, y: target.y }, pixels, geometry: state.metadata });
  const clicked = await call('act_and_observe', { app: bundle, region, max_width: 400,
    action: { kind: 'click', screenshot_id: state.metadata.screenshot_id, ...pixels },
    expect: { target: { role: 'AXStaticText', title: 'Status' }, exact_value: 'Klick bestätigt' } });
  const cursor = await call('cursor_position');
  assert.equal(clicked.action.status, 'completed'); assert.equal(clicked.verification.status, 'matched', JSON.stringify({ cursor, ui: clicked.observation?.ui }));
  checked('Downscaled cropped image click and postcondition', { geometry: state.metadata, verification: clicked.verification });
  const stale = await client.callTool({ name: 'act_and_observe', arguments: { app: bundle, region,
    action: { kind: 'click', screenshot_id: state.metadata.screenshot_id, ...pixels } } });
  assert(stale.isError, 'used screenshot must be invalidated');
  checked('Used image reference rejected without another click');
  const skipped = await call('act_and_observe', { app: bundle, region, max_width: 400,
    action: { kind: 'click_element', target: { role: 'AXButton', title: 'Zurücksetzen' } },
    expect: { target: { role: 'AXStaticText', title: 'Status' }, exact_value: 'Klick bestätigt' } });
  assert.equal(skipped.action.status, 'not_run'); assert.equal(skipped.verification.status, 'already_satisfied');
  checked('Already satisfied postcondition skips input');
  await call('act_and_observe', { app: bundle, region, max_width: 400,
    action: { kind: 'click_element', target: { role: 'AXTextField', title: 'Prüftext' }, method: 'coordinate' } });
  const typed = await call('act_and_observe', { app: bundle, region, max_width: 400,
    action: { kind: 'type', text: 'Grüße aus Köln – Straße 7 👩‍💻' },
    expect: { target: { role: 'AXTextField', title: 'Prüftext' }, exact_value: 'Grüße aus Köln – Straße 7 👩‍💻' } });
  assert.equal(typed.verification.status, 'matched', JSON.stringify({ action: typed.action, verification: typed.verification }));
  checked('Unicode typing and exact field-value verification');
  const timeout = await call('act_and_observe', { app: bundle, region, max_width: 400, timeout_ms: 250,
    action: { kind: 'key', keys: 'arrow-left' },
    expect: { target: { role: 'AXButton', title: 'Nicht vorhandene Schaltfläche' } } });
  assert.equal(timeout.action.status, 'completed'); assert.equal(timeout.verification.status, 'timed_out');
  assert(timeout.observation.metadata.screenshot_id);
  checked('Unmet postcondition times out with fresh observation');
  const raw = await call('screenshot', { max_width: 1280 });
  assert.equal(raw.metadata.imagePixels.width, 1280);
  checked('Full main-display screenshot geometry', { imagePixels: raw.metadata.imagePixels, screenBoundsPoints: raw.metadata.screenBoundsPoints });
  const final = await call('get_element_value', { app: bundle, role: 'AXTextField', title: 'Prüftext' });
  assert.equal(final.value, 'Grüße aus Köln – Straße 7 👩‍💻');
  checked('Independent final Accessibility read');
  report.fixtureEventCount = readFileSync(join(temp, 'events.log'), 'utf8').trim().split('\n').filter(Boolean).length;
  report.outcome = 'passed';
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await client.close().catch(() => {});
  if (fixturePid) { try { process.kill(fixturePid, 'SIGTERM'); } catch {} }
  if (original.bundleId) { try { execFileSync(helper, ['focus-app', '--app', original.bundleId], { stdio: 'ignore' }); } catch {} }
  rmSync(temp, { recursive: true, force: true });
  const outArg = process.argv.indexOf('--report');
  if (outArg !== -1 && process.argv[outArg + 1]) writeFileSync(resolve(process.argv[outArg + 1]), JSON.stringify(report, null, 2) + '\n');
}
