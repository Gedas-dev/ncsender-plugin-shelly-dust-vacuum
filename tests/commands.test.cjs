/* Runs commands.js the way ncSender does (one script, a pluginContext global,
   the export line stripped) against a fake host. Usage: node tests/commands.test.cjs */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'commands.js'), 'utf8')
  .replace(/^export\s*\{[^}]*\}\s*;?\s*$/m, '');

function boot(saved, opts) {
  opts = opts || {};
  const h = {
    now: 1000000,
    requests: [],          // { url, done }
    notices: [],
    sent: [],              // lines the plugin sent to the controller
    logs: [],
    stored: saved === undefined ? null : saved,
    state: { machineStatus: 'Idle', jobStatus: null, connected: true },
    interval: null
  };
  const FakeDate = { now: () => h.now };
  const pluginContext = {
    log: (m) => { h.logs.push(String(m)); throw new Error('pluginContext.log must never be called: it crashes the packaged app'); },
    showNotice: (title, message, details) => h.notices.push({ title, message, details }),
    sendCommand: (command, display) => { h.sent.push(command); },
    getServerState: () => Object.assign({}, h.state),
    setInterval: (fn, ms) => { h.interval = { fn, ms }; return 1; },
    storage: { get: () => h.stored, set: (v) => { h.stored = JSON.parse(JSON.stringify(v)); return true; } }
  };
  if (!opts.noHttp) pluginContext.http = {
    request: (call, done) => { h.requests.push({ url: call.url, timeoutMs: call.timeoutMs, done }); return true; }
  };
  const sandbox = { pluginContext, Date: FakeDate, JSON, Math, parseInt, isFinite, String, Object, Array, RegExp };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'commands.js' });
  h.sb = sandbox;
  h.call = (name, ...args) => sandbox[name](...args);
  // Like the host: JSON in, JSON out. Unless a test says otherwise it talks about
  // the dust extractor, and gets that device's part of the answer (the whole one is in .all).
  h.ask = (req, key) => {
    req = Object.assign({}, req || {});
    key = key || req.device || 'dust';
    if (req.action && req.action !== 'save' && !req.device) req.device = key;
    if (req.action === 'save' && req.settings && !req.settings.dust && !req.settings.pump) req.settings = { [key]: req.settings };
    const full = JSON.parse(vm.runInContext('JSON.stringify(onRequest(' + JSON.stringify(req) + '))', sandbox));
    if (!full.devices) return full;
    return Object.assign({}, full.devices[key], { version: full.version, saveError: full.saveError, all: full });
  };
  h.send = (text, ctx) => {
    const cmds = [{ command: text, isOriginal: true, displayCommand: null, meta: null }];
    const out = sandbox.onBeforeCommand(cmds, Object.assign({ jobRunning: false, laserMode: false, lineNumber: 0, sourceId: 'client' }, ctx || {}), {});
    assert.strictEqual(out, cmds, 'onBeforeCommand must hand back the same commands');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].command, text);
  };
  h.advance = (ms) => { for (let t = 0; t < ms; t += 500) { h.now += 500; h.interval.fn(); } };
  // Answer every waiting request the way a healthy Shelly would. Each Shelly (host) remembers its own relay.
  h.outputs = {};
  const hostOf = (url) => url.replace(/^http:\/\//, '').replace(/\/.*$/, '');
  const waitingFor = (host) => h.requests.filter((r) => !r.answered && (!host || hostOf(r.url) === host));
  h.answer = (output, host) => {
    const waiting = waitingFor(host);
    waiting.forEach((r) => {
      r.answered = true;
      const at = hostOf(r.url);
      if (r.url.indexOf('Switch.Set') >= 0) { h.outputs[at] = /on=true/.test(r.url); r.done({ ok: true, status: 200, body: '{"was_on":false}', error: null }); }
      else if (r.url.indexOf('Switch.GetStatus') >= 0) r.done({ ok: true, status: 200, body: JSON.stringify({ id: 0, output: output === undefined ? !!h.outputs[at] : output }), error: null });
      else if (r.url.indexOf('GetDeviceInfo') >= 0) r.done({ ok: true, status: 200, body: '{"name":null,"id":"shelly1g3-aabbcc","model":"S3SW-001X16EU","gen":3,"app":"S1G3","auth_en":false}', error: null });
    });
    return waiting.length;
  };
  h.fail = (res, host) => {
    const waiting = waitingFor(host);
    waiting.forEach((r) => { r.answered = true; r.done(res || { ok: false, status: 0, body: '', error: 'Connection refused' }); });
    return waiting.length;
  };
  h.sets = (host) => h.requests.filter((r) => r.url.indexOf('Switch.Set') >= 0 && (!host || r.url.indexOf('//' + host + '/') >= 0)).map((r) => r.url.replace(/^.*\?/, ''));
  return h;
}

