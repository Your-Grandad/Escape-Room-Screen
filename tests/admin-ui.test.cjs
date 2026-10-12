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

test("GPIO action feedback uses the actual toggle state and timed duration", async () => {
  let click;
  let payload;
  const messages = [];
  const requests = [];
  const button = {
    dataset: { gpioAction: "7" },
    addEventListener(name, handler) { if (name === "click") click = handler; },
  };
  const status = { textContent: "", dataset: {}, classList: { toggle() {} } };
  const context = {
    window: {
      csrfToken: "test-csrf",
      translate(key, values) {
        if (values) messages.push({ key, ...values });
        return key;
      },
    },
    document: {
      querySelector: selector => selector === "#status" ? status : null,
      querySelectorAll: selector => selector === "[data-gpio-action]" ? [button] : [],
    },
    setInterval() {},
    async fetch(path, options) {
      requests.push({ path, options });
      return { ok: true, json: async () => payload };
    },
  };
  vm.runInNewContext(readScript("admin-dom.js"), context);
  vm.runInNewContext(readScript("admin.js"), context);
  payload = { label: "Light", pin: 18, signal: "toggle", state: "on" };
  await click();
  assert.equal(messages.at(-1).key, "js.gpio_action_triggered");
  assert.equal(messages.at(-1).state, "js.output_on");
  payload = { ...payload, state: "off" };
  await click();
  assert.equal(messages.at(-1).state, "js.output_off");
  payload = { label: "Light", pin: 18, signal: "timed", state: "on", duration_seconds: 10 };
  await click();
  assert.equal(messages.at(-1).key, "js.gpio_action_timed");
  assert.equal(messages.at(-1).seconds, 10);
  assert.equal(messages.at(-1).output, "BCM 18");
  assert.equal(requests[0].path, "/admin/gpio/actions/7/trigger");
  assert.equal(requests[0].options.headers["X-CSRF-Token"], "test-csrf");
});

test("GPIO duration input is enabled and required only for timed signals", () => {
  const template = readFileSync(join(__dirname, "..", "templates", "gpio.html"), "utf8");
  const script = template.match(/<script>\s*(const outputSignal[\s\S]*?)<\/script>/)[1];
  const elements = {
    "output-signal": { value: "on", addEventListener(name, handler) { this[name] = handler; } },
    "output-duration-label": {},
    "output-duration": {},
  };
  vm.runInNewContext(script, { document: { getElementById: id => elements[id] } });
  for (const state of ["on", "off", "toggle", "timed", "on"]) {
    elements["output-signal"].value = state;
    elements["output-signal"].change();
    assert.equal(elements["output-duration-label"].hidden, state !== "timed");
    assert.equal(elements["output-duration"].disabled, state !== "timed");
    assert.equal(elements["output-duration"].required, state === "timed");
  }
});

test("room interaction follows live timer state without clearing manual pause", () => {
  const labels = new Map();
  const button = {
    dataset: { paused: "false" }, disabled: false,
    classList: { toggle() {} }, addEventListener() {},
    querySelector(selector) {
      if (!labels.has(selector)) labels.set(selector, { textContent: "" });
      return labels.get(selector);
    },
  };
  const context = {
    window: { translate: key => key },
    document: {
      querySelector: selector => selector === "#toggle-gpio-pause" ? button : null,
      querySelectorAll: () => [],
    },
    Date: class extends Date {
      static now() { return startedMilliseconds + 600000; }
    },
    setInterval() {},
  };
  vm.runInNewContext(readScript("admin-dom.js"), context);
  vm.runInNewContext(readScript("admin.js"), context);
  const update = (settings, state, disabled) => {
    context.nextSettings = settings;
    vm.runInNewContext("updateActiveTimerSnapshot(nextSettings); updateActiveTimerDisplay();", context);
    assert.equal(button.dataset.controlState, state);
    assert.equal(button.disabled, disabled);
    assert.equal(labels.get(".control-state-label").textContent, `js.state_${state}`);
  };
  update({}, "idle", true);
  const running = { timer_started_at: startedAt };
  update(running, "active", false);
  update({ ...running, timer_paused_at: startedAt }, "paused", true);
  update(running, "active", false);
  button.dataset.paused = "true";
  update(running, "paused", false);
  update({ ...running, timer_paused_at: startedAt }, "paused", true);
  update(running, "paused", false);
  assert.equal(button.dataset.paused, "true");
  button.dataset.paused = "false";
  for (const stop of ["room_completed_at", "room_failed_at"]) {
    update({ ...running, [stop]: startedAt }, "finished", true);
  }
  update({ ...running, timer_run_duration_seconds: 600 }, "finished", true);
  update(running, "active", false);
  update({}, "idle", true);
});

