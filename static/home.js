const title = document.querySelector("#title");
const logo = document.querySelector("#logo");
const message = document.querySelector("#message");
const timer = document.querySelector("#timer");
const announcement = document.querySelector("#announcement");
const announcementMessage = document.querySelector("#announcement-message");
const announcementImage = document.querySelector("#announcement-image");
const announcementVideo = document.querySelector("#announcement-video");
const announcementAudio = document.querySelector("#announcement-audio");
const gpioActivity = document.querySelector("#gpio-activity");
const soundManager = window.HomeAudio.createSoundManager(window.location.search);
const mediaManager = window.HomeMedia?.createManager(window.location.search);
announcementVideo.muted = !soundManager.canPlaySounds;
announcementAudio.autoplay = soundManager.canPlaySounds;
let timerStartedAt = null;
let timerDurationSeconds = Number(timer.dataset.durationSeconds);
let timerPausedAt = null;
let roomCompletedAt = null;
let roomFailedAt = null;
let announcementExpiresAt = null;
let extraTimeSeconds = 0;
let penaltyTimeSeconds = 0;
let originalTitle = title.textContent;
let originalMessage = message.textContent;
let completionMessage = "Congratulations!";
let failureMessage = "Room failed";
let videoAnnouncementActive = false;
let currentVideoFilename = null;
let currentVideoAnnouncementExpiresAt = null;
let audioAnnouncementActive = false;
let currentAudioFilename = null;
let currentAudioAnnouncementExpiresAt = null;
let previousAnnouncementVisible = false;
let previousAnnouncementKey = null;
let previousMessage = null;
let previousTitle = null;
let previousRoomComplete = null;
let previousRoomFailed = null;
const forceDefaultLayout = new URLSearchParams(window.location.search).get("layout") === "default";
let warnedAboutMissingLayout = false;

function updateDisplay(settings) {
  const rotation = settings.screen_rotation ?? 0;
  if (![0, 90, 180, 270].includes(rotation)) {
    console.warn("Invalid screen rotation; using normal orientation.", rotation);
  }
  document.body.dataset.screenRotation = String([0, 90, 180, 270].includes(rotation) ? rotation : 0);
  const briefingActive = mediaManager?.update(settings);
  if (window.ScreenLayout) {
    window.ScreenLayout.apply(document.body, settings, { forceDefault: forceDefaultLayout });
  } else if (settings.screen_layout_enabled && !forceDefaultLayout && !warnedAboutMissingLayout) {
    console.warn("Screen layout script is unavailable; using the default screen.");
    warnedAboutMissingLayout = true;
  }
  soundManager.updateFromSettings(settings);

  const hasAnnouncementNow = Boolean(settings.announcement || settings.announcement_media_filename);
  const announcementKey = [
    settings.announcement || "",
    settings.announcement_expires_at || "",
    settings.announcement_media_type || "",
    settings.announcement_media_filename || "",
  ].join("|");
  if (previousAnnouncementKey !== null && announcementKey !== previousAnnouncementKey) {
    previousAnnouncementVisible = false;
  }
  previousAnnouncementKey = announcementKey;
  if (previousMessage !== null && settings.message !== previousMessage && !hasAnnouncementNow) {
    soundManager.playHint();
  }
  if (previousTitle !== null && settings.title !== previousTitle && !hasAnnouncementNow) {
    soundManager.playHint();
  }
  previousMessage = settings.message;
  previousTitle = settings.title;

  originalTitle = settings.title;
  originalMessage = settings.message;
  completionMessage = settings.completion_message || "Congratulations!";
  failureMessage = settings.failure_message || "Room failed";
  document.body.style.setProperty("--background-colour", settings.background_colour);
  document.body.style.setProperty("--accent-colour", settings.accent_colour);
  const backgroundImage = settings.background_image
    ? `url("/uploads/${encodeURIComponent(settings.background_image)}")`
    : "none";
  document.body.style.setProperty("--background-image", backgroundImage);
  if (settings.logo_image) {
    logo.src = `/uploads/${encodeURIComponent(settings.logo_image)}`;
    logo.hidden = false;
    document.body.classList.add("has-logo");
  } else {
    logo.removeAttribute("src");
    logo.hidden = true;
    document.body.classList.remove("has-logo");
  }
  timerStartedAt = settings.timer_started_at;
  timerDurationSeconds = Number(settings.timer_started_at
    ? settings.timer_run_duration_seconds
    : settings.timer_duration_seconds);
  timerPausedAt = settings.timer_paused_at;
  roomCompletedAt = settings.room_completed_at;
  roomFailedAt = settings.room_failed_at;
  announcementExpiresAt = settings.announcement_expires_at;
  extraTimeSeconds = settings.extra_time_seconds || 0;
  penaltyTimeSeconds = settings.penalty_time_seconds || 0;
  announcementMessage.textContent = settings.announcement || "";
  announcement.dataset.hasCaption = String(Boolean(settings.announcement));
  announcement.dataset.hasVisualMedia = String(Boolean(
    settings.announcement_media_filename && ["image", "video"].includes(settings.announcement_media_type),
  ));
  announcement.classList.toggle("full-screen", Boolean(settings.announcement_media_full_screen));
  updateAnnouncementMedia(briefingActive ? {
    ...settings, announcement_media_type: null, announcement_media_filename: null,
  } : settings);
  updateTimer();
  updateRoomCompletion();
  updateRoomFailure(roomFailedAt);
  updateAnnouncement();
  if (briefingActive) announcement.hidden = true;
}

