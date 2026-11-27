/**
 * Shelly Dust & Vacuum: switches two Shelly relays (Gen2 or newer, e.g.
 * Shelly 1 Gen3, Shelly 1 Mini Gen3), one for the dust extractor and one for
 * the vacuum pump. Each has its own Shelly, its own settings and, if wanted,
 * its own switch on ncSender's main screen.
 *
 * Runs in ncSender's plugin engine, so:
 *  - no fetch: a Shelly is reached through pluginContext.http, which needs
 *    the "network" permission in manifest.json;
 *  - every network call is a callback, never a wait: plugin code runs under
 *    a lock the machine's commands also take;
 *  - the plugin window (config.html) talks to this file through onRequest().
 *
 * Switching a device automatically (on for the dust extractor, off for the
 * vacuum pump unless turned on in its settings):
 *  - ON as soon as the start code (M3/M4, or M8 / M7) is on its way to the
 *    controller, or when a job starts ("job" trigger).
 *  - OFF once the stop code (M5/M9, M2/M30) has been sent AND the machine has
 *    come to rest. The sender streams a program ahead of the cut, so the stop
 *    code goes by while the last moves are still being made; waiting for the
 *    machine to rest keeps the device on until they are done. The
 *    "keep running" delay is added on top.
 *  - Also OFF when a job is stopped, on an alarm, a soft reset, or when the
 *    controller disconnects (each of those stops the spindle without an M5).
 * A device that is not switched automatically is only ever switched by hand.
 *
 * The main-screen switch (optional, one per device): ncSender's Auxiliary I/O
 * switches are controller outputs (M64 Pn on, M65 Pn off). Give a device a
 * spare output and add a switch for it in Settings > Auxiliary I/O: flipping
 * the switch sends M64/M65 Pn, which this file sees and passes on to the
 * Shelly; and when the device is switched any other way, this file sends
 * M64/M65 Pn itself so the switch shows it. The output is only a marker:
 * nothing needs to be wired to it.
 *
 * onBeforeCommand only reads the commands. It returns them untouched and
 * never throws: a plugin that throws there stops the job.
 */

var TICK_MS = 500;
var POLL_WINDOW_MS = 2000;     // how often a relay's state is read while the window is open
var POLL_IDLE_MS = 10000;      // ... and while it is closed
var SETTLE_MS = 1500;          // the machine must be at rest this long before a stop counts
var RETRY_MS = 3000;
var MAX_ATTEMPTS = 15;         // a minute or two of retries, then give up
var HTTP_TIMEOUT_MS = 4000;
var MAX_RECENT = 8;
var PANEL_GAP_MS = 1000;       // at most one M64/M65 a second per switch
var RESET = '\u0018';          // soft reset (Ctrl-X)

var TRIGGERS = {
  spindle: { on: [3, 4], off: [5, 2, 30], started: 'Spindle started', stopped: 'Spindle stopped' },
  flood: { on: [8], off: [9, 2, 30], started: 'Flood coolant on', stopped: 'Coolant off' },
  mist: { on: [7], off: [9, 2, 30], started: 'Mist coolant on', stopped: 'Coolant off' },
  job: null
};

// The vacuum pump holds the work down: by default nothing but a hand switches it.
var KINDS = [
  { key: 'dust', name: 'dust extractor', title: 'Dust extractor', enabled: true },
  { key: 'pump', name: 'vacuum pump', title: 'Vacuum pump', enabled: false }
];

var DEFAULTS = { host: '', channel: 0, enabled: true, trigger: 'spindle', offDelaySec: 5, notify: true, panelPin: -1 };