const CFG = { host: '192.168.1.50', channel: 0, enabled: true, trigger: 'spindle', offDelaySec: 5, notify: true, panelPin: -1 };
const PIN = Object.assign({}, CFG, { panelPin: 1, offDelaySec: 0 });
// Both devices, as 0.3 saves them: dust extractor on P0, vacuum pump (by hand only) on P1.
const DUST = '192.168.1.50', PUMP = '192.168.1.51';
const BOTH = { version: 2, devices: {
  dust: Object.assign({}, CFG, { panelPin: 0, offDelaySec: 0 }),
  pump: Object.assign({}, CFG, { host: PUMP, enabled: false, panelPin: 1 })
} };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('loads like the host loads it', () => {
  assert.ok(!/^export\s/m.test(SOURCE), 'the export line must be the kind the host strips');
  const h = boot(CFG);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.call('buildInitialConfig', { a: 1 }))), { a: 1 });
  assert.strictEqual(typeof h.call('buildInitialConfig', null), 'object');
  assert.strictEqual(h.interval.ms, 500);
});

test('reads M-codes out of G-code', () => {
  const h = boot(CFG);
  const m = (line) => Array.from(h.call('mCodes', line));
  assert.deepStrictEqual(m('M3 S18000'), [3]);
  assert.deepStrictEqual(m('N120 M03S12000'), [3]);
  assert.deepStrictEqual(m('n5 m5'), [5]);
  assert.deepStrictEqual(m('G0 X0 Y0 M5'), [5]);
  assert.deepStrictEqual(m('M30'), [30]);
  assert.deepStrictEqual(m('G1 X10 Y20 F800'), []);
  assert.deepStrictEqual(m('(M3 in a comment) G1 X1'), []);
  assert.deepStrictEqual(m('G1 X1 ; M5 later'), []);
  assert.deepStrictEqual(m('#<_tm3> = 4'), []);
  assert.deepStrictEqual(m('o<m5sub> call'), []);
  assert.deepStrictEqual(m('$M3'), []);
  assert.deepStrictEqual(m('M62.1'), []);
  assert.deepStrictEqual(m('M5 M9'), [5, 9]);
});

test('cleans the address', () => {
  const h = boot(CFG);
  const c = (v) => h.call('cleanHost', v);
  assert.strictEqual(c(' http://192.168.1.50/ '), '192.168.1.50');
  assert.strictEqual(c('shelly1g3-aabbcc.local'), 'shelly1g3-aabbcc.local');
  assert.strictEqual(c('192.168.1.50:8080'), '192.168.1.50:8080');
  assert.strictEqual(c('192.168.1.50/rpc/Switch.Set?id=0'), '192.168.1.50');
  assert.strictEqual(c('user:pw@evil'), '');
  assert.strictEqual(c('a b'), '');
  assert.strictEqual(c(''), '');
  assert.strictEqual(c(null), '');
});

test('M3 switches on at once', () => {
  const h = boot(CFG);
  h.send('M3 S18000');
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  assert.strictEqual(h.requests[0].url, 'http://192.168.1.50/rpc/Switch.Set?id=0&on=true');
  h.answer();
  const st = h.ask();
  assert.strictEqual(st.relay.output, true);
  assert.strictEqual(st.relay.switching, null);
  assert.strictEqual(st.recent[0].why, 'Spindle started (M3)');
});

