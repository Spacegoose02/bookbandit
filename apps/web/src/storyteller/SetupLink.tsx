import { Link } from "react-router-dom";
import { useSession } from "../app/session";
import "./storyteller.css";

/** Settings section for grown-ups who can manage kids: a way into story time setup. */
export function StorytellerSetupLink() {
  const { me } = useSession();
  if (!me || (me.role !== "parent" && me.role !== "admin")) return null;
  return (
    <section className="bb-settings-section">
      <h2>Story time for little ones</h2>
      <p className="bb-muted">Pick bedtime stories for a toddler's profile and set how many they get each night.</p>
      <Link className="bb-btn" to="/storyteller/setup">
        <span aria-hidden>🌙</span> Set up story time
      </Link>
    </section>
  );
}