function adminTimerActionFixture(initial = {}, latest = initial, confirmed = true) {
  const requests = [];
  const confirmations = [];
  const status = { textContent: "", dataset: {} };
  const buttons = ["start", "reset"].map(action => ({
    dataset: { timerAction: action }, disabled: false,
    addEventListener(name, handler) { this[name] = handler; },
  }));
  const context = {
    window: {
      initialDisplaySettings: initial, translate: key => key,
      confirm(message) { confirmations.push(message); return confirmed; },
    },
    document: {
      querySelector: selector => selector === "#status" ? status : null,
      querySelectorAll: selector => selector === "[data-timer-action]" ? buttons : [],
    },
    async fetch(path, options) {
      requests.push({ path, options });
      return {
        ok: true,
        async json() {
          return path === "/admin/timer/reset" ? {} : latest;
        },
      };
    },
    setInterval() {},
  };
  vm.runInNewContext(readScript("admin-dom.js"), context);
  vm.runInNewContext(readScript("admin.js"), context);
  return {
    context, buttons, requests, confirmations, status,
    click: action => buttons.find(button => button.dataset.timerAction === action).click({
      preventDefault() {},
    }),
    update(settings) {
      context.nextSettings = settings;
      vm.runInNewContext("applyActiveTimerSettings(nextSettings);", context);
    },
  };
}

test("start stays disabled after a session starts and re-enables only after reset", async () => {
  const fixture = adminTimerActionFixture();
  assert.equal(fixture.buttons[0].disabled, false);
  for (const settings of [
    { timer_started_at: startedAt },
    { timer_started_at: startedAt, timer_paused_at: startedAt },
    { timer_started_at: startedAt, room_completed_at: startedAt },
    { timer_started_at: startedAt, room_failed_at: startedAt },
  ]) {
    fixture.update(settings);
    assert.equal(fixture.buttons[0].disabled, true);
    await fixture.click("start");
    assert.equal(fixture.requests.length, 0);
  }
  fixture.update({});
  assert.equal(fixture.buttons[0].disabled, false);
});

test("reset checks current server state and cancellation never sends a reset", async () => {
  for (const latest of [
    { timer_started_at: startedAt },
    { timer_started_at: startedAt, timer_paused_at: startedAt },
  ]) {
    const fixture = adminTimerActionFixture({}, latest, false);
    await fixture.click("reset");
    assert.deepEqual(fixture.requests.map(request => request.path), ["/api/display"]);
    assert.deepEqual(fixture.confirmations, ["js.confirm_timer_reset"]);
    assert.equal(fixture.buttons[0].disabled, true);
    assert.equal(fixture.buttons[1].disabled, false);
  }
});

test("confirming reset sends one request and allows the next start", async () => {
  const fixture = adminTimerActionFixture({ timer_started_at: startedAt });
  await fixture.click("reset");
  assert.deepEqual(fixture.requests.map(request => request.path), [
    "/api/display", "/admin/timer/reset",
  ]);
  assert.deepEqual(fixture.confirmations, ["js.confirm_timer_reset"]);
  assert.equal(fixture.buttons[0].disabled, false);
  assert.equal(fixture.buttons[1].disabled, false);
});

test("idle and finished timers reset without warning about an active run", async () => {
  for (const latest of [
    {},
    { timer_started_at: startedAt, room_completed_at: startedAt },
    { timer_started_at: startedAt, room_failed_at: startedAt },
  ]) {
    const fixture = adminTimerActionFixture({ timer_started_at: startedAt }, latest);
    await fixture.click("reset");
    assert.equal(fixture.confirmations.length, 0);
    assert.deepEqual(fixture.requests.map(request => request.path), [
      "/api/display", "/admin/timer/reset",
    ]);
  }
});

test("failure to check timer state blocks reset and reports an error", async () => {
  const fixture = adminTimerActionFixture({ timer_started_at: startedAt });
  fixture.context.fetch = async () => ({ ok: false });
  await fixture.click("reset");
  assert.equal(fixture.confirmations.length, 0);
  assert.equal(fixture.status.textContent, "js.failed_to_fetch_timer");
  assert.equal(fixture.status.dataset.level, "error");
  assert.equal(fixture.buttons[0].disabled, true);
  assert.equal(fixture.buttons[1].disabled, false);
});

test("pending timer actions cannot be double-submitted", async () => {
  const fixture = adminTimerActionFixture({}, { timer_started_at: startedAt });
  let resolve;
  fixture.context.fetch = () => new Promise(done => { resolve = done; });
  const first = fixture.click("start");
  assert.equal(fixture.buttons[0].disabled, true);
  assert.equal(fixture.buttons[1].disabled, true);
  await fixture.click("start");
  await fixture.click("reset");
  resolve({ ok: true, json: async () => ({ timer_started_at: startedAt }) });
  await first;
  assert.equal(fixture.buttons[0].disabled, true);
  assert.equal(fixture.buttons[1].disabled, false);
});