test('M5 waits for the machine to rest, then for the delay', () => {
  const h = boot(CFG);
  h.state.machineStatus = 'Run'; h.state.jobStatus = 'running';
  h.advance(1000);
  h.send('N10 M3 S18000', { jobRunning: true, sourceId: 'job', lineNumber: 10 }); h.answer();
  h.send('N900 M5', { jobRunning: true, sourceId: 'job', lineNumber: 900 });
  h.advance(30000);                       // still cutting the buffered moves
  h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  assert.strictEqual(h.ask().stopping, true);
  h.state.machineStatus = 'Idle'; h.state.jobStatus = 'completed';
  h.advance(1000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true'], 'not yet at rest long enough');
  h.advance(1000);                        // at rest for 2 s: the 5 s delay starts
  const st = h.ask();
  assert.strictEqual(st.stopping, false);
  assert.ok(st.offInSec > 0 && st.offInSec <= 5, 'counting down: ' + st.offInSec);
  h.advance(4000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.advance(1500);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
  h.answer();
  assert.strictEqual(h.ask().relay.output, false);
  assert.strictEqual(h.ask().recent[0].why, 'Spindle stopped (M5)');
});

test('M3 after M5 keeps it running', () => {
  const h = boot(CFG);
  h.state.machineStatus = 'Run';
  h.advance(1000);
  h.send('M3 S1000'); h.answer();
  h.send('M5');
  h.advance(1000);
  h.send('M3 S1000'); h.answer();
  h.state.machineStatus = 'Idle';
  h.advance(20000); h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=true']);
});

test('a short pause between moves is not "at rest"', () => {
  const h = boot(CFG);
  h.state.machineStatus = 'Run';
  h.advance(1000);
  h.send('M3'); h.answer(); h.send('M5');
  for (let i = 0; i < 10; i++) { h.state.machineStatus = 'Idle'; h.advance(1000); h.state.machineStatus = 'Run'; h.advance(1000); }
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
});

test('M5 with nothing running sends nothing', () => {
  const h = boot(CFG);
  h.advance(500); h.answer(false);        // the status reading says it is off
  h.send('M5'); h.advance(20000); h.answer(false);
  assert.deepStrictEqual(h.sets(), []);
});

test('a stopped job, an alarm, a reset and a disconnect switch off', () => {
  ['stopped', 'alarm', 'reset', 'disconnect'].forEach((what) => {
    const h = boot(Object.assign({}, CFG, { offDelaySec: 0 }));
    h.state.machineStatus = 'Run'; h.state.jobStatus = 'running';
    h.advance(1000);
    h.send('M3'); h.answer();
    if (what === 'stopped') { h.state.jobStatus = 'stopped'; h.state.machineStatus = 'Idle'; }
    if (what === 'alarm') h.state.machineStatus = 'Alarm';
    if (what === 'reset') { h.send('\u0018'); h.state.machineStatus = 'Idle'; }
    if (what === 'disconnect') h.state.connected = false;
    h.advance(3000);
    assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false'], what);
  });
});

test('a finished job with no M5 leaves it on (so is the spindle)', () => {
  const h = boot(CFG);
  h.state.machineStatus = 'Run'; h.state.jobStatus = 'running';
  h.advance(1000); h.send('M3'); h.answer();
  h.state.jobStatus = 'completed'; h.state.machineStatus = 'Idle';
  h.advance(20000); h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
});

test('laser mode and check mode do not start it', () => {
  let h = boot(CFG);
  h.send('M3 S500', { laserMode: true });
  assert.deepStrictEqual(h.sets(), []);
  h = boot(CFG);
  h.state.machineStatus = 'Check';
  h.send('M3 S500');
  assert.deepStrictEqual(h.sets(), []);
});

test('off, or with no address, it stays out of the way', () => {
  let h = boot(Object.assign({}, CFG, { enabled: false }));
  h.send('M3'); h.advance(3000);
  assert.deepStrictEqual(h.sets(), []);
  h = boot(Object.assign({}, CFG, { host: '' }));
  h.send('M3'); h.advance(30000);
  assert.strictEqual(h.requests.length, 0);
  h = boot(null);
  h.send('M3'); h.advance(30000);
  assert.strictEqual(h.requests.length, 0);
});

test('coolant triggers', () => {
  let h = boot(Object.assign({}, CFG, { trigger: 'flood', offDelaySec: 0 }));
  h.advance(500);
  h.send('M3'); h.send('M7');
  assert.deepStrictEqual(h.sets(), []);
  h.send('M8'); h.answer(); h.send('M5'); h.advance(3000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.send('M9'); h.advance(3000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
  h = boot(Object.assign({}, CFG, { trigger: 'mist' }));
  h.send('M8'); assert.deepStrictEqual(h.sets(), []);
  h.send('M7'); assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
});

test('job trigger: on at the start, off after the end', () => {
  const h = boot(Object.assign({}, CFG, { trigger: 'job', offDelaySec: 2 }));
  h.advance(1000);
  h.send('M3'); assert.deepStrictEqual(h.sets(), []);
  h.state.jobStatus = 'running'; h.state.machineStatus = 'Run';
  h.advance(500); h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.state.jobStatus = 'paused'; h.state.machineStatus = 'Hold'; h.advance(10000);
  h.state.jobStatus = 'running'; h.state.machineStatus = 'Run'; h.advance(10000);
  h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.state.jobStatus = 'completed';        // still moving: the planner is emptying
  h.advance(5000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.state.machineStatus = 'Idle';
  h.advance(5000);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
});

test('a Shelly that does not answer: retries, one notice, then gives up', () => {
  const h = boot(CFG);
  h.send('M3');
  let tries = 0;
  for (let i = 0; i < 400 && tries < 40; i++) { tries += h.requests.filter((r) => !r.answered && /Switch.Set/.test(r.url)).length; h.fail(); h.advance(500); }
  assert.strictEqual(h.sets().length, 15);
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(h.notices[0].title, "The dust extractor didn't switch on");
  assert.ok(/Can't reach the Shelly at 192\.168\.1\.50 \(Connection refused\)/.test(h.notices[0].details.Problem));
  const st = h.ask();
  assert.strictEqual(st.relay.switching, null);
  assert.strictEqual(st.relay.reachable, false);
});

test('it comes back: the retry gets through', () => {
  const h = boot(CFG);
  h.send('M3'); h.fail(); h.advance(2500);
  assert.strictEqual(h.sets().length, 1);
  h.advance(1000);
  assert.strictEqual(h.sets().length, 2);
  h.answer();
  assert.strictEqual(h.ask().relay.output, true);
  assert.strictEqual(h.ask().relay.error, null);
});

test('no notice when told not to, or for an unplugged Shelly at switch-off', () => {
  let h = boot(Object.assign({}, CFG, { notify: false }));
  h.send('M3'); h.fail();
  assert.strictEqual(h.notices.length, 0);
  h = boot(Object.assign({}, CFG, { offDelaySec: 0 }));
  h.advance(500); h.fail();               // never reached
  h.send('M5'); h.advance(3000); h.fail();
  assert.deepStrictEqual(h.sets(), ['id=0&on=false']);
  assert.strictEqual(h.notices.length, 0);
});

test('explains a password, a wrong channel and a non-Shelly', () => {
  const h = boot(CFG);
  h.send('M3'); h.fail({ ok: false, status: 401, body: '', error: null });
  assert.ok(/asks for a password/.test(h.ask().relay.error));
  h.advance(3500); h.fail({ ok: false, status: 500, body: '{"code":-105,"message":"Argument \'id\', value 3 not found!"}', error: null });
  assert.ok(/refused: Argument 'id'/.test(h.ask().relay.error));
  h.advance(3500); h.fail({ ok: true, status: 200, body: '<html>router</html>', error: null });
  assert.ok(/not like a Shelly/.test(h.ask().relay.error));
  assert.strictEqual(h.ask().relay.reachable, true);
});

test('on then off while the first is in flight: off is sent after it', () => {
  const h = boot(Object.assign({}, CFG, { offDelaySec: 0 }));
  h.advance(500); h.answer(false);
  h.ask({ action: 'on' });
  h.ask({ action: 'off' });
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
  h.answer();
  assert.strictEqual(h.ask().relay.output, false);
});

test('a status reading taken before a switch does not undo it', () => {
  const h = boot(CFG);
  h.advance(500);                          // a status reading goes out (relay off)
  const reading = h.requests[0];
  assert.ok(/GetStatus/.test(reading.url));
  h.send('M3');
  h.requests[1].answered = true; h.requests[1].done({ ok: true, status: 200, body: '{"was_on":false}', error: null });
  reading.answered = true; reading.done({ ok: true, status: 200, body: '{"id":0,"output":false}', error: null });
  assert.strictEqual(h.ask().relay.output, true);
});

test('the window: status, switch by hand, a switch made elsewhere', () => {
  const h = boot(CFG);
  let st = h.ask();
  assert.strictEqual(st.version, 2);
  assert.deepStrictEqual(st.all.order, ['dust', 'pump']);
  assert.deepStrictEqual(st.settings, CFG);
  assert.strictEqual(st.relay.output, null);
  h.answer(true);                          // someone switched it on at the wall
  assert.strictEqual(h.ask().relay.output, true);
  h.ask({ action: 'off' }); h.answer();
  st = h.ask();
  assert.strictEqual(st.relay.output, false);
  assert.strictEqual(st.recent[0].why, 'Switched off by hand');
  h.ask({ action: 'on' }); h.answer();
  assert.strictEqual(h.ask().relay.output, true);
  assert.deepStrictEqual(h.sets(), ['id=0&on=false', 'id=0&on=true']);
});

test('the window: save, and a bad address is refused', () => {
  const h = boot(null);
  let st = h.ask();
  assert.strictEqual(st.settings.host, '');
  assert.strictEqual(st.settings.enabled, true);
  assert.strictEqual(st.settings.trigger, 'spindle');
  st = h.ask({ action: 'save', settings: { host: 'not an address', channel: 0 } });
  assert.ok(st.saveError);
  assert.strictEqual(h.stored, null);
  st = h.ask({ action: 'save', settings: { host: 'http://10.0.0.7/', channel: '1', enabled: true, trigger: 'nonsense', offDelaySec: '9999', notify: false } });
  assert.strictEqual(st.saveError, null);
  assert.strictEqual(h.stored.version, 2);
  assert.deepStrictEqual(h.stored.devices.dust, { host: '10.0.0.7', channel: 1, enabled: true, trigger: 'spindle', offDelaySec: 600, notify: false, panelPin: -1 });
  assert.deepStrictEqual(h.stored.devices.pump, { host: '', channel: 0, enabled: false, trigger: 'spindle', offDelaySec: 5, notify: true, panelPin: -1 });
  h.send('M4');
  assert.deepStrictEqual(h.sets(), ['id=1&on=true']);
  assert.ok(/^http:\/\/10\.0\.0\.7\/rpc\//.test(h.requests[h.requests.length - 1].url));
});

test('the window: test an address before saving it', () => {
  const h = boot(null);
  let st = h.ask({ action: 'test', host: '192.168.1.77' });
  assert.strictEqual(st.test.state, 'working');
  assert.strictEqual(h.requests[0].url, 'http://192.168.1.77/rpc/Shelly.GetDeviceInfo');
  h.answer();
  st = h.ask();
  assert.strictEqual(st.test.state, 'ok');
  assert.deepStrictEqual(st.test.device, { name: 'shelly1g3-aabbcc', model: 'S1G3', gen: 3, auth: false });
  st = h.ask({ action: 'test', host: '192.168.1.78' }); h.fail();
  st = h.ask();
  assert.strictEqual(st.test.state, 'error');
  assert.ok(/Can't reach/.test(st.test.error));
  assert.strictEqual(h.ask({ action: 'test', host: '??' }).test.state, 'error');
});

test('an older ncSender (no network for plugins) says so and never throws', () => {
  const h = boot(CFG, { noHttp: true });
  assert.deepStrictEqual(h.ask(), { unsupported: true });
  h.send('M3'); h.advance(5000);
});

test('nothing is ever written with pluginContext.log; the journal keeps it instead', () => {
  const h = boot(CFG);
  h.send('M3'); h.fail(); h.advance(4000); h.answer(); h.send('M5'); h.advance(10000); h.answer();
  assert.deepStrictEqual(h.logs, []);
  const journal = h.ask().all.journal;
  assert.ok(journal.length >= 3, 'journal: ' + journal.length);
  assert.ok(journal.some((e) => /Could not switch the dust extractor on/.test(e.text)));
  assert.ok(!/pluginContext\.log\(/.test(SOURCE.replace(/\/\/.*$/gm, '')));
});

test('onBeforeCommand survives anything it is handed', () => {
  const h = boot(CFG);
  const f = h.sb.onBeforeCommand;
  [undefined, null, [], [null], [{}], [{ command: 5 }], 'M3', [{ command: 'M3\nG1 X1\nM5' }]].forEach((c) => {
    assert.strictEqual(f(c, undefined, undefined), c);
    assert.strictEqual(f(c, null, null), c);
  });
  h.sb.pluginContext.getServerState = () => { throw new Error('boom'); };
  h.send('M3'); h.advance(2000);
});

test('polls gently when the window is closed, faster while it is open', () => {
  const h = boot(CFG);
  h.advance(60000 - 500);
  const closed = h.requests.length;
  assert.ok(closed === 0 || closed === 1, 'one reading waits unanswered: ' + closed);
  const g = boot(CFG);
  let n = 0;
  for (let i = 0; i < 60; i++) { g.advance(500); n += g.answer(false); }
  assert.ok(n >= 3 && n <= 4, 'about one reading per 10 s: ' + n);
  n = 0;
  for (let i = 0; i < 20; i++) { g.ask(); g.advance(500); n += g.answer(false); g.advance(500); n += g.answer(false); }
  assert.ok(n >= 9 && n <= 11, 'about one reading per 2 s: ' + n);
});

/* ---------- the main-screen switch (a spare controller output) ---------- */

test('reads M64 / M65 out of G-code', () => {
  const h = boot(CFG);
  const p = (line) => { const r = h.call('pinCommand', line); return r ? [r.on, r.pin] : null; };
  assert.deepStrictEqual(p('M64 P1'), [true, 1]);
  assert.deepStrictEqual(p('m65p12'), [false, 12]);
  assert.deepStrictEqual(p('N40 M064 P 3'), [true, 3]);
  assert.strictEqual(p('M64'), null);
  assert.strictEqual(p('M62 P1'), null);
  assert.strictEqual(p('M640 P1'), null);
  assert.strictEqual(p('(M64 P1)'), null);
  assert.strictEqual(p('M64 P1.5'), null);
  assert.strictEqual(p('G1 X64 Y65'), null);
});

test('without a switch output the plugin never sends the controller anything', () => {
  const h = boot(CFG);
  h.state.machineStatus = 'Run'; h.advance(1000);
  h.send('M3'); h.answer(); h.send('M64 P1'); h.send('M5');
  h.state.machineStatus = 'Idle'; h.advance(20000); h.answer();
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
});

test('the switch: flipping it switches the Shelly at once, and nothing is echoed back', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);
  h.send('M64 P1');
  assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h.answer(); h.advance(5000); h.answer();
  assert.strictEqual(h.ask().recent[0].why, 'Main-screen switch (M64 P1)');
  h.state.machineStatus = 'Run';           // off by hand does not wait for the machine
  h.send('M65 P1');
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
  h.answer(); h.advance(5000); h.answer();
  assert.deepStrictEqual(h.sent, []);
});

test('the switch: other outputs are not ours', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);
  h.send('M64 P3'); h.send('M65 P3'); h.send('M64 P11'); h.advance(3000);
  assert.deepStrictEqual(h.sets(), []);
  assert.deepStrictEqual(h.sent, []);
});

test('the switch follows the spindle: M64 at the start, M65 when the extractor stops', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);
  h.state.machineStatus = 'Run'; h.state.jobStatus = 'running';
  h.send('N10 M3 S18000', { jobRunning: true, sourceId: 'job', lineNumber: 10 });
  h.advance(500); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1']);
  h.advance(60000); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1'], 'said once');
  h.send('N900 M5', { jobRunning: true, sourceId: 'job', lineNumber: 900 });
  h.advance(5000);
  assert.deepStrictEqual(h.sent, ['M64 P1'], 'still cutting');
  h.state.machineStatus = 'Idle'; h.state.jobStatus = 'completed';
  h.advance(3000); h.answer();
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false']);
  assert.deepStrictEqual(h.sent, ['M64 P1', 'M65 P1']);
});

test('the switch waits for a controller that takes commands (alarm, pause)', () => {
  ['Alarm', 'Hold', 'Tool', 'Door'].forEach((stopped) => {
    const h = boot(PIN);
    h.advance(500); h.answer(false);
    h.state.machineStatus = 'Run';
    h.send('M3'); h.advance(500); h.answer();
    assert.deepStrictEqual(h.sent, ['M64 P1'], stopped);
    h.send('M5');
    h.state.machineStatus = stopped;
    h.advance(10000); h.answer();
    assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false'], stopped + ': the extractor is off');
    assert.deepStrictEqual(h.sent, ['M64 P1'], stopped + ': the switch is not told yet');
    h.state.machineStatus = 'Idle';
    h.advance(1500);
    assert.deepStrictEqual(h.sent, ['M64 P1', 'M65 P1'], stopped);
  });
  const d = boot(PIN);
  d.advance(500); d.answer(false);
  d.state.connected = false;
  d.ask({ action: 'on' }); d.answer(); d.advance(5000);
  assert.deepStrictEqual(d.sent, []);
});

test('the switch shows a switch made in the window or at the wall', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);         // off at start: nothing to say
  h.advance(3000);
  assert.deepStrictEqual(h.sent, []);
  h.ask({ action: 'on' }); h.answer(); h.advance(1500);
  assert.deepStrictEqual(h.sent, ['M64 P1']);
  h.ask({ action: 'off' }); h.answer(); h.advance(1500);
  assert.deepStrictEqual(h.sent, ['M64 P1', 'M65 P1']);
  for (let i = 0; i < 30; i++) { h.advance(500); h.answer(true); }   // someone switches it on at the wall
  assert.deepStrictEqual(h.sent, ['M64 P1', 'M65 P1', 'M64 P1']);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true', 'id=0&on=false'], 'and the Shelly is left alone');
});

test('the switch goes back to off when the Shelly never switched on', () => {
  const h = boot(PIN);
  h.send('M64 P1');
  for (let i = 0; i < 400; i++) { h.fail(); h.advance(500); }
  assert.strictEqual(h.sets().length, 15);
  assert.deepStrictEqual(h.sent, ['M65 P1']);
});

test('the switch works with automatic switching turned off, and not in check mode', () => {
  let h = boot(Object.assign({}, PIN, { enabled: false }));
  h.advance(500); h.answer(false);
  h.send('M3'); assert.deepStrictEqual(h.sets(), []);
  h.send('M64 P1'); assert.deepStrictEqual(h.sets(), ['id=0&on=true']);
  h = boot(PIN);
  h.state.machineStatus = 'Check';
  h.send('M64 P1'); h.advance(2000);
  assert.deepStrictEqual(h.sets(), []);
});

test('the switch: a new output starts clean, and is told if the extractor runs', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);
  h.send('M3'); h.advance(500); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1']);
  h.ask({ action: 'save', settings: Object.assign({}, PIN, { panelPin: 2 }) });
  h.advance(2000); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1', 'M64 P2']);
  assert.deepStrictEqual(h.sets(), ['id=0&on=true'], 'saving does not switch the Shelly');
});

