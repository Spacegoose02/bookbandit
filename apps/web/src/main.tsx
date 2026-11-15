import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { BarnabyLauncher } from "./ai/BarnabyLauncher";
import { SessionProvider } from "./app/session";
import { BookEditHost } from "./admin/BookEditHost";
import { BedtimeScreen } from "./kid/Bedtime";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <BookEditHost>
          <App />
        </BookEditHost>
        <BarnabyLauncher />
        <BedtimeScreen />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
