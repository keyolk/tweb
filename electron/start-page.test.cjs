"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isStartPage, parseListeningPorts, renderStartPage, startPageUrl } = require("./start-page.cjs");

// Shaped like the measured `lsof -nP -iTCP -sTCP:LISTEN` on the owner's machine.
const LSOF = `COMMAND     PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
mlx-serve  2371 gavin.jeong    4u  IPv4 0x622b3bc7b7444d1c      0t0  TCP 127.0.0.1:8002 (LISTEN)
cco        2376 gavin.jeong   10u  IPv4 0xdd4a5f99b54d1e95      0t0  TCP 127.0.0.1:8787 (LISTEN)
codex      2755 gavin.jeong   32u  IPv4  0xc3ecc901aa0e0b6      0t0  TCP 127.0.0.1:49390 (LISTEN)
Discord    3914 gavin.jeong   37u  IPv4 0xed656b2310fc63ca      0t0  TCP 127.0.0.1:6463 (LISTEN)
node      40000 gavin.jeong   20u  IPv6 0x1                     0t0  TCP *:3000 (LISTEN)
node      40000 gavin.jeong   21u  IPv4 0x2                     0t0  TCP *:3000 (LISTEN)
vite      40001 gavin.jeong   22u  IPv6 0x3                     0t0  TCP [::1]:5173 (LISTEN)
postgres  40002 gavin.jeong    5u  IPv4 0x4                     0t0  TCP 10.0.0.5:5432 (LISTEN)
rapportd    500 gavin.jeong    5u  IPv4 0x5                     0t0  TCP *:49152 (LISTEN)
sshd          1 root           5u  IPv4 0x6                     0t0  TCP *:22 (LISTEN)
`;

test("servers on localhost are listed once each, lowest port first", () => {
  assert.deepEqual(parseListeningPorts(LSOF).map((entry) => [entry.port, entry.command]), [
    [3000, "node"], [5173, "vite"], [8002, "mlx-serve"], [8787, "cco"],
  ]);
  assert.equal(parseListeningPorts(LSOF)[0].url, "http://localhost:3000/");
});

test("ephemeral, privileged, app-private and other-interface ports are left out", () => {
  const ports = parseListeningPorts(LSOF).map((entry) => entry.port);
  for (const port of [49390, 49152, 22, 6463, 5432]) assert.ok(!ports.includes(port), String(port));
});

test("garbage is no ports, and the list is capped", () => {
  assert.deepEqual(parseListeningPorts(""), []);
  assert.deepEqual(parseListeningPorts("not lsof\nat all"), []);
  const many = ["COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    ...Array.from({ length: 30 }, (_, i) => `srv ${i} u 1u IPv4 0x 0t0 TCP 127.0.0.1:${4000 + i} (LISTEN)`)].join("\n");
  assert.equal(parseListeningPorts(many).length, 12);
});

test("the page lists servers and recent pages, escaped, and says when nothing was restored", () => {
  const html = renderStartPage({
    ports: [{ port: 3000, command: "node", url: "http://localhost:3000/" }],
    recent: [
      { url: "https://github.com/keyolk/tweb", title: "<b>tweb</b>" },
      { url: "data:text/html,x", title: "skipped" },
    ],
    restoring: true,
  });
  assert.match(html, /href="http:\/\/localhost:3000\/">localhost:3000</);
  assert.match(html, /&lt;b&gt;tweb&lt;\/b&gt;/);
  assert.ok(!html.includes("skipped"));
  assert.match(html, /No previous page to restore/);
  assert.match(renderStartPage({}), /Nothing listening on localhost/);
});

test("a start page is recognised by its URL, an ordinary data page is not", () => {
  assert.equal(isStartPage(startPageUrl({})), true);
  assert.equal(isStartPage("data:text/html;charset=utf-8,%3Ctitle%3Eother"), false);
  assert.equal(isStartPage("https://example.com"), false);
});
