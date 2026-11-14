/** Tap-a-word: a friendly meaning, the word split into chunks, and "say it" (also slowly). */
import { useEffect, useState } from "react";
import { BarnabyAvatar } from "../brand/Barnaby";
import { readAloudApi, type WordHelp } from "./api";
import { sayWord } from "./narrator";

interface Props {
  word: string;
  context: string;
  x: number;
  y: number;
  bookId: string;
  kid: boolean;
  server: boolean;
  onClose(): void;
}

const SOURCE: Record<WordHelp["source"], string> = {
  dictionary: "",
  family: "From your family's word list",
  ai: "Barnaby's answer",
  none: "",
};

export function WordCard({ word, context, x, y, bookId, kid, server, onClose }: Props) {
  const [help, setHelp] = useState<WordHelp | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setHelp(null);
    setError(false);
    readAloudApi.word(word, bookId, context).then(setHelp, () => setError(true));
    if (kid) void sayWord(word, { bookId, server });
  }, [word, bookId, context, kid, server]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the card on screen, above or below the tapped word.
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(x - width / 2, window.innerWidth - width - 12));
  const below = y < window.innerHeight / 2;
  const style = below ? { left, width, top: y + 24 } : { left, width, bottom: window.innerHeight - y + 24 };

  return (
    <>
      <div className="bb-ra-scrim" onClick={onClose} />
      <div className={`bb-ra-word${kid ? " is-kid" : ""}`} style={style} role="dialog" aria-label={`What “${word}” means`}>
        <header>
          <h2 lang="en">{help && help.syllables.length > 1 ? help.syllables.join("·") : word.toLowerCase()}</h2>
          <button className="bb-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="bb-ra-say">
          <button className="bb-btn" onClick={() => void sayWord(word, { bookId, server })}>
            🔊 Say it
          </button>
          <button className="bb-btn bb-btn-ghost" onClick={() => void sayWord(help && help.syllables.length > 1 ? help.syllables.join(" ") : word, { bookId, server, slow: true })}>
            🐢 Slowly
          </button>
        </div>
        {!help && !error && <p className="bb-muted">Looking it up…</p>}
        {error && <p className="bb-muted">Couldn't look that up right now.</p>}
        {help?.meaning && (
          <>
            <p className="bb-ra-meaning">{help.meaning}</p>
            {help.example && <p className="bb-ra-example">“{help.example}”</p>}
            {SOURCE[help.source] && (
              <p className="bb-ra-source">
                {help.source === "ai" && <BarnabyAvatar size={20} />} {SOURCE[help.source]}
              </p>
            )}
          </>
        )}
        {help && !help.meaning && (
          <p className="bb-ra-meaning">{kid ? "Barnaby doesn't know this one yet. Ask a grown-up what it means!" : "No meaning found offline. An admin can add a dictionary file or turn on Barnaby."}</p>
        )}
      </div>
    </>
  );
}
