import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ContentRating, RewardsSummary } from "@bookbandit/shared";
import { api } from "../api/client";
import type { BookSummary, Shelf } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { Cover } from "../library/BookCard";
import { rewardsApi } from "./api";
import { wakeTime } from "./Bedtime";
import { BadgeShelf, Celebration, GoalPanel } from "./Rewards";
import { BookSpinner } from "./BookSpinner";
import { KidScene } from "./Garden";
import { familyAppsApi } from "../family-apps/api";
import "./kid.css";

/** Kid-friendly names for the age groups a kid can see. */
const AGE_ROWS: { rating: ContentRating; emoji: string; title: string }[] = [
  { rating: "kids", emoji: "🧸", title: "Picture books and early readers" },
  { rating: "middle_grade", emoji: "🗺️", title: "Chapter books" },
  { rating: "teen", emoji: "🎧", title: "Teen books" },
];

/**
 * Kid mode home, built for a 7 year old on a tablet: no search box, no filters,
 * no text-heavy menus. A big "keep reading", today's goal ring, new books, badges, and
 * rows by age group. The server already limits which books a kid gets, so this just shows
 * what comes back.
 */
export function KidHome() {
  const { me } = useSession();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [rewards, setRewards] = useState<RewardsSummary | null>(null);
  const [error, setError] = useState(false);
  const [denDuty, setDenDuty] = useState(false);

  useEffect(() => {
    api.shelves().then(setShelves, () => setError(true));
    // Rewards are a bonus: the home still works if they can't load.
    rewardsApi.summary("me").then(setRewards, () => undefined);
    familyAppsApi.linked().then((l) => setDenDuty(!!l.denDuty), () => undefined);
  }, []);

  if (error) return <BarnabyEmpty title="Uh oh! Ask a grown-up to check the library." />;
  if (!shelves) return <div className="bb-page bb-muted">Loading…</div>;

  const keepReading = shelves.find((s) => s.kind === "continue")?.books ?? [];
  const seen = new Set(keepReading.map((b) => b.id));
  const fresh = (shelves.find((s) => s.kind === "recent")?.books ?? []).filter((b) => !seen.has(b.id)).slice(0, 10);
  const all = dedupe(shelves.filter((s) => s.kind !== "continue").flatMap((s) => s.books));
  const [hero, ...moreReading] = keepReading;
  const rows = AGE_ROWS.map((r) => ({ ...r, books: all.filter((b) => (b.rating ?? "kids") === r.rating) })).filter((r) => r.books.length);
  const unrowed = all.filter((b) => !AGE_ROWS.some((r) => r.rating === (b.rating ?? "kids")));
  const earned = rewards?.badges.filter((b) => b.earnedAt) ?? [];
  const soon = rewards?.bedtime.startsInMinutes;

  return (
    <div className="bb-page bb-kid">
      <KidScene />
      <div className="bb-kid-top">
        <BarnabySays size={72}>
          <span className="bb-kid-hello">Hi {me?.displayName}! Pick a book!</span>
        </BarnabySays>
        {rewards && <GoalPanel s={rewards} />}
      </div>

      {(all.length > 1 || denDuty) && (
        <div className="bb-kid-actions">
          <BookSpinner books={all.length ? all : keepReading} linkFor={bookLink} />
          {denDuty && (
            <p className="bb-kid-denduty">
              <span aria-hidden>🧹</span> Your reading minutes count for Den Duty too!
            </p>
          )}
        </div>
      )}

      {rewards && <Celebration fresh={rewards.fresh} onDone={() => setRewards({ ...rewards, fresh: [] })} />}

      {soon != null && soon <= 30 && rewards?.bedtime.enabled && (
        <p className="bb-kid-bedtime-note" role="status">
          <span aria-hidden>🌙</span> Bedtime in {soon} minutes. Time for one more chapter!
        </p>
      )}
      {rewards?.bedtime.active && rewards.bedtime.endsAt && (
        <p className="bb-kid-bedtime-note" role="status">
          <span aria-hidden>🌙</span> It's bedtime. Books wake up at {wakeTime(rewards.bedtime.endsAt)}.
        </p>
      )}

      {hero && (
        <section aria-labelledby="kid-keep-reading">
          <h2 className="bb-kid-h2" id="kid-keep-reading">
            <span aria-hidden>📖</span> Keep reading
          </h2>
          <Link to={bookLink(hero)} className="bb-kid-hero">
            <span className="bb-kid-hero-cover">
              <Cover book={hero} />
            </span>
            <span className="bb-kid-hero-body">
              <span className="bb-kid-hero-title">{hero.title}</span>
              {hero.percent != null && hero.percent > 0 && <Stars percent={hero.percent} />}
              <span className="bb-btn bb-btn-primary bb-btn-big bb-kid-hero-go">
                <span aria-hidden>▶</span> Keep reading
              </span>
            </span>
          </Link>
          {moreReading.length > 0 && (
            <div className="bb-kid-row">
              {moreReading.map((b) => (
                <KidBook key={b.id} book={b} />
              ))}
            </div>
          )}
        </section>
      )}

      {fresh.length > 0 && (
        <section aria-labelledby="kid-new">
          <h2 className="bb-kid-h2" id="kid-new">
            <span aria-hidden>✨</span> New on my shelf
          </h2>
          <div className="bb-kid-row">
            {fresh.map((b) => (
              <KidBook key={b.id} book={b} />
            ))}
          </div>
        </section>
      )}

      {rewards && (
        <section aria-labelledby="kid-badges" className="bb-kid-badges">
          <h2 className="bb-kid-h2" id="kid-badges">
            <span aria-hidden>🏅</span> My badges
          </h2>
          {earned.length ? (
            <BadgeShelf badges={earned} compact />
          ) : (
            <p className="bb-kid-empty">Read a little every day to earn your first badge!</p>
          )}
          <p>
            <Link to="/stickers" className="bb-btn bb-btn-big">
              <span aria-hidden>📒</span> My sticker book
            </Link>
          </p>
        </section>
      )}

      {rows.map((r) => (
        <section key={r.rating} aria-labelledby={`kid-row-${r.rating}`}>
          <h2 className="bb-kid-h2" id={`kid-row-${r.rating}`}>
            <span aria-hidden>{r.emoji}</span> {r.title}
          </h2>
          <div className="bb-kid-grid">
            {r.books.map((b) => (
              <KidBook key={b.id} book={b} />
            ))}
          </div>
        </section>
      ))}
      {unrowed.length > 0 && (
        <section>
          <h2 className="bb-kid-h2">
            <span aria-hidden>📚</span> More books
          </h2>
          <div className="bb-kid-grid">
            {unrowed.map((b) => (
              <KidBook key={b.id} book={b} />
            ))}
          </div>
        </section>
      )}
      {all.length === 0 && !hero && <BarnabyEmpty title="No books yet! Ask a grown-up to add some." />}

      <p className="bb-kid-ask-link">
        <Link to="/requests" className="bb-btn bb-btn-big">
          <span aria-hidden>🌟</span> Wish for a new book
        </Link>
      </p>
    </div>
  );
}

function dedupe(books: BookSummary[]): BookSummary[] {
  const seen = new Set<string>();
  return books.filter((b) => !seen.has(b.id) && (seen.add(b.id), true));
}

// Kids go straight into the book; the details page is for grown-ups.
const bookLink = (book: BookSummary) => (book.kindleOnly ? `/book/${book.id}` : `/read/${book.id}`);

function Stars({ percent }: { percent: number }) {
  return (
    <span className="bb-kid-stars" aria-label={`${Math.round(percent * 100)}% read`}>
      {"⭐".repeat(Math.max(1, Math.round(percent * 5)))}
    </span>
  );
}

function KidBook({ book }: { book: BookSummary }) {
  return (
    <Link to={bookLink(book)} className="bb-kid-book">
      <Cover book={book} />
      {book.percent != null && book.percent > 0 && <Stars percent={book.percent} />}
      <span className="bb-kid-title">{book.title}</span>
    </Link>
  );
}
