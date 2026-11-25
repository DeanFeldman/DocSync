"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("v1.8 queues durable preview work and reports progressive readiness", () => {
  const main = read("apps/api/app/main.py");
  const service = read("apps/api/app/preview_job_service.py");
  const models = read("apps/api/app/models.py");
  const api = read("apps/web/src/api.ts");
  const types = read("apps/web/src/types.ts");

  assert.match(main, /document-versions\/\{version_id\}\/preview-jobs/);
  assert.match(main, /api\/preview-jobs\/\{job_id\}/);
  assert.match(main, /document-versions\/\{version_id\}\/preview/);
  assert.match(models, /class PreviewRenderJob/);
  assert.match(service, /PREVIEW_WORKER_COUNT = 1/);
  assert.match(service, /"pdf_ready"/);
  assert.match(service, /"render_map_ready"/);
  assert.match(service, /"starting_microsoft_word"/);
  assert.match(service, /"preparing_selectable_text"/);
  assert.match(api, /createPreviewJob/);
  assert.match(api, /fetchPreviewJob/);
  assert.match(types, /interface PreviewRenderJobResponse/);
});
