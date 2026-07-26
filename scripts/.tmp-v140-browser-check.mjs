import fs from "node:fs/promises";
import path from "node:path";

const debugPort = 9223;
const appUrl = "http://127.0.0.1:5173";
const artifactDirectory = path.resolve(".artifacts", "v140-browser");

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails.text);
      }
      if (
        message.method === "Log.entryAdded" &&
        ["error", "warning"].includes(message.params.entry.level)
      ) {
        this.errors.push(message.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return new CdpClient(socket);
}

async function main() {
  await fs.mkdir(artifactDirectory, { recursive: true });
  const targets = await fetch(
    `http://127.0.0.1:${debugPort}/json/list`,
  ).then((response) => response.json());
  const pageTarget = targets.find(
    (target) => target.type === "page" && target.url.startsWith(appUrl),
  );
  if (!pageTarget) throw new Error("The DocSync browser target was not found.");

  const client = await connect(pageTarget.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");
  await client.send("Page.bringToFront");
  await client.send("Page.navigate", { url: appUrl });

  async function evaluate(expression, returnByValue = true) {
    const response = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text);
    }
    return returnByValue ? response.result.value : response.result;
  }

  async function waitFor(expression, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async function count(selector) {
    return evaluate(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    );
  }

  async function click(selector, index = 0) {
    const matches = await count(selector);
    if (matches <= index) {
      throw new Error(
        `Cannot click ${selector} at index ${index}; found ${matches}.`,
      );
    }
    const box = await evaluate(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        disabled: Boolean(element.disabled),
      };
    })()`);
    if (box.disabled) throw new Error(`${selector} is disabled.`);
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }

  async function screenshot(fileName) {
    const capture = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    await fs.writeFile(
      path.join(artifactDirectory, fileName),
      Buffer.from(capture.data, "base64"),
    );
  }

  await waitFor(
    `document.readyState === "complete" && Boolean(document.querySelector(".theme-toggle"))`,
    "DocSync home",
  );

  const initialTheme = await evaluate(
    `document.documentElement.dataset.theme`,
  );
  if (initialTheme === "dark") {
    await click(".theme-toggle");
    await waitFor(
      `document.documentElement.dataset.theme === "light"`,
      "explicit light theme",
    );
  }
  if (
    (await evaluate(`document.documentElement.dataset.theme`)) !== "dark"
  ) {
    await click(".theme-toggle");
    await waitFor(
      `document.documentElement.dataset.theme === "dark"`,
      "dark theme",
    );
  }
  const storedDark = await evaluate(
    `localStorage.getItem("docsync-theme") === "dark"`,
  );
  if (!storedDark) throw new Error("Dark theme preference was not persisted.");

  const workspaceCount = await count(".saved-workspace-main");
  if (workspaceCount < 1) {
    throw new Error("No saved workspace is available for the acceptance test.");
  }
  await click(".saved-workspace-main", 0);
  await waitFor(
    `Boolean(document.querySelector(".workspace-mode .workspace-mode-tabs"))`,
    "saved workspace",
  );

  if (
    !(await evaluate(
      `document.querySelector("#workspace-tab-layout")?.classList.contains("active")`,
    ))
  ) {
    await click("#workspace-tab-layout");
    await waitFor(
      `document.querySelector("#workspace-tab-layout")?.classList.contains("active")`,
      "Layout mode",
    );
  }
  await waitFor(
    `Boolean(document.querySelector(".layout-selection-toggle")) ||
      document.querySelectorAll(".layout-fallback-block.editable").length >= 2`,
    "Layout selection control",
  );
  if ((await count(".layout-selection-toggle")) === 1) {
    await click(".layout-selection-toggle");
  }
  try {
    await waitFor(
      `document.querySelectorAll(".layout-fallback-block.editable").length >= 2`,
      "selectable Layout blocks",
      30_000,
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        await evaluate(`({
          layoutStatus: document.querySelector(".editor-loading-state")?.textContent?.trim(),
          emptyState: document.querySelector(".editor-empty-state")?.textContent?.trim(),
          inlineError: document.querySelector(".editor-inline-error")?.textContent?.trim(),
          activeMode: document.querySelector(".workspace-mode-tabs button.active")?.textContent?.trim(),
          layoutPanel: document.querySelector("#workspace-panel-layout")?.textContent?.trim(),
          editorBlockCount: document.querySelectorAll(".editor-block-card").length,
          layoutBlockCount: document.querySelectorAll(".layout-fallback-block").length,
          buttons: Array.from(document.querySelectorAll("button")).map((button) => button.textContent?.trim()).filter(Boolean).slice(0, 24)
        })`),
        null,
        2,
      ),
    );
    throw error;
  }
  await screenshot("01-dark-layout.png");

  const layoutBlocks = await evaluate(`Array.from(
    document.querySelectorAll(".layout-fallback-block.editable")
  ).slice(0, 3).map((element) => ({
    id: element.dataset.elementId,
    text: element.querySelector(".layout-fallback-content")?.textContent?.trim()
  }))`);
  if (!layoutBlocks[0]?.id || !layoutBlocks[1]?.id) {
    throw new Error("Layout blocks did not expose stable element IDs.");
  }

  await click(".layout-fallback-block.editable", 0);
  await waitFor(
    `document.querySelector("#workspace-tab-edit")?.classList.contains("active") &&
      Boolean(document.querySelector(".quill-editor-host .ql-editor"))`,
    "Layout selection to open Edit",
  );
  try {
    await waitFor(
      `document.activeElement?.classList.contains("ql-editor")`,
      "Quill focus after Layout selection",
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        await evaluate(`({
          active: {
            tag: document.activeElement?.tagName,
            className: document.activeElement?.className,
            text: document.activeElement?.textContent?.trim()
          },
          quill: {
            exists: Boolean(document.querySelector(".ql-editor")),
            contenteditable: document.querySelector(".ql-editor")?.getAttribute("contenteditable"),
            editorElementId: document.querySelector(".ql-editor")?.dataset.editorElementId,
            className: document.querySelector(".ql-editor")?.className
          },
          selected: document.querySelector(".editor-block-card.selected")?.dataset.elementId
        })`),
        null,
        2,
      ),
    );
    throw error;
  }

  const selectedAfterLayout = await evaluate(
    `document.querySelector(".editor-block-card.selected")?.dataset.elementId`,
  );
  if (selectedAfterLayout !== layoutBlocks[0].id) {
    throw new Error("Layout selection opened a different editor block.");
  }

  const quillObject = await evaluate(
    `document.querySelector(".quill-editor-host .ql-editor")`,
    false,
  );
  await client.send("Input.insertText", { text: " QA" });
  await waitFor(
    `document.querySelector(".quill-editor-host .ql-editor")?.textContent?.includes("QA")`,
    "Quill draft input",
  );

  await click(".theme-toggle");
  await waitFor(
    `document.documentElement.dataset.theme === "light"`,
    "light theme",
  );
  await waitFor(
    `getComputedStyle(
      document.querySelector(".editor-block-card:not(.selected)")
    ).backgroundColor === "rgb(255, 255, 255)"`,
    "light theme transition",
  );
  const sameQuill = await client.send("Runtime.callFunctionOn", {
    objectId: quillObject.objectId,
    functionDeclaration: `function () {
      return {
        connected: this.isConnected,
        current: this === document.querySelector(".quill-editor-host .ql-editor"),
        text: this.textContent
      };
    }`,
    returnByValue: true,
  });
  if (
    !sameQuill.result.value.connected ||
    !sameQuill.result.value.current ||
    !sameQuill.result.value.text.includes("QA")
  ) {
    throw new Error("Theme switching remounted Quill or lost the draft.");
  }
  const selectedAfterTheme = await evaluate(
    `document.querySelector(".editor-block-card.selected")?.dataset.elementId`,
  );
  if (selectedAfterTheme !== layoutBlocks[0].id) {
    throw new Error("Theme switching lost the selected block.");
  }
  await screenshot("02-light-edit-draft.png");

  await click("#workspace-tab-layout");
  await waitFor(
    `!document.querySelector("#workspace-panel-layout")?.hidden &&
      document.querySelector(".layout-fallback-block.selected")?.dataset.elementId === ${JSON.stringify(
        layoutBlocks[0].id,
      )}`,
    "persistent Layout selection",
  );
  await click(".layout-fallback-block.editable", 1);
  await waitFor(
    `Boolean(document.querySelector(".discard-draft-dialog"))`,
    "draft confirmation",
  );
  await click(".discard-draft-dialog .quiet-button");
  await waitFor(
    `!document.querySelector(".discard-draft-dialog") &&
      document.querySelector("#workspace-tab-edit")?.classList.contains("active") &&
      document.querySelector(".quill-editor-host .ql-editor")?.textContent?.includes("QA") &&
      document.activeElement?.classList.contains("ql-editor")`,
    "Cancel draft recovery",
  );

  await click("#workspace-tab-layout");
  await waitFor(
    `!document.querySelector("#workspace-panel-layout")?.hidden`,
    "Layout after Cancel",
  );
  await click(".layout-fallback-block.editable", 1);
  await waitFor(
    `Boolean(document.querySelector(".discard-draft-dialog"))`,
    "second draft confirmation",
  );
  await click(".discard-draft-dialog .primary-button");
  await waitFor(
    `document.querySelector("#workspace-tab-edit")?.classList.contains("active") &&
      document.querySelector(".editor-block-card.selected")?.dataset.elementId === ${JSON.stringify(
        layoutBlocks[1].id,
      )} &&
      document.activeElement?.classList.contains("ql-editor")`,
    "OK draft recovery",
  );
  const replacementText = await evaluate(
    `document.querySelector(".quill-editor-host .ql-editor")?.textContent`,
  );
  if (replacementText.includes("QA")) {
    throw new Error("The failed block draft leaked into the next block.");
  }

  await click(".theme-toggle");
  await waitFor(
    `document.documentElement.dataset.theme === "dark"`,
    "restored dark theme",
  );
  await waitFor(
    `getComputedStyle(
      document.querySelector(".editor-block-card:not(.selected)")
    ).backgroundColor === "rgb(23, 34, 49)"`,
    "dark theme transition",
  );
  await screenshot("03-dark-edit-focused.png");

  await client.send("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.readyState === "complete" &&
      document.documentElement.dataset.theme === "dark" &&
      localStorage.getItem("docsync-theme") === "dark"`,
    "persisted theme after reload",
  );

  const summary = {
    initialTheme,
    finalTheme: await evaluate(`document.documentElement.dataset.theme`),
    layoutBlockCount: layoutBlocks.length,
    selectedElementId: layoutBlocks[1].id,
    quillPreservedAcrossTheme: true,
    cancelRecovery: true,
    confirmRecovery: true,
    themePersistedAfterReload: true,
    browserErrors: client.errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  client.socket.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