test('the switch: at most one line a second, even when flipped back and forth', () => {
  const h = boot(PIN);
  h.advance(500); h.answer(false);
  for (let i = 0; i < 6; i++) { h.ask({ action: i % 2 ? 'off' : 'on' }); h.answer(); h.advance(500); h.answer(); }
  assert.ok(h.sent.length <= 3, 'sent ' + h.sent.length);
  h.advance(3000); h.answer();
  assert.strictEqual(h.sent[h.sent.length - 1], 'M65 P1');
});

/* ---------- two devices: dust extractor and vacuum pump ---------- */

test('settings saved by 0.1 / 0.2 become the dust extractor; the pump starts empty and by hand only', () => {
  const h = boot(Object.assign({}, CFG, { panelPin: 2 }));
  const all = h.ask().all;
  assert.deepStrictEqual(all.devices.dust.settings, Object.assign({}, CFG, { panelPin: 2 }));
  assert.deepStrictEqual(all.devices.pump.settings, { host: '', channel: 0, enabled: false, trigger: 'spindle', offDelaySec: 5, notify: true, panelPin: -1 });
  assert.strictEqual(all.devices.pump.title, 'Vacuum pump');
});

test('the spindle switches the dust extractor and leaves the vacuum pump alone', () => {
  const h = boot(BOTH);
  h.advance(500); h.answer(false);
  h.state.machineStatus = 'Run'; h.state.jobStatus = 'running';
  h.send('M3 S18000'); h.advance(500); h.answer();
  assert.deepStrictEqual(h.sets(DUST), ['id=0&on=true']);
  assert.deepStrictEqual(h.sets(PUMP), []);
  assert.deepStrictEqual(h.sent, ['M64 P0']);
});

