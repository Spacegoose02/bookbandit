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
import { CategoriesPage, CategoryPageView } from "./discover/CategoriesPage";
import { CookbookPage } from "./discover/CookbookPage";
import { DiscoverPage } from "./discover/DiscoverPage";
import { KindleImportPage } from "./discover/KindleImportPage";
import { SeriesListPage } from "./series/SeriesListPage";
import { SeriesPage } from "./series/SeriesPage";

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
      <Route path="/cook/:id" element={me ? <CookbookPage /> : null} />
      <Route element={<Layout />}>
        <Route index element={me?.isKid ? <KidHome /> : <HomePage />} />
        <Route path="browse" element={me?.isKid ? <Navigate to="/" replace /> : <BrowsePage />} />
        <Route path="book/:id" element={<BookPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="discover/kindle-import" element={<KindleImportPage />} />
        <Route path="series" element={<SeriesListPage />} />
        <Route path="series/:id" element={<SeriesPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="categories/:id" element={<CategoryPageView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
