import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api/client";
import { Layout } from "./app/Layout";
import { useSession } from "./app/session";
import { KidHome } from "./kid/KidHome";
import { BookPage } from "./library/BookPage";
import { BrowsePage } from "./library/BrowsePage";
import { HomePage } from "./library/HomePage";
import { flushAllPending } from "./reader/progressSync";
import { ReaderPage } from "./reader/ReaderPage";
import { SettingsPage } from "./themes/ThemePicker";
import { ListenPage } from "./audio/ListenPage";
import { StorytellerGate } from "./storyteller/StorytellerGate";
import { StorytellerPage } from "./storyteller/StorytellerPage";
import { StorytellerSetup } from "./storyteller/StorytellerSetup";

export function App() {
  const { me } = useSession();

  // Send any reading positions saved while offline, now and whenever the network returns.
  useEffect(() => {
    if (!me) return;
    const flush = () => void flushAllPending(api, localStorage);
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [me]);

  return (
    <Routes>
      <Route path="/read/:id" element={me ? <ReaderPage /> : null} />
      <Route path="/storyteller" element={me ? <StorytellerPage /> : null} />
      <Route element={<Layout />}>
        <Route index element={me?.isKid ? <StorytellerGate fallback={<KidHome />} /> : <HomePage />} />
        <Route path="browse" element={me?.isKid ? <Navigate to="/" replace /> : <BrowsePage />} />
        <Route path="book/:id" element={<BookPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="listen/:id" element={<ListenPage />} />
        <Route path="storyteller/setup" element={<StorytellerSetup />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
