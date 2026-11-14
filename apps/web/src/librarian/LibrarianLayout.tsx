import { NavLink, Outlet } from "react-router-dom";
import "./librarian.css";

/** /admin/librarian/*: the tools Calibre's desktop app used to be needed for. Admin-only (AdminLayout checks). */
export function LibrarianLayout() {
  const tabs = [
    ["/admin/librarian", "Health"],
    ["/admin/librarian/duplicates", "Duplicates"],
    ["/admin/librarian/books", "Edit books"],
    ["/admin/librarian/convert", "Convert"],
  ];
  return (
    <div className="bb-librarian">
      <nav className="bb-lib-tabs" aria-label="Librarian">
        {tabs.map(([to, label]) => (
          <NavLink key={to} to={to!} end={to === "/admin/librarian"}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
