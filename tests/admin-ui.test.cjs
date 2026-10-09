const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const readScript = (name) => readFileSync(join(__dirname, "..", "static", name), "utf8");
const timerContext = { window: {} };
vm.runInNewContext(readScript("admin-dom.js"), timerContext);
const adminDom = timerContext.window.AdminDom;
const startedAt = "2026-10-08T12:00:00Z";
const startedMilliseconds = Date.parse(startedAt);
const presentation = (settings, elapsedSeconds = 0) => JSON.parse(JSON.stringify(
  adminDom.getTimerPresentation(settings, startedMilliseconds + elapsedSeconds * 1000),
));

test("idle timer shows the available hour without a running countdown", () => {
  assert.deepEqual(presentation({}), {
    state: "idle", elapsedSeconds: 0, remainingSeconds: 3600, urgency: "normal",
  });
  assert.equal(presentation({ extra_time_seconds: 120 }).remainingSeconds, 3720);
});

test("timer includes added time and penalties in both readouts", () => {
  assert.deepEqual(presentation({
    timer_started_at: startedAt, extra_time_seconds: 120, penalty_time_seconds: 60,
  }, 600), {
    state: "running", elapsedSeconds: 660, remainingSeconds: 3060, urgency: "normal",
  });
  assert.equal(adminDom.formatClockDuration(3060), "00:51:00");
  assert.equal(adminDom.formatClockDuration(660), "00:11:00");
});

test("paused and finished timers freeze at their stop time", () => {
  for (const [field, state] of [
    ["timer_paused_at", "paused"],
    ["room_completed_at", "completed"],
    ["room_failed_at", "failed"],
  ]) {
    assert.deepEqual(presentation({
      timer_started_at: startedAt, [field]: "2026-10-08T12:10:00Z",
    }, 900), {
      state, elapsedSeconds: 600, remainingSeconds: 3000, urgency: "normal",
    });
  }
});

test("low-time warnings use exact five-minute and one-minute thresholds", () => {
  for (const [remaining, urgency] of [
    [301, "normal"], [300, "warning"], [61, "warning"],
    [60, "critical"], [1, "critical"], [0, "critical"],
  ]) {
    const timer = presentation({ timer_started_at: startedAt }, 3600 - remaining);
    assert.equal(timer.remainingSeconds, remaining);
    assert.equal(timer.urgency, urgency, `remaining: ${remaining}`);
  }
});

test("paused timers do not produce live countdown warnings", () => {
  const timer = presentation({
    timer_started_at: startedAt, timer_paused_at: "2026-10-08T12:59:00Z",
  }, 5000);
  assert.equal(timer.remainingSeconds, 60);
  assert.equal(timer.state, "paused");
  assert.equal(timer.urgency, "normal");
});

test("remaining time is clamped and long runs retain hours", () => {
  assert.equal(presentation({ timer_started_at: startedAt }, 5000).remainingSeconds, 0);
  assert.equal(adminDom.formatClockDuration(5401), "01:30:01");
  assert.equal(presentation({ timer_started_at: startedAt }, -60).elapsedSeconds, 0);
});

test("idle timer uses the saved starting hours, minutes, and seconds", () => {
  const settings = { timer_duration_seconds: 5415, timer_run_duration_seconds: 3600 };
  assert.equal(presentation(settings).remainingSeconds, 5415);
  assert.equal(adminDom.formatClockDuration(presentation(settings).remainingSeconds), "01:30:15");
});

test("running, paused, and finished timers retain their captured duration", () => {
  for (const stop of [{}, { timer_paused_at: "2026-10-08T12:10:00Z" },
    { room_completed_at: "2026-10-08T12:10:00Z" }, { room_failed_at: "2026-10-08T12:10:00Z" }]) {
    const settings = {
      timer_started_at: startedAt, timer_duration_seconds: 600,
      timer_run_duration_seconds: 5415, extra_time_seconds: 120, penalty_time_seconds: 30, ...stop,
    };
    assert.equal(presentation(settings, 600).remainingSeconds, 4905);
    assert.equal(adminDom.getTimerBaseSeconds(settings), 5415);
    assert.equal(presentation({ ...settings, timer_started_at: null }).remainingSeconds, 720);
  }
});

