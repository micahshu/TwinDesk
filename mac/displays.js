// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The TwinDesk virtual displays (via mac-helper), the display list, and which display is shared.
// settings.sharing.displayId: null = the TwinDesk virtual display (falls back to the main
// display when it is off), otherwise an Electron display id (= CGDirectDisplayID).
// settings.virtual.count 2 adds a second virtual display, shown in its own window on the PC
// (stream sid 1, target(1)); it is never the one `sharing.displayId` picks.
//
// Events: 'change' — displays were added/removed/resized or a virtual display changed.
'use strict';

const { screen } = require('electron');
const { EventEmitter } = require('events');

const WAIT_DISPLAY_MS = 5000;
const MAX_VIRTUAL = 2;

class Displays extends EventEmitter {
  constructor(helper, getSettings) {
    super();
    this.helper = helper;
    this.getSettings = getSettings;
    this.virtualIds = []; // CGDirectDisplayID of each virtual display by index (null: not there)
    this.virtualKeys = [];
    this.virtualError = null;
    this.applying = null;
    this.changeTimer = null;
    const changed = () => this._changed();
    screen.on('display-added', changed);
    screen.on('display-removed', changed);
    screen.on('display-metrics-changed', changed);
    helper.on('event', (name, msg) => {
      if (name === 'displayTerminated') {
        const i = msg && Number.isInteger(msg.index) ? msg.index : 0;
        this.virtualIds[i] = null;
        this.virtualKeys[i] = '';
        this._changed();
      }
    });
    helper.on('exit', () => {
      this.virtualIds = [];
      this.virtualKeys = [];
      this._changed();
    });
  }

  // The TwinDesk virtual display (index 0), when it exists.
  get virtualId() {
    return this.virtualIds[0] ?? null;
  }

  // How many virtual displays to keep: settings.virtual.count, but one while a phone views Extend.
  virtualCount() {
    if (this.override) return 1;
    return Math.max(1, Math.min(MAX_VIRTUAL, this.getSettings().virtual.count | 0 || 1));
  }

  _changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('change'), 300);
  }

  // A phone viewing Extend: the virtual display takes the phone's shape (its pixels at 2x, HiDPI),
  // in place of settings.virtual's size. null = settings.virtual again.
  setOverride(o) {
    const next = o && o.width > 0 && o.height > 0
      ? { width: Math.max(480, Math.round(o.width / 2)), height: Math.max(360, Math.round(o.height / 2)), hiDPI: true } : null;
    if (JSON.stringify(next) === JSON.stringify(this.override || null)) return;
    this.override = next;
    const v = this.getSettings().virtual;
    if (v.enabled && this.getSettings().sharing.on) this.applyVirtual();
  }

  // Create, re-create or remove the virtual displays to match settings.virtual. Serialized.
  applyVirtual() {
    const run = async () => {
      const v = this.getSettings().virtual;
      this.virtualError = null;
      try {
        // The virtual displays exist only while this Mac's screen is shared (no empty extra monitor).
        const n = v.enabled && this.getSettings().sharing.on ? this.virtualCount() : 0;
        for (let i = this.virtualIds.length - 1; i >= n; i--) {
          if (this.virtualIds[i] != null) await this.helper.request('destroyDisplay', { index: i });
        }
        this.virtualIds.length = Math.min(this.virtualIds.length, n);
        this.virtualKeys.length = this.virtualIds.length;
        // A second display is the first one's size (a phone's override applies to one display only).
        for (let i = 0; i < n; i++) await this._ensureVirtual(i, this.override || v, v.hz || 60);
      } catch (e) {
        this.virtualError = e.message;
        console.error(`[displays] virtual display: ${e.message}`);
      } finally {
        this._changed();
      }
    };
    this.applying = (this.applying || Promise.resolve()).then(run);
    return this.applying;
  }

  async _ensureVirtual(i, size, hz) {
    // Already there as asked: keep it (re-creating it pulls it from under a capture that just
    // started on it; several callers apply at once when sharing starts).
    const key = JSON.stringify([size.width, size.height, !!size.hiDPI, hz]);
    const id = this.virtualIds[i];
    if (id != null && key === this.virtualKeys[i] && screen.getAllDisplays().some((d) => d.id === id)) return;
    try {
      const r = await this.helper.request('createDisplay', {
        index: i, width: size.width, height: size.height, hiDPI: !!size.hiDPI, hz, name: i ? `TwinDesk ${i + 1}` : 'TwinDesk',
      });
      this.virtualIds[i] = r.displayId;
      this.virtualKeys[i] = key;
      console.log(`[displays] virtual display${i ? ` ${i + 1}` : ''} ${r.displayId}: ${size.width}x${size.height} pt, ${r.pixelWidth}x${r.pixelHeight} px`);
      await this._waitForDisplay(r.displayId);
    } catch (e) {
      this.virtualIds[i] = null;
      this.virtualKeys[i] = '';
      this.virtualError = e.message;
      console.error(`[displays] virtual display${i ? ` ${i + 1}` : ''}: ${e.message}`);
    }
  }

  _waitForDisplay(id) {
    if (screen.getAllDisplays().some((d) => d.id === id)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        screen.removeListener('display-added', onAdded);
        resolve();
      };
      const onAdded = (_e, d) => d.id === id && done();
      const timer = setTimeout(() => {
        console.error(`[displays] display ${id} did not appear within ${WAIT_DISPLAY_MS} ms`);
        done();
      }, WAIT_DISPLAY_MS);
      screen.on('display-added', onAdded);
    });
  }

  // `virtual`: the TwinDesk display (index 0); `virtualIndex`: which virtual display, null for others.
  list() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => {
      const vi = this.virtualIds.indexOf(d.id);
      return {
        id: d.id,
        label: vi === 0 ? 'TwinDesk (virtual)' : vi > 0 ? `TwinDesk (virtual ${vi + 1})` : d.label || (d.internal ? 'Built-in display' : `Display ${d.id}`),
        width: d.size.width,
        height: d.size.height,
        pixelWidth: Math.round(d.size.width * d.scaleFactor),
        pixelHeight: Math.round(d.size.height * d.scaleFactor),
        bounds: d.bounds,
        virtual: vi === 0,
        virtualIndex: vi < 0 ? null : vi,
        primary: d.id === primary,
        hz: d.displayFrequency || 60,
      };
    });
  }

  // The display to share right now (an entry of list()), or null. sid > 0: that PC window's own
  // virtual display, or nothing (a second window never falls back to another display).
  target(sid = 0) {
    const all = this.list();
    if (sid > 0) return all.find((d) => d.virtualIndex === sid) || null;
    const want = this.getSettings().sharing.displayId;
    return (
      (want != null && all.find((d) => d.id === want)) ||
      all.find((d) => d.virtual) ||
      all.find((d) => d.primary) ||
      all[0] ||
      null
    );
  }
}

module.exports = { Displays };
