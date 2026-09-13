import {
  extractLinks,
  flattenBookmarks,
  buildLinkGraph,
  bookmarkletSource,
  isBookmarkletUrl,
  parseDescriptionLines,
  resolveLinkTarget,
  searchBookmarks,
  targetKey
} from "./core.mjs";
import { createDescriptionEditor } from "./editor.mjs";

const elements = {
  home: document.querySelector("#app-title"),
  listView: document.querySelector("#list-view"),
  detailView: document.querySelector("#detail-view"),
  search: document.querySelector("#search"),
  heading: document.querySelector("#result-heading"),
  results: document.querySelector("#results"),
  status: document.querySelector("#status"),
  back: document.querySelector("#back"),
  title: document.querySelector("#detail-title"),
  titleEditor: document.querySelector("#title-editor"),
  url: document.querySelector("#detail-url"),
  descriptionArea: document.querySelector("#description-area"),
  editorSurface: document.querySelector("#editor-surface"),
  descriptionPreview: document.querySelector("#description-preview"),
  descriptionEditor: document.querySelector("#description-editor"),
  description: document.querySelector("#description"),
  links: document.querySelector("#links"),
  saveStatus: document.querySelector("#save-status")
};

let bookmarks = [];
let metadata = {};
let selectedBookmark = null;
let selectedTarget = null;
let navigationStack = [];
let saveTimer = null;
let saving = false;
let saveAgain = false;
let descriptionEditor = null;

async function loadData() {
  const [tree, stored] = await Promise.all([
    chrome.bookmarks.getTree(),
    chrome.storage.local.get("metadata")
  ]);
  bookmarks = flattenBookmarks(tree);
  metadata = stored.metadata || {};
}

function displayUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

const icons = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.25V20h2.75L17.81 8.94l-2.75-2.75L4 17.25Zm15.71-10.42a1 1 0 0 0 0-1.42l-1.12-1.12a1 1 0 0 0-1.42 0l-1.23 1.23 2.75 2.75 1.02-1.44Z"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Zm5 16H5V5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6Z"/></svg>'
};

function createIconButton(icon, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-action";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = icons[icon];
  button.addEventListener("click", onClick);
  return button;
}

async function openBookmarkUrl(bookmark) {
  if (!isBookmarkletUrl(bookmark.url)) {
    await chrome.tabs.create({ url: bookmark.url });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("実行対象のタブがありません");
  if (!chrome.userScripts?.execute) {
    throw new Error("拡張機能の詳細で「ユーザー スクリプトを許可する」を有効にしてください");
  }
  await chrome.userScripts.execute({
    target: { tabId: tab.id },
    world: "MAIN",
    injectImmediately: true,
    js: [{ code: bookmarkletSource(bookmark.url) }]
  });
}

function renderResults() {
  const query = elements.search.value;
  const matches = searchBookmarks(bookmarks, metadata, query);
  elements.heading.textContent = query.trim() ? "検索結果" : "最近追加したブックマーク";
  elements.results.replaceChildren();
  elements.status.textContent = matches.length ? "" : "該当するブックマークがありません";

  for (const bookmark of matches) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    const identity = document.createElement("div");
    const actions = document.createElement("div");
    const title = document.createElement("span");
    const url = document.createElement("span");
    row.className = "result-row";
    identity.className = "result-identity";
    actions.className = "result-actions";
    title.className = "result-title";
    url.className = "result-url";
    title.textContent = bookmark.title;
    url.textContent = displayUrl(bookmark.url);
    identity.append(title, url);
    actions.append(
      createIconButton("edit", `${bookmark.title}の説明を編集`, () => {
        navigationStack = [];
        openBookmark(bookmark, false);
      }),
      createIconButton("open", isBookmarkletUrl(bookmark.url)
        ? `${bookmark.title}を現在のタブで実行`
        : `${bookmark.title}を新しいタブで開く`, async () => {
        try {
          await openBookmarkUrl(bookmark);
        } catch (error) {
          elements.status.textContent = `実行できませんでした: ${error.message}`;
        }
      })
    );
    row.append(identity, actions);
    item.append(row);
    elements.results.append(item);
  }
}

function renderLinks() {
  if (!selectedTarget) return;
  const previewMetadata = { ...metadata };
  if (selectedBookmark) {
    previewMetadata[selectedBookmark.id] = {
      bookmarkId: selectedBookmark.id,
      description: elements.description.value,
      updatedAt: Date.now()
    };
  }
  const graph = buildLinkGraph(bookmarks, previewMetadata);
  const links = graph.get(targetKey(selectedTarget)) || [];
  elements.links.replaceChildren();
  if (!links.length) {
    const empty = document.createElement("span");
    empty.className = "link-empty";
    empty.textContent = "リンクなし";
    elements.links.append(empty);
  }
  for (const link of links) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "link-chip";
    chip.textContent = link;
    chip.addEventListener("click", () => followLink(link));
    elements.links.append(chip);
  }

  if (selectedTarget.type === "virtual" && selectedTarget.matches.length) {
    const label = document.createElement("p");
    label.className = "match-label";
    label.textContent = "同名のブックマーク";
    elements.links.append(label);
    for (const bookmark of selectedTarget.matches) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "link-chip";
      chip.textContent = displayUrl(bookmark.url);
      chip.addEventListener("click", () => navigateTo({ type: "bookmark", bookmark }));
      elements.links.append(chip);
    }
  }
}