function newDevice(kind) {
  return {
    key: kind.key,
    name: kind.name,
    title: kind.title,
    autoByDefault: kind.enabled,
    cfg: null,
    // The relay as last heard from, and what is still to be sent to it.
    relay: {
      target: null,        // true / false while a switch is still to be confirmed, else null
      busy: false,         // a Switch.Set is in flight
      attempts: 0,
      retryAt: 0,
      notified: false,     // the operator has been told about this failure
      output: null,        // true / false, or null while the Shelly can't be reached
      known: null,         // the last state the Shelly confirmed; kept while it can't be reached
      epoch: 0,            // counts switches, so an older status reading can be told apart
      reachable: null,
      error: null,
      polling: false,
      lastPollAt: 0
    },
    // A pending automatic switch-off.
    auto: {
      pendingOff: 0,       // a stop was seen at this time; waiting for the machine to rest
      offAt: 0,            // the machine is at rest; switch off at this time
      offWhy: ''
    },
    // The main-screen switch: what it shows (as far as this file knows) and what it should show.
    panel: {
      shown: null,         // true / false, or null before anything is known (ncSender starts with it off)
      want: null,
      sentAt: 0
    },
    recent: [],            // [{ t, on, why }] newest first
    test: { state: 'idle', host: '', error: null, device: null }
  };
}

var devices = [];
for (var di = 0; di < KINDS.length; di++) devices.push(newDevice(KINDS[di]));

// What the machine was doing at the last tick.
var machine = {
  seen: false,
  lastJob: '',
  lastStatus: '',
  lastConnected: false,
  restSince: 0             // when the machine was first seen at rest; 0 while it moves
};

var loaded = false;        // settings read from pluginContext.storage
var lastAsked = 0;         // when the window last asked for the status

function buildInitialConfig(raw) { return raw || {}; }

/* ---------- host ---------- */

function host() { return typeof pluginContext !== 'undefined' && pluginContext ? pluginContext : null; }

function hasHttp() {
  var h = host();
  return !!(h && h.http && typeof h.http.request === 'function' && h.storage);
}

// pluginContext.log is deliberately not used anywhere in this file: it crashes
// the packaged ncSender app. What would be logged is kept here instead, and
// handed to the window with the status (as "journal").
var journal = [];
function log(message) {
  journal.unshift({ t: Date.now(), text: String(message) });
  if (journal.length > 20) journal.length = 20;
}

function serverState() {
  var h = host();
  try { return h && typeof h.getServerState === 'function' ? h.getServerState() : null; } catch (e) { return null; }
}

function deviceByKey(key) {
  for (var i = 0; i < devices.length; i++) if (devices[i].key === key) return devices[i];
  return null;
}

/* ---------- settings ---------- */

/** "http://192.168.1.50/" -> "192.168.1.50"; "" when it isn't an address. */
function cleanHost(value) {
  var text = String(value === undefined || value === null ? '' : value).trim();
  text = text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(text) ? text : '';
}

function clampInt(value, lo, hi, fallback) {
  var n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function sanitize(raw, autoByDefault) {
  var src = raw && typeof raw === 'object' ? raw : {};
  var auto = autoByDefault === undefined ? DEFAULTS.enabled : !!autoByDefault;
  return {
    host: cleanHost(src.host),
    channel: clampInt(src.channel, 0, 7, DEFAULTS.channel),
    enabled: src.enabled === undefined ? auto : !!src.enabled,
    trigger: typeof src.trigger === 'string' && TRIGGERS.hasOwnProperty(src.trigger) ? src.trigger : DEFAULTS.trigger,
    offDelaySec: clampInt(src.offDelaySec, 0, 600, DEFAULTS.offDelaySec),
    notify: src.notify === undefined ? DEFAULTS.notify : !!src.notify,
    panelPin: clampInt(src.panelPin, -1, 15, DEFAULTS.panelPin)
  };
}

/** Settings as saved: { devices: { dust: {...}, pump: {...} } }. Before 0.3 it was the dust extractor's alone. */
function readSaved(saved) {
  var out = {};
  var byKey = saved && typeof saved === 'object' && saved.devices && typeof saved.devices === 'object' ? saved.devices : null;
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i];
    var raw = byKey ? byKey[d.key] : (d.key === 'dust' ? saved : null);
    out[d.key] = sanitize(raw, d.autoByDefault);
  }
  return out;
}

