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
const teamInfo = document.querySelector("#team-info");
const teamName = document.querySelector("#team-name");
const teamDetails = document.querySelector("#team-details");
const soundManager = window.HomeAudio.createSoundManager(window.location.search);
announcementAudio.autoplay = soundManager.canPlaySounds;
let timerStartedAt = null;
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

function updateDisplay(settings) {
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
  timerPausedAt = settings.timer_paused_at;
  roomCompletedAt = settings.room_completed_at;
  roomFailedAt = settings.room_failed_at;
  announcementExpiresAt = settings.announcement_expires_at;
  extraTimeSeconds = settings.extra_time_seconds || 0;
  penaltyTimeSeconds = settings.penalty_time_seconds || 0;
  announcementMessage.textContent = settings.announcement || "";
  announcement.classList.toggle("full-screen", Boolean(settings.announcement_media_full_screen));
  updateAnnouncementMedia(settings);
  updateLatestResult(settings.latest_result);
  updateTimer();
  updateRoomCompletion();
  updateRoomFailure(roomFailedAt);
  updateAnnouncement();
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

function updateLatestResult(latestResult) {
  if (!teamInfo || !teamName || !teamDetails) {
    return;
  }

  if (!latestResult) {
    teamInfo.hidden = true;
    return;
  }

  teamName.textContent = latestResult.group_name;
  const remaining = latestResult.time_remaining_seconds >= 0
    ? window.translate("js.left", {
      value: formatDuration(latestResult.time_remaining_seconds),
    })
    : window.translate("js.overtime", {
      value: formatDuration(-latestResult.time_remaining_seconds),
    });
  teamDetails.textContent = [
    window.translate("js.players", { value: latestResult.group_size }),
    window.translate("js.hints", { value: latestResult.hints_used }),
    window.translate("js.penalties", { value: latestResult.penalties }),
    `${window.translate("js.time", {
      value: formatDuration(latestResult.time_taken_seconds),
    })} (${remaining})`,
  ].join(" • ");
  teamInfo.hidden = false;
}

function updateTimer() {
  const elapsedSeconds = timerStartedAt
    ? Math.floor(
      (
        Date.parse(timerPausedAt || roomCompletedAt || roomFailedAt || new Date())
        - Date.parse(timerStartedAt)
      ) / 1000,
    ) + penaltyTimeSeconds
    : 0;
  const remainingSeconds = (60 * 60 + extraTimeSeconds) - elapsedSeconds;
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
}, 250);

const displayEvents = new EventSource("/events");
displayEvents.addEventListener("display", (event) => updateDisplay(JSON.parse(event.data)));
