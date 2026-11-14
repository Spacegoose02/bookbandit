import { NavLink, Outlet } from "react-router-dom";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import "./admin.css";

/**
 * Shell for /admin/* (admin only) and /family/* (parents and admins). The server enforces the
 * same rules; this only avoids showing pages that would answer 403.
 */
export function AdminLayout({ area }: { area: "admin" | "family" }) {
  const { me } = useSession();
  if (!me) return null;
  const allowed = area === "admin" ? me.role === "admin" : me.role === "admin" || me.role === "parent";
  if (!allowed)
    return (
      <BarnabyEmpty title={area === "admin" ? "Admins only" : "For parents"}>
        <p>{area === "admin" ? "Only a family admin can open these settings." : "Only a parent or admin can see the family dashboard."}</p>
      </BarnabyEmpty>
    );

  const tabs =
    area === "admin"
      ? [
          ["/admin", "Overview"],
          ["/admin/inbox", "Inbox"],
          ["/admin/review", "Needs a rating"],
          ["/admin/librarian", "Librarian"],
          ["/admin/people", "People & devices"],
          ["/admin/settings", "Connections"],
          ["/admin/import", "Move in"],
          ["/barnaby/settings", "Barnaby AI"],
          ["/family", "Family"],
        ]
      : [
          ["/family", "Kids"],
          ["/family/people", "Manage kids & devices"],
          ["/barnaby/family", "Barnaby chats"],
          ...(me.role === "admin" ? [["/admin", "Admin"]] : []),
        ];

  return (
    <div className="bb-page bb-admin">
      <nav className="bb-admin-tabs" aria-label={area === "admin" ? "Admin" : "Family"}>
        {tabs.map(([to, label]) => (
          <NavLink key={to} to={to!} end={to === "/admin" || to === "/family"}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

/**
 * Links for the main nav. The app shell (src/app/Layout.tsx) can drop this in with one line:
 * `<AdminNavLinks role={me.role} />`. Renders nothing for kids and plain adults.
 */
export function AdminNavLinks({ role }: { role: string }) {
  if (role !== "admin" && role !== "parent") return null;
  return (
    <>
      <NavLink to="/family">Family</NavLink>
      {role === "admin" && <NavLink to="/admin">Admin</NavLink>}
    </>
  );
}