function load() {
  if (loaded) return;
  loaded = true;
  var saved = null;
  try { if (hasHttp()) saved = pluginContext.storage.get(); } catch (e) { }
  var all = readSaved(saved);
  for (var i = 0; i < devices.length; i++) devices[i].cfg = all[devices[i].key];
}

/* ---------- reading G-code ---------- */

/** The M-codes in one line of G-code, in order: "N10 M03 S18000 (go)" -> [3]. */
function mCodes(line) {
  if (line.indexOf('M') < 0 && line.indexOf('m') < 0) return [];
  var text = line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').toUpperCase();
  // Named parameters and subroutine names can hold an M and a digit.
  text = text.replace(/<[^>]*>/g, ' ').replace(/^\s+/, '');
  var first = text.charAt(0);
  if (first === '$' || first === '[' || first === '%') return [];
  var codes = [];
  var re = /(^|[^A-Z])M\s*(\d+)(\.\d+)?/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (!m[3]) codes.push(parseInt(m[2], 10));
  }
  return codes;
}

/** "M64 P2" -> { on: true, pin: 2 }, "M65 P2" -> { on: false, pin: 2 }; null for anything else. */
function pinCommand(line) {
  if (line.indexOf('6') < 0) return null;
  var text = line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').toUpperCase();
  var m = /(^|[^A-Z])M0*6([45])\s*P\s*(\d+)(?![\d.])/.exec(text);
  return m ? { on: m[2] === '4', pin: parseInt(m[3], 10) } : null;
}

/* ---------- the Shelly ---------- */

function rpcUrl(s, method, query) {
  return 'http://' + s.host + '/rpc/' + method + (query ? '?' + query : '');
}

