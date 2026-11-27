const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { createOfficeRelay } = require("../../../scripts/onlyoffice-wsl-relay.cjs");

test("the managed ONLYOFFICE relay forwards only to the active DocSync backend", async (t) => {
  const backend = http.createServer((request, response) => {
    response.end(request.url);
  }).listen(0, "127.0.0.1");
  t.after(() => { backend.close(); backend.closeAllConnections(); });
  await once(backend, "listening");
  const port = backend.address().port;
  let currentPort = port;

  const relay = createOfficeRelay(() => currentPort).listen(0, "127.0.0.1");
  t.after(() => { relay.close(); relay.closeAllConnections(); });
  await once(relay, "listening");

  const callbackPath = "/onlyoffice-service/version/" + "a".repeat(48) + "/source";
  const target = "http://127.0.0.1:" + relay.address().port + "/" + port + callbackPath;
  const allowed = await fetch(target);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), callbackPath);
  currentPort = null;
  assert.equal((await fetch(target)).status, 404);
});
