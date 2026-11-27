const http = require("node:http");

const route = /^\/(\d{4,5})(\/onlyoffice-service\/[\w-]{1,100}\/[0-9a-f]{48}\/(source|callback))$/;
function createOfficeRelay(allowedPort) {
  return http.createServer((request, response) => {
    const match = route.exec(request.url);
    const port = Number(match?.[1]);
    if (!match || port < 1024 || port > 65535 || (allowedPort && port !== allowedPort())
        || (match[3] === "source" ? request.method !== "GET" : request.method !== "POST")) {
      response.writeHead(404).end();
      return;
    }
    const headers = {};
    for (const key of ["authorization", "content-type", "content-length"]) {
      if (request.headers[key]) headers[key] = request.headers[key];
    }
    const upstream = http.request({host: "127.0.0.1", port, path: match[2], method: request.method, headers}, (result) => {
      const outgoing = {"cache-control": "no-store"};
      for (const key of ["content-type", "content-length", "content-disposition"]) {
        if (result.headers[key]) outgoing[key] = result.headers[key];
      }
      response.writeHead(result.statusCode, outgoing);
      result.pipe(response);
      result.on("error", () => response.destroy());
    });
    upstream.setTimeout(38000, () => upstream.destroy(new Error("DocSync timed out")));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
}

if (require.main === module) {
  const [host, listenPort] = process.argv.slice(2);
  createOfficeRelay().listen(Number(listenPort), host, () => process.stdout.write("DocSync direct relay ready\n"));
}

module.exports = { createOfficeRelay };