function appendRenderedText(container, text) {
  const pattern = /\[([^\[\]\n]+)\]/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(offset, match.index)));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "description-link";
    link.textContent = match[1];
    link.addEventListener("click", () => followLink(match[1].trim()));
    container.append(link);
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function renderDescription() {
  elements.descriptionPreview.replaceChildren();
  if (!elements.description.value) {
    const empty = document.createElement("span");
    empty.className = "description-empty";
    empty.textContent = "説明なし";
    elements.descriptionPreview.append(empty);
    return;
  }

  for (const [index, value] of parseDescriptionLines(elements.description.value).entries()) {
    const line = document.createElement("div");
    line.className = `description-line${value.depth && value.text ? " indented" : ""}`;
    line.dataset.index = index;
    line.style.setProperty("--depth", value.depth);
    if (value.depth && value.text) {
      const bullet = document.createElement("span");
      bullet.className = "description-bullet";
      bullet.setAttribute("aria-hidden", "true");
      bullet.textContent = "•";
      line.append(bullet);
    }
    if (value.text) appendRenderedText(line, value.text);
    else line.append(document.createElement("br"));
    elements.descriptionPreview.append(line);
  }
}

function ensureDescriptionEditor() {
  if (descriptionEditor) return descriptionEditor;
  descriptionEditor = createDescriptionEditor(elements.descriptionEditor, {
    onChange(value) {
      elements.description.value = value;
      renderLinks();
      scheduleSave();
    },
    onLink: followLink
  });
  return descriptionEditor;
}

function startEditing(lineIndex = null) {
  if (!selectedBookmark) return;
  elements.editorSurface.classList.add("editing");
  elements.descriptionPreview.hidden = true;
  elements.description.hidden = true;
  elements.descriptionEditor.hidden = false;
  const editor = ensureDescriptionEditor();
  editor.setValue(elements.description.value);
  let offset = null;
  if (lineIndex !== null) {
    const rows = elements.description.value.split("\n");
    offset = rows.slice(0, lineIndex).reduce((sum, row) => sum + row.length + 1, 0)
      + (rows[lineIndex]?.length || 0);
  }
  requestAnimationFrame(() => editor.focus(offset));
}

async function finishEditing() {
  if (!elements.editorSurface.classList.contains("editing")) return;
  await flushSave();
  elements.editorSurface.classList.remove("editing");
  renderDescription();
  elements.description.hidden = true;
  elements.descriptionEditor.hidden = true;
  elements.descriptionPreview.hidden = false;
}

function openBookmark(bookmark, edit = false) {
  selectedTarget = { type: "bookmark", bookmark };
  selectedBookmark = bookmark;
  elements.title.textContent = bookmark.title;
  elements.title.hidden = false;
  elements.titleEditor.hidden = true;
  elements.titleEditor.value = bookmark.title;
  elements.url.value = displayUrl(bookmark.url);
  elements.url.readOnly = true;
  elements.url.classList.remove("editing");
  elements.url.hidden = false;
  elements.descriptionArea.hidden = false;
  elements.description.value = metadata[bookmark.id]?.description || "";
  const editor = ensureDescriptionEditor();
  editor.setValue(elements.description.value);
  elements.saveStatus.textContent = "";
  elements.editorSurface.classList.toggle("editing", edit);
  renderDescription();
  renderLinks();
  elements.listView.hidden = true;
  elements.detailView.hidden = false;
  elements.description.hidden = true;
  elements.descriptionEditor.hidden = !edit;
  elements.descriptionPreview.hidden = edit;
  if (edit) {
    requestAnimationFrame(() => editor.focus());
  }
}

function openVirtual(target) {
  selectedTarget = target;
  selectedBookmark = null;
  elements.title.textContent = target.title;
  elements.title.hidden = false;
  elements.titleEditor.hidden = true;
  elements.url.hidden = true;
  elements.descriptionArea.hidden = true;
  elements.saveStatus.textContent = "";
  elements.listView.hidden = true;
  elements.detailView.hidden = false;
  renderLinks();
}

function showTarget(target) {
  if (target.type === "bookmark") openBookmark(target.bookmark, false);
  else openVirtual(target);
}

async function navigateTo(target) {
  await flushSave();
  if (selectedTarget) navigationStack.push(selectedTarget);
  showTarget(target);
}

