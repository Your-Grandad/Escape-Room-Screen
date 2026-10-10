const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = readFileSync(join(__dirname, "../static/home-media.js"), "utf8");
const filename = (extension = "mp4") => "a".repeat(32) + "." + extension;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function harness(search = "", overrides = {}) {
  const operations = [];
  const nodes = {};
  function node(id) {
    const listeners = {};
    return nodes[id] = {
      hidden: true, paused: true, ended: false, attributes: {},
      textContent: "", muted: false, volume: 1, error: null,
      get src() { return this.attributes.src; },
      set src(value) { this.attributes.src = value; operations.push([id, "src"]); },
      getAttribute(name) { return this.attributes[name]; },
      removeAttribute(name) { delete this.attributes[name]; operations.push([id, "remove"]); },
      addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
      dispatch(name) { for (const callback of listeners[name] || []) callback(); },
      play() {
        operations.push([id, "play"]);
        if (this.error) return Promise.reject(this.error);
        this.paused = false;
        this.ended = false;
        return Promise.resolve();
      },
      pause() { this.paused = true; operations.push([id, "pause"]); },
      load() { operations.push([id, "load"]); },
    };
  }
  [
    "#background-video", "#briefing-video", "#briefing-panel", "#background-soundtrack",
    "#announcement-video", "#announcement-audio", "#media-status", "#media-status-text", "#media-retry",
  ].forEach(node);
  const style = {};
  const fonts = new Set();
  const requests = [];
  const logs = [];
  let clock = Date.parse("2026-01-01T12:00:10Z");
  const document = {
    body: {
      dataset: { mediaDisabled: overrides.disabled ? "true" : "false" },
      style: {
        setProperty(key, value) { style[key] = value; },
        removeProperty(key) { delete style[key]; },
      },
    },
    querySelector(selector) { return nodes[selector]; }, fonts,
  };
  const context = {
    window: { translate: key => key, FontFace: !overrides.noFont },
    document, URLSearchParams, AbortController, setTimeout, clearTimeout,
    Date: { now: () => clock, parse: Date.parse },
    console: { warn: (...args) => logs.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (overrides.fetchError) throw new Error("offline");
      return { ok: true, status: 200 };
    },
    FontFace: class {
      load() {
        return overrides.fontError ? Promise.reject(new Error("bad font")) : Promise.resolve(this);
      }
    },
  };
  vm.runInNewContext(script, context);
  const manager = context.window.HomeMedia.createManager(search);
  const settings = {
    timer_started_at: "2026-01-01T12:00:00Z", timer_run_duration_seconds: 3600,
    media_settings: {
      background_video: filename(), background_video_enabled: true,
      soundtrack: filename("mp3"), soundtrack_enabled: true, soundtrack_volume: 25,
      font_filename: null, text_colour: "#123456", hint_colour: "#abcdef",
    },
  };
  return {
    nodes, operations, logs, style, fonts, requests, manager, settings,
    setClock(value) { clock = value; },
  };
}

test("optional background and soundtrack play once without snapshot churn", async () => {
  const h = harness();
  h.manager.update(h.settings);
  await flush();
  const background = h.nodes["#background-video"];
  const music = h.nodes["#background-soundtrack"];
  assert.equal(background.hidden, false);
  assert.equal(music.paused, false);
  assert.equal(music.volume, .25);
  assert.equal(h.style["--screen-text-colour"], "#123456");
  const loads = h.operations.filter(operation => operation[1] === "load").length;
  h.manager.update(h.settings);
  h.manager.tick();
  await flush();
  assert.equal(h.operations.filter(operation => operation[1] === "load").length, loads);
});

test("background decoder is released before briefing and music pauses", async () => {
  const h = harness();
  h.manager.update(h.settings);
  await flush();
  h.operations.length = 0;
  h.manager.update({ ...h.settings, timer_started_at: null, briefing_token: "t", briefing_filename: filename() });
  await flush();
  const released = h.operations.findIndex(([id, action]) => id === "#background-video" && action === "remove");
  const loaded = h.operations.findIndex(([id, action]) => id === "#briefing-video" && action === "src");
  assert(released >= 0 && released < loaded);
  assert.equal(h.nodes["#background-video"].hidden, true);
  assert.equal(h.nodes["#background-soundtrack"].paused, true);
  assert.equal(h.nodes["#briefing-panel"].hidden, false);
  h.manager.update(h.settings);
  await flush();
  assert.equal(h.nodes["#briefing-video"].src, undefined);
  assert.equal(h.nodes["#background-video"].hidden, false);
});

