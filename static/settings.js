function setupColourControl(name) {
  const picker = document.querySelector(`#${name}-picker`);
  const hexInput = document.querySelector(`#${name}-hex`);
  const preview = document.querySelector(`#${name}-preview`);
  const acceptButton = document.querySelector(`[data-accept-colour="${name}"]`);
  const hexPattern = /^#[0-9a-fA-F]{6}$/;

  function updatePreview(value) {
    if (hexPattern.test(value)) {
      preview.style.background = value;
    }
  }

  acceptButton.addEventListener("click", () => {
    hexInput.value = picker.value;
    updatePreview(picker.value);
  });

  picker.addEventListener("input", () => updatePreview(picker.value));
  hexInput.addEventListener("input", () => {
    if (hexPattern.test(hexInput.value)) {
      picker.value = hexInput.value;
      updatePreview(hexInput.value);
    }
  });
}

setupColourControl("background");
setupColourControl("accent");

function setupImagePreview(name) {
  const input = document.querySelector(`[name="${name}_image"]`);
  const preview = document.querySelector(`#${name}-image-preview`);
  const error = document.querySelector(`#${name}-image-preview-error`);
  const remove = document.querySelector(`[name="remove_${name}_image"]`);
  const savedSource = preview.getAttribute("src");
  let objectUrl = null;

  function updatePreview() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const file = input.files[0];
    objectUrl = file ? URL.createObjectURL(file) : null;
    const source = objectUrl || (remove?.checked ? null : savedSource);
    error.hidden = true;
    preview.hidden = !source;
    if (source) preview.src = source;
    else preview.removeAttribute("src");
  }

  function showPreviewError() {
    if (!preview.getAttribute("src")) return;
    preview.hidden = true;
    error.hidden = false;
  }

  input.addEventListener("change", updatePreview);
  remove?.addEventListener("change", updatePreview);
  preview.addEventListener("error", showPreviewError);
  preview.addEventListener("load", () => {
    if (!preview.getAttribute("src")) return;
    preview.hidden = false;
    error.hidden = true;
  });
  if (savedSource && preview.complete && preview.naturalWidth === 0) showPreviewError();
}

setupImagePreview("background");
setupImagePreview("logo");
