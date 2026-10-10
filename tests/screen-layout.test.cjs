const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = name => readFileSync(join(__dirname, "..", "static", name), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const defaultLayout = () => {
  const element = (x, y, width, height, font_size) => ({
    x, y, width, height, font_size, align: "center", visible: true,
  });
  return {
    version: 1, hint_layout: "stacked",
    elements: {
      title: element(18, 4, 64, 18, 10),
      message: element(10, 28, 80, 12, 4),
      logo: element(2, 2, 14, 16, 3),
      timer: element(10, 42, 80, 20, 12),
      hints: element(10, 66, 80, 30, 3),
    },
  };
};

test("dashed box guides are scoped to the editor, not the player screen", () => {
  const css = script("screen-layout-editor.css");
  assert.match(css, /\.screen-layout-stage \.layout-block\s*\{[^}]*border: 2px dashed #f8fafc;/);
  assert.match(css, /\.screen-layout-stage \.layout-block\.selected\s*\{[^}]*outline: 2px dashed #f6c453;/);
  assert.doesNotMatch(script("screen-layout.css"), /border:.*dashed|outline:.*dashed/);
});

function element(dataset = {}) {
  const listeners = new Map();
  const classes = new Set();
  const styles = new Map();
  return {
    dataset, listeners, styles, value: "", checked: false, disabled: true, hidden: false,
    textContent: "", writes: 0,
    classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    style: {
      setProperty(name, value) { styles.set(name, value); },
      removeProperty(name) { styles.delete(name); },
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    focus() { this.emit("focus"); },
    emit(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); },
    removeAttribute(name) {
      if (name === "data-layout-hidden") delete dataset.layoutHidden;
      if (name === "data-hint-layout") delete dataset.hintLayout;
    },
    closest(selector) {
      if (selector === "[data-layout-element]" && dataset.layoutElement) return this;
      if (selector === "[data-layout-resize]" && dataset.layoutResize) return this;
      return null;
    },
  };
}

function fixture({ pointer = true, stylesAvailable = true, editor = false } = {}) {
  const blocks = new Map(Object.keys(defaultLayout().elements).map(name => (
    [name, element({ layoutElement: name })]
  )));
  const stage = element();
  let captured;
  stage.querySelectorAll = () => [...blocks.values()];
  stage.querySelector = selector => blocks.get(selector.match(/="([^"]+)"/)?.[1]);
  stage.getBoundingClientRect = () => ({ width: 1000, height: 562.5 });
  stage.setPointerCapture = id => { captured = id; };
  stage.hasPointerCapture = id => captured === id;
  stage.releasePointerCapture = () => { captured = undefined; };
  const caption = element();
  const media = element();
  blocks.get("hints").querySelector = selector => selector === "#announcement-message" ? caption : media;
  const fields = ["x", "y", "width", "height", "font_size", "align", "visible"]
    .map(name => element({ layoutProperty: name }));
  const elements = new Map([
    ["#screen-layout-stage", stage],
    ...["layout-status", "layout-save", "layout-cancel", "layout-reset-draft", "layout-element",
      "layout-hint-mode", "layout-preview-hint", "layout-snap", "layout-resize-handle",
      "layout-current-state"].map(name => [`#${name}`, element()]),
  ]);
  elements.get("#layout-snap").checked = true;
  elements.get("#layout-resize-handle").dataset.layoutResize = true;
  const frames = new Map();
  const timeouts = new Map();
  const windowEvents = new Map();
  const warnings = [];
  const requests = [];
  let sequence = 0;
  const translations = Object.fromEntries([
    "unavailable", "invalid", "unsaved", "pointer_fallback", "discarded", "saved",
    "saved_disabled", "save_failed", "current_custom", "current_default",
  ].map(key => [`layout.${key}`, key]));
  const context = {
    window: {
      PointerEvent: pointer ? class {} : undefined, csrfToken: "test-csrf",
      screenLayoutEditor: { defaultLayout: defaultLayout(), layout: null, translations },
      addEventListener(name, handler) { windowEvents.set(name, handler); },
    },
    document: {
      querySelector: selector => elements.get(selector),
      querySelectorAll: () => fields,
    },
    getComputedStyle: () => ({ getPropertyValue: () => stylesAvailable ? "1" : "" }),
    requestAnimationFrame(handler) { const id = ++sequence; frames.set(id, handler); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(handler) { const id = ++sequence; timeouts.set(id, handler); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    AbortController,
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ screen_layout: JSON.parse(options.body).layout }) };
    },
    console: { warn(...args) { warnings.push(args); } },
  };
  vm.createContext(context);
  vm.runInContext(script("screen-layout.js"), context);
  if (editor) vm.runInContext(script("screen-layout-editor.js"), context);
  return {
    context, stage, blocks, fields, elements, frames, timeouts, warnings, requests,
    caption, media, windowEvents,
    engine: context.window.ScreenLayout,
    apply(layout, enabled = true, options) {
      return context.window.ScreenLayout.apply(stage, { screen_layout: layout, screen_layout_enabled: enabled }, options);
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(handler => handler());
    },
    field(name) { return fields.find(field => field.dataset.layoutProperty === name); },
    control(name) { return elements.get(`#layout-${name}`); },
    move(name, dx, dy, resize = false) {
      if (resize) elements.get("#layout-element").value = name;
      if (resize) elements.get("#layout-element").emit("change");
      stage.emit("pointerdown", {
        button: 0, pointerId: 1, clientX: 0, clientY: 0,
        target: resize ? elements.get("#layout-resize-handle") : blocks.get(name),
      });
      stage.emit("pointermove", { pointerId: 1, clientX: dx, clientY: dy });
    },
  };
}

test("valid layouts apply bounded percentages, visibility, and hint arrangement", () => {
  const f = fixture();
  const layout = defaultLayout();
  layout.elements.logo.visible = false;
  layout.hint_layout = "side-by-side";
  assert.equal(f.apply(layout).active, true);
  assert.equal(f.stage.classList.contains("custom-layout"), true);
  assert.equal(f.blocks.get("title").styles.get("--layout-x"), "18%");
  assert.equal(f.blocks.get("logo").dataset.layoutHidden, "true");
  assert.equal(f.stage.dataset.hintLayout, "side-by-side");
  assert.equal(f.apply(layout, false).active, false);
  assert.equal(f.stage.classList.contains("custom-layout"), false);
  assert.equal(f.blocks.get("logo").dataset.layoutHidden, undefined);
  assert.equal(f.blocks.get("title").styles.size, 0);
});

test("unsupported layouts and missing CSS fall back visibly in logs without stale positioning", () => {
  const f = fixture();
  f.apply(defaultLayout());
  for (const mutate of [
    layout => { layout.version = 2; },
    layout => { layout.elements.title.x = 99; },
    layout => { layout.elements.timer.font_size = Infinity; },
    layout => { layout.elements.logo.visible = "false"; },
    layout => { delete layout.elements.hints; },
  ]) {
    const layout = defaultLayout();
    mutate(layout);
    assert.equal(f.apply(layout).active, false);
    assert.equal(f.stage.classList.contains("custom-layout"), false);
    assert.equal(f.blocks.get("title").styles.size, 0);
  }
  const unsupported = fixture({ stylesAvailable: false, editor: true });
  assert.equal(unsupported.control("save").disabled, true);
  assert.equal(unsupported.control("status").dataset.level, "error");
  assert.equal(unsupported.stage.classList.contains("custom-layout"), false);
});

test("query or server fallback overrides retain the original screen", () => {
  const f = fixture();
  assert.equal(f.apply(defaultLayout(), true, { forceDefault: true }).active, false);
  f.stage.dataset.layoutDisabled = "true";
  assert.equal(f.apply(defaultLayout()).active, false);
  assert.equal(f.warnings.length, 0);
});

test("unchanged layouts do not repeat DOM styling or warnings", () => {
  const f = fixture();
  const layout = defaultLayout();
  f.apply(layout);
  const title = f.blocks.get("title");
  title.style.setProperty = () => { throw new Error("Unexpected repeated style write"); };
  assert.equal(f.apply(copy(layout)).active, true);
  const invalid = { version: 2 };
  assert.equal(f.apply(invalid).active, false);
  const warnings = f.warnings.length;
  f.apply(invalid);
  assert.equal(f.warnings.length, warnings);
});

test("dragging and resizing are bounded, snapped, and local until saved", () => {
  const f = fixture({ editor: true });
  f.move("title", 100, 56.25);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.field("x").value, "28");
  assert.equal(f.field("y").value, "14");
  assert.equal(f.requests.length, 0);
  f.stage.emit("pointerup", { pointerId: 1 });
  f.move("title", 10000, 10000);
  f.stage.emit("pointerup", { pointerId: 1 });
  assert.equal(f.field("x").value, "36");
  assert.equal(f.field("y").value, "82");
  f.move("title", -10000, -10000, true);
  f.stage.emit("pointerup", { pointerId: 1 });
  assert.equal(f.field("width").value, "5");
  assert.equal(f.field("height").value, "5");
  assert.equal(f.frames.size, 0);
  assert.equal(f.requests.length, 0);
});

