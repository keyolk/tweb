"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  declaredRulesetIds,
  extensionDirs,
  extensionsDir,
  isUblockOriginLite,
  loadExtensions,
  prepareExtension,
  readManifest,
  safePathSegment,
  startBackgroundWorker,
  ubolShimScript,
} = require("./extensions.cjs");

// A fake fs rather than a temp directory: the interesting cases are a missing directory, a
// subdirectory with no manifest, and unreadable JSON, and all three are easier to state
// exactly than to arrange on disk.
function fakeFs(tree) {
  const dirent = (name, isDir) => ({ name, isDirectory: () => isDir, isFile: () => !isDir });
  return {
    readdirSync(dir) {
      const entry = tree[dir];
      if (!entry || !entry.dirs) throw new Error(`ENOENT: ${dir}`);
      return entry.dirs.map((name) => dirent(name, true));
    },
    statSync(file) {
      if (!(file in tree)) throw new Error(`ENOENT: ${file}`);
      return dirent(path.basename(file), false);
    },
    readFileSync(file) {
      if (!(file in tree)) throw new Error(`ENOENT: ${file}`);
      return tree[file];
    },
  };
}

const MV3_BLOCKER = JSON.stringify({
  manifest_version: 3,
  name: "blocker",
  permissions: ["declarativeNetRequest"],
  declarative_net_request: {
    rule_resources: [
      { id: "a", enabled: true, path: "a.json" },
      { id: "b", enabled: false, path: "b.json" },
      { id: "c", path: "c.json" },
    ],
  },
});
const MV3_CONTENT = JSON.stringify({
  manifest_version: 3,
  name: "content extension",
  content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
});
const MV2_BLOCKER = JSON.stringify({
  manifest_version: 2,
  name: "old blocker",
  permissions: ["webRequest", "webRequestBlocking"],
});

test("safePathSegment cannot escape the runtime root", () => {
  assert.equal(safePathSegment("2026.812.1211"), "2026.812.1211");
  assert.equal(safePathSegment("../../outside"), ".._.._outside");
  assert.equal(safePathSegment(".."), "unknown");
  assert.equal(safePathSegment(""), "unknown");
  assert.equal(safePathSegment(undefined), "unknown");
});

test("uBO Lite identity is narrow enough not to adapt arbitrary MV3 extensions", () => {
  const ubol = {
    manifest_version: 3,
    short_name: "uBO Lite",
    author: "Raymond Hill",
    version: "1.0",
    background: { service_worker: "/js/background.js", type: "module" },
  };
  assert.equal(isUblockOriginLite(ubol), true);
  assert.equal(isUblockOriginLite({ ...ubol, author: "somebody else" }), false);
  assert.equal(isUblockOriginLite({ ...ubol, short_name: "lookalike" }), false);
  assert.equal(isUblockOriginLite({ ...ubol, manifest_version: 2 }), false);
  assert.equal(isUblockOriginLite({ ...ubol, background: { service_worker: "x" } }), false);
});

test("prepareExtension adapts a runtime copy and leaves the source byte-for-byte alone", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-ext-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(path.join(source, "js"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "__MSG_extName__",
    short_name: "uBO Lite",
    author: "Raymond Hill",
    version: "1.2.3",
    permissions: ["declarativeNetRequest", "scripting"],
    background: { service_worker: "/js/background.js", type: "module" },
  };
  const sourceBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(source, "manifest.json"), sourceBytes);
  fs.writeFileSync(path.join(source, "js", "background.js"), "// real worker\n");

  const prepared = prepareExtension(source, manifest, runtime);
  assert.equal(prepared.adapted, true);
  assert.notEqual(prepared.dir, source);
  assert.equal(fs.readFileSync(path.join(source, "manifest.json"), "utf8"), sourceBytes);
  assert.equal(fs.existsSync(path.join(source, "tweb-compat.js")), false);
  assert.deepEqual(prepared.manifest.background, {
    service_worker: "/tweb-background.js",
    type: "module",
  });
  assert.equal(
    fs.readFileSync(path.join(prepared.dir, "tweb-background.js"), "utf8"),
    'import "/tweb-compat.js";\nimport "/js/background.js";\n',
  );
  assert.equal(fs.readFileSync(path.join(prepared.dir, "tweb-compat.js"), "utf8"), ubolShimScript());
  assert.equal(fs.readFileSync(path.join(prepared.dir, "js", "background.js"), "utf8"), "// real worker\n");
});

test("prepareExtension is idempotent for the same uBO Lite version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-ext-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(path.join(source, "js"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    short_name: "uBO Lite",
    author: "Raymond Hill",
    version: "1.2.3",
    permissions: ["declarativeNetRequest"],
    background: { service_worker: "/js/background.js", type: "module" },
  };
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, "js", "background.js"), "// real worker\n");
  const first = prepareExtension(source, manifest, runtime);
  const second = prepareExtension(source, manifest, runtime);
  assert.equal(second.dir, first.dir);
  assert.deepEqual(second.manifest, first.manifest);
});