test("short custom timers use the same exact warning thresholds", () => {
  const settings = { timer_started_at: startedAt, timer_run_duration_seconds: 301 };
  assert.equal(presentation(settings).urgency, "normal");
  assert.equal(presentation(settings, 1).urgency, "warning");
  assert.equal(presentation(settings, 241).urgency, "critical");
  assert.equal(presentation(settings, 400).remainingSeconds, 0);
});

function homeTimerFixture(duration, now = startedMilliseconds + 600000) {
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", hidden: true, paused: true,
      dataset: { durationSeconds: String(duration) },
      classList: { add() {}, remove() {}, toggle() {} },
      removeAttribute() {}, pause() {},
    });
    return elements.get(selector);
  };
  const soundManager = {
    canPlaySounds: false, updateFromSettings() {},
    playHint() {}, playSuccess() {}, playFailed() {},
  };
  const context = {
    window: { HomeAudio: { createSoundManager: () => soundManager }, location: { search: "" }, translate: key => key },
    document: {
      querySelector: getElement,
      body: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval() {},
    EventSource: class { addEventListener() {} },
  };
  vm.createContext(context);
  vm.runInContext(readScript("home.js"), context);
  return {
    timer: getElement("#timer"),
    update(settings) {
      context.settings = settings;
      vm.runInContext("updateDisplay(settings)", context);
    },
    tick() { vm.runInContext("updateTimer()", context); },
  };
}

test("room display starts at the saved duration before live updates arrive", () => {
  const home = homeTimerFixture(5415);
  home.tick();
  assert.equal(home.timer.textContent, "90:15");
});

test("room display retains current run duration and picks up the next idle duration", () => {
  const home = homeTimerFixture(5415);
  const settings = {
    timer_duration_seconds: 600, timer_run_duration_seconds: 5415,
    timer_started_at: startedAt, extra_time_seconds: 120, penalty_time_seconds: 30,
  };
  home.update(settings);
  assert.equal(home.timer.textContent, "81:45");
  for (const field of ["timer_paused_at", "room_completed_at", "room_failed_at"]) {
    home.update({ ...settings, [field]: "2026-10-08T12:05:00Z" });
    assert.equal(home.timer.textContent, "86:45");
  }
  home.update({ ...settings, timer_started_at: null, extra_time_seconds: 0, penalty_time_seconds: 0 });
  assert.equal(home.timer.textContent, "10:00");
});

test("room display never exceeds the saved start because of fractional seconds or clock skew", () => {
  const settings = {
    timer_duration_seconds: 2730, timer_run_duration_seconds: 2730,
    timer_started_at: "2026-10-08T12:00:00.125Z",
  };
  const home = homeTimerFixture(2730, startedMilliseconds + 250);
  home.update(settings);
  assert.equal(home.timer.textContent, "45:30");
  home.update({ ...settings, timer_started_at: "2026-10-08T12:00:00.500Z" });
  assert.equal(home.timer.textContent, "45:30");
  const later = homeTimerFixture(2730, startedMilliseconds + 1125);
  later.update(settings);
  assert.equal(later.timer.textContent, "45:29");
});