function updateAnnouncementMedia(settings) {
  if (settings.announcement_media_type === "image" && settings.announcement_media_filename) {
    announcementImage.src = `/uploads/${encodeURIComponent(settings.announcement_media_filename)}`;
    announcementImage.hidden = false;
    announcementVideo.hidden = true;
    announcementVideo.removeAttribute("src");
    announcementAudio.pause();
    announcementAudio.hidden = true;
    announcementAudio.removeAttribute("src");
    audioAnnouncementActive = false;
    currentAudioFilename = null;
    currentAudioAnnouncementExpiresAt = null;
  } else if (settings.announcement_media_type === "video" && settings.announcement_media_filename) {
    const newSrc = `/uploads/${encodeURIComponent(settings.announcement_media_filename)}`;
    if (
      settings.announcement_media_filename !== currentVideoFilename
      || settings.announcement_expires_at !== currentVideoAnnouncementExpiresAt
    ) {
      currentVideoFilename = settings.announcement_media_filename;
      currentVideoAnnouncementExpiresAt = settings.announcement_expires_at;
      videoAnnouncementActive = false;
      announcementVideo.src = newSrc;
      try {
        announcementVideo.load();
        const p = announcementVideo.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            videoAnnouncementActive = true;
          }).catch((err) => {
            console.warn('Auto-play blocked or failed:', err);
            videoAnnouncementActive = true;
          });
        } else {
          videoAnnouncementActive = true;
        }
      } catch (err) {
        console.warn('Video play attempt failed:', err);
        videoAnnouncementActive = true;
      }
    }
    announcementVideo.hidden = false;
    announcementImage.hidden = true;
    announcementImage.removeAttribute("src");
    announcementAudio.pause();
    announcementAudio.hidden = true;
    announcementAudio.removeAttribute("src");
    audioAnnouncementActive = false;
    currentAudioFilename = null;
    currentAudioAnnouncementExpiresAt = null;
  } else if (settings.announcement_media_type === "audio" && settings.announcement_media_filename) {
    const newSrc = `/uploads/${encodeURIComponent(settings.announcement_media_filename)}`;
    if (
      settings.announcement_media_filename !== currentAudioFilename
      || settings.announcement_expires_at !== currentAudioAnnouncementExpiresAt
    ) {
      currentAudioFilename = settings.announcement_media_filename;
      currentAudioAnnouncementExpiresAt = settings.announcement_expires_at;
      audioAnnouncementActive = true;
      announcementAudio.src = newSrc;
      if (!soundManager.canPlaySounds) {
        announcementAudio.load();
      } else {
        try {
          announcementAudio.load();
          const playback = announcementAudio.play();
          if (playback && typeof playback.then === "function") {
            playback.then(() => {
              audioAnnouncementActive = true;
            }).catch((error) => {
              console.warn("Audio auto-play blocked or failed:", error);
              audioAnnouncementActive = true;
            });
          } else {
            audioAnnouncementActive = true;
          }
        } catch (error) {
          console.warn("Audio play attempt failed:", error);
          audioAnnouncementActive = true;
        }
      }
    }
    announcementAudio.hidden = false;
    announcementImage.hidden = true;
    announcementImage.removeAttribute("src");
    announcementVideo.pause();
    announcementVideo.hidden = true;
    announcementVideo.removeAttribute("src");
    videoAnnouncementActive = false;
    currentVideoFilename = null;
    currentVideoAnnouncementExpiresAt = null;
  } else {
    announcementImage.hidden = true;
    announcementVideo.hidden = true;
    announcementImage.removeAttribute("src");
    announcementVideo.removeAttribute("src");
    announcementAudio.pause();
    announcementAudio.hidden = true;
    announcementAudio.removeAttribute("src");
    currentVideoFilename = null;
    currentVideoAnnouncementExpiresAt = null;
    videoAnnouncementActive = false;
    currentAudioFilename = null;
    currentAudioAnnouncementExpiresAt = null;
    audioAnnouncementActive = false;
  }

  announcementVideo.onended = () => {
    videoAnnouncementActive = false;
    announcement.hidden = true;
    previousAnnouncementVisible = false;
  };
  announcementAudio.onended = () => {
    audioAnnouncementActive = false;
    announcement.hidden = true;
    previousAnnouncementVisible = false;
  };
}

