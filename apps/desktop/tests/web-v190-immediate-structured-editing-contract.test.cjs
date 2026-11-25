const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (name) => fs.readFileSync(path.join(__dirname, "../../..", "apps/web/src", name), "utf8");

test("the workspace opens ONLYOFFICE for the selected document", () => {
  const app = read("App.tsx");
  const history = read("DocumentVersionHistory.tsx");
  const office = read("LocalOfficeEditor.tsx");
  assert.match(app, /<LocalOfficeEditor/);
  assert.doesNotMatch(app, /FindReplacePanel|>Pending changes|Find &amp; Replace/);
  assert.doesNotMatch(app, /WordPreview|InlineLayoutEditor|edit-sidebar|editor-document-header/);
  assert.match(app, /setHistoryDocumentId\(document.id\)/);
  assert.match(history, /restoreDocumentVersion/);
  assert.match(office, /\/onlyoffice\/open/);
  assert.match(office, /<iframe/);
  assert.match(office, /Matching files/);
  assert.match(office, /This file only/);
  assert.doesNotMatch(office, /Back to Layout|Edit in ONLYOFFICE/);
});