test("video hints suspend background and music; ending resumes both", async () => {
  const h = harness();
  h.manager.update({
    ...h.settings, announcement_media_type: "video", announcement_media_filename: filename(),
    announcement_expires_at: "2026-01-01T12:02:00Z",
  });
  await flush();
  assert.equal(h.nodes["#background-video"].src, undefined);
  assert.equal(h.nodes["#background-soundtrack"].paused, true);
  h.nodes["#announcement-video"].dispatch("ended");
  await flush();
  assert.equal(h.nodes["#background-video"].hidden, false);
  assert.equal(h.nodes["#background-soundtrack"].paused, false);
  // Manual replay must suspend the background again.
  h.nodes["#announcement-video"].dispatch("play");
  assert.equal(h.nodes["#background-video"].src, undefined);
  assert.equal(h.nodes["#background-soundtrack"].paused, true);
});

test("audio hints pause only music until ending or expiration", async () => {
  const h = harness();
  const state = {
    ...h.settings, announcement_media_type: "audio", announcement_media_filename: filename("mp3"),
    announcement_expires_at: "2026-01-01T12:00:20Z",
  };
  h.manager.update(state);
  await flush();
  assert.equal(h.nodes["#background-video"].hidden, false);
  assert.equal(h.nodes["#background-soundtrack"].paused, true);
  h.setClock(Date.parse("2026-01-01T12:00:21Z"));
  h.manager.tick();
  await flush();
  assert.equal(h.nodes["#background-soundtrack"].paused, false);
});

test("idle paused complete failed and expired timers cannot play soundtrack", async () => {
  for (const changes of [
    { timer_started_at: null }, { timer_paused_at: "2026-01-01T12:00:05Z" },
    { room_completed_at: "2026-01-01T12:00:05Z" }, { room_failed_at: "2026-01-01T12:00:05Z" },
    { timer_run_duration_seconds: 10 },
  ]) {
    const h = harness();
    h.manager.update({ ...h.settings, ...changes });
    await flush();
    assert.equal(h.nodes["#background-soundtrack"].paused, true);
  }
});

test("autoplay failures use visible fallback and bounded retry, not repeated play", async () => {
  const h = harness();
  h.nodes["#background-video"].error = new Error("decoder unavailable");
  h.nodes["#background-soundtrack"].error = new Error("autoplay blocked");
  h.manager.update(h.settings);
  await flush();
  assert.equal(h.nodes["#background-video"].hidden, true);
  assert.equal(h.nodes["#background-video"].src, undefined);
  assert.equal(h.nodes["#media-status"].hidden, false);
  const plays = h.operations.filter(operation => operation[1] === "play").length;
  h.manager.tick();
  await flush();
  assert.equal(h.operations.filter(operation => operation[1] === "play").length, plays);
  h.nodes["#background-video"].error = null;
  h.nodes["#background-soundtrack"].error = null;
  h.nodes["#media-retry"].dispatch("click");
  await flush();
  assert.equal(h.nodes["#background-video"].hidden, false);
  assert.equal(h.nodes["#background-soundtrack"].paused, false);
});

test("briefing ended sends one scoped completion and errors never start timer", async () => {
  const h = harness();
  h.nodes["#briefing-video"].error = new Error("unsupported");
  h.manager.update({ ...h.settings, briefing_token: "one-use-token", briefing_filename: filename() });
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.nodes["#media-status"].hidden, false);
  h.nodes["#briefing-video"].ended = true;
  h.nodes["#briefing-video"].dispatch("ended");
  h.nodes["#briefing-video"].dispatch("ended");
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/briefing/finished");
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { token: "one-use-token" });
  assert.equal(h.nodes["#briefing-panel"].hidden, true);
});

