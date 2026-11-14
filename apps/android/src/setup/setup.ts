import jsQR from "jsqr";
import "../native.css";
import { BookBandit, errorMessage } from "../native";
import { insecureWarning, isPlausibleCode, isValidPin, normalizeServer, parsePairLink } from "../pairing";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const steps = ["step-choose", "step-scan", "step-details", "step-done"] as const;
type Step = (typeof steps)[number];

function show(step: Step) {
  for (const s of steps) $(s).hidden = s !== step;
  if (step !== "step-scan") stopCamera();
}

const serverInput = $<HTMLInputElement>("server");
const codeInput = $<HTMLInputElement>("code");
const nameInput = $<HTMLInputElement>("name");
const pinInput = $<HTMLInputElement>("pin");
const pin2Input = $<HTMLInputElement>("pin2");
const errorEl = $("error");
const warnEl = $("server-warn");
const pairBtn = $<HTMLButtonElement>("pair");

function fill(info: { server: string | null; code: string | null }) {
  if (info.server) serverInput.value = info.server;
  if (info.code) codeInput.value = info.code;
  updateWarning();
  show("step-details");
  (info.server && info.code ? nameInput : info.server ? codeInput : serverInput).focus();
}

function updateWarning() {
  const s = normalizeServer(serverInput.value);
  const w = s ? insecureWarning(s) : null;
  warnEl.hidden = !w;
  warnEl.textContent = w ?? "";
}

// ---- camera -------------------------------------------------------------------------------

let stream: MediaStream | null = null;
let raf = 0;

function stopCamera() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function startScan() {
  show("step-scan");
  const status = $("scan-status");
  const video = $<HTMLVideoElement>("video");
  status.textContent = "Looking for a BookBandit QR code…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
  } catch {
    status.textContent = "The camera isn't available. You can type the code instead.";
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let last = 0;
  const tick = (t: number) => {
    if (!stream) return;
    raf = requestAnimationFrame(tick);
    if (t - last < 150 || !ctx || video.readyState < 2) return;
    last = t;
    // Scale down: jsQR is fast on ~640px frames, and Fire tablets are slow.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (!hit) return;
    const info = parsePairLink(hit.data);
    if (info) {
      fill(info);
    } else {
      status.textContent = "That QR code isn't a BookBandit pairing code.";
    }
  };
  raf = requestAnimationFrame(tick);
}

// ---- pairing ------------------------------------------------------------------------------

async function pair(e: Event) {
  e.preventDefault();
  errorEl.textContent = "";
  const server = normalizeServer(serverInput.value);
  if (!server) {
    errorEl.textContent = "Check the server address.";
    serverInput.focus();
    return;
  }
  if (!isPlausibleCode(codeInput.value)) {
    errorEl.textContent = "Type the pairing code shown next to the QR code.";
    codeInput.focus();
    return;
  }
  const pin = pinInput.value.trim();
  if (pin && !isValidPin(pin)) {
    errorEl.textContent = "The PIN should be 4 to 8 digits.";
    pinInput.focus();
    return;
  }
  if (pin !== pin2Input.value.trim()) {
    errorEl.textContent = "The two PINs don't match.";
    pin2Input.focus();
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = "Pairing…";
  try {
    const res = await BookBandit.pair({ server, code: codeInput.value, name: nameInput.value.trim() || "Tablet", pin: pin || undefined });
    $("done-text").textContent = res.lockedToPerson
      ? `"${res.deviceName}" is connected and signs straight in. Opening the library…`
      : `"${res.deviceName}" is connected. Opening the library…`;
    show("step-done");
    setTimeout(() => location.replace("/"), 1200);
  } catch (err) {
    errorEl.textContent = errorMessage(err);
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = "Pair this tablet";
  }
}

// ---- wiring -------------------------------------------------------------------------------

$("choose-scan").addEventListener("click", () => void startScan());
$("choose-type").addEventListener("click", () => fill({ server: null, code: null }));
$("scan-cancel").addEventListener("click", () => fill({ server: null, code: null }));
$("back").addEventListener("click", () => show("step-choose"));
$("step-details").addEventListener("submit", (e) => void pair(e));
serverInput.addEventListener("input", updateWarning);
serverInput.addEventListener("blur", () => {
  const s = normalizeServer(serverInput.value);
  if (s) serverInput.value = s;
  updateWarning();
});

async function start() {
  // Opened from a scanned bookbandit://pair link: the details arrive in our query string, or
  // through the plugin when the app was started by the link.
  const fromQuery = new URLSearchParams(location.search);
  if (fromQuery.get("code")) {
    fill({ server: fromQuery.get("server") ? normalizeServer(fromQuery.get("server")!) : null, code: fromQuery.get("code") });
    return;
  }
  try {
    const state = await BookBandit.getState();
    if (state.paired && !fromQuery.has("again")) {
      location.replace("/");
      return;
    }
    if (state.pendingPairLink) {
      const info = parsePairLink(state.pendingPairLink);
      if (info) fill(info);
    }
  } catch {
    /* plain browser preview */
  }
}

void start();
