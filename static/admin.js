const announcementForm = document.querySelector("#announcement-form");
const hintHistory = document.querySelector("#hint-history");
const status = document.querySelector("#status");
const currentAnnouncement = document.querySelector("#current-announcement");
const currentAnnouncementMessage = document.querySelector("#current-announcement-message");
const currentAnnouncementImage = document.querySelector("#current-announcement-image");
const currentAnnouncementVideo = document.querySelector("#current-announcement-video");
const currentAnnouncementAudio = document.querySelector("#current-announcement-audio");
const cancelAnnouncementForm = document.querySelector("#cancel-announcement-form");
const previewDialog = document.querySelector("#preview-dialog");
const completionDialog = document.querySelector("#completion-dialog");
const completionForm = document.querySelector("#completion-form");
const completionTime = document.querySelector("#completion-time");
const gpioPauseButton = document.querySelector("#toggle-gpio-pause");
const timerPauseButton = document.querySelector("#toggle-timer-pause");
const activeTimerState = document.querySelector("#active-timer-state");
const activeTimerElapsed = document.querySelector("#active-timer-elapsed");
const activeTimerRemaining = document.querySelector("#active-timer-remaining");
const activeTimerPanel = document.querySelector("#active-timer-panel");
const activeTimerWarning = document.querySelector("#active-timer-warning");
const actionLogList = document.querySelector("#action-log-list");
const actionLogStorageKey = "admin-action-log-cache";
const adminDom = window.AdminDom;
let activeTimerSnapshot = window.initialDisplaySettings || null;
let shownRoomResultKey = null;
let timerActionPending = false;

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": window.csrfToken,
    },
    body: body ? JSON.stringify(body) : null,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || window.translate("js.request_failed"));
  return payload;
}

function loadActionLogCache() {
  if (!actionLogList) return;
  try {
    const cached = JSON.parse(localStorage.getItem(actionLogStorageKey) || "null");
    if (Array.isArray(cached)) {
      adminDom.renderActionLog(actionLogList, cached);
    }
  } catch (error) {
    localStorage.removeItem(actionLogStorageKey);
  }
}

function saveActionLogCache(actions) {
  if (!actionLogList) return;
  localStorage.setItem(actionLogStorageKey, JSON.stringify(actions));
}

function clearActionLogCache() {
  if (!actionLogList) return;
  localStorage.removeItem(actionLogStorageKey);
  adminDom.renderActionLog(actionLogList, []);
}

function updateActiveTimerDisplay() {
  updateGpioPauseButton();
  updateTimerActionButtons();
  if (!activeTimerPanel || !activeTimerState || !activeTimerElapsed || !activeTimerRemaining) return;
  const timer = adminDom.getTimerPresentation(activeTimerSnapshot || {});
  const stateLabels = {
    idle: "js.timer_not_running",
    running: "js.timer_running",
    paused: "js.timer_paused",
    completed: "js.timer_completed",
    failed: "js.timer_failed",
  };
  activeTimerPanel.dataset.timerState = timer.state;
  activeTimerPanel.dataset.urgency = timer.urgency;
  const stateLabel = window.translate(stateLabels[timer.state]);
  if (activeTimerState.textContent !== stateLabel) activeTimerState.textContent = stateLabel;
  activeTimerElapsed.textContent = adminDom.formatClockDuration(timer.elapsedSeconds);
  activeTimerRemaining.textContent = adminDom.formatClockDuration(timer.remainingSeconds);
  if (activeTimerWarning) {
    activeTimerWarning.hidden = timer.urgency === "normal";
    const warningLabel = timer.urgency === "normal"
      ? ""
      : window.translate(timer.urgency === "critical" ? "js.timer_critical_time" : "js.timer_low_time");
    if (activeTimerWarning.textContent !== warningLabel) activeTimerWarning.textContent = warningLabel;
  }
}

