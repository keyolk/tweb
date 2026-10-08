"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluate, evaluateParams } = require("./agent-eval.cjs");

// The `Runtime.evaluate` reply for `[][0].click()`, as Chrome sends it.
const typeErrorReply = {
  result: { type: "object", subtype: "error", className: "TypeError" },
  exceptionDetails: {
    text: "Uncaught",
    exception: {
      type: "object", subtype: "error", className: "TypeError",
      description: "TypeError: Cannot read properties of undefined (reading 'click')\n    at <anonymous>:1:6",
    },
  },
};

test("a page exception fails the eval with the exception's own message", async () => {
  await assert.rejects(
    evaluate("[][0].click()", { debuggerSend: async () => typeErrorReply }),
    /TypeError: Cannot read properties of undefined \(reading 'click'\)/,
  );
});

test("a thrown non-Error value is still reported", async () => {
  const reply = { result: {}, exceptionDetails: { text: "Uncaught", exception: { type: "string", value: "boom" } } };
  await assert.rejects(evaluate("throw 'boom'", { debuggerSend: async () => reply }), /boom/);
});

test("undefined and null are different answers", async () => {
  assert.deepEqual(await evaluate("undefined", { debuggerSend: async () => ({ result: { type: "undefined" } }) }), {});
  assert.deepEqual(
    await evaluate("null", { debuggerSend: async () => ({ result: { type: "object", subtype: "null", value: null } }) }),
    { value: null },
  );
});

test("a string and a boolean keep their types", async () => {
  const send = (value) => async () => ({ result: { type: typeof value, value } });
  assert.deepEqual(await evaluate("'true'", { debuggerSend: send("true") }), { value: "true" });
  assert.deepEqual(await evaluate("true", { debuggerSend: send(true) }), { value: true });
});

test("the script is awaited and run as a user gesture", () => {
  const params = evaluateParams("fetch('/x')");
  assert.equal(params.awaitPromise, true);
  assert.equal(params.returnByValue, true);
  assert.equal(params.userGesture, true);
});

test("without a debugger it falls back to executeJavaScript", async () => {
  assert.deepEqual(await evaluate("1", { executeJavaScript: async () => 1 }), { value: 1 });
  assert.deepEqual(await evaluate("void 0", { executeJavaScript: async () => undefined }), {});
});