function updateTimer() {
  const stoppedAt = timerPausedAt || roomCompletedAt || roomFailedAt;
  const elapsedSeconds = timerStartedAt
    ? Math.max(0, Math.floor(
      (
        (stoppedAt ? Date.parse(stoppedAt) : Date.now())
        - Date.parse(timerStartedAt)
      ) / 1000,
    )) + penaltyTimeSeconds
    : 0;
  const remainingSeconds = (timerDurationSeconds + extraTimeSeconds) - elapsedSeconds;
  timer.textContent = formatDuration(remainingSeconds);
}

function updateRoomCompletion() {
  const isComplete = Boolean(roomCompletedAt);
  document.body.classList.toggle("room-complete", isComplete);
  if (previousRoomComplete !== null && !previousRoomComplete && isComplete) {
    soundManager.playSuccess();
  }

  if (!isComplete) {
    title.textContent = originalTitle;
    message.textContent = originalMessage;
    previousRoomComplete = isComplete;
    return;
  }

  message.textContent = completionMessage;
  previousRoomComplete = isComplete;
}

function updateRoomFailure(failedAt) {
  const isFailed = Boolean(failedAt);
  document.body.classList.toggle("room-failed", isFailed);
  if (previousRoomFailed !== null && !previousRoomFailed && isFailed) {
    soundManager.playFailed();
  }

  if (!isFailed) {
    if (!roomCompletedAt) {
      title.textContent = originalTitle;
      message.textContent = originalMessage;
    }
    previousRoomFailed = isFailed;
    return;
  }

  message.textContent = failureMessage;
  previousRoomFailed = isFailed;
}

function formatDuration(totalSeconds) {
  const negative = totalSeconds < 0;
  const absSeconds = Math.abs(totalSeconds);
  const minutes = String(Math.floor(absSeconds / 60)).padStart(2, "0");
  const seconds = String(absSeconds % 60).padStart(2, "0");
  return `${negative ? '-' : ''}${minutes}:${seconds}`;
}

function updateAnnouncement() {
  if (!announcementAudio.hidden) {
    const isActive = audioAnnouncementActive
      && announcementExpiresAt
      && Date.now() < Date.parse(announcementExpiresAt);
    announcement.hidden = !isActive;
    if (!isActive && !announcementAudio.paused) {
      announcementAudio.pause();
    }
    previousAnnouncementVisible = !announcement.hidden;
    return;
  }

  if (!announcementVideo.hidden) {
    announcement.hidden = !videoAnnouncementActive;
    if (!announcement.hidden && !previousAnnouncementVisible) {
      soundManager.playHint();
    }
    previousAnnouncementVisible = !announcement.hidden;
    return;
  }

  const hasContent = announcementMessage.textContent
    || !announcementImage.hidden;
  const isActive = hasContent
    && announcementExpiresAt
    && Date.now() < Date.parse(announcementExpiresAt);

  if (!isActive) {
    announcement.hidden = true;
    previousAnnouncementVisible = false;
    return;
  }

  announcement.hidden = false;
  if (!previousAnnouncementVisible) {
    soundManager.playHint();
  }
  previousAnnouncementVisible = true;
}

setInterval(() => {
  updateTimer();
  updateRoomCompletion();
  updateRoomFailure(roomFailedAt);
  updateAnnouncement();
  mediaManager?.tick();
}, 250);

let lastDisplaySnapshot = null;
let displayEventGeneration = 0;
let displayRefreshPending = false;

function applyDisplaySnapshot(settings) {
  const snapshot = JSON.stringify(settings, (_key, value) => (
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value
  ));
  if (snapshot === lastDisplaySnapshot) return;
  updateDisplay(settings);
  lastDisplaySnapshot = snapshot;
}

async function refreshDisplay() {
  if (displayRefreshPending) return;
  displayRefreshPending = true;
  const generation = displayEventGeneration;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("/api/display", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Display refresh failed: HTTP ${response.status}`);
    const settings = await response.json();
    if (generation === displayEventGeneration) applyDisplaySnapshot(settings);
  } catch (error) {
    console.warn("Unable to refresh kiosk display state.", error);
  } finally {
    clearTimeout(timeout);
    displayRefreshPending = false;
  }
}

if (window.initialDisplaySettings) applyDisplaySnapshot(window.initialDisplaySettings);

if (typeof EventSource !== "undefined") {
  const displayEvents = new EventSource("/events");
  displayEvents.addEventListener("display", (event) => {
    try {
      const settings = JSON.parse(event.data);
      applyDisplaySnapshot(settings);
      displayEventGeneration += 1;
    } catch (error) {
      console.warn("Unable to apply a kiosk live update.", error);
      refreshDisplay();
    }
  });
  displayEvents.addEventListener("error", () => {
    console.warn("Kiosk live updates disconnected; refreshing over HTTP.");
    refreshDisplay();
  });
} else {
  console.warn("Live updates are unavailable; refreshing the kiosk over HTTP.");
}

refreshDisplay();
setInterval(refreshDisplay, 5000);
window.addEventListener("online", refreshDisplay);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDisplay();
});