async function refreshActiveTimer() {
  if (!activeTimerState || !activeTimerElapsed || !activeTimerRemaining) return;
  try {
    const response = await fetch("/api/display", { credentials: "same-origin"     });
    if (!response.ok) throw new Error(window.translate("js.failed_to_fetch_timer"));
    const payload = await response.json();
    applyActiveTimerSettings(payload);
  } catch (error) {
    console.warn("refreshActiveTimer error", error);
  }
}

function setStatusText(text, level = "info") {
  if (status) {
    status.textContent = text;
    status.dataset.level = level;
  }
}

function setCompletionMessage(text) {
  if (completionTime) {
    completionTime.textContent = text;
  }
}

function updateActiveTimerSnapshot(settings) {
  activeTimerSnapshot = {
    timer_started_at: settings.timer_started_at,
    briefing_token: settings.briefing_token,
    timer_duration_seconds: settings.timer_duration_seconds,
    timer_run_duration_seconds: settings.timer_run_duration_seconds,
    timer_paused_at: settings.timer_paused_at,
    room_completed_at: settings.room_completed_at,
    room_failed_at: settings.room_failed_at,
    extra_time_seconds: settings.extra_time_seconds,
    penalty_time_seconds: settings.penalty_time_seconds,
  };
  const briefingControls = document.querySelector("#briefing-controls");
  if (briefingControls) briefingControls.hidden = !settings.briefing_token;
  updateTimerPauseButton(settings);
}

function applyActiveTimerSettings(settings) {
  const previousSnapshot = activeTimerSnapshot;
  updateActiveTimerSnapshot(settings);
  updateActiveTimerDisplay();
  const justFailed = Boolean(
    previousSnapshot
    && previousSnapshot.timer_started_at === settings.timer_started_at
    && !previousSnapshot.room_failed_at
    && !previousSnapshot.room_completed_at
    && settings.room_failed_at,
  );
  if (!justFailed || !completionDialog || !completionTime) return;
  const resultKey = `${settings.timer_started_at}:${settings.room_failed_at}`;
  if (shownRoomResultKey === resultKey) return;
  showRoomResultDialog(settings, settings.room_failed_at);
}

function initDisplayEventStream() {
  if (!window.EventSource || !activeTimerState) return;
  const eventSource = new EventSource("/events");
  eventSource.addEventListener("display", (event) => {
    try {
      applyActiveTimerSettings(JSON.parse(event.data));
    } catch (error) {
      console.warn("display event error", error);
    }
  });
}

function updateCurrentAnnouncement(settings) {
  if (
    !currentAnnouncement
    || !currentAnnouncementMessage
    || !currentAnnouncementImage
    || !currentAnnouncementVideo
    || !currentAnnouncementAudio
  ) {
    return;
  }

  const hasAnnouncement = Boolean(
    settings.announcement || settings.announcement_media_filename,
  );
  currentAnnouncement.hidden = !hasAnnouncement;
  if (!hasAnnouncement) {
    currentAnnouncementVideo.pause();
    currentAnnouncementAudio.pause();
    return;
  }

  currentAnnouncementMessage.textContent = settings.announcement || "";
  if (settings.announcement_media_type === "image") {
    currentAnnouncementImage.src = `/uploads/${encodeURIComponent(
      settings.announcement_media_filename,
    )}`;
    currentAnnouncementImage.hidden = false;
    currentAnnouncementVideo.hidden = true;
    currentAnnouncementVideo.removeAttribute("src");
    currentAnnouncementAudio.pause();
    currentAnnouncementAudio.hidden = true;
    currentAnnouncementAudio.removeAttribute("src");
    return;
  }

  if (settings.announcement_media_type === "video") {
    currentAnnouncementVideo.src = `/uploads/${encodeURIComponent(
      settings.announcement_media_filename,
    )}`;
    currentAnnouncementVideo.hidden = false;
    currentAnnouncementImage.hidden = true;
    currentAnnouncementImage.removeAttribute("src");
    currentAnnouncementAudio.pause();
    currentAnnouncementAudio.hidden = true;
    currentAnnouncementAudio.removeAttribute("src");
    return;
  }

  if (settings.announcement_media_type === "audio") {
    currentAnnouncementAudio.src = `/uploads/${encodeURIComponent(
      settings.announcement_media_filename,
    )}`;
    currentAnnouncementAudio.hidden = false;
    currentAnnouncementImage.hidden = true;
    currentAnnouncementImage.removeAttribute("src");
    currentAnnouncementVideo.pause();
    currentAnnouncementVideo.hidden = true;
    currentAnnouncementVideo.removeAttribute("src");
    return;
  }

  currentAnnouncementImage.hidden = true;
  currentAnnouncementImage.removeAttribute("src");
  currentAnnouncementVideo.hidden = true;
  currentAnnouncementVideo.removeAttribute("src");
  currentAnnouncementAudio.pause();
  currentAnnouncementAudio.hidden = true;
  currentAnnouncementAudio.removeAttribute("src");
}

