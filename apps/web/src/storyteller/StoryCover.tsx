import { api } from "../api/client";
import type { Story } from "./api";

export function StoryCover({ story }: { story: Pick<Story, "id" | "coverPath" | "title"> }) {
  const url = api.coverUrl(story);
  return url ? (
    <img src={url} alt="" draggable={false} />
  ) : (
    <span className="bb-cover bb-cover-blank">
      <span>{story.title}</span>
    </span>
  );
}
