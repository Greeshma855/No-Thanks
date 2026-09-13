export function parseAllowedHosts(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isRemoteAnalysisAllowed(rawUrl: string, allowlist: string): boolean {
  let hostname: string;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    hostname = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return parseAllowedHosts(allowlist).some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return hostname !== suffix && hostname.endsWith(`.${suffix}`);
    }
    return hostname === pattern;
  });
}

export function isEligibleBrowserUrl(rawUrl: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}