async function followLink(title) {
  await navigateTo(resolveLinkTarget(title, bookmarks));
}

async function closeDetail() {
  await flushSave();
  if (navigationStack.length) {
    showTarget(navigationStack.pop());
    return;
  }
  selectedBookmark = null;
  selectedTarget = null;
  elements.detailView.hidden = true;
  elements.listView.hidden = false;
  renderResults();
  elements.search.focus();
}

async function goHome() {
  await flushSave();
  navigationStack = [];
  selectedBookmark = null;
  selectedTarget = null;
  elements.detailView.hidden = true;
  elements.listView.hidden = false;
  renderResults();
  elements.search.focus();
}

function startTitleEditing() {
  if (!selectedBookmark) return;
  elements.titleEditor.value = selectedBookmark.title;
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
  if (elements.titleEditor.hidden || !selectedBookmark) return;
  const title = elements.titleEditor.value.trim();
  if (!title || title === selectedBookmark.title) {
    cancelTitleEditing();
    return;
  }

  const bookmarkId = selectedBookmark.id;
  elements.titleEditor.hidden = true;
  elements.title.hidden = false;
  try {
    const updated = await chrome.bookmarks.update(bookmarkId, { title });
    selectedBookmark.title = updated.title;
    elements.title.textContent = updated.title;
    elements.saveStatus.textContent = "タイトルを保存しました";
  } catch {
    elements.saveStatus.textContent = "タイトルを保存できませんでした";
  } finally {
    renderLinks();
  }
}

function startUrlEditing() {
  if (!selectedBookmark || !elements.url.readOnly) return;
  elements.url.value = selectedBookmark.url;
  elements.url.readOnly = false;
  elements.url.classList.add("editing");
  elements.url.focus();
  elements.url.select();
}

function cancelUrlEditing() {
  elements.url.readOnly = true;
  elements.url.classList.remove("editing");
  if (selectedBookmark) elements.url.value = displayUrl(selectedBookmark.url);
}

async function finishUrlEditing() {
  if (elements.url.readOnly || !selectedBookmark) return;
  const url = elements.url.value.trim();
  if (!url || url === selectedBookmark.url) {
    cancelUrlEditing();
    return;
  }

  const bookmarkId = selectedBookmark.id;
  elements.url.readOnly = true;
  elements.url.classList.remove("editing");
  try {
    const updated = await chrome.bookmarks.update(bookmarkId, { url });
    selectedBookmark.url = updated.url;
    elements.url.value = displayUrl(updated.url);
    elements.saveStatus.textContent = "URLを保存しました";
  } catch {
    elements.url.value = displayUrl(selectedBookmark.url);
    elements.saveStatus.textContent = "URLを保存できませんでした";
  }
}

async function saveDescription() {
  if (!selectedBookmark) return;
  if (saving) {
    saveAgain = true;
    return;
  }

  saving = true;
  const bookmarkId = selectedBookmark.id;
  const description = elements.description.value;
  if (description) {
    metadata[bookmarkId] = {
      bookmarkId,
      description,
      updatedAt: Date.now()
    };
  } else {
    delete metadata[bookmarkId];
  }

  try {
    await chrome.storage.local.set({ metadata });
    if (selectedBookmark?.id === bookmarkId) elements.saveStatus.textContent = "保存済み";
  } catch {
    if (selectedBookmark?.id === bookmarkId) elements.saveStatus.textContent = "未保存";
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      await saveDescription();
    }
  }
}

function scheduleSave() {
  if (!selectedBookmark) return;
  clearTimeout(saveTimer);
  elements.saveStatus.textContent = "未保存";
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDescription();
  }, 500);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveDescription();
}

async function refreshBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  bookmarks = flattenBookmarks(tree);
  if (!elements.listView.hidden) renderResults();
}

elements.search.addEventListener("input", renderResults);
elements.home.addEventListener("click", goHome);
elements.back.addEventListener("click", () => closeDetail());
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
elements.url.addEventListener("click", startUrlEditing);
elements.url.addEventListener("blur", finishUrlEditing);
elements.url.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter") {
    event.preventDefault();
    if (elements.url.readOnly) startUrlEditing();
    else finishUrlEditing();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelUrlEditing();
  }
});
elements.descriptionPreview.addEventListener("click", (event) => {
  if (!event.target.closest(".description-link")) {
    const line = event.target.closest(".description-line");
    startEditing(line ? Number(line.dataset.index) : null);
  }
});
elements.descriptionPreview.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.target.closest(".description-link")) startEditing();
});
for (const event of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onRemoved
]) {
  event.addListener(refreshBookmarks);
}

loadData()
  .then(() => {
    renderResults();
    elements.search.focus();
  })
  .catch(() => {
    elements.status.textContent = "ブックマークを読み込めませんでした";
  });