test("pointer cancellation restores the original block", () => {
  const f = fixture({ editor: true });
  f.move("title", 100, 100);
  f.flush();
  f.stage.emit("pointercancel");
  assert.equal(f.field("x").value, "18");
  assert.equal(f.field("y").value, "4");
  assert.equal(f.frames.size, 0);
});

test("numeric fields and keyboard work without pointer-event support", () => {
  const f = fixture({ pointer: false, editor: true });
  assert.equal(f.control("status").textContent, "pointer_fallback");
  f.stage.emit("keydown", { key: "ArrowRight", target: f.blocks.get("title") });
  assert.equal(f.field("x").value, "20");
  f.stage.emit("keydown", { key: "ArrowDown", target: f.control("resize-handle") });
  assert.equal(f.field("height").value, "20");
  f.field("x").value = "24";
  f.field("x").emit("change");
  assert.equal(f.blocks.get("title").styles.get("--layout-x"), "24%");
  f.field("x").value = "99";
  f.field("x").emit("change");
  assert.equal(f.field("x").value, "24");
  assert.equal(f.control("status").dataset.level, "error");
  f.field("x").value = "";
  f.field("x").emit("change");
  assert.equal(f.field("x").value, "24");
});

test("save sends validated layout once with CSRF and cancel restores the saved baseline", async () => {
  const f = fixture({ editor: true });
  f.field("x").value = "24";
  f.field("x").emit("change");
  await f.control("save").emit("click");
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, "/admin/screen-layout");
  assert.equal(request.options.headers["X-CSRF-Token"], "test-csrf");
  assert.equal(JSON.parse(request.options.body).enabled, true);
  assert.equal(JSON.parse(request.options.body).layout.elements.title.x, 24);
  assert.equal(f.control("status").textContent, "saved");
  assert.equal(f.timeouts.size, 0);
  f.field("x").value = "26";
  f.field("x").emit("change");
  f.control("cancel").emit("click");
  assert.equal(f.field("x").value, "24");
  f.control("reset-draft").emit("click");
  assert.equal(f.field("x").value, "18");
});

test("save failures keep edits and are reported instead of claiming success", async () => {
  const f = fixture({ editor: true });
  f.field("x").value = "24";
  f.field("x").emit("change");
  f.context.fetch = async () => ({ ok: false, json: async () => ({ error: "Denied" }) });
  await f.control("save").emit("click");
  assert.equal(f.field("x").value, "24");
  assert.equal(f.control("status").textContent, "save_failed Denied");
  assert.equal(f.control("save").disabled, false);
  assert.equal(f.timeouts.size, 0);
});

test("hint previews change placeholders without loading media", () => {
  const f = fixture({ editor: true });
  f.control("preview-hint").value = "text";
  f.control("preview-hint").emit("change");
  assert.equal(f.media.hidden, true);
  assert.equal(f.caption.hidden, false);
  f.control("preview-hint").value = "media";
  f.control("preview-hint").emit("change");
  assert.equal(f.media.hidden, false);
  assert.equal(f.caption.hidden, true);
  assert.equal(f.requests.length, 0);
});
