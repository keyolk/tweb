"use strict";

// `tweb eval` — run a script in the page's main world and say what it produced.
//
// Electron's `executeJavaScript` throws away a synchronous exception: a `TypeError` comes back as
// "Script failed to execute, this normally means an error was thrown. Check the renderer console
// for the error." — the one thing an agent needs to know about a failed `[...][0].click()` is
// gone. `Runtime.evaluate` reports the exception itself, so it is used whenever the debugger is
// available, and `executeJavaScript` stays as the fallback for a tab whose debugger something
// else holds.

function evaluateParams(script) {
  return {
    expression: String(script ?? ""),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  };
}

// `{ value }` for a value, `{}` for `undefined`: the CLI prints nothing for a missing value, where
// `{ value: null }` prints `null` — the two are different answers.
function evaluationResult(reply) {
  if (reply?.exceptionDetails) {
    const details = reply.exceptionDetails;
    const message = details.exception?.description || details.exception?.value || details.text;
    throw new Error(String(message || "evaluation failed"));
  }
  const result = reply?.result || {};
  if (result.type === "undefined") return {};
  // A value that does not survive `returnByValue` (a DOM node, a function) comes back without
  // one; its description is the honest answer, and better than a silent `{}`.
  if (!("value" in result)) {
    return result.unserializableValue !== undefined
      ? { value: result.unserializableValue }
      : { value: result.description ?? null };
  }
  return { value: result.value };
}

async function evaluate(script, { debuggerSend, executeJavaScript }) {
  if (debuggerSend) return evaluationResult(await debuggerSend("Runtime.evaluate", evaluateParams(script)));
  const value = await executeJavaScript(String(script ?? ""));
  return value === undefined ? {} : { value };
}

module.exports = { evaluate, evaluationResult, evaluateParams };
