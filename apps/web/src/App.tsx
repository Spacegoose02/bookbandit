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
import { SignIn } from "./auth/SignIn";
import { useSession } from "./app/session";
import { KidHome } from "./kid/KidHome";
import { StickerBookPage } from "./kid/Rewards";
import { EreadersPage } from "./ereader/EreadersPage";
import { BookPage } from "./library/BookPage";
import { BrowsePage } from "./library/BrowsePage";
import { HomePage } from "./library/HomePage";
import { flushAllPending } from "./reader/progressSync";
import { ReaderPage } from "./reader/ReaderPage";
import { RequestsPage } from "./requests/RequestsPage";
import { SettingsPage } from "./themes/ThemePicker";
import { AiSettingsPage } from "./ai/AiSettingsPage";
import { BarnabyPage } from "./ai/BarnabyPage";
import { FamilyAiPage } from "./ai/FamilyAiPage";
import { FindBookPage } from "./ai/FindBookPage";
import { ListenPage } from "./audio/ListenPage";
import { ManageCategoriesPage } from "./discover/ManageCategoriesPage";
import { AudioAdminPage } from "./audio/AudioAdminPage";
import { StorytellerGate } from "./storyteller/StorytellerGate";
import { StorytellerPage } from "./storyteller/StorytellerPage";
import { StorytellerSetup } from "./storyteller/StorytellerSetup";
import { CategoriesPage, CategoryPageView } from "./discover/CategoriesPage";
import { CookbookPage } from "./discover/CookbookPage";
import { DiscoverPage } from "./discover/DiscoverPage";
import { KindleImportPage } from "./discover/KindleImportPage";
import { ImportPage } from "./imports/ImportPage";
import { SeriesListPage } from "./series/SeriesListPage";
import { SeriesPage } from "./series/SeriesPage";
import { NarrationSettingsPage } from "./readaloud/NarrationSettingsPage"; // ws/readaloud
import { LibrarianLayout } from "./librarian/LibrarianLayout";
import { HealthPage } from "./librarian/HealthPage";
import { DuplicatesPage } from "./librarian/DuplicatesPage";
import { BooksPage } from "./librarian/BooksPage";
import { ConvertPage } from "./librarian/ConvertPage";

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
      <Route path="/who" element={<SignIn switching />} />
      <Route path="/read/:id" element={me ? <ReaderPage /> : null} />
      <Route path="/storyteller" element={me ? <StorytellerPage /> : null} />
      <Route path="/cook/:id" element={me ? <CookbookPage /> : null} />
      <Route element={<Layout />}>
        <Route index element={me?.isKid ? <StorytellerGate fallback={<KidHome />} /> : <HomePage />} />
        <Route path="browse" element={me?.isKid ? <Navigate to="/" replace /> : <BrowsePage />} />
        <Route path="book/:id" element={<BookPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="stickers" element={<StickerBookPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="barnaby" element={<BarnabyPage />} />
        <Route path="barnaby/family" element={<FamilyAiPage />} />
        <Route path="barnaby/find" element={<FindBookPage />} />
        <Route path="barnaby/settings" element={<AiSettingsPage />} />
        <Route path="listen/:id" element={<ListenPage />} />
        <Route path="storyteller/setup" element={<StorytellerSetup />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="discover/kindle-import" element={<KindleImportPage />} />
        <Route path="series" element={<SeriesListPage />} />
        <Route path="series/:id" element={<SeriesPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="categories/:id" element={<CategoryPageView />} />
        <Route path="settings/ereaders" element={<EreadersPage />} />
        <Route path="readaloud/settings" element={<NarrationSettingsPage />} /> {/* ws/readaloud */}
        <Route path="admin" element={<AdminLayout area="admin" />}>
          <Route index element={<AdminHome />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="settings" element={<ConnectionsPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="audio" element={<AudioAdminPage />} />
          <Route path="categories" element={<ManageCategoriesPage />} /> {/* ws/discover */}
          <Route path="librarian" element={<LibrarianLayout />}>
            <Route index element={<HealthPage />} />
            <Route path="duplicates" element={<DuplicatesPage />} />
            <Route path="books" element={<BooksPage />} />
            <Route path="convert" element={<ConvertPage />} />
          </Route>
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
