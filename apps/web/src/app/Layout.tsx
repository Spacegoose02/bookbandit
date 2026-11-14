import { NavLink, Outlet } from "react-router-dom";
import { isDemo } from "../api/client";
import { BarnabyEmpty, BarnabyLogo } from "../brand/Barnaby";
import { useSession } from "./session";

export function Layout() {
  const { me, error } = useSession();

  if (error === "signin")
    return (
      <BarnabyEmpty title="Please sign in">
        <p>BookBandit couldn't tell who you are. Sign in through your family's login page, then come back.</p>
      </BarnabyEmpty>
    );
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
            </>
          ) : (
            <>
              <NavLink to="/" end>
                Home
              </NavLink>
              <NavLink to="/browse">Library</NavLink>
              <NavLink to="/settings" end>
                Appearance
              </NavLink>
              <NavLink to="/settings/ereaders">E-readers</NavLink>
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
