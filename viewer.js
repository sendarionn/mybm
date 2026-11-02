import {
  buildLinksForTarget,
  buildLinkSuggestions,
  childNodes,
  flattenNodes,
  folderViewerPath,
  isBookmarkletUrl,
  mergeRenamedLinksIntoEditedDescription,
  nodeById,
  resolveLinkedLabel
} from "./core.mjs";
import { createDescriptionEditor } from "./editor.mjs";
import { readMetadata } from "./storage.mjs";

const elements = {
  viewer: document.querySelector("#viewer"),
  status: document.querySelector("#viewer-status"),
  title: document.querySelector("#folder-title"),
  titleEditor: document.querySelector("#folder-title-editor"),
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
let currentDescription = "";
let savedRevision = 0;

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

function startTitleEditing() {
  if (!folder) return;
  elements.titleEditor.value = folder.title;
  elements.title.hidden = true;
  elements.titleEditor.hidden = false;
  elements.titleEditor.focus();
  elements.titleEditor.select();
}

function cancelTitleEditing() {
  elements.titleEditor.hidden = true;
  elements.title.hidden = false;
}

async function finishTitleEditing() {
  if (!folder || elements.titleEditor.hidden) return;
  const title = elements.titleEditor.value.trim();
  if (!title || title === folder.title) {
    cancelTitleEditing();
    return;
  }
  await flushSave();
  try {
    await chrome.bookmarks.update(folder.id, { title });
    folder.title = title;
    elements.title.textContent = title;
    document.title = `${title} - mybm`;
  } catch {
    elements.saveStatus.textContent = "フォルダ名を保存できませんでした";
  } finally {
    cancelTitleEditing();
  }
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
    button.addEventListener("click", () => openTarget(resolveLinkedLabel(link, metadata[folder.id], nodes)));
    elements.links.append(button);
  }
}

async function saveDescription(value) {
  if (!folder) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "saveMetadataEntry",
      nodeId: folder.id,
      description: value,
      baseRevision: savedRevision
    });
    if (response?.conflict) {
      if (response.entry) {
        metadata[folder.id] = response.entry;
        savedRevision = response.entry.revision || 0;
      }
      elements.saveStatus.textContent = "名称変更との競合を確認してください";
      return;
    }
    if (!response?.ok) throw new Error("save failed");
    if (response.entry) metadata[folder.id] = response.entry;
    else delete metadata[folder.id];
    savedRevision = response.entry?.revision || 0;
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
      currentDescription = value;
      metadata[folder.id] = {
        ...metadata[folder.id],
        bookmarkId: folder.id,
        description: value,
        updatedAt: Date.now()
      };
      renderLinks();
      scheduleSave(value);
    },
    onLink(label) {
      openTarget(resolveLinkedLabel(label, metadata[folder.id], nodes));
    }
  });
  return editor;
}

function renderChildren() {
  const children = childNodes(nodes, folder.id);
  renderNodeList(elements.folders, children.filter(({ type }) => type === "folder"), "子フォルダなし", navigateFolder);
  renderNodeList(elements.bookmarks, children.filter(({ type }) => type === "bookmark"), "ブックマークなし", openBookmark);
}

function applyLinkedNodeRename(message) {
  for (const change of message.changes || []) {
    metadata[change.sourceId] = {
      ...metadata[change.sourceId],
      description: change.afterDescription,
      linkReferences: change.linkReferences,
      updatedAt: change.updatedAt,
      revision: change.revision
    };
    if (folder?.id !== change.sourceId) continue;
    const merged = mergeRenamedLinksIntoEditedDescription(
      change.beforeDescription,
      currentDescription,
      change.beforeLinkReferences,
      message.targetId,
      message.title
    );
    if (merged.changed) {
      const hadUnsavedInput = currentDescription !== change.beforeDescription;
      currentDescription = merged.description;
      metadata[change.sourceId] = {
        ...metadata[change.sourceId],
        description: merged.description,
        linkReferences: merged.linkReferences
      };
      savedRevision = change.revision || 0;
      editor.setValue(currentDescription);
      if (hadUnsavedInput) scheduleSave(currentDescription);
      else elements.saveStatus.textContent = "リンク名を更新しました";
    } else if (merged.conflict) {
      elements.saveStatus.textContent = "名称変更との競合を確認してください";
    }
  }
  renderLinks();
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
  elements.titleEditor.value = folder.title;
  document.title = `${folder.title} - mybm`;
  elements.path.textContent = folder.folder;
  currentDescription = metadata[folder.id]?.description || "";
  savedRevision = metadata[folder.id]?.revision || 0;
  ensureEditor().setValue(currentDescription);
  renderChildren();
  renderLinks();
}

window.addEventListener("popstate", async () => {
  await flushSave();
  loadFolder();
});
for (const event of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onRemoved
]) event.addListener(async () => {
  await flushSave();
  loadFolder();
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  const node = nodeById(nodes, id);
  if (!node) return;
  if (typeof changeInfo.title === "string") node.title = changeInfo.title;
  if (typeof changeInfo.url === "string") node.url = changeInfo.url;
  if (folder?.id === id && typeof changeInfo.title === "string") {
    folder.title = changeInfo.title;
    elements.title.textContent = changeInfo.title;
    document.title = `${changeInfo.title} - mybm`;
  }
  renderChildren();
  renderLinks();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "linkedNodeRenamed") applyLinkedNodeRename(message);
});

elements.title.addEventListener("click", startTitleEditing);
elements.title.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startTitleEditing();
  }
});
elements.titleEditor.addEventListener("blur", finishTitleEditing);
elements.titleEditor.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter") {
    event.preventDefault();
    finishTitleEditing();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelTitleEditing();
  }
});

loadFolder().catch(() => showError("フォルダを読み込めませんでした"));