test("prepareExtension returns ordinary extensions unchanged", () => {
  const manifest = { manifest_version: 3, name: "ordinary", content_scripts: [{ js: ["cs.js"] }] };
  assert.deepEqual(prepareExtension("/source", manifest, "/runtime"), {
    dir: "/source",
    manifest,
    adapted: false,
  });
});

test("extensionsDir prefers the environment override", () => {
  assert.equal(extensionsDir({ TWEB_EXTENSIONS_DIR: "/scratch/ext" }, "/data"), "/scratch/ext");
  assert.equal(extensionsDir({}, "/data"), path.join("/data", "extensions"));
  assert.equal(extensionsDir({ TWEB_EXTENSIONS_DIR: "" }, "/data"), path.join("/data", "extensions"));
});

test("extensionDirs returns nothing for a directory that does not exist", () => {
  assert.deepEqual(extensionDirs("/nope", fakeFs({})), []);
});

test("extensionDirs skips subdirectories without a manifest, and dotfiles", () => {
  const tree = {
    "/ext": { dirs: [".DS_Store_dir", "good", "empty"] },
    "/ext/good/manifest.json": MV3_BLOCKER,
  };
  assert.deepEqual(extensionDirs("/ext", fakeFs(tree)), ["/ext/good"]);
});

test("extensionDirs is sorted, because load order decides DNR priority ties", () => {
  const tree = {
    "/ext": { dirs: ["zebra", "alpha", "middle"] },
    "/ext/zebra/manifest.json": MV3_BLOCKER,
    "/ext/alpha/manifest.json": MV3_BLOCKER,
    "/ext/middle/manifest.json": MV3_BLOCKER,
  };
  assert.deepEqual(extensionDirs("/ext", fakeFs(tree)), ["/ext/alpha", "/ext/middle", "/ext/zebra"]);
});

test("readManifest reports a parse failure instead of throwing", () => {
  const tree = { "/ext/bad/manifest.json": "{ not json" };
  const manifest = readManifest("/ext/bad", fakeFs(tree));
  assert.ok(manifest.__readError);
});

test("declaredRulesetIds re-states what Electron ignored, treating absent enabled as true", () => {
  // Chrome's default for a rule_resources entry is enabled: true, so only an explicit false
  // means off. Getting this backwards would silently disarm every extension.
  assert.deepEqual(declaredRulesetIds(JSON.parse(MV3_BLOCKER)), ["a", "c"]);
  assert.deepEqual(declaredRulesetIds({}), []);
  assert.deepEqual(declaredRulesetIds({ declarative_net_request: {} }), []);
  assert.deepEqual(declaredRulesetIds({ declarative_net_request: { rule_resources: "no" } }), []);
  assert.deepEqual(
    declaredRulesetIds({ declarative_net_request: { rule_resources: [{ enabled: true }] } }),
    [],
    "an entry with no id cannot be enabled by id",
  );
});

function fakeSession(behaviour = {}) {
  const loadedDirs = [];
  const startedScopes = [];
  const removedIds = [];
  return {
    loadedDirs,
    startedScopes,
    removedIds,
    extensions: {
      async loadExtension(dir) {
        loadedDirs.push(dir);
        if (behaviour.throwFor === dir) throw new Error("boom");
        return { id: `id-${path.basename(dir)}`, name: path.basename(dir) };
      },
      removeExtension(id) {
        removedIds.push(id);
      },
    },
    serviceWorkers: {
      async startWorkerForScope(scope) {
        startedScopes.push(scope);
        if (behaviour.workerThrows) throw new Error("worker boom");
        return { scope };
      },
    },
  };
}

test("loadExtensions loads a supported content-script extension", async () => {
  const tree = { "/ext": { dirs: ["content"] }, "/ext/content/manifest.json": MV3_CONTENT };
  const ses = fakeSession();
  const lines = [];
  const results = await loadExtensions(ses, "/ext", { log: (l) => lines.push(l), fsImpl: fakeFs(tree) });
  assert.deepEqual(ses.loadedDirs, ["/ext/content"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].loaded, true);
  assert.equal(results[0].id, "id-content");
  assert.deepEqual(results[0].rulesetIds, []);
  assert.match(lines.join("\n"), /content extension: loaded — contentScripts/);
});

test("startBackgroundWorker retries the load/registration race", async () => {
  let calls = 0;
  const waits = [];
  const ses = {
    serviceWorkers: {
      async startWorkerForScope(scope) {
        assert.equal(scope, "chrome-extension://abc/");
        calls += 1;
        if (calls < 3) throw new Error("not registered yet");
        return { scope };
      },
    },
  };
  const status = await startBackgroundWorker(ses, "chrome-extension://abc/", {
    attempts: 4,
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(status, { started: true, error: null });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 100]);
});

