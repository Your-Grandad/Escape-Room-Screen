(() => {
  "use strict";
  window.HomeMedia = {
    createManager(search) {
      const params = new URLSearchParams(search);
      const preview = ["1", "true"].includes(params.get("preview"));
      const disabled = params.get("media") === "default" || document.body.dataset.mediaDisabled === "true";
      const background = document.querySelector("#background-video");
      const briefing = document.querySelector("#briefing-video");
      const panel = document.querySelector("#briefing-panel");
      const music = document.querySelector("#background-soundtrack");
      const hintVideo = document.querySelector("#announcement-video");
      const hintAudio = document.querySelector("#announcement-audio");
      const status = document.querySelector("#media-status");
      const statusText = document.querySelector("#media-status-text");
      const retry = document.querySelector("#media-retry");
      let settings = null;
      let token = null;
      let consumedToken = null;
      let finishing = false;
      let fontFilename = null;
      let loadedFont = null;
      let backgroundFailed = null;
      let musicBlocked = false;
      let musicFilename = null;
      let backgroundPending = false;
      let musicPending = false;
      let completedHint = null;
      let hintKey = null;

      function notify(key, error) {
        console.warn(key, error || "");
        statusText.textContent = window.translate(key);
        status.hidden = false;
      }
      function unload(element) {
        element.pause();
        if (element.getAttribute("src")) {
          element.removeAttribute("src");
          element.load();
        }
      }
      function source(element, filename) {
        const url = `/uploads/${encodeURIComponent(filename)}`;
        if (element.getAttribute("src") !== url) {
          element.src = url;
          element.load();
        }
      }
      function activeRun() {
        if (!settings?.timer_started_at || settings.timer_paused_at
          || settings.room_completed_at || settings.room_failed_at) return false;
        const seconds = Number(settings.timer_run_duration_seconds)
          + Number(settings.extra_time_seconds || 0) - Number(settings.penalty_time_seconds || 0);
        return Date.now() - Date.parse(settings.timer_started_at) < seconds * 1000;
      }
      function hintActive(kind) {
        if (!settings?.announcement_media_filename || settings.announcement_media_type !== kind
          || completedHint === hintKey) return false;
        return kind === "video" || Date.now() < Date.parse(settings.announcement_expires_at);
      }
      function updateFont(media) {
        const filename = disabled ? null : media.font_filename;
        if (filename === fontFilename) return;
        fontFilename = filename;
        if (loadedFont) document.fonts.delete(loadedFont);
        loadedFont = null;
        document.body.style.removeProperty("--screen-font");
        if (!filename) return;
        if (!window.FontFace || !document.fonts) {
          notify("media.font_failed");
          return;
        }
        const font = new FontFace("RoomCustomFont", `url("/uploads/${encodeURIComponent(filename)}")`);
        font.load().then(() => {
          if (fontFilename !== filename) return;
          document.fonts.add(font);
          loadedFont = font;
          document.body.style.setProperty("--screen-font", '"RoomCustomFont", system-ui, sans-serif');
        }).catch(error => {
          if (fontFilename === filename) notify("media.font_failed", error);
        });
      }
      async function finishBriefing() {
        if (!token || finishing || preview || disabled || !briefing.ended) return;
        const finishedToken = token;
        finishing = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch("/api/briefing/finished", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: finishedToken }), signal: controller.signal,
          });
          if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
          consumedToken = finishedToken;
          if (token === finishedToken) {
            token = null;
            panel.hidden = true;
            unload(briefing);
            status.hidden = true;
          }
          // Only the normal SSE/polling snapshot applies server state.
        } catch (error) {
          if (token === finishedToken) notify("media.finish_failed", error);
        } finally {
          clearTimeout(timeout);
          finishing = false;
        }
      }
      function tick() {
        if (!settings) return;
        const media = settings.media_settings || {};
        const foreground = Boolean(settings.briefing_token);
        const videoHint = hintActive("video");
        const audioHint = hintActive("audio");
        const backgroundWanted = !disabled && media.background_video_enabled && media.background_video
          && !foreground && !videoHint && !settings.room_completed_at && !settings.room_failed_at
          && backgroundFailed !== media.background_video;
        if (!backgroundWanted) {
          background.hidden = true;
          unload(background);
        } else {
          source(background, media.background_video);
          if (background.paused && !backgroundPending) {
            backgroundPending = true;
            const filename = media.background_video;
            background.play().then(() => {
              if (!background.getAttribute("src") || settings.briefing_token || hintActive("video")) {
                unload(background);
                return;
              }
              background.hidden = false;
            }).catch(error => {
              if (background.getAttribute("src")) {
                backgroundFailed = filename;
                background.hidden = true;
                unload(background);
                notify("media.background_failed", error);
              }
            }).finally(() => { backgroundPending = false; });
          }
        }
        const musicWanted = !disabled && !preview && media.soundtrack_enabled && media.soundtrack
          && activeRun() && !foreground && !videoHint && !audioHint;
        if (!musicWanted) {
          music.pause();
          if (disabled || !media.soundtrack_enabled || !media.soundtrack) unload(music);
        } else {
          source(music, media.soundtrack);
          music.volume = media.soundtrack_volume / 100;
          if (music.paused && !musicBlocked && !musicPending) {
            musicPending = true;
            music.play().then(() => {
              if (!activeRun() || settings.briefing_token || hintActive("audio") || hintActive("video")) music.pause();
            }).catch(error => {
              musicBlocked = true;
              notify("media.soundtrack_failed", error);
            }).finally(() => { musicPending = false; });
          }
        }
      }
      function update(next) {
        settings = next;
        const media = next.media_settings || {};
        const nextToken = next.briefing_token === consumedToken ? null : next.briefing_token || null;
        const changed = token !== nextToken;
        if (changed) {
          token = nextToken;
          unload(briefing);
          panel.hidden = true;
          status.hidden = true;
        }
        if (musicFilename !== media.soundtrack) musicBlocked = false;
        musicFilename = media.soundtrack;
        const nextHintKey = [next.announcement_media_filename, next.announcement_expires_at].join("|");
        if (nextHintKey !== hintKey) completedHint = null;
        hintKey = nextHintKey;
        if (!disabled) {
          document.body.style.setProperty("--screen-text-colour", media.text_colour || "#f8fafc");
          document.body.style.setProperty("--screen-hint-colour", media.hint_colour || next.accent_colour);
        }
        updateFont(media);
        if (next.media_settings_error) notify("media.invalid_settings");
        // Release background decoder before a foreground video gets its source.
        tick();
        if (token) {
          unload(hintVideo);
          unload(hintAudio);
          if (disabled) {
            notify("media.briefing_disabled");
          } else if (changed) {
            panel.hidden = false;
            briefing.muted = preview;
            source(briefing, next.briefing_filename);
            briefing.play().catch(error => notify("media.briefing_failed", error));
          }
        }
        return Boolean(next.briefing_token);
      }
      briefing.addEventListener("ended", finishBriefing);
      briefing.addEventListener("error", () => {
        if (token) notify("media.briefing_failed");
      });
      background.addEventListener("error", () => {
        if (!background.getAttribute("src")) return;
        backgroundFailed = settings?.media_settings?.background_video;
        background.hidden = true;
        unload(background);
        notify("media.background_failed");
      });
      music.addEventListener("error", () => {
        if (!music.getAttribute("src")) return;
        musicBlocked = true;
        music.pause();
        notify("media.soundtrack_failed");
      });
      [hintVideo, hintAudio].forEach(element => element.addEventListener("ended", () => {
        completedHint = hintKey;
        tick();
      }));
      [hintVideo, hintAudio].forEach(element => element.addEventListener("play", () => {
        completedHint = null;
        tick();
      }));
      retry.addEventListener("click", () => {
        status.hidden = true;
        backgroundFailed = null;
        musicBlocked = false;
        if (token && !disabled) {
          if (briefing.ended) finishBriefing();
          else {
            // Call play in the user gesture to satisfy autoplay restrictions.
            briefing.play().catch(error => notify("media.briefing_failed", error));
          }
        }
        tick();
      });
      return { update, tick };
    },
  };
})();