test('the vacuum pump stays on through M5, a stopped job, an alarm, a reset and a disconnect', () => {
  const h = boot(BOTH);
  h.advance(500); h.answer(false);
  h.send('M64 P1'); h.answer();                 // pump on at its main-screen switch
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true']);
  assert.strictEqual(h.ask({}, 'pump').recent[0].why, 'Main-screen switch (M64 P1)');
  h.state.machineStatus = 'Run'; h.state.jobStatus = 'running'; h.advance(1000);
  h.send('M3'); h.advance(500); h.answer();
  h.send('M5'); h.state.machineStatus = 'Idle'; h.advance(5000); h.answer();
  h.send('M3'); h.advance(500); h.answer();
  h.state.jobStatus = 'stopped'; h.advance(3000); h.answer();
  h.state.machineStatus = 'Alarm'; h.advance(3000); h.answer();
  h.state.machineStatus = 'Idle'; h.advance(2000); h.answer();
  h.state.connected = false; h.advance(3000); h.answer();
  h.state.connected = true; h.advance(3000); h.answer();
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true'], 'never switched off');
  assert.strictEqual(h.ask({}, 'pump').relay.output, true);
  assert.strictEqual(h.ask({}, 'dust').relay.output, false);
  h.send('M65 P1');
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true', 'id=0&on=false']);
});

