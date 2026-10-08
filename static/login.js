const passwordInput = document.getElementById("login-password");
const showPassword = document.getElementById("show-password");

showPassword.addEventListener("click", () => {
  const revealing = passwordInput.type === "password";
  passwordInput.type = revealing ? "text" : "password";
  showPassword.setAttribute("aria-pressed", String(revealing));
  showPassword.setAttribute(
    "aria-label",
    revealing ? showPassword.dataset.hideLabel : showPassword.dataset.showLabel,
  );
  showPassword.title = showPassword.getAttribute("aria-label");
  showPassword.querySelector(".icon-eye").hidden = revealing;
  showPassword.querySelector(".icon-eye-off").hidden = !revealing;
});
