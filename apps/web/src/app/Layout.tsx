import { NavLink, Outlet } from "react-router-dom";
import { isDemo } from "../api/client";
import { BarnabyEmpty, BarnabyLogo } from "../brand/Barnaby";
import { SignIn } from "../auth/SignIn";
import { AdminNavLinks } from "../admin/AdminLayout";
import { useSession } from "./session";

export function Layout() {
  const { me, error } = useSession();

  if (error === "signin") return <SignIn />;
  if (error)
    return (
      <BarnabyEmpty title="Barnaby can't reach the server">
        <p className="bb-muted">{error}</p>
      </BarnabyEmpty>
    );
  if (!me) return <div className="bb-boot" aria-busy="true" />;

  const kid = me.isKid;
  return (
    <div className={`bb-app${kid ? " is-kid" : ""}`}>
      <header className="bb-topbar">
        <NavLink to="/" className="bb-home-link" aria-label="BookBandit home">
          <BarnabyLogo size={kid ? 48 : 36} />
        </NavLink>
        <nav className="bb-nav" aria-label="Main">
          {kid ? (
            <>
              <NavLink to="/" end className="bb-nav-big">
                <span aria-hidden>📚</span> Books
              </NavLink>
              <NavLink to="/settings" className="bb-nav-big">
                <span aria-hidden>🎨</span> Colors
              </NavLink>
              {!isDemo && (
                <a href="/who" className="bb-nav-big">
                  <span aria-hidden>👋</span> Switch
                </a>
              )}
            </>
          ) : (
            <>
              <NavLink to="/" end>
                Home
              </NavLink>
              <NavLink to="/browse">Library</NavLink>
              <AdminNavLinks role={me.role} />
              <NavLink to="/settings">Settings</NavLink>
            </>
          )}
        </nav>
        <span className="bb-me" title={me.displayName}>
          {me.avatar ? <span aria-hidden>{me.avatar}</span> : null}
          <span>{me.displayName}</span>
        </span>
      </header>
      {isDemo && <div className="bb-demo-banner">Demo mode: sample books, nothing is saved to a server.</div>}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
