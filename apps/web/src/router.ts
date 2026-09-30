import { useEffect, useState } from 'react';

/**
 * Navigation, in twenty lines and no dependency.
 *
 * The dashboard has a handful of pages and no nested layouts, so a router
 * library would be a dependency carrying features nobody asked for. What is
 * needed is exactly this: the current path, a way to change it without a
 * reload, and re-rendering when the back button changes it underneath us.
 *
 * The server already serves the app shell for every non-API path
 * (`isAppShellPath`), so a pasted deep link and a reload both work without
 * anything further here.
 */

/** Change the path without a reload, and tell every `usePath` about it. */
export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  history.pushState(null, '', to);
  // `pushState` deliberately does not fire `popstate` — that event is the back
  // button. Dispatching it ourselves is what makes one subscription enough for
  // both directions, rather than a second channel that can drift from it.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The current path, re-rendering on back, forward and `navigate`. */
export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    // A path that changed between the first render and this effect would
    // otherwise be missed for good.
    sync();
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return path;
}

/**
 * The trailing segment of a path, decoded — `/projekte/vorschicht` → `vorschicht`.
 *
 * Returns null when the path is exactly the prefix, which is how the projects
 * page distinguishes "show the list" from "show this one".
 */
export function segmentAfter(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (rest === '') return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    // `decodeURIComponent('%')` throws `URIError`, and this runs during render
    // with no error boundary between it and the root — so a mistyped URL took
    // the whole dashboard down rather than one page. The raw segment is handed
    // back instead: every caller validates what it gets (`eskalationsNummer` is
    // strict, the projects page looks the slug up), so an undecodable segment
    // becomes "unbekannt" on the page it belongs to, which is the honest answer.
    return rest;
  }
}
