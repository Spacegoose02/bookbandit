/**
 * First thing the app shows. With no server saved (or from Library > Change server), it asks for
 * the server address and an optional pairing code. Otherwise it checks the server answers and
 * opens it; if it doesn't, it offers the books saved on this PC.
 */
import "./styles.css";
import { errorText, native, type AppInfo } from "./bridge";
import { esc, splitPairLink } from "./format";

const app = document.getElementById("app")!;
const FACE = "/brand/barnaby-face.webp";
const FULL = "/brand/barnaby-full.webp";

function card(inner: string, hero = FULL): void {
  app.innerHTML = `<section class="card"><img class="hero" src="${hero}" alt="" />${inner}</section>`;
}

function setup(info: AppInfo, error = "", values = { address: info.serverUrl ?? "", code: "" }): void {
  card(`
    <h1>Book<b>Bandit</b></h1>
    <p class="lead">Connect this PC to your family's library.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <form id="f" novalidate>
      <label class="field">
        <span>Server address</span>
        <input id="address" name="address" autocomplete="url" spellcheck="false" placeholder="books.example.com or 192.168.1.20:8080"
          value="${esc(values.address)}" required autofocus />
        <small>The address you open BookBandit at in a browser. A pairing link works here too.</small>
      </label>
      <details class="pair" ${values.code ? "open" : ""}>
        <summary>Pair this PC with a code (optional)</summary>
        <label class="field">
          <span>Pairing code</span>
          <input id="code" name="code" spellcheck="false" autocomplete="off" placeholder="ABCD-1234" value="${esc(values.code)}" />
          <small>A parent makes one in BookBandit under People &gt; Devices. Pairing lets kids sign in here with their PIN or pictures.</small>
        </label>
      </details>
      <div class="actions">
        ${info.serverUrl ? `<button type="button" class="btn quiet" id="cancel">Cancel</button>` : ""}
        <button type="submit" class="btn primary" id="go">Connect</button>
      </div>
    </form>
    <p class="foot">${esc(info.deviceName)} · version ${esc(info.version)}</p>
  `);

  const form = document.getElementById("f") as HTMLFormElement;
  const address = document.getElementById("address") as HTMLInputElement;
  const code = document.getElementById("code") as HTMLInputElement;
  // A pasted pairing link fills in both boxes (on paste, on leaving the box, and on Connect).
  const splitLink = () => {
    const { address: a, code: c } = splitPairLink(address.value);
    if (!c) return;
    address.value = a;
    code.value = c;
    (code.closest("details") as HTMLDetailsElement).open = true;
  };
  address.addEventListener("paste", () => setTimeout(splitLink));
  address.addEventListener("change", splitLink);
  document.getElementById("cancel")?.addEventListener("click", () => void start(false));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    splitLink();
    const go = document.getElementById("go") as HTMLButtonElement;
    go.disabled = true;
    go.textContent = "Connecting…";
    const values = { address: address.value, code: code.value };
    try {
      await native.connect(values.address, values.code);
      await native.openServer();
    } catch (err) {
      setup({ ...info }, errorText(err), values);
    }
  });
}

function connecting(info: AppInfo): void {
  card(
    `<div class="spinner" role="progressbar" aria-label="Connecting"></div>
     <h1>Opening your library</h1>
     <p class="lead">${esc(info.serverUrl ?? "")}</p>`,
    FACE,
  );
}

function unreachable(info: AppInfo): void {
  card(`
    <h1>Can't reach your library</h1>
    <p class="lead">Barnaby couldn't reach <b>${esc(info.serverUrl ?? "")}</b>. You might be offline,
      or the server might be asleep. Books you saved on this PC still work.</p>
    <div class="actions">
      <button class="btn primary" id="offline">Read offline</button>
      <button class="btn" id="retry">Try again</button>
      <button class="btn quiet" id="change">Change server</button>
    </div>
  `);
  document.getElementById("offline")!.addEventListener("click", () => location.assign("/offline.html"));
  document.getElementById("retry")!.addEventListener("click", () => void start(false));
  document.getElementById("change")!.addEventListener("click", () => setup(info));
}

async function start(forceSetup: boolean): Promise<void> {
  const info = await native.appInfo();
  if (forceSetup || !info.serverUrl) return setup(info);
  connecting(info);
  if (await native.serverReachable().catch(() => false)) {
    try {
      await native.openServer();
      return;
    } catch (e) {
      return setup(info, errorText(e));
    }
  }
  unreachable(info);
}

const params = new URLSearchParams(location.search);
void start(params.has("setup"));
