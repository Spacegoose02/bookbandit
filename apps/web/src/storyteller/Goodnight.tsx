import { BARNABY_FULL } from "../brand/Barnaby";

/** Barnaby's goodnight screen: the end of story time for tonight. */
export function Goodnight({ name }: { name: string }) {
  return (
    <div className="bb-goodnight" role="status">
      <div className="bb-goodnight-sky" aria-hidden>
        {STARS.map(([x, y, s, d], i) => (
          <i key={i} style={{ left: `${x}%`, top: `${y}%`, width: s, height: s, animationDelay: `${d}s` }} />
        ))}
        <span className="bb-goodnight-moon" />
      </div>
      <img className="bb-goodnight-barnaby" src={BARNABY_FULL} alt="" />
      <h1>Goodnight, {name}!</h1>
      <p>Barnaby is tucking the books into bed. More stories tomorrow!</p>
      <span className="bb-goodnight-zzz" aria-hidden>
        z<small>z</small>
        <small>z</small>
      </span>
    </div>
  );
}

// [x%, y%, size px, twinkle delay s] – fixed so screenshots are stable.
const STARS: [number, number, number, number][] = [
  [6, 12, 4, 0], [14, 30, 3, 1.2], [22, 8, 5, 0.4], [31, 22, 3, 2], [38, 6, 4, 0.8], [47, 18, 3, 1.6],
  [55, 9, 5, 0.2], [63, 28, 3, 1], [71, 12, 4, 2.2], [79, 24, 3, 0.6], [88, 7, 5, 1.4], [94, 20, 3, 0.9],
  [10, 48, 3, 1.8], [90, 44, 4, 0.3], [18, 66, 3, 2.4], [84, 70, 3, 1.1], [5, 82, 4, 0.7], [95, 86, 3, 1.9],
];
