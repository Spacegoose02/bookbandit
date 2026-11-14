import { NavLink } from "react-router-dom";
import "./discover.css";

/** Small row of links into Discover, Series and Categories (until the lead adds them to the main nav). */
export function ExploreLinks() {
  return (
    <nav className="bb-explore" aria-label="Explore">
      <NavLink to="/discover" className="bb-explore-link">
        <span aria-hidden>✨</span> Discover
      </NavLink>
      <NavLink to="/series" className="bb-explore-link">
        <span aria-hidden>📚</span> Series
      </NavLink>
      <NavLink to="/categories" className="bb-explore-link">
        <span aria-hidden>🏷️</span> Categories
      </NavLink>
    </nav>
  );
}
