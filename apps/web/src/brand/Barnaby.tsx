import type { ReactNode } from "react";

/**
 * Barnaby, the BookBandit raccoon. He's the logo, the face of the (future) AI helper,
 * and the friendly guide in empty states and kid mode.
 */
const base = import.meta.env.BASE_URL;
export const BARNABY_FACE = `${base}brand/barnaby-face.webp`;
export const BARNABY_FULL = `${base}brand/barnaby-full.webp`;

export function BarnabyLogo({ size = 36, withName = true }: { size?: number; withName?: boolean }) {
  return (
    <span className="bb-logo">
      <img src={BARNABY_FACE} width={size} height={size} alt={withName ? "" : "BookBandit"} />
      {withName && (
        <span className="bb-logo-name">
          Book<b>Bandit</b>
        </span>
      )}
    </span>
  );
}

/** Round avatar for Barnaby, for the AI chat and anywhere he "speaks". */
export function BarnabyAvatar({ size = 44, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <span
      className={`bb-barnaby-avatar${thinking ? " is-thinking" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={thinking ? "Barnaby is thinking" : "Barnaby"}
    >
      <img src={BARNABY_FACE} alt="" />
    </span>
  );
}

/**
 * A chat bubble from Barnaby. The AI helper will reuse this for its replies;
 * for now it's used for friendly hints and empty states.
 */
export function BarnabySays({
  children,
  thinking = false,
  size = 44,
}: {
  children?: ReactNode;
  thinking?: boolean;
  size?: number;
}) {
  return (
    <div className="bb-barnaby-says">
      <BarnabyAvatar size={size} thinking={thinking} />
      <div className="bb-bubble" aria-live="polite">
        {thinking ? (
          <span className="bb-dots" aria-label="Barnaby is thinking">
            <i />
            <i />
            <i />
          </span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/** Full-body Barnaby with a message, for empty shelves, errors and kid mode. */
export function BarnabyEmpty({ title, children, size = 180 }: { title: string; children?: ReactNode; size?: number }) {
  return (
    <div className="bb-empty">
      <img src={BARNABY_FULL} width={size} alt="" />
      <h2>{title}</h2>
      {children && <div className="bb-empty-body">{children}</div>}
    </div>
  );
}
