const h1 = document.querySelector("h1");
const h2 = document.querySelector("h2");
const urlParams = new URLSearchParams(window.location.search);
const type = urlParams.get("type");
const map = {
  clear: {
    h1: "Applying Patch (Enhanced v1.5.8)",
    h2: "Please wait while we apply the patch. Avoid using any Microsoft services during while using this setting.",
  },
  attach: {
    h1: "Attaching Debugger",
    h2: "Please wait while we attach the Debugger. You may be able to see a notification from the browser that the extension started debugging the browser.",
  },
  simulate: {
    h1: "Switching Simulation Device",
    h2: "Please wait while we switch the simulation device. You may be able to see a notification from the browser that the extension started debugging the browser.",
  },
  detach: {
    h1: "Detaching Simulation Device",
    h2: "Please wait while we detach the Debugger. You may be able to see a notification from the browser that the extension started debugging the browser will be removed.",
  },
  complete: {
    h1: "Completing specified Device searches.",
    h2: "Please wait while we complete the specified Device searches.",
  },
  default: {
    h1: "No action specified",
    h2: "Please specify an action to perform.",
  },
};
const patch = map[type] || map.default;
if (h1) h1.innerText = patch.h1;
if (h2) h2.innerText = patch.h2;
const screenWidth = screen.width;
const scale = screenWidth > 720 ? screenWidth / 1920 : 1;
document.body.style.setProperty("--scale", scale);