test('after a reset or a reconnect the pump switch is told again that the pump runs', () => {
  const h = boot(BOTH);
  h.advance(500); h.answer(false);
  h.ask({ action: 'on' }, 'pump'); h.answer(); h.advance(1500);
  assert.deepStrictEqual(h.sent, ['M64 P1']);
  h.send('\u0018'); h.state.machineStatus = 'Alarm'; h.advance(3000); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1'], 'not into an alarm');
  h.state.machineStatus = 'Idle'; h.advance(1500); h.answer();
  assert.deepStrictEqual(h.sent, ['M64 P1', 'M64 P1']);
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true']);
});

test('each switch moves only its own device, and shows only its own device', () => {
  const h = boot(BOTH);
  h.advance(500); h.answer(false);
  h.send('M64 P0'); h.answer();
  assert.deepStrictEqual([h.sets(DUST), h.sets(PUMP)], [['id=0&on=true'], []]);
  h.send('M64 P1'); h.answer();
  h.send('M65 P0'); h.answer();
  assert.deepStrictEqual([h.sets(DUST), h.sets(PUMP)], [['id=0&on=true', 'id=0&on=false'], ['id=0&on=true']]);
  h.advance(3000); h.answer();
  assert.deepStrictEqual(h.sent, [], 'the switches moved themselves');
  h.ask({ action: 'off' }, 'pump'); h.answer(); h.advance(1500);
  h.ask({ action: 'on' }, 'dust'); h.answer(); h.advance(1500);
  assert.deepStrictEqual(h.sent, ['M65 P1', 'M64 P0']);
});