test("leaderboard delete confirmation works on cloned rows after paging and filtering", () => {
  const makeRow = id => {
    const cell = { textContent: "" };
    const form = {
      action: `/admin/results/${id}/delete`,
      dataset: { confirmDelete: `Delete Team ${id}?` },
      closest: () => form,
    };
    return {
      dataset: { outcome: "completed", timeRemaining: String(1000 - id) },
      form,
      querySelector: selector => selector === ".team-name" ? { textContent: `Team ${id}` } : cell,
      cloneNode: () => makeRow(id),
    };
  };
  const rows = Array.from({ length: 12 }, (_, index) => makeRow(index + 1));
  const listeners = new Map();
  const element = value => ({
    value, hidden: false, disabled: false, textContent: "",
    addEventListener(name, handler) { this[name] = handler; },
  });
  const tbody = {
    children: [], querySelectorAll: () => rows,
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { listeners.set(name, handler); },
  };
  const elements = new Map([
    ["leaderboard-table", { querySelector: () => tbody }],
    ["leaderboard-filter", element("")],
    ["leaderboard-sort", element("time_remaining_desc")],
    ["leaderboard-page-size", element("10")],
    ["leaderboard-pagination", element()],
    ["leaderboard-previous", element()],
    ["leaderboard-next", element()],
    ["leaderboard-page-status", element()],
    ["leaderboard-empty-row", { content: { firstElementChild: { cloneNode: () => ({}) } } }],
  ]);
  const confirmations = [];
  let confirmed = false;
  const template = readFileSync(join(__dirname, "..", "templates", "stats.html"), "utf8");
  const script = template.match(/<script>\s*(\(function\(\)\{[\s\S]*?)<\/script>/)[1]
    .replace(/\{\{ t\("stats.page_status"[^\n]*\}\}/, JSON.stringify("Page {page} of {pages} ({total} results)"));
  vm.runInNewContext(script, {
    document: { getElementById: id => elements.get(id) },
    window: { confirm(message) { confirmations.push(message); return confirmed; } },
  });
  assert.equal(tbody.children.length, 10);
  elements.get("leaderboard-next").click();
  assert.equal(tbody.children.length, 2);
  const submit = form => {
    let prevented = false;
    listeners.get("submit")({ target: form, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(tbody.children[0].form.action, "/admin/results/11/delete");
  assert.equal(submit(tbody.children[0].form), true);
  assert.equal(confirmations.at(-1), "Delete Team 11?");
  confirmed = true;
  assert.equal(submit(tbody.children[0].form), false);
  elements.get("leaderboard-filter").value = "Team 12";
  elements.get("leaderboard-filter").input();
  assert.equal(tbody.children.length, 1);
  assert.equal(tbody.children[0].form.action, "/admin/results/12/delete");
  assert.equal(submit(tbody.children[0].form), false);
  assert.equal(confirmations.at(-1), "Delete Team 12?");
});

function homeTimerFixture(duration, now = startedMilliseconds + 600000) {
  const intervals = new Map();
  const timeouts = new Map();
  const streamEvents = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const requests = [];
  const warnings = [];
  let timeoutSequence = 0;
  let updates = 0;
  let clock = now;
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
    canPlaySounds: false, updateFromSettings() { updates++; },
    playHint() {}, playSuccess() {}, playFailed() {},
  };
  const context = {
    window: {
      HomeAudio: { createSoundManager: () => soundManager }, location: { search: "" },
      translate: key => key,
      addEventListener(name, handler) { windowEvents.set(name, handler); },
    },
    document: {
      querySelector: getElement,
      addEventListener(name, handler) { documentEvents.set(name, handler); },
      body: { dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    },
    URLSearchParams,
    setInterval(handler, delay) { intervals.set(delay, handler); },
    setTimeout(handler, delay) {
      const id = ++timeoutSequence;
      timeouts.set(id, { handler, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    AbortController,
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
        options.signal.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    },
    EventSource: class { addEventListener(name, handler) { streamEvents.set(name, handler); } },
    console: { warn(...args) { warnings.push(args); } },
  };
  vm.createContext(context);
  vm.runInContext(readScript("home.js"), context);
  return {
    timer: getElement("#timer"),
    announcement: getElement("#announcement"),
    announcementMessage: getElement("#announcement-message"),
    requests, warnings, intervals, timeouts,
    get rotation() { return context.document.body.dataset.screenRotation; },
    get updates() { return updates; },
    update(settings) {
      context.settings = settings;
      vm.runInContext("updateDisplay(settings)", context);
    },
    tick() { vm.runInContext("updateTimer()", context); },
    advance(milliseconds) { clock += milliseconds; },
    poll() { return intervals.get(5000)(); },
    event(settings) { streamEvents.get("display")({ data: JSON.stringify(settings) }); },
    streamError() { streamEvents.get("error")(); },
    online() { windowEvents.get("online")(); },
    async respond(settings, status = 200) {
      requests.at(-1).resolve({ ok: status === 200, status, json: async () => settings });
      await new Promise(setImmediate);
    },
  };
}

test("room display starts at the saved duration before live updates arrive", () => {
  const home = homeTimerFixture(5415);
  home.tick();
  assert.equal(home.timer.textContent, "90:15");
});

test("player rotation follows live snapshots and rejects unsupported orientations", () => {
  const home = homeTimerFixture(3600);
  for (const rotation of [0, 90, 180, 270, 0]) {
    home.update({ ...runningDisplay, screen_rotation: rotation });
    assert.equal(home.rotation, String(rotation));
  }
  home.update(runningDisplay);
  assert.equal(home.rotation, "0");
  home.update({ ...runningDisplay, screen_rotation: 45 });
  assert.equal(home.rotation, "0");
  assert(home.warnings.some(args => args[0].includes("Invalid screen rotation")));
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

const runningDisplay = {
  title: "Room", message: "Ready", timer_duration_seconds: 3600,
  timer_run_duration_seconds: 3600, timer_started_at: startedAt,
};

test("kiosk HTTP fallback applies pause and hints without any live events", async () => {
  const home = homeTimerFixture(3600);
  assert.equal(home.requests.length, 1);
  assert.equal(home.requests[0].url, "/api/display");
  assert.equal(home.requests[0].options.cache, "no-store");
  await home.respond(runningDisplay);
  assert.equal(home.timer.textContent, "50:00");
  home.poll();
  await home.respond({
    ...runningDisplay, timer_paused_at: "2026-10-08T12:05:00Z",
    announcement: "Look under the clock", announcement_expires_at: "2026-10-08T12:12:00Z",
  });
  assert.equal(home.timer.textContent, "55:00");
  assert.equal(home.announcementMessage.textContent, "Look under the clock");
  assert.equal(home.announcement.hidden, false);
  home.advance(30000);
  home.tick();
  assert.equal(home.timer.textContent, "55:00");
});

test("a newer live update cannot be overwritten by an older pending HTTP response", async () => {
  const home = homeTimerFixture(3600);
  const paused = { ...runningDisplay, timer_paused_at: "2026-10-08T12:05:00Z" };
  home.event(paused);
  await home.respond(runningDisplay);
  assert.equal(home.timer.textContent, "55:00");
  assert.equal(home.updates, 1);
});

test("identical live and HTTP snapshots do not repaint or reload media", async () => {
  const home = homeTimerFixture(3600);
  const latestResult = { group_name: "Team", group_size: 4 };
  home.event({ ...runningDisplay, latest_result: latestResult });
  await home.respond({ latest_result: { group_size: 4, group_name: "Team" }, ...runningDisplay });
  home.poll();
  await home.respond({ latest_result: { group_size: 4, group_name: "Team" }, ...runningDisplay });
  assert.equal(home.updates, 1);
});

test("HTTP refreshes are bounded, do not overlap, and recover after timeout", async () => {
  const home = homeTimerFixture(3600);
  home.poll();
  home.poll();
  home.streamError();
  assert.equal(home.requests.length, 1);
  const timeout = [...home.timeouts.values()][0];
  assert.equal(timeout.delay, 8000);
  timeout.handler();
  await new Promise(setImmediate);
  assert(home.warnings.some(warning => warning[0] === "Unable to refresh kiosk display state."));
  home.poll();
  assert.equal(home.requests.length, 2);
  await home.respond(runningDisplay);
  assert.equal(home.timer.textContent, "50:00");
});

test("stream disconnect and reconnecting network immediately trigger HTTP refreshes", async () => {
  const home = homeTimerFixture(3600);
  await home.respond(runningDisplay);
  home.streamError();
  assert.equal(home.requests.length, 2);
  await home.respond({ ...runningDisplay, timer_paused_at: "2026-10-08T12:05:00Z" });
  home.online();
  assert.equal(home.requests.length, 3);
  await home.respond(runningDisplay);
  assert.equal(home.timer.textContent, "50:00");
});

test("failed HTTP responses are reported and preserve the last valid state", async () => {
  const home = homeTimerFixture(3600);
  home.event(runningDisplay);
  await home.respond({}, 503);
  assert.equal(home.timer.textContent, "50:00");
  assert(home.warnings.some(warning => warning[0] === "Unable to refresh kiosk display state."));
  home.poll();
  await home.respond({ ...runningDisplay, timer_paused_at: "2026-10-08T12:05:00Z" });
  assert.equal(home.timer.textContent, "55:00");
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
