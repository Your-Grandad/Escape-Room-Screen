(function () {
  "use strict";
  const names = ["title", "message", "logo", "timer", "hints"];
  const properties = ["x", "y", "width", "height", "font_size", "align", "visible"];
  const modes = ["stacked", "side-by-side", "text-only", "media-only"];
  const applied = new WeakMap();

  function validate(layout) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)
      || Object.keys(layout).sort().join(",") !== "elements,hint_layout,version"
      || layout.version !== 1 || !modes.includes(layout.hint_layout)
      || !layout.elements || Object.keys(layout.elements).sort().join(",") !== [...names].sort().join(",")) {
      throw new Error("Invalid screen layout.");
    }
    for (const name of names) {
      const element = layout.elements[name];
      if (!element || Object.keys(element).sort().join(",") !== [...properties].sort().join(",")
        || !["left", "center", "right"].includes(element.align)
        || typeof element.visible !== "boolean"
        || !["x", "y", "width", "height", "font_size"].every(key => (
          typeof element[key] === "number" && Number.isFinite(element[key])
        ))
        || element.x < 0 || element.y < 0 || element.width < 5 || element.height < 5
        || element.x + element.width > 100 || element.y + element.height > 100
        || element.font_size < 0.5 || element.font_size > 20) {
        throw new Error(`Invalid screen layout element: ${name}.`);
      }
    }
    return layout;
  }

  function clear(root) {
    root.classList.remove("custom-layout");
    root.removeAttribute("data-hint-layout");
    root.querySelectorAll("[data-layout-element]").forEach(element => {
      for (const key of properties) element.style.removeProperty(`--layout-${key.replace("_", "-")}`);
      element.removeAttribute("data-layout-hidden");
    });
  }

  function apply(root, settings, options = {}) {
    let key;
    try {
      const enabled = settings.screen_layout_enabled === true
        && !options.forceDefault && root.dataset.layoutDisabled !== "true";
      key = JSON.stringify([enabled, enabled ? settings.screen_layout : null]);
      const previous = applied.get(root);
      if (previous && previous.key === key) return previous.result;
      if (!enabled) {
        clear(root);
        const result = { active: false, error: null };
        applied.set(root, { key, result });
        return result;
      }
      const layout = validate(settings.screen_layout);
      if (getComputedStyle(root).getPropertyValue("--screen-layout-ready").trim() !== "1") {
        throw new Error("Screen layout styles are unavailable.");
      }
      const elements = names.map(name => {
        const element = root.querySelector(`[data-layout-element="${name}"]`);
        if (!element) throw new Error(`Missing screen element: ${name}.`);
        return element;
      });
      elements.forEach((element, index) => {
        const values = layout.elements[names[index]];
        for (const property of ["x", "y", "width", "height"]) {
          element.style.setProperty(`--layout-${property}`, `${values[property]}%`);
        }
        element.style.setProperty("--layout-font-size", String(values.font_size));
        element.style.setProperty("--layout-align", values.align);
        element.dataset.layoutHidden = String(!values.visible);
      });
      root.dataset.hintLayout = layout.hint_layout;
      root.classList.add("custom-layout");
      const result = { active: true, error: null };
      applied.set(root, { key, result });
      return result;
    } catch (error) {
      clear(root);
      console.warn("Custom screen layout unavailable; using the default screen.", error);
      const result = { active: false, error: error.message };
      applied.set(root, { key, result });
      return result;
    }
  }

  window.ScreenLayout = { apply, validate };
})();