function initCancelAnnouncementForm() {
  if (!cancelAnnouncementForm) return;

  cancelAnnouncementForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = await post("/admin/announcement/cancel");
      updateCurrentAnnouncement(settings);
      setStatusText(window.translate("js.announcement_cancelled"));
      refreshActions();
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function initGpioPauseButton() {
  if (!gpioPauseButton) return;

  gpioPauseButton.addEventListener("click", async () => {
    try {
      const response = await post("/admin/gpio/pause", {
        paused: gpioPauseButton.dataset.paused !== "true",
      });
      const paused = response.paused;
      gpioPauseButton.dataset.paused = String(paused);
      updateGpioPauseButton();
      setStatusText(window.translate(
        paused ? "js.room_input_paused" : "js.room_input_active",
      ));
      refreshActions();
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function updateGpioPauseButton() {
  if (!gpioPauseButton) return;
  const timer = adminDom.getTimerPresentation(activeTimerSnapshot || {});
  const running = timer.state === "running" && timer.remainingSeconds > 0;
  const paused = gpioPauseButton.dataset.paused === "true";
  const state = running
    ? (paused ? "paused" : "active")
    : timer.state === "idle" ? "idle" : timer.state === "paused" ? "paused" : "finished";
  gpioPauseButton.disabled = !running;
  setControlState(gpioPauseButton, state, window.translate(
    paused ? "js.resume_room_input" : "js.pause_room_input",
  ));
}

function setControlState(button, state, actionLabel) {
  const stateLabels = {
    active: "js.state_active",
    paused: "js.state_paused",
    idle: "js.state_idle",
    finished: "js.state_finished",
  };
  button.dataset.controlState = state;
  button.classList.toggle("btn-active", state === "active");
  button.classList.toggle("btn-paused", state === "paused");
  button.classList.toggle("btn-inactive", state === "idle" || state === "finished");
  button.querySelector(".control-state-label").textContent = window.translate(stateLabels[state]);
  button.querySelector(".control-action-label").textContent = actionLabel;
}

function updateTimerPauseButton(settings) {
  if (!timerPauseButton) return;
  const paused = Boolean(settings.timer_paused_at);
  const finished = Boolean(settings.room_completed_at || settings.room_failed_at);
  const started = Boolean(settings.timer_started_at);
  const state = !started ? "idle" : finished ? "finished" : paused ? "paused" : "active";
  timerPauseButton.dataset.paused = String(paused);
  timerPauseButton.disabled = !started || finished;
  setControlState(timerPauseButton, state, window.translate(
    paused ? "js.resume_timer" : "js.pause_timer",
  ));
}

function initTimerPauseButton() {
  if (!timerPauseButton) return;

  timerPauseButton.addEventListener("click", async () => {
    try {
      const settings = await post("/admin/timer/pause");
      updateActiveTimerSnapshot(settings);
      updateActiveTimerDisplay();
      setStatusText(window.translate(
        settings.timer_paused_at ? "js.timer_paused" : "js.timer_resumed",
      ));
      refreshActions();
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function initGpioButtons() {
  document.querySelectorAll("[data-gpio]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await post(`/admin/gpio/${button.dataset.gpio}/${button.dataset.state}`);
        setStatusText(`${button.dataset.gpio} turned ${button.dataset.state}.`);
      } catch (error) {
        setStatusText(error.message, "error");
      }
    });
  });
}

function initGpioOutputActionButtons() {
  document.querySelectorAll("[data-gpio-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const action = await post(`/admin/gpio/actions/${button.dataset.gpioAction}/trigger`);
        const target = action.pin == null ? action.output_name : `BCM ${action.pin}`;
        setStatusText(window.translate(
          action.signal === "timed" ? "js.gpio_action_timed" : "js.gpio_action_triggered", {
          label: action.label,
          output: target,
          state: window.translate(
            action.state === "on" ? "js.output_on" : "js.output_off",
          ),
          seconds: action.duration_seconds,
        }));
      } catch (error) {
        setStatusText(error.message, "error");
      }
    });
  });
}

function initTimerActionButtons() {
  document.querySelectorAll("[data-timer-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      if (button.disabled || timerActionPending) return;
      timerActionPending = true;
      updateTimerActionButtons();
      try {
        if (button.dataset.timerAction === "reset") {
          const response = await fetch("/api/display", { credentials: "same-origin" });
          if (!response.ok) throw new Error(window.translate("js.failed_to_fetch_timer"));
          const current = await response.json();
          updateActiveTimerSnapshot(current);
          updateActiveTimerDisplay();
          if (
            (current.timer_started_at || current.briefing_token)
            && !current.room_completed_at
            && !current.room_failed_at
            && !window.confirm(window.translate(
              current.briefing_token ? "media.confirm_briefing_reset" : "js.confirm_timer_reset",
            ))
          ) return;
        }
        const settings = await post(`/admin/timer/${button.dataset.timerAction}`);
        setStatusText(
          button.dataset.timerAction === "start"
            ? settings.briefing_token ? window.translate("media.briefing_active") : window.translate("js.timer_started", {
              duration: adminDom.formatClockDuration(adminDom.getTimerBaseSeconds(settings)),
            })
            : window.translate("js.timer_reset", {
              duration: adminDom.formatClockDuration(adminDom.getTimerBaseSeconds(settings)),
            }),
        );
        clearActionLogCache();
        updateActiveTimerSnapshot(settings);
        updateActiveTimerDisplay();
        refreshActiveTimer();
        refreshHints();
        refreshActions();
      } catch (error) {
        setStatusText(error.message, "error");
      } finally {
        timerActionPending = false;
        updateTimerActionButtons();
      }
    });
  });
}