test("failed briefing completion remains pending and can be retried", async () => {
  const h = harness("", { fetchError: true });
  h.manager.update({ ...h.settings, briefing_token: "token", briefing_filename: filename() });
  await flush();
  h.nodes["#briefing-video"].ended = true;
  h.nodes["#briefing-video"].dispatch("ended");
  await flush();
  assert.equal(h.nodes["#briefing-panel"].hidden, false);
  assert.equal(h.nodes["#media-status-text"].textContent, "media.finish_failed");
  h.nodes["#media-retry"].dispatch("click");
  await flush();
  assert.equal(h.requests.length, 2);
});

test("stale snapshots cannot replay a consumed briefing or send completion twice", async () => {
  const h = harness();
  const pending = { ...h.settings, briefing_token: "token", briefing_filename: filename() };
  h.manager.update(pending);
  await flush();
  h.nodes["#briefing-video"].ended = true;
  h.nodes["#briefing-video"].dispatch("ended");
  await flush();
  const plays = h.operations.filter(([id, action]) => id === "#briefing-video" && action === "play").length;
  assert.equal(h.manager.update(pending), true);
  await flush();
  assert.equal(h.nodes["#briefing-panel"].hidden, true);
  assert.equal(h.operations.filter(([id, action]) => id === "#briefing-video" && action === "play").length, plays);
  h.nodes["#briefing-video"].dispatch("ended");
  await flush();
  assert.equal(h.requests.length, 1);
  h.manager.update({ ...pending, briefing_token: "next-token" });
  await flush();
  assert.equal(h.nodes["#briefing-panel"].hidden, false);
});

test("briefing transitions do not hide invalid settings or unsupported-font warnings", () => {
  const h = harness("", { noFont: true });
  h.manager.update({
    ...h.settings, briefing_token: "token", briefing_filename: filename(),
    media_settings: { ...h.settings.media_settings, font_filename: filename("woff2") },
  });
  assert.equal(h.nodes["#media-status-text"].textContent, "media.font_failed");
  assert.equal(h.nodes["#media-status"].hidden, false);
  h.manager.update({ ...h.settings, media_settings_error: true });
  assert.equal(h.nodes["#media-status-text"].textContent, "media.invalid_settings");
  assert.equal(h.nodes["#media-status"].hidden, false);
});

test("previews are silent and cannot finish briefing; overrides load no new media", async () => {
  const preview = harness("?preview=1");
  preview.manager.update({ ...preview.settings, briefing_token: "token", briefing_filename: filename() });
  await flush();
  assert.equal(preview.nodes["#briefing-video"].muted, true);
  assert.equal(preview.nodes["#background-soundtrack"].src, undefined);
  preview.nodes["#briefing-video"].ended = true;
  preview.nodes["#briefing-video"].dispatch("ended");
  assert.equal(preview.requests.length, 0);
  for (const h of [harness("?media=default"), harness("", { disabled: true })]) {
    h.manager.update({
      ...h.settings, briefing_token: "token", briefing_filename: filename(),
      media_settings: { ...h.settings.media_settings, font_filename: filename("woff2") },
    });
    await flush();
    assert.equal(h.operations.some(operation => operation[1] === "src"), false);
    assert.equal(h.fonts.size, 0);
    assert.equal(h.nodes["#media-status-text"].textContent, "media.briefing_disabled");
  }
});

test("font load and removal preserve fallback; failures are reported", async () => {
  const h = harness();
  h.manager.update({ ...h.settings, media_settings: {
    ...h.settings.media_settings, font_filename: filename("woff2"),
  } });
  await flush();
  assert.equal(h.fonts.size, 1);
  assert(h.style["--screen-font"].includes("system-ui"));
  h.manager.update(h.settings);
  assert.equal(h.fonts.size, 0);
  assert.equal(h.style["--screen-font"], undefined);
  for (const options of [{ fontError: true }, { noFont: true }]) {
    const failed = harness("", options);
    failed.manager.update({ ...failed.settings, media_settings: {
      ...failed.settings.media_settings, font_filename: filename("woff2"),
    } });
    await flush();
    assert.equal(failed.style["--screen-font"], undefined);
    assert.equal(failed.nodes["#media-status-text"].textContent, "media.font_failed");
  }
});
