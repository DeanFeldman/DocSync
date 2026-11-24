import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = await realpath(process.env.DOCSYNC_TEST_REPO ?? path.resolve(import.meta.dirname, ".."));
const { createServer } = await import(pathToFileURL(path.join(repo, "node_modules/vite/dist/node/index.js")));
const edge = process.env.DOCSYNC_TEST_EDGE ??
  path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe");
await access(edge);
const scratchRoot = process.env.DOCSYNC_TEST_SCRATCH ?? path.join(repo, ".artifacts");
await mkdir(scratchRoot, {recursive: true});
const scratchParent = await realpath(scratchRoot);
const scratch = await mkdtemp(path.join(scratchParent, "editor-"));
const localPort = createNetServer();
await new Promise((resolve, reject) => {
  localPort.once("error", reject);
  localPort.listen(0, "127.0.0.1", resolve);
});
const apiPort = localPort.address().port;
await new Promise((resolve, reject) => {
  localPort.close(error => error ? reject(error) : resolve());
});
const apiOrigin = "http://127.0.0.1:" + apiPort;
const db = path.join(scratch, "data", "documentsync.db").replaceAll("\\", "/");
const api = spawn(process.env.DOCUMENTSYNC_PYTHON ?? "python", ["-B", "desktop_backend.py"], {
  cwd: path.join(repo, "apps/api"), windowsHide: true,
  env: { ...process.env, DOCUMENTSYNC_DATA_DIR: path.join(scratch, "data"),
    DOCUMENTSYNC_DATABASE_URL: "sqlite:///" + db, DOCUMENTSYNC_PORT: String(apiPort),
    DOCUMENTSYNC_SESSION_TOKEN: "", DOCUMENTSYNC_WORD_WORKER_AUTOSTART: "false" },
  stdio: ["ignore", "ignore", "pipe"],
});
let apiLog = "";
api.on("error", error => { apiLog += error.message; });
api.stderr.on("data", chunk => { apiLog = (apiLog + chunk).slice(-3000); });
let server;
let browser;
let socket;
let evaluate;
let previewRequests = 0;
const browserErrors = [];

async function waitFor(check, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(35);
  }
  throw new Error("Timed out waiting for " + label);
}