function updateTimerActionButtons() {
  document.querySelectorAll("[data-timer-action]").forEach((button) => {
    button.disabled = timerActionPending || (
      button.dataset.timerAction === "start"
        && Boolean(activeTimerSnapshot?.timer_started_at || activeTimerSnapshot?.briefing_token)
    );
  });
}

function formatAdjustmentDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (minutes > 0) {
    parts.push(window.translate(
      minutes === 1 ? "js.duration_minute" : "js.duration_minutes",
      { value: minutes },
    ));
  }
  if (seconds > 0) {
    parts.push(window.translate(
      seconds === 1 ? "js.duration_second" : "js.duration_seconds",
      { value: seconds },
    ));
  }
  return parts.join(" ");
}

function initTimerAdjustButtons() {
  document.querySelectorAll("[data-adjust-combined], [data-adjust-seconds]").forEach((button) => {
    button.addEventListener("click", async () => {
      let seconds = Number(button.dataset.adjustSeconds);
      if (button.dataset.adjustCombined) {
        const minutes = Number(document.querySelector("#timer-adjust-minutes")?.value);
        const remainingSeconds = Number(document.querySelector("#timer-adjust-seconds")?.value);
        if (
          !Number.isInteger(minutes) || minutes < 0 || minutes > 59
          || !Number.isInteger(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > 59
          || (minutes === 0 && remainingSeconds === 0)
        ) {
          setStatusText(window.translate("js.valid_adjustment"), "error");
          return;
        }
        seconds = (minutes * 60 + remainingSeconds) * Number(button.dataset.adjustCombined);
      }
      try {
        await post("/admin/timer/adjust", { seconds });
        const duration = formatAdjustmentDuration(Math.abs(seconds));
        setStatusText(
          seconds >= 0
            ? window.translate("js.added_time_total", { duration })
            : window.translate("js.added_time_taken", { duration }),
        );
        refreshHints();
        refreshActions();
        refreshActiveTimer();
      } catch (err) {
        setStatusText(err.message, "error");
      }
    });
  });
}

function initCompleteRoomButton() {
  const completeRoomButton = document.querySelector("#complete-room");
  if (!completeRoomButton || !completionDialog || !completionTime) return;

  completeRoomButton.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const settings = await post("/admin/complete");
      showRoomResultDialog(settings, settings.room_completed_at);
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function initFailRoomButton() {
  const failRoomButton = document.querySelector("#fail-room");
  if (!failRoomButton || !completionDialog || !completionTime) return;

  failRoomButton.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const settings = await post("/admin/fail");
      showRoomResultDialog(settings, settings.room_failed_at);
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function showRoomResultDialog(settings, endedAt) {
  const extraTimeSeconds = Number(settings.extra_time_seconds || 0);
  const penaltyTimeSeconds = Number(settings.penalty_time_seconds || 0);
  const timeTaken = elapsedSeconds(settings.timer_started_at, endedAt) + penaltyTimeSeconds;
  const timeRemaining = (adminDom.getTimerBaseSeconds(settings) + extraTimeSeconds) - timeTaken;
  setCompletionMessage(
    timeRemaining >= 0
      ? window.translate("js.completion_time_left", {
        taken: adminDom.formatDuration(timeTaken),
        remaining: adminDom.formatDuration(timeRemaining),
      })
      : window.translate("js.completion_overtime", {
        taken: adminDom.formatDuration(timeTaken),
        remaining: adminDom.formatDuration(-timeRemaining),
      }),
  );
  shownRoomResultKey = `${settings.timer_started_at}:${endedAt}`;
  if (!completionDialog.open) completionDialog.showModal();
  updateActiveTimerSnapshot(settings);
  updateActiveTimerDisplay();
  refreshActions();
}

async function sendHint() {
  if (!announcementForm) return;
  if (!announcementForm.reportValidity()) return;
  try {
    const response = await post(
      "/admin/announcement",
      Object.fromEntries(new FormData(announcementForm)),
    );
    appendHint(response.hint);
    updateCurrentAnnouncement(response);
    announcementForm.reset();
    setStatusText(window.translate("js.announcement_sent"));
    refreshActions();
  } catch (error) {
    setStatusText(error.message, "error");
  }
}

function appendHint(hint) {
  if (!hintHistory) return;
  const noHints = document.querySelector("#no-hints");
  if (noHints) noHints.remove();
  hintHistory.append(adminDom.createHintHistoryItem(hint, hintHistory.children.length + 1));
}

async function refreshHints() {
  if (!hintHistory) return;
  try {
    const res = await fetch("/admin/api/hints", { credentials: "same-origin" });
    if (!res.ok) throw new Error("Failed to fetch hints");
    const hints = await res.json();
    adminDom.renderHintHistory(hintHistory, hints);
  } catch (err) {
    console.warn("refreshHints error", err);
  }
}

async function refreshActions() {
  if (!actionLogList) return;
  try {
    const res = await fetch("/admin/api/actions", { credentials: "same-origin" });
    if (!res.ok) throw new Error("Failed to fetch actions");
    const actions = await res.json();
    saveActionLogCache(actions);
    adminDom.renderActionLog(actionLogList, actions);
  } catch (err) {
    console.warn("refreshActions error", err);
  }
}

function elapsedSeconds(startedAt, completedAt) {
  return Math.max(0, Math.floor((new Date(completedAt) - new Date(startedAt)) / 1000));
}

function initHintForm() {
  if (!announcementForm) return;
  announcementForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendHint();
  });
}

function initHintPresetButton() {
  const hintPresetSelect = document.querySelector("#hint-preset-select");
  const sendHintPresetButton = document.querySelector("#send-hint-preset");
  const hintPresetSearch = document.querySelector("#hint-preset-search");
  const hintCategoryFilter = document.querySelector("#hint-category-filter");
  const noResults = document.querySelector("#hint-preset-no-results");
  if (!sendHintPresetButton || !hintPresetSelect) return;

  const filterHintPresets = () => {
    const query = hintPresetSearch?.value.trim().toLocaleLowerCase() || "";
    const category = hintCategoryFilter?.value || "";
    let visibleCount = 0;
    for (const option of hintPresetSelect.options) {
      if (!option.value) continue;
      const matchesSearch = !query || option.dataset.search.includes(query);
      const matchesCategory = !category || option.dataset.category === category;
      option.hidden = !(matchesSearch && matchesCategory);
      if (!option.hidden) visibleCount += 1;
    }
    const selectedOption = hintPresetSelect.selectedOptions[0];
    if (selectedOption?.hidden) hintPresetSelect.value = "";
    if (noResults) noResults.hidden = visibleCount !== 0;
  };
  hintPresetSearch?.addEventListener("input", filterHintPresets);
  hintCategoryFilter?.addEventListener("change", filterHintPresets);

  sendHintPresetButton.addEventListener("click", async () => {
    const presetId = hintPresetSelect.value;
    if (!presetId) {
      setStatusText(window.translate("js.select_hint"), "error");
      return;
    }
    try {
      const response = await post(`/admin/hints/${presetId}/send`, {});
      appendHint(response.hint);
      updateCurrentAnnouncement(response);
      setStatusText(window.translate("js.saved_hint_sent"));
      refreshActions();
    } catch (error) {
      setStatusText(error.message, "error");
    }
  });
}

function initCompletionForm() {
  if (!completionForm || !completionDialog || !completionTime) return;

  completionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!completionForm.reportValidity()) return;
    try {
      await post("/admin/results", Object.fromEntries(new FormData(completionForm)));
      completionDialog.close();
      setStatusText(window.translate("js.room_result_saved"));
    } catch (error) {
      setCompletionMessage(error.message);
    }
  });
}

