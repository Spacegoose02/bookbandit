import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThemeId } from "@bookbandit/shared";
import { api, ApiError } from "../api/client";
import type { Me } from "../api/types";
import { applyTheme, themeOrDefault, type Theme } from "../themes/themes";

interface Session {
  me: Me | null;
  error: string | null;
  theme: Theme;
  setTheme(id: ThemeId): void;
  /** Patch the local copy after a change saved on the server (e.g. a new display name). */
  updateMe(patch: Partial<Me>): void;
}

const SessionContext = createContext<Session | null>(null);
const THEME_CACHE = "bb-theme";

function cachedTheme(): Theme {
  try {
    return themeOrDefault(localStorage.getItem(THEME_CACHE));
  } catch {
    return themeOrDefault(null);
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Start with the last theme this device used so there's no flash of the wrong colors.
  const [theme, setThemeState] = useState<Theme>(cachedTheme);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setThemeState(themeOrDefault(m.theme));
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError && e.status === 401 ? "signin" : e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_CACHE, theme.id);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(themeOrDefault(id));
    setMe((m) => (m ? { ...m, theme: id } : m));
    api.setTheme(id).catch(() => {
      /* theme still applies on this device; it syncs next time */
    });
  }, []);

  const updateMe = useCallback((patch: Partial<Me>) => setMe((m) => (m ? { ...m, ...patch } : m)), []);

  const value = useMemo(() => ({ me, error, theme, setTheme, updateMe }), [me, error, theme, setTheme, updateMe]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
