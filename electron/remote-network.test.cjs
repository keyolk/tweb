"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { remoteNetwork, profileName, remoteProfileDir, proxyConfig } = require("./remote-network.cjs");

test("an ordinary pane has no remote network", () => {
  assert.equal(remoteNetwork({}), null);
  // A proxy rule alone is not a request for the mode: TWEB_REMOTE is what the frontend sets it with.
  assert.equal(remoteNetwork({ TWEB_PROXY_SERVER: "socks5://127.0.0.1:1080" }), null);
});

test("the frontend's tunnel becomes a loopback-inclusive proxy", () => {
  const remote = remoteNetwork({ TWEB_REMOTE: "me@box", TWEB_PROXY_SERVER: "socks5://127.0.0.1:50123" });
  assert.deepEqual(remote, { proxyRules: "socks5://127.0.0.1:50123", destination: "me@box", profileName: "me@box" });
  // Without `<-loopback>` Chromium sends localhost direct, and the remote's dev server is unreachable.
  assert.deepEqual(proxyConfig(remote), { proxyRules: "socks5://127.0.0.1:50123", proxyBypassRules: "<-loopback>" });
});

test("a remote pane never falls back to the local network", () => {
  for (const rules of [undefined, "", "http://127.0.0.1:8080", "socks5://10.0.0.1:1080", "socks5://127.0.0.1:0",
    "socks5://127.0.0.1:99999", "socks5://127.0.0.1:1080;direct://"]) {
    assert.throws(() => remoteNetwork({ TWEB_REMOTE: "box", TWEB_PROXY_SERVER: rules }), /TWEB_PROXY_SERVER/);
  }
});

test("each destination gets its own profile that cannot leave remote/", () => {
  assert.equal(profileName("coder.gavin-jeong.regular"), "coder.gavin-jeong.regular");
  assert.equal(profileName("gavin-jeong/regular.coder"), "gavin-jeong_regular.coder");
  assert.equal(profileName(".."), "_");
  assert.equal(profileName(""), "_");
  assert.equal(remoteProfileDir("/data/tweb", { profileName: profileName("../../etc") }), "/data/tweb/remote/__.._etc");
});
