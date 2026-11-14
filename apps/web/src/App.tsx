import { useEffect } from "react";
import { AdminHome } from "./admin/AdminHome";
import { AdminLayout } from "./admin/AdminLayout";
import { ConnectionsPage } from "./admin/ConnectionsPage";
import { InboxPage, ReviewPage } from "./admin/InboxPage";
import { PeoplePage } from "./admin/PeoplePage";
import { FamilyPage, KidPage } from "./family/FamilyPage";
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
      <Route element={<Layout />}>
        <Route index element={me?.isKid ? <KidHome /> : <HomePage />} />
        <Route path="browse" element={me?.isKid ? <Navigate to="/" replace /> : <BrowsePage />} />
        <Route path="book/:id" element={<BookPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminLayout area="admin" />}>
          <Route index element={<AdminHome />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="settings" element={<ConnectionsPage />} />
        </Route>
        <Route path="family" element={<AdminLayout area="family" />}>
          <Route index element={<FamilyPage />} />
          <Route path="kids/:id" element={<KidPage />} />
          <Route path="people" element={<PeoplePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