try {
  await waitFor(() => fetch(apiOrigin + "/api/health").then(r => r.ok).catch(() => false), "API");
  const form = new FormData();
  form.append("name", "Core editor smoke");
  for (const name of ["Building-A-Agreement.docx", "Building-B-Agreement.docx", "Building-C-Agreement.docx"]) {
    const fixture = await readFile(path.join(repo, "apps/api/sample-documents", name));
    form.append("files", new Blob([fixture], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }), name);
  }
  const upload = await fetch(apiOrigin + "/api/document-sets", {method: "POST", body: form});
  assert.equal(upload.status, 201, await upload.clone().text());
  const workspace = await upload.json();
  const entry = path.join(repo, "apps/web/src/issue50-smoke.tsx").replaceAll("\\", "/");
  server = await createServer({
    root: path.join(repo, "apps/web"),
    configLoader: "runner",
    cacheDir: path.join(scratch, "vite"),
    server: { port: 0, strictPort: true, host: "127.0.0.1", hmr: false,
      proxy: { "/api": apiOrigin } },
    plugins: [{
      name: "docsync-issue50-smoke",
      enforce: "pre",
      resolveId(id) { if (id === "/src/issue50-smoke.tsx" || id === entry) return entry; },
      load(id) {
        if (id !== entry) return;
        return [
          'import { useState } from "react";',
          'import { createRoot } from "react-dom/client";',
          'import DocumentExperience from "./DocumentExperience";',
          'import { ConfirmationProvider } from "./ConfirmationDialog";',
          'import "./styles.css";',
          "const fixture = " + JSON.stringify(workspace) + ";",
          'function Harness() {',
          ' const [index, setIndex] = useState(0);',
          ' const [dirty, setDirty] = useState(false);',
          ' return <><nav style={{height: 32}}><button id="switch" onClick={() => setIndex((index + 1) % 2)}>Switch document</button><output id="dirty">{String(dirty)}</output></nav>',
          ' <main style={{height: "calc(100vh - 32px)"}}><DocumentExperience documentSet={fixture} document={fixture.documents[index]} searchTarget={null} onGenerated={() => {}} generationJobs={[]} onGenerationQueued={() => {}} onDirtyChange={setDirty} /></main></>;',
          '}',
          'createRoot(document.getElementById("root")).render(<ConfirmationProvider><Harness /></ConfirmationProvider>);',
        ].join("\n");
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === "/issue50") {
            const html = await vite.transformIndexHtml("/issue50",
              '<html><body><div id="root"></div><script type="module" src="/src/issue50-smoke.tsx"></script></body></html>');
            response.setHeader("content-type", "text/html");
            response.end(html);
          } else if (request.url?.endsWith("/preview-jobs")) {
            previewRequests++;
            setTimeout(() => {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(JSON.stringify({detail: "Word preview intentionally unavailable in smoke test."}));
            }, 5000);
          } else if (request.url?.includes("/edit-batches") && request.method === "POST") {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({detail: "Staging intentionally unavailable."}));
          } else {
            next();
          }
        });
      },
    }],
  });
  await server.listen();
  const webOrigin = server.resolvedUrls.local[0];
  browser = spawn(edge, ["--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--remote-debugging-port=0",
    "--user-data-dir=" + path.join(scratch, "edge"), webOrigin + "issue50"],
  {windowsHide: true, stdio: "ignore"});
  const devToolsPort = await waitFor(
    () => readFile(path.join(scratch, "edge", "DevToolsActivePort"), "utf8")
      .then(config => Number(config.split(/\r?\n/)[0])).catch(() => false),
    "Edge debugging port",
  );
  const target = await waitFor(() => fetch("http://127.0.0.1:" + devToolsPort + "/json/list", {signal: AbortSignal.timeout(1200)})
    .then(r => r.json()).then(pages => pages.find(page => page.url.endsWith("/issue50")))
    .catch(() => false), "Edge CDP");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({data}) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (!pending.has(message.id)) return;
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      pending.set(++id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  evaluate = async expression => {
    const result = await send("Runtime.evaluate", {expression, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const requests = [];
  await send("Network.enable");
  socket.addEventListener("message", ({data}) => {
    const message = JSON.parse(data);
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      requests.push([message.params.response.status, message.params.response.url]);
    }
  });
  await send("Page.reload");
  const start = performance.now();
  await waitFor(() => evaluate('Boolean(document.querySelector("#workspace-panel-layout"))').catch(() => false), "Layout panel");
  assert.equal(await evaluate('document.querySelectorAll(".workspace-mode-tabs").length'), 0);
  const focused = 'document.activeElement?.matches(".structured-active-editor .ql-editor")';
  try {
    await waitFor(() => evaluate(focused).catch(() => false), "focus in Layout sidebar");
  } catch (error) {
    console.log("Browser response errors", requests);
    throw error;
  }
  assert.ok(previewRequests >= 1, "Background preview should be requested");
  await send("Input.insertText", {text: " SMOKE "});
  await waitFor(() => evaluate('document.activeElement.innerText.includes("SMOKE")'), "editable keystroke");
  const firstInputMs = Math.round(performance.now() - start);
  const blockId = 'document.activeElement.dataset.inlineEditorElementId';
  const firstBlockId = JSON.stringify(await evaluate(blockId));
  async function press(key, modifiers = 0) {
    const windowsVirtualKeyCode = {z:90,y:89,ArrowRight:39,End:35}[key];
    await send("Input.dispatchKeyEvent", {type:"keyDown", key, modifiers, windowsVirtualKeyCode});
    await send("Input.dispatchKeyEvent", {type:"keyUp", key, modifiers, windowsVirtualKeyCode});
  }
  await press("z", 2);
  await waitFor(() => evaluate('!document.activeElement.innerText.includes("SMOKE")'), "undo");
  await press("y", 2);
  await waitFor(() => evaluate('document.activeElement.innerText.includes("SMOKE")'), "redo");
  await evaluate('(() => { const data = new DataTransfer(); data.setData("text/plain", "Paste\\nSecond line"); document.activeElement.dispatchEvent(new ClipboardEvent("paste", {clipboardData:data,bubbles:true,cancelable:true})); })()');
  await waitFor(() => evaluate('document.activeElement.innerText.includes("Second line")'), "multiline paste");
  await evaluate('document.querySelector("#switch").click()');
  await waitFor(() => evaluate(focused + " && " + blockId + " !== " + firstBlockId), "switch to second document");
  await evaluate('document.querySelector("#switch").click()');
  await waitFor(() => evaluate(focused + " && " + blockId + " === " + firstBlockId +
    ' && document.activeElement.innerText.includes("SMOKE")'), "draft recovery when returning");
  console.log("First input in browser harness (ms)", firstInputMs);
  await waitFor(
    () => evaluate('document.body.innerText.includes("Word preview intentionally unavailable")'),
    "the preview failure",
  );
  await send("Input.insertText", {text: "AFTERFAIL"});
  await waitFor(() => evaluate('document.activeElement.innerText.includes("AFTERFAIL")'),
    "editing after the preview failure");
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({firstInputMs, previewRequests, checks: [
    "typing while preview is pending", "Layout-only workspace", "undo/redo", "multiline paste",
    "draft survives document switching",
    "editing after a failed preview",
  ]}));
} catch (error) {
  console.error({browserErrors, apiLog, previewRequests,
    ui: evaluate ? await evaluate("document.body.innerText.slice(0, 750)").catch(() => "") : ""});
  throw error;
} finally {
  socket?.close();
  browser?.kill();
  api.kill();
  await server?.close();
  const resolvedScratch = await realpath(scratch);
  if (path.dirname(resolvedScratch) === scratchParent && path.basename(resolvedScratch).startsWith("editor-")) {
    await rm(resolvedScratch, {recursive: true, force: true, maxRetries: 4})
      .catch(error => console.warn("Temporary test files could not be removed:", error.message));
  }
}
