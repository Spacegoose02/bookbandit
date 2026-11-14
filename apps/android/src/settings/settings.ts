import "../native.css";
import { BookBandit, errorCode, errorMessage, formatBytes, pickReadableFile, retryAfterMs, type NativeState } from "../native";
import { isValidPin } from "../pairing";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The PIN typed at the gate, reused for the settings that need it (the native side re-checks). */
let pin = "";
let state: NativeState;

// ---- PIN gate -----------------------------------------------------------------------------

function renderDots(n: number) {
  $("dots").innerHTML = Array.from({ length: Math.max(4, n) }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
}

function buildPad(onDone: (pin: string) => void) {
  let typed = "";
  const pad = $("pad");
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"];
  pad.innerHTML = "";
  for (const k of keys) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = k;
    b.setAttribute("aria-label", k === "⌫" ? "Delete" : k === "OK" ? "Enter" : k);
    b.addEventListener("click", () => {
      if (k === "⌫") typed = typed.slice(0, -1);
      else if (k === "OK") {
        if (typed.length >= 4) onDone(typed);
        typed = "";
      } else if (typed.length < 8) typed += k;
      renderDots(typed.length);
    });
    pad.appendChild(b);
  }
  renderDots(0);
}

async function gate(): Promise<void> {
  if (!state.hasPin) return;
  $("gate").hidden = false;
  await new Promise<void>((resolve) => {
    buildPad(async (guess) => {
      try {
        await BookBandit.checkPin({ pin: guess });
        pin = guess;
        $("gate").hidden = true;
        resolve();
      } catch (e) {
        const wait = retryAfterMs(e);
        $("gate-error").textContent = wait > 0 ? `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.` : "That PIN isn't right.";
      }
    });
  });
}

// ---- offline books ------------------------------------------------------------------------

async function renderDownloads() {
  const { items, usedBytes, freeBytes } = await BookBandit.listDownloads();
  $("offline-summary").textContent = items.length
    ? `${items.length} book${items.length === 1 ? "" : "s"} saved for ${state.role === "kid" ? "this kid" : "this reader"}, using ${formatBytes(usedBytes)}. ${formatBytes(freeBytes)} free.`
    : "Nothing saved yet. Use \"Save for offline\" on a book's page, or the button below.";
  const ul = $("downloads");
  ul.innerHTML = "";
  for (const b of items) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "grow";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = b.title || "Untitled";
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `${b.format.toUpperCase()} · ${formatBytes(b.sizeBytes)}`;
    info.append(title, meta);
    const remove = document.createElement("button");
    remove.className = "btn";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      await BookBandit.removeDownload({ bookId: b.bookId });
      void renderDownloads();
    });
    li.append(info, remove);
    ul.appendChild(li);
  }
}

interface ShelfJson {
  items: { id: string; kind: string; books: { id: string }[] }[];
}

/** Saves the books on the current reader's home shelves (up to 20), e.g. before a car trip. */
async function downloadShelves() {
  const status = $("download-status");
  const btn = $<HTMLButtonElement>("download-shelves");
  btn.disabled = true;
  status.textContent = "Finding books…";
  try {
    const res = await fetch("/api/shelves", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(res.status === 503 ? "You're offline." : `HTTP ${res.status}`);
    const shelves = (await res.json()) as ShelfJson;
    const ids = [...new Set(shelves.items.filter((s) => s.id !== "downloaded").flatMap((s) => s.books.map((b) => b.id)))].slice(0, 20);
    let queued = 0;
    for (const id of ids) {
      const d = await fetch(`/api/books/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
      if (!d.ok) continue;
      const detail = (await d.json()) as { files?: { id: string; format: string }[] };
      const file = pickReadableFile(detail.files);
      if (!file) continue;
      if ((await BookBandit.downloadStatus({ bookId: id })).status === "done") continue;
      await BookBandit.download({ bookId: id, fileId: file.id });
      queued++;
    }
    status.textContent = queued ? `Saving ${queued} book${queued === 1 ? "" : "s"}. They appear above when done.` : "Everything on the shelves is already saved.";
  } catch (e) {
    status.textContent = `Couldn't save the shelves: ${errorMessage(e)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- kid safety and PIN -------------------------------------------------------------------

async function wireSafety() {
  const auto = $<HTMLInputElement>("auto-pin");
  auto.checked = state.autoPinKids;
  auto.addEventListener("change", async () => {
    try {
      await BookBandit.setAutoPinKids({ value: auto.checked, pin });
    } catch {
      auto.checked = !auto.checked;
    }
  });
  $("pin-now").addEventListener("click", () => void BookBandit.pinScreen().catch((e) => alertInline(e)));
  $("unpin").addEventListener("click", () => void BookBandit.unpinScreen({ pin }).catch((e) => alertInline(e)));

  $("save-pin").addEventListener("click", async () => {
    const a = $<HTMLInputElement>("new-pin").value.trim();
    const b = $<HTMLInputElement>("new-pin2").value.trim();
    const out = $("pin-status");
    if (!isValidPin(a)) {
      out.textContent = "The PIN should be 4 to 8 digits.";
      return;
    }
    if (a !== b) {
      out.textContent = "The two PINs don't match.";
      return;
    }
    try {
      await BookBandit.setPin({ oldPin: pin, newPin: a });
      pin = a;
      out.textContent = "PIN changed.";
      $<HTMLInputElement>("new-pin").value = "";
      $<HTMLInputElement>("new-pin2").value = "";
    } catch (e) {
      out.textContent = errorMessage(e);
    }
  });
}

function alertInline(e: unknown) {
  $("pin-status").textContent = errorMessage(e);
}

// ---- this tablet --------------------------------------------------------------------------

function wireTablet() {
  $("device-name").textContent = state.deviceName;
  $("server").textContent = state.server ?? "";
  $("locked").textContent = state.lockedToPerson ? "One person (this is their own tablet)" : "Anyone in the family (\"Who's reading?\")";
  $("version").textContent = state.appVersion;

  let armed = false;
  const btn = $<HTMLButtonElement>("unpair");
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Tap again to unpair and delete offline books";
      setTimeout(() => {
        armed = false;
        btn.textContent = "Unpair this tablet";
      }, 5000);
      return;
    }
    try {
      await BookBandit.unpair({ pin });
      location.replace("/native/setup.html");
    } catch (e) {
      $("unpair-status").textContent = errorCode(e) === "WRONG_PIN" ? "The PIN changed. Open settings again." : errorMessage(e);
    }
  });
}

async function start() {
  state = await BookBandit.getState();
  if (!state.paired) {
    location.replace("/native/setup.html");
    return;
  }
  await gate();
  $("content").hidden = false;
  $("who").textContent = `${state.deviceName} · ${state.server ?? ""}`;
  wireTablet();
  await wireSafety();
  $("download-shelves").addEventListener("click", () => void downloadShelves());
  BookBandit.addListener("download", (e) => {
    if (e.status === "done" || e.status === "error") void renderDownloads();
    if (e.status === "error") $("download-status").textContent = e.error ?? "A download failed.";
  });
  await renderDownloads();
}

void start();
