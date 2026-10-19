const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Only an unambiguous PostgreSQL URL whose authority is a literal loopback
// target may use plain transport. Query parameters and fragments fail closed:
// pg connection-string options must never redirect a URL classified as local.
export function requiresDatabaseTls(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return !(
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return true;
  }
}
