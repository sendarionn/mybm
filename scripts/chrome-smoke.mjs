import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";

const extensionPath = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const child = spawn("npx", [
  "-y",
  "chrome-devtools-mcp@latest",
  "--categoryExtensions",
  "--isolated",
  "--headless",
  `--workspace=${extensionPath}`,
  "--no-performance-crux",
  "--no-usage-statistics"
], { stdio: ["pipe", "pipe", "inherit"] });

let requestId = 0;
const pending = new Map();

function request(method, params = {}) {
  const id = ++requestId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});

function textContent(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

function returnedJson(result) {
  const match = textContent(result).match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

function uidFor(snapshot, pattern) {
  const line = snapshot.split("\n").find((value) => pattern.test(value));
  const uid = line?.match(/uid=([^ ]+)/)?.[1];
  assert.ok(uid, `要素が見つかりません: ${pattern}`);
  return uid;
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: "mybm-chrome-smoke", version: "1.0.0" }
  });
  notify("notifications/initialized");
  const call = (name, args = {}) => request("tools/call", { name, arguments: args });

  const installed = textContent(await call("install_extension", { path: extensionPath }));
  const extensionId = installed.match(/Id: ([a-p]{32})/)?.[1];
  assert.ok(extensionId, "mybmを読み込めませんでした");

  await call("trigger_extension_action", { id: extensionId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  let pages = textContent(await call("list_pages"));
  const serviceWorkerId = pages.match(/(sw-\d+):/)?.[1];
  const popupPageId = Number(pages.match(/(\d+): mybm \(chrome-extension:/)?.[1]);
  assert.ok(serviceWorkerId, "Service Workerを検出できませんでした");
  assert.ok(popupPageId, "ポップアップを検出できませんでした");

  const fixtures = returnedJson(await call("evaluate_script", {
    serviceWorkerId,
    function: `async () => {
      const folder = await chrome.bookmarks.create({ title: "mybm Chrome smoke" });
      const child = await chrome.bookmarks.create({ parentId: folder.id, title: "child folder" });
      const bookmark = await chrome.bookmarks.create({
        parentId: folder.id,
        title: "test bookmark",
        url: "https://example.com/mybm-smoke"
      });
      return { folder, child, bookmark };
    }`,
    waitForStableDom: false
  }));

  const snapshot = async () => textContent(await call("take_snapshot", { pageId: popupPageId }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  let current = await snapshot();
  assert.match(current, /mybm Chrome smoke/);
  assert.match(current, /child folder/);
  const globalSearchUid = uidFor(current, /searchbox "ブックマークを検索"/);
  await call("fill", { pageId: popupPageId, uid: globalSearchUid, value: "no matching node" });
  current = await snapshot();
  await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => {
      const input = document.querySelector("#search");
      input.value = "";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }`
  });
  current = await snapshot();
  assert.match(current, /mybm Chrome smoke/);
  assert.match(current, /child folder/);
  await call("fill", {
    pageId: popupPageId,
    uid: uidFor(current, /searchbox "ブックマークを検索"/),
    value: "mybm Chrome smoke"
  });
  current = await snapshot();
  await call("click", {
    pageId: popupPageId,
    uid: uidFor(current, /button "mybm Chrome smoke フォルダ/)
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  current = await snapshot();
  assert.match(current, /searchbox "フォルダ内を検索"[^\n]*focused/);
  assert.match(current, /child folder/);
  assert.match(current, /test bookmark/);
  const folderPreviewHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-preview").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  const screenshot = await call("take_screenshot", {
    pageId: popupPageId,
    format: "webp"
  });
  assert.equal(screenshot.content?.some((item) => item.type === "image" && item.data), true);

  await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => document.querySelector("#description-preview").click()`
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  current = await snapshot();
  const editorUid = uidFor(current, /textbox "説明"/);
  const folderEditorHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-editor .cm-editor").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  const selectEditorContent = () => call("evaluate_script", {
    pageId: popupPageId,
    function: `() => {
      const content = document.querySelector("#description-editor .cm-content");
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }`
  });
  await call("fill", { pageId: popupPageId, uid: editorUid, value: "first line\nsecond line\nthird line" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const expandedFolderEditorHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-editor .cm-editor").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  assert.equal(expandedFolderEditorHeight > folderEditorHeight, true);
  await selectEditorContent();
  await call("press_key", { pageId: popupPageId, key: "Backspace" });
  await call("fill", { pageId: popupPageId, uid: editorUid, value: "Chrome smoke memo" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const shrunkFolderEditorHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-editor .cm-editor").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  assert.equal(shrunkFolderEditorHeight < expandedFolderEditorHeight, true);

  const stored = returnedJson(await call("evaluate_script", {
    serviceWorkerId,
    function: `async () => await chrome.storage.local.get(null)`,
    waitForStableDom: false
  }));
  assert.equal(stored.metadata[fixtures.folder.id].description, "Chrome smoke memo");
  assert.deepEqual(stored.metadataBackup, stored.metadata);
  assert.equal(stored.metadata[fixtures.folder.id].revision >= 1, true);

  current = await snapshot();
  await call("click", {
    pageId: popupPageId,
    uid: uidFor(current, /button "test bookmarkの説明を編集"/)
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const bookmarkPreviewHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-preview").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => document.querySelector("#description-preview").click()`
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  current = await snapshot();
  const bookmarkEditorHeight = returnedJson(await call("evaluate_script", {
    pageId: popupPageId,
    function: `() => ({ height: document.querySelector("#description-editor .cm-editor").getBoundingClientRect().height })`,
    waitForStableDom: false
  })).height;
  assert.equal(Math.abs(folderPreviewHeight - bookmarkPreviewHeight) < 1, true);
  assert.equal(Math.abs(folderEditorHeight - bookmarkEditorHeight) < 1, true);
  assert.equal(bookmarkPreviewHeight < 50, true);
  const bookmarkEditorMetrics = () => call("evaluate_script", {
    pageId: popupPageId,
    function: `() => {
      const scroller = document.querySelector("#description-editor .cm-scroller");
      return {
        height: document.querySelector("#description-editor .cm-editor").getBoundingClientRect().height,
        scrollable: scroller.scrollHeight > scroller.clientHeight
      };
    }`,
    waitForStableDom: false
  }).then(returnedJson);
  await call("fill", {
    pageId: popupPageId,
    uid: uidFor(current, /textbox "説明"/),
    value: "折り返し確認".repeat(30)
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await bookmarkEditorMetrics()).height > bookmarkEditorHeight, true);
  await selectEditorContent();
  await call("press_key", { pageId: popupPageId, key: "Backspace" });
  await call("fill", {
    pageId: popupPageId,
    uid: uidFor(current, /textbox "説明"/),
    value: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cappedMetrics = await bookmarkEditorMetrics();
  assert.equal(cappedMetrics.height <= 220.5, true);
  assert.equal(cappedMetrics.scrollable, true);
  await selectEditorContent();
  await call("press_key", { pageId: popupPageId, key: "Backspace" });
  await call("fill", {
    pageId: popupPageId,
    uid: uidFor(current, /textbox "説明"/),
    value: "Bookmark smoke memo"
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const bothStored = returnedJson(await call("evaluate_script", {
    serviceWorkerId,
    function: `async () => await chrome.storage.local.get(null)`,
    waitForStableDom: false
  }));
  assert.equal(bothStored.metadata[fixtures.folder.id].description, "Chrome smoke memo");
  assert.equal(bothStored.metadata[fixtures.bookmark.id].description, "Bookmark smoke memo");

  await call("click", { pageId: popupPageId, uid: uidFor(await snapshot(), /button "一覧へ戻る"/) });
  current = await snapshot();
  assert.match(current, /searchbox "フォルダ内を検索"/);
  await call("click", { pageId: popupPageId, uid: uidFor(current, /button "一覧へ戻る"/) });
  current = await snapshot();
  assert.match(current, /searchbox "ブックマークを検索"[^\n]*value="mybm Chrome smoke"/);
  assert.match(current, /button "mybm Chrome smoke フォルダ/);

  const consoleMessages = textContent(await call("list_console_messages", {
    pageId: popupPageId,
    types: ["error"],
    includeStackTraces: true
  }));
  assert.match(consoleMessages, /<no console messages found>/);

  await call("reload_extension", { id: extensionId });
  await call("trigger_extension_action", { id: extensionId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  pages = textContent(await call("list_pages"));
  const reloadedWorkerId = pages.match(/(sw-\d+):/)?.[1];
  assert.ok(reloadedWorkerId, "再読み込み後のService Workerを検出できませんでした");
  const reloadedStored = returnedJson(await call("evaluate_script", {
    serviceWorkerId: reloadedWorkerId,
    function: `async () => await chrome.storage.local.get(null)`,
    waitForStableDom: false
  }));
  assert.equal(reloadedStored.metadata[fixtures.folder.id].description, "Chrome smoke memo");
  assert.equal(reloadedStored.metadata[fixtures.bookmark.id].description, "Bookmark smoke memo");
  console.log("Chrome実機スモークテスト成功");
} finally {
  child.kill("SIGTERM");
}
