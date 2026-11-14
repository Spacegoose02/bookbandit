import { localTime, type RewardsSummary } from "@bookbandit/shared";
import { useSession } from "../app/session";
import { browserTimeZone } from "./api";
import "./fun.css";

export type Plot = { day: number; date: string; plant: "sunflower" | "tulip" | "soil" | "later"; label: string };

/**
 * This month's reading garden, one plot per day: a tulip for a day the reading goal was reached,
 * a sunflower for a day a book was finished. Days without either stay plain soil: nothing ever
 * wilts or goes away, so a missed day is never a loss.
 */
export function gardenPlots(s: Pick<RewardsSummary, "stickers" | "goal">, now: number, timeZone?: string): Plot[] {
  const tz = timeZone ?? s.goal?.timeZone ?? browserTimeZone();
  const today = localTime(now, tz);
  const [y, m] = today.month.split("-").map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const goalDays = new Set<string>();
  const bookDays = new Map<string, string[]>();
  for (const st of s.stickers) {
    if (st.reason === "goal_day") goalDays.add(st.key);
    if (st.reason === "book") {
      const d = localTime(st.earnedAt, tz).date;
      bookDays.set(d, [...(bookDays.get(d) ?? []), st.book?.title ?? "a book"]);
    }
  }
  return Array.from({ length: days }, (_, i) => {
    const day = i + 1;
    const date = `${today.month}-${String(day).padStart(2, "0")}`;
    const books = bookDays.get(date);
    if (date > today.date) return { day, date, plant: "later", label: `Day ${day}: still to come` };
    if (books) return { day, date, plant: "sunflower", label: `Day ${day}: finished ${books.join(" and ")}` };
    if (goalDays.has(date)) return { day, date, plant: "tulip", label: `Day ${day}: reading goal reached` };
    return { day, date, plant: "soil", label: `Day ${day}` };
  });
}

const PLANT: Record<Plot["plant"], string> = { sunflower: "🌻", tulip: "🌷", soil: "", later: "" };

export function ReadingGarden({ s, now = Date.now() }: { s: RewardsSummary; now?: number }) {
  const plots = gardenPlots(s, now);
  const flowers = plots.filter((p) => p.plant === "tulip" || p.plant === "sunflower").length;
  const month = new Date(`${plots[0]!.date}T12:00:00Z`).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
  return (
    <section className="bb-garden" aria-labelledby="bb-garden-h">
      <h2 className="bb-kid-h2" id="bb-garden-h">
        <span aria-hidden>🌱</span> My reading garden
      </h2>
      <p className="bb-garden-note">
        {flowers === 0
          ? `Reach your reading goal or finish a book to plant your first flower in ${month}!`
          : `${flowers} flower${flowers === 1 ? "" : "s"} in ${month}. 🌷 is a goal day, 🌻 is a finished book.`}
      </p>
      <ol className="bb-garden-bed">
        {plots.map((p) => (
          <li key={p.date} className={`bb-garden-plot is-${p.plant}`} aria-label={p.label} title={p.label}>
            <span aria-hidden>{PLANT[p.plant]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A short burst of paper confetti over a celebration. Decorative, plays once, never blocks a tap,
 * and isn't shown at all to people who asked for less motion.
 */
export function Confetti({ pieces = 28 }: { pieces?: number }) {
  const colors = ["var(--bb-accent)", "#ff6b8b", "#ffd43b", "#69db7c", "#74c0fc", "#b197fc"];
  return (
    <div className="bb-confetti" aria-hidden>
      {Array.from({ length: pieces }, (_, i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            background: colors[i % colors.length],
            animationDelay: `${(i % 7) * 70}ms`,
            ["--drift" as string]: `${((i * 53) % 120) - 60}px`,
            ["--spin" as string]: `${(i * 97) % 720}deg`,
          }}
        />
      ))}
    </div>
  );
}

/** The kid theme's picture scene (space, under the sea, castle…), when the theme has one. */
export function KidScene() {
  const { theme } = useSession();
  if (!theme.scene) return null;
  return <div className="bb-kid-scene" aria-hidden />;
}