test("startBackgroundWorker returns the last error when every attempt fails", async () => {
  let calls = 0;
  const ses = {
    serviceWorkers: {
      async startWorkerForScope() {
        calls += 1;
        throw new Error(`failure ${calls}`);
      },
    },
  };
  const status = await startBackgroundWorker(ses, "chrome-extension://abc/", {
    attempts: 3,
    wait: async () => {},
  });
  assert.deepEqual(status, { started: false, error: "failure 3" });
  assert.equal(calls, 3);
});

test("loadExtensions starts a declared service worker before reporting success", async () => {
  const manifest = JSON.stringify({
    ...JSON.parse(MV3_CONTENT),
    background: { service_worker: "sw.js" },
  });
  const tree = { "/ext": { dirs: ["blocker"] }, "/ext/blocker/manifest.json": manifest };
  const ses = fakeSession();
  const results = await loadExtensions(ses, "/ext", { fsImpl: fakeFs(tree) });
  assert.equal(results[0].loaded, true);
  assert.equal(results[0].serviceWorkerStarted, true);
  assert.deepEqual(ses.startedScopes, ["chrome-extension://id-blocker/"]);
  assert.deepEqual(ses.removedIds, []);
});

test("a worker owned by an earlier engine stays loaded and is reported", async () => {
  const manifest = JSON.stringify({
    ...JSON.parse(MV3_CONTENT),
    background: { service_worker: "sw.js" },
  });
  const tree = { "/ext": { dirs: ["blocker"] }, "/ext/blocker/manifest.json": manifest };
  const ses = fakeSession({ workerThrows: true });
  const lines = [];
  const results = await loadExtensions(ses, "/ext", {
    log: (l) => lines.push(l),
    fsImpl: fakeFs(tree),
    workerOptions: { attempts: 1 },
  });
  assert.equal(results[0].loaded, true);
  assert.equal(results[0].workerError, "worker boom");
  assert.deepEqual(ses.removedIds, []);
  assert.match(lines.join("\n"), /background worker not running in this engine/);
});

test("loadExtensions never calls loadExtension for a refused manifest", async () => {
  // The whole point of the policy: an MV2 blocker must not reach the session, because
  // Chromium WILL load it and it will then block nothing.
  const tree = { "/ext": { dirs: ["old"] }, "/ext/old/manifest.json": MV2_BLOCKER };
  const ses = fakeSession();
  const lines = [];
  const results = await loadExtensions(ses, "/ext", { log: (l) => lines.push(l), fsImpl: fakeFs(tree) });
  assert.deepEqual(ses.loadedDirs, []);
  assert.equal(results[0].loaded, false);
  assert.equal(results[0].verdict.supported, false);
  assert.match(lines.join("\n"), /old blocker: refused — requires webRequest, which Electron does not implement/);
});

test("a refusal is a result, not an absence: it is reported alongside the loads", async () => {
  const tree = {
    "/ext": { dirs: ["good", "old"] },
    "/ext/good/manifest.json": MV3_CONTENT,
    "/ext/old/manifest.json": MV2_BLOCKER,
  };
  const ses = fakeSession();
  const results = await loadExtensions(ses, "/ext", { fsImpl: fakeFs(tree) });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.loaded), [true, false]);
});

test("a load that throws does not stop the extensions after it", async () => {
  const tree = {
    "/ext": { dirs: ["aaa", "bbb"] },
    "/ext/aaa/manifest.json": MV3_CONTENT,
    "/ext/bbb/manifest.json": MV3_CONTENT,
  };
  const ses = fakeSession({ throwFor: "/ext/aaa" });
  const lines = [];
  const results = await loadExtensions(ses, "/ext", { log: (l) => lines.push(l), fsImpl: fakeFs(tree) });
  assert.deepEqual(results.map((r) => r.loaded), [false, true]);
  assert.match(lines.join("\n"), /load failed — boom/);
});

test("loadExtensions on a missing directory is a no-op, not an error", async () => {
  const ses = fakeSession();
  assert.deepEqual(await loadExtensions(ses, "/nope", { fsImpl: fakeFs({}) }), []);
  assert.deepEqual(ses.loadedDirs, []);
});

test("an unreadable manifest is refused with the read error, and does not throw", async () => {
  const tree = { "/ext": { dirs: ["bad"] }, "/ext/bad/manifest.json": "{ oops" };
  const ses = fakeSession();
  const lines = [];
  const results = await loadExtensions(ses, "/ext", { log: (l) => lines.push(l), fsImpl: fakeFs(tree) });
  assert.equal(results[0].loaded, false);
  assert.equal(results[0].verdict, null);
  assert.ok(results[0].error);
  assert.deepEqual(ses.loadedDirs, []);
  assert.match(lines.join("\n"), /manifest\.json unreadable/);
});
