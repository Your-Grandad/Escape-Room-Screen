(() => {
  const storageKey = "escape-room-admin-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let preferredTheme = null;

  try {
    const savedTheme = localStorage.getItem(storageKey);
    if (savedTheme === "light" || savedTheme === "dark") {
      preferredTheme = savedTheme;
    } else if (savedTheme !== null) {
      console.warn("Ignoring an invalid saved admin theme:", savedTheme);
    }
  } catch (error) {
    console.warn("Unable to read the saved admin theme.", error);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.adminTheme = theme;
    document.querySelectorAll("[data-admin-theme-toggle]").forEach((button) => {
      const dark = theme === "dark";
      button.setAttribute("aria-pressed", String(dark));
      button.querySelector("[data-theme-state]").textContent = dark
        ? button.dataset.onLabel
        : button.dataset.offLabel;
    });
  }

  function currentTheme() {
    return preferredTheme || (systemTheme.matches ? "dark" : "light");
  }

  applyTheme(currentTheme());

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(currentTheme());
    document.querySelectorAll("[data-admin-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        preferredTheme = document.documentElement.dataset.adminTheme === "dark"
          ? "light"
          : "dark";
        applyTheme(preferredTheme);
        try {
          localStorage.setItem(storageKey, preferredTheme);
        } catch (error) {
          console.warn("Unable to save the admin theme preference.", error);
        }
      });
    });
  });

  systemTheme.addEventListener("change", () => {
    if (preferredTheme === null) applyTheme(currentTheme());
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    const value = event.key === null ? null : event.newValue;
    if (value !== null && value !== "light" && value !== "dark") {
      console.warn("Ignoring an invalid admin theme update:", value);
      return;
    }
    preferredTheme = value;
    applyTheme(currentTheme());
  });
})();
