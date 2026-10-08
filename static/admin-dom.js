window.AdminDom = (() => {
  function buildUploadUrl(filename) {
    return `/uploads/${encodeURIComponent(filename)}`;
  }

  function formatClockDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const remainingSeconds = String(seconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${remainingSeconds}`;
  }

  function formatDuration(totalSeconds) {
    const negative = totalSeconds < 0;
    const seconds = Math.abs(Math.floor(totalSeconds));
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const remainingSeconds = String(seconds % 60).padStart(2, "0");
    return `${negative ? "-" : ""}${minutes}:${remainingSeconds}`;
  }

  function getTimerBaseSeconds(settings) {
    return Number((settings.timer_started_at
      ? settings.timer_run_duration_seconds
      : settings.timer_duration_seconds) ?? 3600);
  }

  function getTimerPresentation(settings, now = Date.now()) {
    const state = !settings.timer_started_at
      ? "idle"
      : settings.room_failed_at
        ? "failed"
        : settings.room_completed_at
          ? "completed"
          : settings.timer_paused_at
            ? "paused"
            : "running";
    const stoppedAt = settings.room_failed_at
      || settings.room_completed_at
      || settings.timer_paused_at;
    const elapsedSeconds = settings.timer_started_at
      ? Math.max(0, Math.floor(
        (new Date(stoppedAt || now) - new Date(settings.timer_started_at)) / 1000,
      )) + Number(settings.penalty_time_seconds || 0)
      : 0;
    const remainingSeconds = Math.max(
      0,
      getTimerBaseSeconds(settings) + Number(settings.extra_time_seconds || 0) - elapsedSeconds,
    );
    const urgency = state !== "running" || remainingSeconds > 300
      ? "normal"
      : remainingSeconds <= 60
        ? "critical"
        : "warning";
    return { state, elapsedSeconds, remainingSeconds, urgency };
  }

  function createHintHistoryItem(hint, index) {
    const item = document.createElement("li");
    const count = document.createElement("span");
    const text = document.createElement("span");
    const timestamp = document.createElement("time");
    const timerValue = document.createElement("time");

    count.className = "hint-count";
    count.textContent = window.translate("js.hint_number", { number: index });
    text.textContent = hint.message;
    timerValue.className = "hint-timer";
    timerValue.dateTime = `PT${hint.timer_remaining_seconds}S`;
    timerValue.textContent = window.translate("js.timer_value", {
      value: formatDuration(hint.timer_remaining_seconds),
    });
    timestamp.dateTime = hint.given_at;
    timestamp.textContent = window.translate("js.utc", { value: hint.given_at });
    item.append(count, text);

    if (hint.media_type === "image" && hint.media_filename) {
      const image = document.createElement("img");
      image.className = "hint-media-preview";
      image.src = buildUploadUrl(hint.media_filename);
      image.alt = window.translate("js.hint_image");
      item.append(image);
    } else if (hint.media_type === "video" && hint.media_filename) {
      const video = document.createElement("video");
      video.className = "hint-media-preview";
      video.src = buildUploadUrl(hint.media_filename);
      video.controls = true;
      item.append(video);
    } else if (hint.media_type === "audio" && hint.media_filename) {
      const audio = document.createElement("audio");
      audio.className = "hint-audio-preview";
      audio.src = buildUploadUrl(hint.media_filename);
      audio.controls = true;
      item.append(audio);
    }

    item.append(timerValue, timestamp);
    return item;
  }

  function renderHintHistory(container, hints) {
    container.innerHTML = "";
    if (!Array.isArray(hints) || hints.length === 0) {
      const empty = document.createElement("li");
      empty.id = "no-hints";
      empty.textContent = window.translate("js.no_hints");
      container.append(empty);
      return;
    }

    hints.forEach((hint, index) => {
      container.append(createHintHistoryItem(hint, index + 1));
    });
  }

  function renderActionLog(list, actions) {
    list.innerHTML = "";
    if (!Array.isArray(actions) || actions.length === 0) {
      const empty = document.createElement("li");
      empty.id = "no-actions";
      empty.textContent = window.translate("js.no_actions");
      list.append(empty);
      return;
    }

    actions.forEach((action) => {
      const item = document.createElement("li");
      item.textContent = `${action.created_at} — ${action.action_type}: ${action.description}`;
      list.append(item);
    });
  }

  return {
    createHintHistoryItem,
    formatClockDuration,
    formatDuration,
    getTimerBaseSeconds,
    getTimerPresentation,
    renderActionLog,
    renderHintHistory,
  };
})();
