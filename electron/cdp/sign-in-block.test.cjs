"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { isGoogleSignInRejection, rejectionContinueUrl, signInNoticePage } = require("./sign-in-block.cjs");

// The URL a pane landed on, measured: YouTube's sign-in refused inside the Chrome engine.
const REJECTED = "https://accounts.google.com/v3/signin/rejected?continue=https://www.youtube.com/signin?action_handle_signin%3Dtrue%26app%3Ddesktop%26hl%3Den%26next%3Dhttps%253A%252F%252Fwww.youtube.com%252F&dsh=S-1&ec=65620&flowEntry=ServiceLogin&flowName=WebLiteSignIn&hl=en&service=youtube";

test("Google's sign-in rejection is recognised", () => {
  assert.strictEqual(isGoogleSignInRejection(REJECTED), true);
});

test("ordinary sign-in pages and other hosts are not", () => {
  for (const url of [
    "https://accounts.google.com/v3/signin/identifier?continue=x",
    "https://accounts.google.com/ServiceLogin",
    "https://evil.example/v3/signin/rejected",
    "https://accounts.google.com.evil.example/v3/signin/rejected",
    "not a url",
  ]) assert.strictEqual(isGoogleSignInRejection(url), false, url);
});

test("the notice offers the page the user was going to", () => {
  assert.match(rejectionContinueUrl(REJECTED), /^https:\/\/www\.youtube\.com\/signin\?/);
  assert.strictEqual(rejectionContinueUrl("https://accounts.google.com/v3/signin/rejected?continue=javascript:alert(1)"), null);
  const page = decodeURIComponent(signInNoticePage(REJECTED));
  assert.match(page, /tweb chrome login/);
  assert.match(page, /https:\/\/www\.youtube\.com\/signin/);
  assert.doesNotMatch(page, /<script/i);
});