test('a Shelly that fails is named: dust extractor or vacuum pump', () => {
  const h = boot(BOTH);
  h.advance(500); h.answer(false);
  h.ask({ action: 'on' }, 'pump'); h.fail(null, PUMP); h.answer();
  assert.strictEqual(h.notices[0].title, "The vacuum pump didn't switch on");
  assert.strictEqual(h.notices[0].details.Shelly, PUMP);
  assert.ok(/192\.168\.1\.51/.test(h.ask({}, 'pump').relay.error));
  assert.strictEqual(h.ask({}, 'dust').relay.error, null);
});

test('the pump can be switched automatically too, if asked: here with every job', () => {
  const both = JSON.parse(JSON.stringify(BOTH));
  both.devices.pump.enabled = true; both.devices.pump.trigger = 'job'; both.devices.pump.offDelaySec = 0;
  const h = boot(both);
  h.advance(500); h.answer(false);
  h.state.jobStatus = 'running'; h.state.machineStatus = 'Run'; h.advance(500); h.answer();
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true']);
  h.send('M3'); h.advance(500); h.answer(); h.send('M5'); h.advance(5000);
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true'], 'M5 is the dust extractor\'s business');
  h.state.jobStatus = 'completed'; h.state.machineStatus = 'Idle'; h.advance(3000); h.answer();
  assert.deepStrictEqual(h.sets(PUMP), ['id=0&on=true', 'id=0&on=false']);
});

