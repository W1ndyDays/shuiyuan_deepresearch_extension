// shims/node_url.mjs — only pathToFileURL is imported by the core, and only
// for its entry-guard comparison (which never passes in the service worker).

export function pathToFileURL(p) {
  return { href: `file://${String(p)}` };
}
