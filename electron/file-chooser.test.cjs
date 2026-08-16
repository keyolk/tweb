"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  completionScope,
  expandHome,
  acceptsFile,
  completionEntries,
  commonPrefix,
  completedInput,
  chosenPaths,
} = require("./file-chooser.cjs");

const HOME = "/Users/someone";

function entry(name, directory = false) {
  return { name, directory };
}

test("a trailing slash means inside the directory, without one it is a partial name", () => {
  assert.deepEqual(completionScope("/tmp/", HOME), { directory: "/tmp/", prefix: "" });
  assert.deepEqual(completionScope("/tmp/pro", HOME), { directory: "/tmp", prefix: "pro" });
});

test("an empty input lists the current directory", () => {
  assert.deepEqual(completionScope("", HOME), { directory: ".", prefix: "" });
});

test("tilde expands the way a shell user expects, and only the forms that are decidable", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/Downloads/a.txt", HOME), "/Users/someone/Downloads/a.txt");
  // ~other needs a passwd lookup the chooser has no business doing.
  assert.equal(expandHome("~other/file", HOME), "~other/file");
  assert.equal(expandHome("/absolute", HOME), "/absolute");
});

test("an input with no accept attribute takes anything", () => {
  assert.equal(acceptsFile("photo.png", ""), true);
  assert.equal(acceptsFile("archive.tar.gz", null), true);
});

test("an extension list is honoured case-insensitively", () => {
  assert.equal(acceptsFile("data.CSV", ".txt,.csv"), true);
  assert.equal(acceptsFile("photo.png", ".txt,.csv"), false);
});

test("a wildcard MIME family matches by extension", () => {
  assert.equal(acceptsFile("photo.png", "image/*"), true);
  assert.equal(acceptsFile("notes.txt", "image/*"), false);
  assert.equal(acceptsFile("clip.mp4", "video/*"), true);
});

test("an undecidable MIME type lets the file through rather than hiding it", () => {
  // The chooser has a filename, not a sniffed type. Hiding the file the user came for is
  // the worse failure, and `accept` is advisory in Chrome too.
  assert.equal(acceptsFile("report.bin", "application/vnd.custom"), true);
  assert.equal(acceptsFile("anything.xyz", "*/*"), true);
});

test("a directory always passes the filter, because it is how you reach the file", () => {
  assert.equal(acceptsFile("photos", "application/pdf", true), true);
});

test("directories are offered before files", () => {
  const { entries } = completionEntries([entry("zebra.txt"), entry("apps", true), entry("alpha.txt")]);
  assert.deepEqual(entries.map((item) => item.name), ["apps", "alpha.txt", "zebra.txt"]);
});

test("dotfiles stay hidden until the prefix asks for them", () => {
  const all = [entry(".bashrc"), entry("notes.txt")];
  assert.deepEqual(completionEntries(all).entries.map((item) => item.name), ["notes.txt"]);
  assert.deepEqual(completionEntries(all, { prefix: "." }).entries.map((item) => item.name), [".bashrc"]);
});

test("the prefix filters case-insensitively", () => {
  const { entries } = completionEntries([entry("Report.pdf"), entry("other.pdf")], { prefix: "rep" });
  assert.deepEqual(entries.map((item) => item.name), ["Report.pdf"]);
});

test("accept filters the offered list but a directory survives it", () => {
  const { entries } = completionEntries([entry("a.png"), entry("b.txt"), entry("sub", true)], { accept: ".txt" });
  assert.deepEqual(entries.map((item) => item.name), ["sub", "b.txt"]);
});

test("a truncated list says so rather than looking complete", () => {
  const many = Array.from({ length: 9 }, (_, index) => entry(`f${index}.txt`));
  const model = completionEntries(many, { limit: 4 });
  assert.equal(model.entries.length, 4);
  assert.equal(model.total, 9);
  assert.equal(model.truncated, 5);
});

test("Tab completes to what every candidate shares, not to the first guess", () => {
  assert.equal(commonPrefix(["report-a.txt", "report-b.txt"]), "report-");
  assert.equal(commonPrefix(["alpha", "beta"]), "");
  assert.equal(commonPrefix(["only.txt"]), "only.txt");
  assert.equal(commonPrefix([]), "");
});

test("Tab on one directory adds the slash, so a second Tab goes inside it", () => {
  assert.equal(completedInput("/tmp/pro", [entry("projects", true)], HOME), "/tmp/projects/");
});

test("Tab on several candidates stops where the choice is still open", () => {
  const done = completedInput("/tmp/rep", [entry("report-a.txt"), entry("report-b.txt")], HOME);
  assert.equal(done, "/tmp/report-");
});

test("Tab with nothing to add leaves the input alone", () => {
  assert.equal(completedInput("/tmp/xyz", [], HOME), "/tmp/xyz");
});

test("Tab completes a bare name without inventing a ./ prefix", () => {
  assert.equal(completedInput("rep", [entry("report.txt")], HOME), "report.txt");
});

test("a single-file input takes the first path rather than refusing several", () => {
  const chosen = chosenPaths(["/a.txt", "/b.txt"], { multiple: false });
  assert.deepEqual(chosen.paths, ["/a.txt"]);
  assert.equal(chosen.error, "");
});

test("a multiple input keeps every path", () => {
  assert.deepEqual(chosenPaths(["/a.txt", "/b.txt"], { multiple: true }).paths, ["/a.txt", "/b.txt"]);
});

test("choosing nothing is an error, not an empty success", () => {
  assert.equal(chosenPaths([]).error, "no file chosen");
  assert.equal(chosenPaths(["   "]).error, "no file chosen");
});