function themeFixture({ saved = null, systemDark = false, blockedStorage = false } = {}) {
  const storageKey = "escape-room-admin-theme";
  const storage = new Map(saved === null ? [] : [[storageKey, saved]]);
  const documentEvents = new Map();
  const windowEvents = new Map();
  const buttonEvents = new Map();
  const warnings = [];
  const stateLabel = { textContent: "" };
  const root = { dataset: {} };
  let ready = false;
  let mediaListener;
  const button = {
    dataset: { onLabel: "On", offLabel: "Off" },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector() { return stateLabel; },
    addEventListener(name, handler) { buttonEvents.set(name, handler); },
  };
  const media = {
    matches: systemDark,
    addEventListener(_name, handler) { mediaListener = handler; },
  };
  vm.runInNewContext(readScript("admin-theme.js"), {
    document: {
      documentElement: root,
      querySelectorAll() { return ready ? [button] : []; },
      addEventListener(name, handler) { documentEvents.set(name, handler); },
    },
    window: {
      matchMedia() { return media; },
      addEventListener(name, handler) { windowEvents.set(name, handler); },
    },
    localStorage: {
      getItem(key) {
        if (blockedStorage) throw new Error("Storage blocked");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (blockedStorage) throw new Error("Storage blocked");
        storage.set(key, value);
      },
    },
    console: { warn(...args) { warnings.push(args); } },
  });
  return {
    root, button, stateLabel, storage, storageKey, warnings,
    initialize() { ready = true; documentEvents.get("DOMContentLoaded")(); },
    toggle() { buttonEvents.get("click")(); },
    systemChange(dark) { media.matches = dark; mediaListener(); },
    storageChange(value) { windowEvents.get("storage")({ key: storageKey, newValue: value }); },
    clearStorage() { windowEvents.get("storage")({ key: null, newValue: null }); },
    restore() { windowEvents.get("pageshow")({ persisted: true }); },
  };
}

