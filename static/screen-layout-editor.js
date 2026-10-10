(function () {
  "use strict";
  const config = window.screenLayoutEditor;
  const engine = window.ScreenLayout;
  const stage = document.querySelector("#screen-layout-stage");
  const status = document.querySelector("#layout-status");
  const saveButton = document.querySelector("#layout-save");
  const cancelButton = document.querySelector("#layout-cancel");
  const resetButton = document.querySelector("#layout-reset-draft");
  const select = document.querySelector("#layout-element");
  const hintMode = document.querySelector("#layout-hint-mode");
  const previewHint = document.querySelector("#layout-preview-hint");
  const snap = document.querySelector("#layout-snap");
  const handle = document.querySelector("#layout-resize-handle");
  const fields = [...document.querySelectorAll("[data-layout-property]")];
  const blocks = [...stage.querySelectorAll("[data-layout-element]")];
  const translate = key => config.translations[`layout.${key}`] || key;
  const clone = value => JSON.parse(JSON.stringify(value));
  let saved = clone(config.layout || config.defaultLayout);
  let draft = clone(saved);
  let selected = "title";
  let pending = false;
  let drag = null;
  let frame = null;

  function setStatus(text, level = "info") {
    status.textContent = text;
    status.dataset.level = level;
  }

  function isDirty() {
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }

  function setPending(value) {
    pending = value;
    [saveButton, cancelButton, resetButton, select, hintMode, previewHint, snap, handle, ...fields]
      .forEach(control => { control.disabled = value; });
  }

  function render() {
    const result = engine.apply(stage, { screen_layout: draft, screen_layout_enabled: true });
    if (!result.active) throw new Error(result.error || translate("unavailable"));
    stage.style.setProperty("--screen-height-unit", `${stage.getBoundingClientRect().height / 100}px`);
    select.value = selected;
    hintMode.value = draft.hint_layout;
    const block = draft.elements[selected];
    fields.forEach(field => {
      const key = field.dataset.layoutProperty;
      if (key === "visible") field.checked = block.visible;
      else field.value = String(block[key]);
    });
    blocks.forEach(element => element.classList.toggle("selected", element.dataset.layoutElement === selected));
    handle.style.setProperty("--handle-x", `${block.x + block.width}%`);
    handle.style.setProperty("--handle-y", `${block.y + block.height}%`);
  }

  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      try { render(); } catch (error) { setStatus(error.message, "error"); }
    });
  }

  function changeGeometry(original, dx, dy, resize, name = selected) {
    const step = snap.checked ? 2 : 0.1;
    const rounded = number => Math.round(number / step) * step;
    const bounded = (number, low, high) => Math.round(Math.max(low, Math.min(high, number)) * 100) / 100;
    const block = { ...original };
    if (resize) {
      block.width = bounded(rounded(original.width + dx), 5, 100 - original.x);
      block.height = bounded(rounded(original.height + dy), 5, 100 - original.y);
    } else {
      block.x = bounded(rounded(original.x + dx), 0, 100 - original.width);
      block.y = bounded(rounded(original.y + dy), 0, 100 - original.height);
    }
    draft.elements[name] = block;
  }

  function finishDrag(cancelled = false) {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (cancelled) draft.elements[current.name] = current.original;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    render();
    if (stage.hasPointerCapture(current.id)) stage.releasePointerCapture(current.id);
  }

  setPending(true);
  try {
    if (!engine) throw new Error(translate("unavailable"));
    engine.validate(draft);
    render();
    setPending(false);
  } catch (error) {
    setStatus(`${translate("unavailable")} ${error.message}`, "error");
    return;
  }

  select.addEventListener("change", () => { selected = select.value; render(); });
  blocks.forEach(block => {
    block.addEventListener("focus", () => { selected = block.dataset.layoutElement; render(); });
  });
  fields.forEach(field => {
    field.addEventListener("change", () => {
      const key = field.dataset.layoutProperty;
      const next = clone(draft);
      try {
        if (key !== "visible" && key !== "align" && field.value.trim() === "") {
          throw new Error(translate("invalid"));
        }
        next.elements[selected][key] = key === "visible" ? field.checked
          : key === "align" ? field.value : Number(field.value);
        engine.validate(next);
        draft = next;
        render();
        setStatus(translate("unsaved"));
      } catch (error) {
        setStatus(`${translate("invalid")} ${error.message}`, "error");
        render();
      }
    });
  });
  hintMode.addEventListener("change", () => {
    draft.hint_layout = hintMode.value;
    render();
    setStatus(translate("unsaved"));
  });
  previewHint.addEventListener("change", () => {
    const hint = stage.querySelector('[data-layout-element="hints"]');
    hint.dataset.hasCaption = String(previewHint.value !== "media");
    hint.dataset.hasVisualMedia = String(previewHint.value !== "text");
    hint.querySelector("#announcement-message").hidden = previewHint.value === "media";
    hint.querySelector(".layout-media-placeholder").hidden = previewHint.value === "text";
  });

  stage.addEventListener("keydown", event => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction || pending) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : snap.checked ? 2 : 1;
    changeGeometry(draft.elements[selected], direction[0] * step, direction[1] * step, event.target === handle);
    render();
    setStatus(translate("unsaved"));
  });
  if (window.PointerEvent && typeof stage.setPointerCapture === "function") {
    stage.addEventListener("pointerdown", event => {
      if (event.button !== 0 || pending || drag) return;
      const resizing = event.target.closest("[data-layout-resize]");
      const block = event.target.closest("[data-layout-element]");
      if (!resizing && !block) return;
      if (block) selected = block.dataset.layoutElement;
      event.preventDefault();
      (resizing || block).focus({ preventScroll: true });
      render();
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      drag = { id: event.pointerId, name: selected, x: event.clientX, y: event.clientY, rect, original: { ...draft.elements[selected] }, resize: Boolean(resizing) };
      try { stage.setPointerCapture(event.pointerId); } catch (error) {
        drag = null;
        setStatus(`${translate("pointer_fallback")} ${error.message}`, "error");
      }
    });
    stage.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      changeGeometry(drag.original,
        (event.clientX - drag.x) * 100 / drag.rect.width,
        (event.clientY - drag.y) * 100 / drag.rect.height,
        drag.resize, drag.name);
      scheduleRender();
    });
    stage.addEventListener("pointerup", event => {
      if (!drag || event.pointerId !== drag.id) return;
      finishDrag();
      setStatus(translate("unsaved"));
    });
    stage.addEventListener("pointercancel", () => finishDrag(true));
    stage.addEventListener("lostpointercapture", () => finishDrag(true));
  } else {
    setStatus(translate("pointer_fallback"));
  }
  const resize = () => scheduleRender();
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
  } else {
    window.addEventListener("resize", resize);
  }
  window.addEventListener("beforeunload", event => {
    if (!isDirty() && !pending) return;
    event.preventDefault();
    event.returnValue = "";
  });
  cancelButton.addEventListener("click", () => {
    if (pending) return;
    finishDrag(true);
    draft = clone(saved);
    render();
    setStatus(translate("discarded"));
  });
  resetButton.addEventListener("click", () => {
    if (pending) return;
    finishDrag(true);
    draft = clone(config.defaultLayout);
    render();
    setStatus(translate("unsaved"));
  });
  saveButton.addEventListener("click", async () => {
    if (pending) return;
    finishDrag();
    setPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/admin/screen-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": window.csrfToken },
        body: JSON.stringify({ layout: draft, enabled: true }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || translate("save_failed"));
      saved = clone(engine.validate(payload.screen_layout));
      draft = clone(saved);
      render();
      document.querySelector("#layout-current-state").textContent = translate(
        config.serverDisabled ? "current_default" : "current_custom",
      );
      setStatus(translate(config.serverDisabled ? "saved_disabled" : "saved"));
    } catch (error) {
      setStatus(`${translate("save_failed")} ${error.message}`, "error");
    } finally {
      clearTimeout(timeout);
      setPending(false);
    }
  });
})();
