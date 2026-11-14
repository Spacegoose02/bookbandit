import { useEffect, useState } from "react";
import { useSession } from "../app/session";
import { aiApi, type AiStatus } from "./api";

/** Barnaby's availability for the signed-in person (null while loading or when the server has no AI routes). */
export function useAiStatus(): AiStatus | null {
  const { me } = useSession();
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    if (!me) return;
    aiApi.status().then(setStatus, () => setStatus(null));
  }, [me]);
  return status;
}
