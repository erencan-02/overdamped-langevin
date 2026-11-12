/**
 * Embedding the app in other pages with an iframe. The app is a static site and GitHub Pages
 * sends no header that forbids framing, so any page can embed it; this module only makes that
 * work well:
 *
 *  - `isEmbedded()`: the app runs in a frame (or `?embed` is in the address, e.g. to try the
 *    embedded layout on its own). The side windows then start folded, and the Scene menu and
 *    the title card offer to open the full app in a new tab.
 *  - `?tools=open` / `?tools=closed` sets whether the side windows start open.
 *  - `iframeCode()`: the snippet the Scenario window copies ("Embed code"), so a set-up with its
 *    worksheet can be put into a course page. The scenario travels in the hash as for links.
 *
 * Features that need permission from the embedding page: the live camera (allow="camera"),
 * copying to the clipboard (allow="clipboard-write"; the app falls back to a text field) and
 * fullscreen. The snippet asks for all three.
 */

/** Query parameters that only concern embedding (dropped for the full app). */
const EMBED_PARAMS = ['embed', 'tools'];

export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false; // not in a browser (e.g. tests)
  if (new URLSearchParams(location.search).has('embed')) return true;
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent hides window.top: that means framed
  }
}

/** The side windows' start state from `?tools=open|closed`, or null if not given. */
export function toolsParam(): boolean | null {
  const v = new URLSearchParams(location.search).get('tools');
  return v === 'open' ? true : v === 'closed' ? false : null;
}

/** This page's address without the embedding options (for "open the full app"). */
export function fullAppUrl(): string {
  const q = new URLSearchParams(location.search);
  for (const p of EMBED_PARAMS) q.delete(p);
  const search = q.toString();
  return `${location.origin}${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
}

/** The address that shows `hash` (e.g. "#s=…") in embedded form. */
export function embedUrl(hash: string): string {
  return `${location.origin}${location.pathname}?embed${hash}`;
}

/** An iframe that shows `url`, ready to paste into a page. */
export function iframeCode(url: string, title: string): string {
  return (
    `<iframe src="${escapeAttr(url)}" title="${escapeAttr(title)}" width="100%" height="640" ` +
    'style="border: 0; border-radius: 12px" allow="camera; clipboard-write; fullscreen" loading="lazy"></iframe>'
  );
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
