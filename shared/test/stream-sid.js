// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two Mac virtual displays, each in its own PC window (stream `sid`): the Mac makes both displays
// and gives each Stream its own; every message of the second carries sid 1 and none of the first
// does; the PC's second window asks for its stream only from a Mac that says `screens`, so an older
// Mac never reads a sid-1 screen.policy as Monitor 2's. Electron is faked.
'use strict';

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

// ---- a fake electron ----
let pid = 0;
class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.mainFrame = { processId: ++pid, routingId: 1 };
  }
  send(ch, m) { this.sent.push([ch, m]); }
}
class FakeWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeContents();
    this.visible = false;
  }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isFullScreen() { return false; }
  show() { this.visible = true; this.emit('show'); }
  showInactive() { this.inactive = true; this.show(); }
  getBounds() { return { x: this.opts.x ?? 640, y: this.opts.y ?? 340, width: this.opts.width, height: this.opts.height }; }
  hide() { this.visible = false; this.emit('hide'); }
  close() {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit('close', e);
    if (!e.prevented) this.emit('closed');
  }
  focus() {}
  restore() {}
  setTitle(t) { this.title = t; }
  setFullScreen() {}
  getNormalBounds() { return { x: 0, y: 0, width: 1280, height: 720 }; }
}
const displaysNow = [{ id: 1, label: 'Built-in', internal: true, size: { width: 1728, height: 1117 }, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, displayFrequency: 120 }];
const electron = {
  BrowserWindow: FakeWindow,
  ipcMain: new EventEmitter(),
  session: { defaultSession: { setDisplayMediaRequestHandler(h) { electron.mediaHandler = h; } } },
  desktopCapturer: { getSources: async () => displaysNow.map((d) => ({ id: `screen:${d.id}`, display_id: String(d.id) })) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  screen: Object.assign(new EventEmitter(), { getAllDisplays: () => displaysNow.slice(), getPrimaryDisplay: () => displaysNow[0] }),
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? 'electron' : resolve.call(this, request, ...rest);
};
require.cache.electron = { id: 'electron', filename: 'electron', loaded: true, exports: electron };

const P = require('../protocol.js');
const T = P.T;
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const quiet = console.log;
const loud = console.error;

(async () => {
  console.log = console.error = () => {};
  try {
    await mac();
    await pc();
  } finally {
    console.log = quiet;
    console.error = loud;
  }
  console.log('stream-sid: passed');
  process.exit(0); // the apps' debounce and retry timers don't matter here
})().catch((e) => {
  console.log = quiet;
  console.error = loud;
  console.error(e);
  process.exit(1);
});

async function mac() {
  const { Displays } = require('../../mac/displays.js');
  const { Stream } = require('../../mac/stream.js');
  const { Input } = require('../../mac/input.js');

  // The helper makes and removes displays (as mac-helper does, by index).
  const helper = Object.assign(new EventEmitter(), {
    calls: [],
    inputs: [],
    async request(name, a = {}) {
      this.calls.push([name, a]);
      if (name === 'createDisplay') {
        const id = 100 + a.index;
        if (!displaysNow.some((d) => d.id === id)) {
          displaysNow.push({ id, label: a.name, size: { width: a.width, height: a.height }, scaleFactor: 1, bounds: { x: -2560 * (a.index + 1), y: 0, width: a.width, height: a.height }, displayFrequency: 60 });
        }
        return { displayId: id, pixelWidth: a.width, pixelHeight: a.height };
      }
      if (name === 'destroyDisplay') {
        const i = displaysNow.findIndex((d) => d.id === 100 + (a.index | 0));
        if (i >= 0) displaysNow.splice(i, 1);
      }
      return {};
    },
    send(name, a) { if (name === 'input') this.inputs.push(a); },
  });
  const settings = {
    sharing: { on: true, displayId: null, audio: false },
    virtual: { enabled: true, width: 2560, height: 1440, hiDPI: false, hz: 60, count: 2 },
    bitrateMbps: 50,
    streamMaxHeight: 0,
  };
  const s = () => settings;
  // Multi-device mode's Displays (one Stream, screens 1) never makes a second display.
  assert.strictEqual(new Displays(helper, s).virtualCount(), 1);
  const displays = new Displays(helper, s);
  displays.screens = 2; // services.js: Monitor 2's Stream and one follower
  settings.sharing.displayId = 1;
  assert.strictEqual(displays.virtualCount(), 1, 'another display picked to share: no second one');
  settings.sharing.displayId = null;
  await displays.applyVirtual();
  assert.deepStrictEqual(helper.calls.filter((c) => c[0] === 'createDisplay').map((c) => [c[1].index, c[1].name]), [[0, 'TwinDesk'], [1, 'TwinDesk 2']]);
  assert.strictEqual(displays.virtualId, 100);
  assert.strictEqual(displays.target().id, 100, 'Monitor 2 shows the TwinDesk display');
  assert.strictEqual(displays.target(1).id, 101, 'the second window shows the second display');
  assert.strictEqual(displays.target(1).label, 'TwinDesk (virtual 2)');
  assert.strictEqual(displays.list().filter((d) => d.virtual).length, 1, 'only the first counts as "the" virtual display');

  const server = Object.assign(new EventEmitter(), {
    current: { name: 'PC', os: P.OS.WIN, transport: 'ip' },
    sent: [],
    sendToClient(m) { this.sent.push(m); },
  });
  server.setMaxListeners(50);
  const hub = { acquire: async () => false, release() {}, error: null };
  const s0 = new Stream(server, displays, s, hub);
  const s1 = new Stream(server, displays, s, hub, 1);
  s0.followers.push(s1);
  new Input(server, helper, displays);

  // Monitor 2's policy (no sid) starts only stream 0.
  server.emit(`t:${T.SCREEN_POLICY}`, { t: T.SCREEN_POLICY, accept: true });
  await tick();
  const info = server.sent.filter((m) => m.t === T.STREAM_INFO);
  assert.strictEqual(info.length, 1);
  assert.strictEqual(info[0].sid, undefined, 'stream 0 carries no sid');
  assert.strictEqual(s1.active, null, 'stream 1 waits for its own policy');

  // The second window's policy starts stream 1, on the second display.
  server.emit(`t:${T.SCREEN_POLICY}`, { t: T.SCREEN_POLICY, accept: true, sid: 1 });
  await tick();
  const info1 = server.sent.filter((m) => m.t === T.STREAM_INFO && m.sid === 1);
  assert.strictEqual(info1.length, 1);
  assert.strictEqual(info1[0].name, 'TwinDesk (virtual 2)');
  const start1 = s1.win.webContents.sent.find(([ch]) => ch === 'start')[1];
  assert.strictEqual(start1.sourceId, 'screen:101');
  assert.strictEqual(s0.win.webContents.sent.find(([ch]) => ch === 'start')[1].sourceId, 'screen:100');
  assert.notStrictEqual(s0.win, s1.win, 'each stream has its own capture window');

  // getDisplayMedia from each capture window gets that window's display.
  const pick = (win) => new Promise((r) => electron.mediaHandler({ frame: win.webContents.mainFrame }, r));
  assert.strictEqual((await pick(s1.win)).video.id, 'screen:101');
  assert.strictEqual((await pick(s0.win)).video.id, 'screen:100');
  const orphan = await new Promise((r) => electron.mediaHandler({ frame: null }, r));
  assert.deepStrictEqual(orphan, {}, 'no frame and two capture windows: neither display');

  // Offers leave tagged; answers reach only their own window.
  electron.ipcMain.emit('capture:out', { sender: s1.win.webContents }, { t: T.RTC_OFFER, session: s1.active.session, sdp: 'o1' });
  electron.ipcMain.emit('capture:out', { sender: s0.win.webContents }, { t: T.RTC_OFFER, session: s0.active.session, sdp: 'o0' });
  assert.strictEqual(server.sent.find((m) => m.sdp === 'o1').sid, 1);
  assert.strictEqual(server.sent.find((m) => m.sdp === 'o0').sid, undefined);
  server.emit(`t:${T.RTC_ANSWER}`, { t: T.RTC_ANSWER, session: s1.active.session, sdp: 'a1', sid: 1 });
  assert.ok(s1.win.webContents.sent.some(([ch, m]) => ch === 'remote' && m.sdp === 'a1'));
  assert.ok(!s0.win.webContents.sent.some(([ch, m]) => ch === 'remote' && m.sdp === 'a1'));

  // Input in the second window lands on the second display.
  server.emit(`t:${T.IN_MOVE}`, { t: T.IN_MOVE, x: 0.5, y: 0.5, sid: 1 });
  server.emit(`t:${T.IN_MOVE}`, { t: T.IN_MOVE, x: 0.5, y: 0.5 });
  assert.deepStrictEqual(helper.inputs.map((i) => i.bounds.x), [-5120, -2560]);

  // Monitor 2 closing and opening again restarts its stream only; a shared setting restarts both,
  // and a move to another transport restarts each once.
  const was = s1.session;
  server.emit(`t:${T.SCREEN_POLICY}`, { t: T.SCREEN_POLICY, accept: false });
  server.emit(`t:${T.SCREEN_POLICY}`, { t: T.SCREEN_POLICY, accept: true });
  await tick();
  assert.strictEqual(s1.session, was, 'Monitor 3 keeps its session while Monitor 2 reopens');
  s0.restart('bitrate changed');
  await tick();
  assert.strictEqual(s1.session, was + 1);
  server.current.transport = 'wifi';
  server.emit('transport', server.current);
  await tick();
  assert.strictEqual(s1.session, was + 2);

  // Sharing off: both windows are told.
  s0.stop('off');
  const stops = server.sent.filter((m) => m.t === T.STREAM_STOP);
  assert.deepStrictEqual(stops.map((m) => m.sid), [1, undefined]);

  // A PC that never asked for the second window (an older one) hears nothing about it.
  server.emit('client');
  server.sent.length = 0;
  s0.stop('off');
  assert.deepStrictEqual(server.sent.filter((m) => m.t === T.STREAM_STOP).map((m) => m.sid), [undefined]);

  // Back to one display: the second goes away, target(1) is nothing (no fallback to another).
  settings.virtual.count = 1;
  await displays.applyVirtual();
  assert.ok(helper.calls.some((c) => c[0] === 'destroyDisplay' && c[1].index === 1));
  assert.strictEqual(displays.target(1), null);
  assert.strictEqual(displays.target().id, 100);
}

async function pc() {
  const Screen = require('../../windows/screen.js');
  // Two PC monitors, side by side.
  const pcDisplays = [{ id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }, { id: 2, workArea: { x: 2560, y: 0, width: 2560, height: 1400 } }];
  electron.screen.getAllDisplays = () => pcDisplays;
  electron.screen.getDisplayMatching = (b) => pcDisplays.find((d) => b.x >= d.workArea.x && b.x < d.workArea.x + d.workArea.width) || pcDisplays[0];
  const link = Object.assign(new EventEmitter(), {
    status: { state: 'connected' },
    sent: [],
    send(m) { this.sent.push(m); },
    snapshot: () => ({ link: { macName: 'Mac' } }),
  });
  const settings = { windows: {}, monitor: { mute: false, volume: 1, pacing: 'fast', framegen: false } };
  const opts = { link, clip: { sendIfChanged() {}, request() {} }, inputAllowed: () => true, settings, saveSettings() {}, onChange() {}, isQuitting: () => false };
  const s0 = new Screen(opts);
  const s1 = new Screen({ ...opts, sid: 1, primary: s0 });
  s0.followers.push(s1);
  // main.js wraps Monitor 2's policy() to wait for Wi-Fi; Monitor 3's changes must pass through it.
  const policy0 = s0.policy.bind(s0);
  let viaPrimary = 0;
  s0.policy = () => { viaPrimary++; return policy0(); };
  const withSid = () => link.sent.filter((m) => m.sid !== undefined);

  // An older Mac (no `screens`): only Monitor 2, and nothing with a sid.
  link.emit(T.SCREEN_STATE, { t: T.SCREEN_STATE, on: true, mode: 'extend', remote: true, modes: ['extend', 'mirror'] });
  s0.open(false);
  s0.win.emit('ready-to-show');
  assert.ok(s0.win.isVisible());
  assert.ok(link.sent.some((m) => m.t === T.SCREEN_POLICY && m.accept === true && m.sid === undefined));
  assert.strictEqual(s1.win, null, 'no second window for an older Mac');
  assert.deepStrictEqual(withSid(), []);

  // A Mac with two screens: the second window opens with Monitor 2 and asks with sid 1.
  link.emit(T.SCREEN_STATE, { t: T.SCREEN_STATE, on: true, mode: 'extend', remote: true, modes: ['extend', 'mirror'], screens: 2 });
  assert.ok(s1.win, 'the second window opened');
  assert.deepStrictEqual([s1.win.opts.x, s1.win.opts.y], [3200, 340], 'first time: centred on the other PC monitor');
  const calls = viaPrimary;
  s1.win.emit('ready-to-show');
  assert.ok(s1.win.inactive, 'it shows without taking the focus from Monitor 2');
  assert.ok(viaPrimary > calls, "its show went through Monitor 2's policy()");
  assert.ok(link.sent.some((m) => m.t === T.SCREEN_POLICY && m.accept === true && m.sid === 1));
  assert.strictEqual(s1.win.opts.title, 'Monitor 3');

  // Each window takes only its own stream.
  link.emit(T.STREAM_INFO, { t: T.STREAM_INFO, name: 'TwinDesk (virtual 2)', width: 2560, height: 1440, sid: 1 });
  assert.strictEqual(s1.state.state, 'on');
  assert.strictEqual(s0.state.state, 'off');
  link.emit(T.STREAM_INFO, { t: T.STREAM_INFO, name: 'TwinDesk (virtual)', width: 2560, height: 1440 });
  assert.strictEqual(s0.state.name, 'TwinDesk (virtual)');
  assert.strictEqual(s1.state.name, 'TwinDesk (virtual 2)');

  // What a window's renderer sends leaves with its sid.
  electron.ipcMain.emit('rtc', { sender: s1.win.webContents }, { t: T.RTC_ANSWER, session: 3, sdp: 'a1' });
  electron.ipcMain.emit('rtc', { sender: s0.win.webContents }, { t: T.RTC_ANSWER, session: 7, sdp: 'a0' });
  electron.ipcMain.emit('rtc', { sender: s1.win.webContents }, { t: T.IN_MOVE, x: 0.5, y: 0.5 });
  assert.strictEqual(link.sent.find((m) => m.sdp === 'a1').sid, 1);
  assert.strictEqual(link.sent.find((m) => m.sdp === 'a0').sid, undefined);
  assert.strictEqual(link.sent.filter((m) => m.t === T.IN_MOVE).pop().sid, 1);

  // Closing Monitor 2 closes the second window too, and both say they stopped watching.
  s0.win.close();
  assert.ok(!s1.win.isVisible() && !s0.win.isVisible());
  assert.ok(link.sent.some((m) => m.t === T.SCREEN_POLICY && m.accept === false && m.sid === 1));
  assert.ok(link.sent.some((m) => m.t === T.SCREEN_POLICY && m.accept === false && m.sid === undefined));

  // Monitor 3 alone on screen still counts as watching (main.js keeps Wi-Fi up for it).
  s1.open(false);
  assert.ok(!s0.watching() && s0.anyWatching());
  s1.win.close();
  assert.ok(!s0.anyWatching());

  // Opening Monitor 2 again brings both. Monitor 3 closed by hand stays closed through a reconnect,
  // until Monitor 2 is opened again.
  s0.open(false);
  assert.ok(s1.win.isVisible());
  s1.win.close();
  link.emit('welcome');
  link.emit(T.SCREEN_STATE, { t: T.SCREEN_STATE, on: true, mode: 'extend', remote: true, modes: ['extend', 'mirror'], screens: 2 });
  assert.ok(!s1.win.isVisible() && s0.win.isVisible(), 'closed by hand: a reconnect does not reopen it');
  s0.open(false);
  assert.ok(s1.win.isVisible());

  // Stop on Monitor 3's bar stops the Mac's sharing and closes both windows.
  electron.ipcMain.emit('monitor-ctl', { sender: s1.win.webContents }, { share: false });
  assert.ok(link.sent.some((m) => m.t === T.SCREEN_CTL && m.share === false && m.sid === undefined));
  assert.ok(!s0.win.isVisible() && !s1.win.isVisible());

  // The Mac going back to one screen hides the second.
  s0.open(false);
  assert.ok(s1.win.isVisible());
  link.emit(T.SCREEN_STATE, { t: T.SCREEN_STATE, on: true, mode: 'extend', remote: true, modes: ['extend', 'mirror'], screens: 1 });
  assert.ok(!s1.win.isVisible());
  assert.ok(s0.win.isVisible());
}
