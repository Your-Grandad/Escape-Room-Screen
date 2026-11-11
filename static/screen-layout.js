(function () {
  "use strict";
  const names = ["title", "message", "logo", "timer", "hints"];
  const properties = ["x", "y", "width", "height", "font_size", "align", "visible"];
  const modes = ["stacked", "side-by-side", "text-only", "media-only"];
  const applied = new WeakMap();

  function validate(layout) {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)
      || !["elements,hint_layout,version", "elements,hint_layout,result_layouts,version"]
        .includes(Object.keys(layout).sort().join(","))
      || layout.version !== 1 || !modes.includes(layout.hint_layout)
      || !layout.elements) {
      throw new Error("Invalid screen layout.");
    }
    validateElements(layout.elements, names);
    if (Object.hasOwn(layout, "result_layouts")) {
      const results = layout.result_layouts;
      if (!results || Object.keys(results).sort().join(",") !== "complete,failed") {
        throw new Error("Invalid result layouts.");
      }
      for (const name of ["complete", "failed"]) {
        if (!results[name] || Object.keys(results[name]).join(",") !== "elements") {
          throw new Error(`Invalid result layout: ${name}.`);
        }
        validateElements(results[name].elements, names.filter(name => name !== "hints"));
      }
    }
    return layout;
  }

  function validateElements(elements, expected) {
    if (!elements || Object.keys(elements).sort().join(",") !== [...expected].sort().join(",")) {
      throw new Error("Invalid screen elements.");
    }
    for (const name of expected) {
      const element = elements[name];
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
      const screen = options.screen || (settings.room_failed_at ? "failed"
        : settings.room_completed_at ? "complete" : "normal");
      const enabled = settings.screen_layout_enabled === true
        && !options.forceDefault && root.dataset.layoutDisabled !== "true";
      key = JSON.stringify([enabled, screen, enabled ? settings.screen_layout : null]);
      const previous = applied.get(root);
      if (previous && previous.key === key) return previous.result;
      if (!enabled) {
        clear(root);
        const result = { active: false, error: null };
        applied.set(root, { key, result });
        return result;
      }
      const layout = validate(settings.screen_layout);
      const design = screen === "normal" ? layout : layout.result_layouts?.[screen];
      if (!design) {
        clear(root);
        const result = { active: false, error: null };
        applied.set(root, { key, result });
        return result;
      }
      if (getComputedStyle(root).getPropertyValue("--screen-layout-ready").trim() !== "1") {
        throw new Error("Screen layout styles are unavailable.");
      }
      clear(root);
      const activeNames = Object.keys(design.elements);
      const elements = activeNames.map(name => {
        const element = root.querySelector(`[data-layout-element="${name}"]`);
        if (!element) throw new Error(`Missing screen element: ${name}.`);
        return element;
      });
      elements.forEach((element, index) => {
        const values = design.elements[activeNames[index]];
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