function parseJson(text) {
  try { var v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

/** What went wrong with an answer, in words; null when it is fine. */
function problemOf(res, hostName, expectKey) {
  if (res && res.ok) {
    var body = parseJson(res.body);
    if (body && (!expectKey || body.hasOwnProperty(expectKey))) return null;
    return hostName + " answered, but not like a Shelly Gen2 or newer.";
  }
  if (res && res.status === 401) return "The Shelly asks for a password. Turn off authentication on the device: this plugin can't sign in.";
  if (res && res.status) {
    var err = parseJson(res.body);
    if (err && err.message) return 'The Shelly refused: ' + err.message;
    if (res.status === 404) return hostName + " answered, but not like a Shelly Gen2 or newer.";
    return 'The Shelly answered with an error (' + res.status + ').';
  }
  return "Can't reach the Shelly at " + hostName + (res && res.error ? ' (' + res.error + ')' : '') + '.';
}

function note(d, on, why) {
  d.recent.unshift({ t: Date.now(), on: on, why: why || '' });
  if (d.recent.length > MAX_RECENT) d.recent.length = MAX_RECENT;
}

function warn(d, on, problem, s, wasOn) {
  log('Could not switch the ' + d.name + ' ' + (on ? 'on' : 'off') + ': ' + problem);
  // A Shelly that is unplugged can't be switched off, and doesn't need to be:
  // only say so when the device was last seen running.
  if (!s.notify || (!on && !wasOn)) return;
  var h = host();
  try {
    if (h && typeof h.showNotice === 'function') {
      h.showNotice('The ' + d.name + " didn't switch " + (on ? 'on' : 'off'),
        'ncSender keeps trying for a minute or two.', { Problem: problem, Shelly: s.host });
    }
  } catch (e) { }
}

/** Ask for a relay to be on or off. Sends now, and again until it is confirmed. */
function switchRelay(d, on, why) {
  var relay = d.relay;
  relay.target = on;
  relay.attempts = 0;
  relay.retryAt = 0;
  relay.notified = false;
  d.panel.want = on;
  note(d, on, why);
  log(d.title + ' ' + (on ? 'ON' : 'OFF') + (why ? ': ' + why : ''));
  flush(d, Date.now());
}

function flush(d, now) {
  var relay = d.relay;
  if (relay.busy || relay.target === null || now < relay.retryAt) return;
  var s = d.cfg;
  if (!s.host || !hasHttp()) { relay.target = null; return; }
  var on = relay.target;
  var wasOn = relay.known === true;
  relay.busy = true;
  relay.epoch++;
  var sent = pluginContext.http.request({
    url: rpcUrl(s, 'Switch.Set', 'id=' + s.channel + '&on=' + (on ? 'true' : 'false')),
    timeoutMs: HTTP_TIMEOUT_MS
  }, function (res) {
    relay.busy = false;
    relay.epoch++;
    // The address was changed while this was on its way: the answer is another device's.
    var current = d.cfg;
    if (current.host !== s.host || current.channel !== s.channel) { flush(d, Date.now()); return; }
    var problem = problemOf(res, s.host, 'was_on');
    if (!problem) {
      relay.output = on;
      relay.known = on;
      relay.reachable = true;
      relay.error = null;
      if (relay.target === on) relay.target = null;
      else flush(d, Date.now());
      return;
    }
    relay.reachable = !!(res && res.status);
    relay.error = problem;
    // Asked for the opposite meanwhile: that is what matters now.
    if (relay.target !== on) { relay.attempts = 0; relay.retryAt = 0; flush(d, Date.now()); return; }
    relay.attempts++;
    if (!relay.notified) { relay.notified = true; warn(d, on, problem, s, wasOn); }
    if (relay.attempts >= MAX_ATTEMPTS) {
      relay.target = null;
      // The switch must not go on saying "on" for a device that never started.
      if (on) d.panel.want = false;
      log('Gave up switching the ' + d.name + ' ' + (on ? 'on' : 'off'));
    }
    else relay.retryAt = Date.now() + RETRY_MS;
  });
  if (sent === false) {
    relay.busy = false;
    relay.target = null;
    relay.error = 'The Shelly address is not valid.';
  }
}

/** Read a relay's real state, so the window shows a switch made elsewhere (the Shelly app, a wall switch). */
function poll(d, now) {
  var relay = d.relay;
  var s = d.cfg;
  if (!s.host || !hasHttp() || relay.polling || relay.busy || relay.target !== null) return;
  var every = now - lastAsked < 5000 ? POLL_WINDOW_MS : POLL_IDLE_MS;
  if (now - relay.lastPollAt < every) return;
  relay.lastPollAt = now;
  relay.polling = true;
  var epoch = relay.epoch;
  var sent = pluginContext.http.request({
    url: rpcUrl(s, 'Switch.GetStatus', 'id=' + s.channel),
    timeoutMs: HTTP_TIMEOUT_MS
  }, function (res) {
    relay.polling = false;
    // Settings changed, or a switch went out, while this was on its way: it is stale.
    if (d.cfg !== s || relay.epoch !== epoch || relay.busy || relay.target !== null) return;
    var problem = problemOf(res, s.host, 'output');
    if (problem) {
      relay.reachable = !!(res && res.status);
      relay.error = problem;
      if (!relay.reachable) relay.output = null;
      return;
    }
    relay.reachable = true;
    relay.error = null;
    relay.output = !!parseJson(res.body).output;
    relay.known = relay.output;
    d.panel.want = relay.output;
  });
  if (sent === false) relay.polling = false;
}

/** False only when the Shelly last confirmed "off" and nothing has asked for "on" since. */
function believedOn(d) { return d.relay.target === true || (d.relay.target === null && d.relay.known !== false); }

/* ---------- on and off ---------- */

function startDevice(d, why) {
  d.auto.pendingOff = 0;
  d.auto.offAt = 0;
  switchRelay(d, true, why);
}

/** A stop was seen. The relay is switched once the machine has come to rest (see tick). */
function stopDevice(d, why) {
  if (d.auto.pendingOff || d.auto.offAt) return;
  if (!believedOn(d)) return;
  d.auto.pendingOff = Date.now();
  d.auto.offWhy = why;
}

/** Switched by hand (the window or the main-screen switch): at once, no waiting for the machine. */
function stopNow(d, why) {
  d.auto.pendingOff = 0;
  d.auto.offAt = 0;
  switchRelay(d, false, why);
}

function machineIs(st, name) {
  return !!st && String(st.machineStatus || '').toLowerCase().indexOf(name) === 0;
}

/** The trigger a device follows right now, or null when it is only switched by hand. */
function triggerOf(d) { return d.cfg.host && d.cfg.enabled ? TRIGGERS[d.cfg.trigger] : null; }

function inspect(commands, context) {
  load();
  if (!commands || !commands.length) return;
  // The devices that care about commands at all: most setups, most lines, none or one.
  var watching = [];
  for (var w = 0; w < devices.length; w++) {
    if (devices[w].cfg.host && (triggerOf(devices[w]) || devices[w].cfg.panelPin >= 0)) watching.push(devices[w]);
  }
  if (!watching.length) return;
  for (var i = 0; i < commands.length; i++) {
    var text = commands[i] ? commands[i].command : null;
    if (typeof text !== 'string') continue;
    // Most lines are moves: skip them without taking them apart.
    if (text.indexOf('M') < 0 && text.indexOf('m') < 0 && text.indexOf(RESET) < 0) continue;
    var lines = text.split('\n');
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      var n, d;
      if (line.indexOf(RESET) >= 0) {
        for (n = 0; n < watching.length; n++) {
          // A reset may clear the outputs: say again what the switch should show.
          watching[n].panel.shown = null;
          if (triggerOf(watching[n])) stopDevice(watching[n], 'Reset');
        }
        continue;
      }
      var io = pinCommand(line);
      if (io) {
        var mine = false;
        for (n = 0; n < watching.length; n++) {
          d = watching[n];
          if (d.cfg.panelPin !== io.pin) continue;
          mine = true;
          if (machineIs(serverState(), 'check')) continue;
          // The command itself moves the switch; nothing more to send to it.
          d.panel.shown = io.on;
          if (io.on) startDevice(d, 'Main-screen switch (M64 P' + io.pin + ')');
          else stopNow(d, 'Main-screen switch (M65 P' + io.pin + ')');
        }
        if (mine) continue;
      }
      var codes = mCodes(line);
      for (var k = 0; k < codes.length; k++) {
        var code = codes[k];
        for (n = 0; n < watching.length; n++) {
          d = watching[n];
          var trigger = triggerOf(d);
          if (!trigger) continue;
          if (trigger.on.indexOf(code) >= 0) {
            // In laser mode M3/M4 fire the laser; a check-mode run cuts nothing.
            if (d.cfg.trigger === 'spindle' && context && context.laserMode) continue;
            if (machineIs(serverState(), 'check')) continue;
            startDevice(d, trigger.started + ' (M' + code + ')');
          } else if (trigger.off.indexOf(code) >= 0) {
            stopDevice(d, trigger.stopped + ' (M' + code + ')');
          }
        }
      }
    }
  }
}

/**
 * Make a main-screen switch show what its device is doing, by sending its
 * output's own M64 / M65. Only while the controller takes commands (idle,
 * running or jogging): a line sent into an alarm is refused, and one sent
 * into a pause waits there. Until then the switch is simply behind.
 */
function syncPanel(d, now, st) {
  var s = d.cfg;
  var panel = d.panel;
  if (s.panelPin < 0 || !s.host || panel.want === null || panel.want === panel.shown) return;
  // ncSender starts with every output off: nothing to say.
  if (panel.shown === null && panel.want === false) { panel.shown = false; return; }
  var h = host();
  if (!h || typeof h.sendCommand !== 'function' || !st || !st.connected) return;
  var status = String(st.machineStatus || '').toLowerCase();
  if (status.indexOf('idle') !== 0 && status.indexOf('run') !== 0 && status.indexOf('jog') !== 0) return;
  if (now - panel.sentAt < PANEL_GAP_MS) return;
  panel.sentAt = now;
  panel.shown = panel.want;
  var command = (panel.want ? 'M64 P' : 'M65 P') + s.panelPin;
  try { h.sendCommand(command, command + ' (' + d.title + ' switch)'); } catch (e) { }
}

function onBeforeCommand(commands, context, _settings) {
  try { inspect(commands, context); }
  catch (e) { log('onBeforeCommand: ' + (e && e.message ? e.message : e)); }
  return commands;
}

function tick() {
  load();
  var now = Date.now();
  var st = serverState();
  var i, d, s;
  if (st) {
    var status = String(st.machineStatus || '').toLowerCase();
    var job = String(st.jobStatus || '');
    var connected = !!st.connected;
    var moving = connected && (status.indexOf('run') === 0 || status.indexOf('jog') === 0 || status.indexOf('home') === 0);
    if (moving) machine.restSince = 0;
    else if (!machine.restSince) machine.restSince = now;

    if (machine.seen) {
      var active = job === 'running' || job === 'paused';
      var wasActive = machine.lastJob === 'running' || machine.lastJob === 'paused';
      for (i = 0; i < devices.length; i++) {
        d = devices[i];
        s = d.cfg;
        // A controller that has just connected shows every output as off.
        if (connected && !machine.lastConnected) d.panel.shown = null;
        if (!s.enabled || !s.host) continue;
        if (s.trigger === 'job') {
          if (active && !wasActive && status.indexOf('check') !== 0) startDevice(d, 'Job started');
          if (!active && wasActive) stopDevice(d, 'Job ended');
        } else if (wasActive && (job === 'stopped' || job === 'error')) {
          // A stopped job resets the controller: the spindle is off with no M5 sent.
          stopDevice(d, 'Job stopped');
        }
        if (status.indexOf('alarm') === 0 && machine.lastStatus.indexOf('alarm') !== 0) stopDevice(d, 'Alarm');
        if (!connected && machine.lastConnected) stopDevice(d, 'Controller disconnected');
      }
    }
    machine.seen = true;
    machine.lastJob = job;
    machine.lastStatus = status;
    machine.lastConnected = connected;
  } else if (!machine.restSince) {
    machine.restSince = now;
  }

  for (i = 0; i < devices.length; i++) {
    d = devices[i];
    if (d.auto.pendingOff && machine.restSince && now - machine.restSince >= SETTLE_MS) {
      d.auto.pendingOff = 0;
      d.auto.offAt = now + d.cfg.offDelaySec * 1000;
    }
    if (d.auto.offAt && now >= d.auto.offAt) {
      d.auto.offAt = 0;
      switchRelay(d, false, d.auto.offWhy);
    }
    flush(d, now);
    poll(d, now);
    syncPanel(d, now, st);
  }
}

/* ---------- the plugin window ---------- */

function testDevice(d, rawHost) {
  var name = cleanHost(rawHost);
  if (!name) { d.test = { state: 'error', host: '', error: "That isn't an IP address or host name.", device: null }; return; }
  d.test = { state: 'working', host: name, error: null, device: null };
  var sent = pluginContext.http.request({ url: 'http://' + name + '/rpc/Shelly.GetDeviceInfo', timeoutMs: HTTP_TIMEOUT_MS }, function (res) {
    if (d.test.host !== name || d.test.state !== 'working') return;
    var problem = problemOf(res, name, 'gen');
    if (problem) { d.test = { state: 'error', host: name, error: problem, device: null }; return; }
    var info = parseJson(res.body);
    d.test = {
      state: 'ok', host: name, error: null,
      device: { name: info.name || info.id || 'Shelly', model: info.app || info.model || '', gen: info.gen, auth: !!info.auth_en }
    };
  });
  if (sent === false) d.test = { state: 'error', host: name, error: "That isn't an IP address or host name.", device: null };
}

/** Save every device's settings: { dust: {...}, pump: {...} }. Returns what is wrong, or null. */
function saveSettings(raw) {
  var src = raw && typeof raw === 'object' ? raw : {};
  var next = {};
  var i, d;
  for (i = 0; i < devices.length; i++) {
    d = devices[i];
    var given = src[d.key] && typeof src[d.key] === 'object' ? src[d.key] : d.cfg;
    var typed = given.host !== undefined && given.host !== null ? String(given.host).trim() : '';
    next[d.key] = sanitize(given, d.autoByDefault);
    if (typed && !next[d.key].host) return d.title + ": that isn't an IP address or host name.";
  }
  // Two devices on one relay, or on one switch, would fight over it.
  for (i = 0; i < devices.length; i++) {
    for (var j = i + 1; j < devices.length; j++) {
      var a = next[devices[i].key], b = next[devices[j].key];
      if (a.host && a.host.toLowerCase() === b.host.toLowerCase() && a.channel === b.channel) {
        return devices[i].title + ' and ' + devices[j].title.toLowerCase() + ' use the same Shelly relay. Give each its own Shelly, or its own relay channel.';
      }
      if (a.panelPin >= 0 && a.panelPin === b.panelPin) {
        return devices[i].title + ' and ' + devices[j].title.toLowerCase() + ' use the same output (P' + a.panelPin + ') for their switch. Pick another output for one of them.';
      }
    }
  }
  var ok = false;
  try { ok = pluginContext.storage.set({ version: 2, devices: next }) !== false; } catch (e) { }
  if (!ok) return "The settings couldn't be saved.";
  for (i = 0; i < devices.length; i++) {
    d = devices[i];
    var old = d.cfg;
    var cfg = next[d.key];
    var moved = old.host !== cfg.host || old.channel !== cfg.channel;
    var repinned = old.panelPin !== cfg.panelPin;
    d.cfg = cfg;
    if (moved) {
      d.relay.target = null;
      d.relay.output = null;
      d.relay.known = null;
      d.relay.epoch++;
      d.relay.reachable = null;
      d.relay.error = null;
      d.relay.lastPollAt = 0;
      d.auto.pendingOff = 0;
      d.auto.offAt = 0;
    }
    // Another output, another switch: it starts off, and is told if the device is running.
    if (moved || repinned) { d.panel.shown = null; d.panel.want = moved ? null : d.relay.known; }
  }
  return null;
}

function statusOf(d, now) {
  var offIn = null;
  if (d.auto.offAt) offIn = Math.max(0, Math.ceil((d.auto.offAt - now) / 1000));
  return {
    title: d.title,
    settings: d.cfg,
    relay: {
      output: d.relay.output,
      reachable: d.relay.reachable,
      switching: d.relay.target,
      error: d.relay.error
    },
    stopping: !!d.auto.pendingOff,
    offInSec: offIn,
    recent: d.recent,
    test: d.test
  };
}

function status(saveError) {
  var now = Date.now();
  var out = { version: 2, now: now, saveError: saveError || null, order: [], devices: {}, journal: journal };
  for (var i = 0; i < devices.length; i++) {
    out.order.push(devices[i].key);
    out.devices[devices[i].key] = statusOf(devices[i], now);
  }
  return out;
}

function onRequest(req) {
  if (!hasHttp()) return { unsupported: true };
  load();
  var saveError = null;
  lastAsked = Date.now();
  var d = req && req.device ? deviceByKey(req.device) : null;
  switch (req && req.action) {
    case 'save': saveError = saveSettings(req.settings); break;
    case 'test': if (d) testDevice(d, req.host); break;
    case 'on':
      if (d && d.cfg.host) startDevice(d, 'Switched on by hand');
      break;
    case 'off':
      if (d && d.cfg.host) stopNow(d, 'Switched off by hand');
      break;
  }
  for (var i = 0; i < devices.length; i++) poll(devices[i], Date.now());
  return status(saveError);
}

if (typeof pluginContext !== 'undefined' && pluginContext && typeof pluginContext.setInterval === 'function') {
  pluginContext.setInterval(function () { tick(); }, TICK_MS);
}

export { buildInitialConfig, onBeforeCommand, onRequest, tick, mCodes, pinCommand, cleanHost, sanitize, readSaved };
