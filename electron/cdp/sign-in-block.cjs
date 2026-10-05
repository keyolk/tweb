"use strict";

// Google's "Couldn't sign you in — This browser or app may not be secure", recognised so the pane
// can say what to do instead of leaving the user on a page whose only button fails the same way.
//
// The Chrome engine is headless and CDP-driven, and Google's sign-in refuses exactly that; TWeb
// does not hide it (see `tweb chrome login`). The refusal lands on a stable path, measured on
// accounts.google.com: `/v3/signin/rejected`, with the service's own sign-in flow in the query.

function isGoogleSignInRejection(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_) {
    return false;
  }
  return parsed.hostname === "accounts.google.com" && /\/signin\/rejected\b/.test(parsed.pathname);
}

/// Where the user was trying to go, so the notice can offer the way back once signed in.
function rejectionContinueUrl(url) {
  try {
    const target = new URL(String(url)).searchParams.get("continue");
    return target && /^https?:/.test(target) ? target : null;
  } catch (_) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function signInNoticePage(url) {
  const back = rejectionContinueUrl(url);
  const html = `<!doctype html><meta charset="utf-8"><title>Sign in with tweb chrome login</title><style>
    :root{color-scheme:light dark}body{font:16px system-ui;margin:3rem;line-height:1.55;max-width:46rem}
    code{font:14px ui-monospace,Menlo,monospace;background:#8882;padding:2px 5px;border-radius:4px}
    ol{padding-left:1.3rem}small{opacity:.7}
  </style><h1>Google won't sign in here</h1>
  <p>This pane runs Chrome under remote control, and Google refuses to sign in to an automated
  browser. TWeb does not hide that. Sign in once in a normal Chrome window on the same profile
  instead — the session then carries over to every <code>--engine chrome</code> pane.</p>
  <ol>
    <li>Close every <code>--engine chrome</code> pane (Ctrl-C).</li>
    <li>Run <code>tweb chrome login</code> and sign in in the window it opens, then quit it (Cmd-Q).</li>
    <li>Open the pane again.</li>
  </ol>
  ${back ? `<p><small>You were going to</small><br><a href="${escapeHtml(back)}">${escapeHtml(back)}</a></p>` : ""}`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { isGoogleSignInRejection, rejectionContinueUrl, signInNoticePage };