function imagePreviewFixture(savedSource = null, brokenSavedImage = false) {
  const elements = new Map();
  const revoked = [];
  let urlSequence = 0;
  const makeElement = (source = null) => ({
    hidden: !source, checked: false, files: [], style: {},
    complete: brokenSavedImage, naturalWidth: brokenSavedImage ? 0 : 32,
    attributes: new Map(source ? [["src", source]] : []),
    events: new Map(),
    addEventListener(event, callback) { this.events.set(event, callback); },
    emit(event) { this.events.get(event)?.(); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    set src(value) { this.attributes.set("src", value); },
  });
  for (const name of ["background", "accent"]) {
    for (const selector of [`#${name}-picker`, `#${name}-hex`, `#${name}-preview`, `[data-accept-colour="${name}"]`]) {
      elements.set(selector, makeElement());
    }
  }
  const images = {};
  for (const name of ["background", "logo"]) {
    const input = makeElement();
    const preview = makeElement(savedSource);
    const error = makeElement();
    const remove = savedSource ? makeElement() : null;
    elements.set(`[name="${name}_image"]`, input);
    elements.set(`#${name}-image-preview`, preview);
    elements.set(`#${name}-image-preview-error`, error);
    elements.set(`[name="remove_${name}_image"]`, remove);
    images[name] = { input, preview, error, remove };
  }
  vm.runInNewContext(readScript("settings.js"), {
    document: { querySelector: selector => elements.get(selector) },
    URL: {
      createObjectURL() { return `blob:preview-${++urlSequence}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });
  return { images, revoked };
}

test("background and logo previews replace selected files and restore saved images", () => {
  const fixture = imagePreviewFixture("/uploads/saved.png");
  for (const image of Object.values(fixture.images)) {
    image.input.files = [{ name: "first.png" }];
    image.input.emit("change");
    const first = image.preview.getAttribute("src");
    assert(first.startsWith("blob:"));
    assert.equal(image.preview.hidden, false);
    image.input.files = [{ name: "replacement.png" }];
    image.input.emit("change");
    assert(fixture.revoked.includes(first));
    const replacement = image.preview.getAttribute("src");
    image.input.files = [];
    image.input.emit("change");
    assert(fixture.revoked.includes(replacement));
    assert.equal(image.preview.getAttribute("src"), "/uploads/saved.png");
    assert.equal(image.preview.hidden, false);
    image.remove.checked = true;
    image.remove.emit("change");
    assert.equal(image.preview.hidden, true);
    assert.equal(image.preview.getAttribute("src"), null);
    image.remove.checked = false;
    image.remove.emit("change");
    assert.equal(image.preview.getAttribute("src"), "/uploads/saved.png");
    image.remove.checked = true;
    image.input.files = [{ name: "new.png" }];
    image.input.emit("change");
    assert.equal(image.preview.hidden, false);
    assert(image.preview.getAttribute("src").startsWith("blob:"));
  }
});

test("previews without a saved image stay hidden after clearing the file", () => {
  const fixture = imagePreviewFixture();
  for (const image of Object.values(fixture.images)) {
    assert.equal(image.preview.hidden, true);
    image.input.files = [{ name: "new.png" }];
    image.input.emit("change");
    assert.equal(image.preview.hidden, false);
    image.input.files = [];
    image.input.emit("change");
    assert.equal(image.preview.hidden, true);
    assert.equal(image.preview.getAttribute("src"), null);
  }
});

test("unreadable image previews report errors and recover after a new selection", () => {
  const fixture = imagePreviewFixture("/uploads/broken.png", true);
  for (const image of Object.values(fixture.images)) {
    assert.equal(image.preview.hidden, true);
    assert.equal(image.error.hidden, false);
    image.input.files = [{ name: "valid.png" }];
    image.input.emit("change");
    image.preview.emit("load");
    assert.equal(image.preview.hidden, false);
    assert.equal(image.error.hidden, true);
    image.preview.emit("error");
    assert.equal(image.preview.hidden, true);
    assert.equal(image.error.hidden, false);
    image.input.files = [{ name: "retry.png" }];
    image.input.emit("change");
    image.preview.emit("load");
    assert.equal(image.preview.hidden, false);
    assert.equal(image.error.hidden, true);
  }
});

test("theme follows the system before rendering and exposes its pressed state", () => {
  const theme = themeFixture({ systemDark: true });
  assert.equal(theme.root.dataset.adminTheme, "dark");
  theme.initialize();
  assert.equal(theme.button.attributes["aria-pressed"], "true");
  assert.equal(theme.stateLabel.textContent, "On");
});

test("theme toggle persists and overrides the device preference after a reload", () => {
  const theme = themeFixture({ saved: "light", systemDark: true });
  assert.equal(theme.root.dataset.adminTheme, "light");
  theme.initialize();
  theme.toggle();
  assert.equal(theme.root.dataset.adminTheme, "dark");
  assert.equal(theme.storage.get(theme.storageKey), "dark");
  assert.equal(theme.button.attributes["aria-pressed"], "true");
  const reloaded = themeFixture({ saved: theme.storage.get(theme.storageKey) });
  assert.equal(reloaded.root.dataset.adminTheme, "dark");
});

test("restoring a cached page uses the latest saved theme and updates its toggle", () => {
  const theme = themeFixture({ saved: "light" });
  theme.initialize();
  theme.storage.set(theme.storageKey, "dark");
  theme.restore();
  assert.equal(theme.root.dataset.adminTheme, "dark");
  assert.equal(theme.button.attributes["aria-pressed"], "true");
  assert.equal(theme.stateLabel.textContent, "On");
  theme.storage.delete(theme.storageKey);
  theme.restore();
  assert.equal(theme.root.dataset.adminTheme, "light");
});

test("restoring with blocked storage preserves the current in-memory selection", () => {
  const theme = themeFixture({ blockedStorage: true });
  theme.initialize();
  theme.toggle();
  theme.restore();
  assert.equal(theme.root.dataset.adminTheme, "dark");
  assert.equal(theme.button.attributes["aria-pressed"], "true");
});

test("system changes apply only until a theme is explicitly selected", () => {
  const theme = themeFixture();
  theme.initialize();
  theme.systemChange(true);
  assert.equal(theme.root.dataset.adminTheme, "dark");
  theme.toggle();
  theme.systemChange(true);
  assert.equal(theme.root.dataset.adminTheme, "light");
});

test("theme synchronizes with other tabs and resets to the system after clearing storage", () => {
  const theme = themeFixture();
  theme.initialize();
  theme.storageChange("dark");
  assert.equal(theme.root.dataset.adminTheme, "dark");
  theme.storageChange("invalid");
  assert.equal(theme.root.dataset.adminTheme, "dark");
  assert.equal(theme.warnings.length, 1);
  theme.clearStorage();
  assert.equal(theme.root.dataset.adminTheme, "light");
  assert.equal(theme.button.attributes["aria-pressed"], "false");
});

test("unavailable browser storage is reported but the local toggle still works", () => {
  const theme = themeFixture({ blockedStorage: true });
  assert.equal(theme.warnings.length, 1);
  theme.initialize();
  theme.toggle();
  assert.equal(theme.root.dataset.adminTheme, "dark");
  assert.equal(theme.warnings.length, 2);
});
