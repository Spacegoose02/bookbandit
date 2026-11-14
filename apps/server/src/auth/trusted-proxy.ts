import { BlockList, isIPv4, isIPv6 } from "node:net";

/** True when `ip` matches one of the IPs/CIDRs. An empty list trusts nothing. */
export function ipMatches(ip: string, entries: string[]): boolean {
  if (entries.length === 0 || !ip) return false;
  const addr = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const family = isIPv4(addr) ? "ipv4" : isIPv6(addr) ? "ipv6" : null;
  if (!family) return false;
  const list = new BlockList();
  for (const entry of entries) {
    const [base, bits] = entry.split("/");
    if (!base) continue;
    const fam = isIPv4(base) ? "ipv4" : isIPv6(base) ? "ipv6" : null;
    if (!fam) continue;
    if (bits) list.addSubnet(base, Number(bits), fam);
    else list.addAddress(base, fam);
  }
  return list.check(addr, family);
}

export function parseTrustedProxies(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
