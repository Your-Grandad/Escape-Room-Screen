const passwordInput = document.getElementById("login-password");
const showPassword = document.getElementById("show-password");

showPassword.addEventListener("change", () => {
  passwordInput.type = showPassword.checked ? "text" : "password";
});