test('saving refuses two devices on one switch or one relay', () => {
  const h = boot(BOTH);
  const D = BOTH.devices;
  let st = h.ask({ action: 'save', settings: { dust: D.dust, pump: Object.assign({}, D.pump, { panelPin: 0 }) } });
  assert.ok(/same output \(P0\)/.test(st.saveError), st.saveError);
  st = h.ask({ action: 'save', settings: { dust: D.dust, pump: Object.assign({}, D.pump, { host: DUST }) } });
  assert.ok(/same Shelly relay/.test(st.saveError), st.saveError);
  st = h.ask({ action: 'save', settings: { dust: D.dust, pump: Object.assign({}, D.pump, { host: 'nope nope' }) } });
  assert.ok(/^Vacuum pump: /.test(st.saveError), st.saveError);
  assert.deepStrictEqual(h.stored, BOTH, 'nothing was saved');
  // One two-channel Shelly for both is fine.
  st = h.ask({ action: 'save', settings: { dust: D.dust, pump: Object.assign({}, D.pump, { host: DUST, channel: 1 }) } });
  assert.strictEqual(st.saveError, null);
  h.ask({ action: 'on' }, 'pump');
  assert.strictEqual(h.requests[h.requests.length - 1].url, 'http://192.168.1.50/rpc/Switch.Set?id=1&on=true');
  // Saving one device keeps the other.
  st = h.ask({ action: 'save', settings: { dust: Object.assign({}, D.dust, { offDelaySec: 9 }) } });
  assert.strictEqual(st.saveError, null);
  assert.strictEqual(h.stored.devices.pump.channel, 1);
  assert.strictEqual(h.stored.devices.dust.offDelaySec, 9);
});

test('testing an address is per device', () => {
  const h = boot(BOTH);
  h.ask({ action: 'test', host: '192.168.1.99' }, 'pump');
  assert.strictEqual(h.ask({}, 'pump').test.state, 'working');
  assert.strictEqual(h.ask({}, 'dust').test.state, 'idle');
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log('ok   ' + t.name); }
  catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
});
console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