function initDialogs() {
  const openPreviewButton = document.querySelector("#open-preview");
  const closePreviewButton = document.querySelector("#close-preview");
  if (openPreviewButton && previewDialog) {
    openPreviewButton.addEventListener("click", () => {
      previewDialog.showModal();
    });
  }
  if (closePreviewButton && previewDialog) {
    closePreviewButton.addEventListener("click", () => {
      previewDialog.close();
    });
  }
}

function initCompletionDialogClose() {
  const closeCompletionButton = document.querySelector("#close-completion");
  if (!closeCompletionButton || !completionDialog) return;

  closeCompletionButton.addEventListener("click", () => {
    completionDialog.close();
  });
}

function initPage() {
  if (activeTimerSnapshot) updateTimerPauseButton(activeTimerSnapshot);
  updateActiveTimerDisplay();
  initGpioPauseButton();
  initTimerPauseButton();
  initGpioButtons();
  initGpioOutputActionButtons();
  initTimerActionButtons();
  initTimerAdjustButtons();
  initCompleteRoomButton();
  initFailRoomButton();
  initHintForm();
  initHintPresetButton();
  initCancelAnnouncementForm();
  initCompletionForm();
  initDialogs();
  initCompletionDialogClose();
  initDisplayEventStream();
  loadActionLogCache();
  refreshActiveTimer();
  refreshHints();
  refreshActions();
  setInterval(updateActiveTimerDisplay, 1000);
  setInterval(() => {
    refreshActiveTimer();
    refreshHints();
    refreshActions();
  }, 5000);
}

initPage();
