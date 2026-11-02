import {
  buildLinksForTarget,
  buildLinkSuggestions,
  childNodes,
  flattenNodes,
  folderViewerPath,
  isBookmarkletUrl,
  nodeById,
  resolveLinkTarget
} from "./core.mjs";
import { createDescriptionEditor } from "./editor.mjs";
import { readMetadata, writeMetadata } from "./storage.mjs";

const elements = {
  viewer: document.querySelector("#viewer"),
  status: document.querySelector("#viewer-status"),
  title: document.querySelector("#folder-title"),
  path: document.querySelector("#folder-path"),
  editor: document.querySelector("#description-editor"),
  saveStatus: document.querySelector("#save-status"),
  folders: document.querySelector("#child-folders"),
  bookmarks: document.querySelector("#child-bookmarks"),
  links: document.querySelector("#links")
};

let nodes = [];
let metadata = {};
let folder = null;
let editor = null;
let saveTimer = null;
let pendingDescription = null;

function folderIdFromLocation() {
  return new URL(location.href).searchParams.get("folderId");
}

function viewerUrl(folderId) {
  return folderViewerPath(folderId);
}

function showError(message) {
  elements.viewer.hidden = true;
  elements.status.hidden = false;
  elements.status.textContent = message;
}

function nodeButton(node, label, onClick) {
  const button = document.createElement("button");
  const kind = document.createElement("span");
  const title = document.createElement("span");
  button.type = "button";
  button.className = "node-button";
  kind.className = "node-kind";
  kind.textContent = node.type === "folder" ? "▰" : "↗";
  title.textContent = label;
  button.append(kind, title);
  button.addEventListener("click", onClick);
  return button;
}

function renderNodeList(container, values, emptyText, onClick) {
  container.replaceChildren();
  if (!values.length) {
    const empty = document.createElement("span");
    empty.className = "node-empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const node of values) container.append(nodeButton(node, node.title, () => onClick(node)));
}

async function openBookmark(node) {
  await flushSave();
  if (isBookmarkletUrl(node.url)) {
    elements.saveStatus.textContent = "ブックマークレットはツールバーのmybmから実行してください";
    return;
  }
  chrome.tabs.create({ url: node.url });
}

async function navigateFolder(node, replace = false) {
  await flushSave();
  const url = viewerUrl(node.id);
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  loadFolder();
}

function openTarget(target) {
  if (target.type === "folder") {
    navigateFolder(target.node);
    return;
  }
  if (target.type === "bookmark") {
    openBookmark(target.node);
    return;
  }
  renderAmbiguousTarget(target);
}

function renderAmbiguousTarget(target) {
  elements.links.replaceChildren();
  const label = document.createElement("span");
  label.className = "node-empty";
  label.textContent = target.matches.length ? "同名ノードを選択" : "リンク先がありません";
  elements.links.append(label);
  for (const match of target.matches) {
    const detail = match.type === "folder" ? `${match.title}（フォルダ）` : `${match.title}｜${match.url}`;
    elements.links.append(nodeButton(match, detail, () => openTarget({ type: match.type, node: match })));
  }
}

function renderLinks() {
  const target = { type: "folder", node: folder };
  const links = buildLinksForTarget(nodes, metadata, target);
  elements.links.replaceChildren();
  if (!links.length) {
    const empty = document.createElement("span");
    empty.className = "node-empty";
    empty.textContent = "リンクなし";
    elements.links.append(empty);
    return;
  }
  for (const link of links) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-chip";
    button.textContent = link;
    button.addEventListener("click", () => openTarget(resolveLinkTarget(link, nodes)));
    elements.links.append(button);
  }
}

async function saveDescription(value) {
  if (!folder) return;
  if (value) {
    metadata[folder.id] = { bookmarkId: folder.id, description: value, updatedAt: Date.now() };
  } else {
    delete metadata[folder.id];
  }
  try {
    await writeMetadata(chrome.storage.local, metadata);
    elements.saveStatus.textContent = "保存済み";
  } catch {
    elements.saveStatus.textContent = "未保存";
  }
}

function scheduleSave(value) {
  clearTimeout(saveTimer);
  pendingDescription = value;
  elements.saveStatus.textContent = "未保存";
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const description = pendingDescription;
    pendingDescription = null;
    saveDescription(description);
  }, 500);
}

async function flushSave() {
  if (pendingDescription === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const description = pendingDescription;
  pendingDescription = null;
  await saveDescription(description);
}

function ensureEditor() {
  if (editor) return editor;
  editor = createDescriptionEditor(elements.editor, {
    getLinkSuggestions: () => buildLinkSuggestions(nodes, metadata),
    onChange(value) {
      if (!folder) return;
      if (value) metadata[folder.id] = { bookmarkId: folder.id, description: value, updatedAt: Date.now() };
      else delete metadata[folder.id];
      renderLinks();
      scheduleSave(value);
    },
    onLink(label) {
      openTarget(resolveLinkTarget(label, nodes));
    }
  });
  return editor;
}

async function loadFolder() {
  const folderId = folderIdFromLocation();
  if (!folderId) {
    showError("フォルダが指定されていません");
    return;
  }
  const [tree, storedMetadata] = await Promise.all([
    chrome.bookmarks.getTree(),
    readMetadata(chrome.storage.local)
  ]);
  nodes = flattenNodes(tree);
  metadata = storedMetadata;
  folder = nodeById(nodes, folderId);
  if (!folder || folder.type !== "folder") {
    showError("フォルダが削除されたか、存在しません");
    return;
  }

  elements.status.hidden = true;
  elements.viewer.hidden = false;
  elements.title.textContent = folder.title;
  document.title = `${folder.title} - mybm`;
  elements.path.textContent = folder.folder;
  ensureEditor().setValue(metadata[folder.id]?.description || "");
  const children = childNodes(nodes, folder.id);
  renderNodeList(elements.folders, children.filter(({ type }) => type === "folder"), "子フォルダなし", navigateFolder);
  renderNodeList(elements.bookmarks, children.filter(({ type }) => type === "bookmark"), "ブックマークなし", openBookmark);
  renderLinks();
}

window.addEventListener("popstate", async () => {
  await flushSave();
  loadFolder();
});
for (const event of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onRemoved
]) event.addListener(async () => {
  await flushSave();
  loadFolder();
});

loadFolder().catch(() => showError("フォルダを読み込めませんでした"));
