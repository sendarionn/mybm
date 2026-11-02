const LINK_PATTERN = /\[([^\[\]\n]+)\]/g;
const BOOKMARKLET_PATTERN = /^\s*javascript:/i;

function nodeType(node) {
  return node.type || (node.url ? "bookmark" : "folder");
}

export function isBookmarkletUrl(url = "") {
  return BOOKMARKLET_PATTERN.test(url);
}

export function bookmarkletSource(url = "") {
  const source = url.replace(BOOKMARKLET_PATTERN, "");
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

export function extractLinks(description = "") {
  const links = [];
  const seen = new Set();

  for (const match of description.matchAll(LINK_PATTERN)) {
    const value = match[1].trim();
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      links.push(value);
    }
  }

  return links;
}

export function parseLinkOccurrences(description = "") {
  const counts = new Map();
  return [...description.matchAll(LINK_PATTERN)].map((match) => {
    const label = match[1].trim();
    const key = normalize(label);
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    return {
      from: match.index,
      to: match.index + match[0].length,
      label,
      key,
      occurrence
    };
  }).filter(({ label }) => label);
}

function referenceKey(label, occurrence) {
  return `${normalize(label)}\u0000${occurrence}`;
}

export function resolveLinkReferences(description, nodes, previousReferences = []) {
  const previous = new Map(previousReferences
    .map((reference) => [referenceKey(reference.label, reference.occurrence), reference]));
  const references = [];
  for (const link of parseLinkOccurrences(description)) {
    const preserved = previous.get(referenceKey(link.label, link.occurrence));
    if (preserved) {
      references.push({ label: link.label, occurrence: link.occurrence, targetId: preserved.targetId });
      continue;
    }
    const target = resolveLinkTarget(link.label, nodes);
    if (target.type !== "virtual") {
      references.push({ label: link.label, occurrence: link.occurrence, targetId: target.node.id });
    }
  }
  return references;
}

export function resolveLinkedLabel(label, entry, nodes) {
  const targetIds = new Set((entry?.linkReferences || [])
    .filter((reference) => normalize(reference.label) === normalize(label))
    .map(({ targetId }) => targetId));
  if (targetIds.size === 1) {
    const [targetId] = targetIds;
    const node = nodeById(nodes, targetId);
    if (node) return { type: nodeType(node), node };
    return { type: "virtual", title: label.trim(), matches: [] };
  }
  return resolveLinkTarget(label, nodes);
}

export function metadataEntryForDescription(nodeId, description, nodes, previousEntry = {}) {
  const previous = previousEntry || {};
  return {
    bookmarkId: nodeId,
    description,
    updatedAt: Date.now(),
    revision: (previous.revision || 0) + 1,
    linkReferences: resolveLinkReferences(description, nodes, previous.linkReferences || [])
  };
}

export function hasMetadataSaveConflict(currentEntry, baseRevision, previousDescription) {
  if ((currentEntry?.revision || 0) === (baseRevision || 0)) return false;
  return (currentEntry?.description || "") !== (previousDescription || "");
}

export function migrateMetadataLinkReferences(metadata, nodes) {
  let changed = false;
  const migrated = {};
  for (const [id, entry] of Object.entries(metadata)) {
    if (!entry?.description) {
      migrated[id] = entry;
      continue;
    }
    if (Array.isArray(entry.linkReferences)) {
      migrated[id] = entry;
      continue;
    }
    migrated[id] = {
      ...entry,
      linkReferences: resolveLinkReferences(entry.description, nodes)
    };
    changed = true;
  }
  return { metadata: migrated, changed };
}

export function renameLinkedReferences(description, references, targetId, newTitle) {
  const referenceMap = new Map((references || []).map((reference) => [
    referenceKey(reference.label, reference.occurrence),
    reference
  ]));
  const links = parseLinkOccurrences(description);
  let text = "";
  let offset = 0;
  let changed = false;
  const outputLinks = [];

  for (const link of links) {
    const reference = referenceMap.get(referenceKey(link.label, link.occurrence));
    const targeted = reference?.targetId === targetId;
    const label = targeted ? newTitle : link.label;
    text += description.slice(offset, link.from);
    text += targeted ? `[${label}]` : description.slice(link.from, link.to);
    offset = link.to;
    if (label !== link.label) changed = true;
    outputLinks.push({ label, targetId: reference?.targetId || null });
  }
  text += description.slice(offset);
  if (!changed) return { description, linkReferences: references || [], changed: false };

  const counts = new Map();
  const linkReferences = [];
  for (const link of outputLinks) {
    const key = normalize(link.label);
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    if (link.targetId) linkReferences.push({ label: link.label, occurrence, targetId: link.targetId });
  }
  return { description: text, linkReferences, changed: true };
}

export function mergeRenamedLinksIntoEditedDescription(
  baseDescription,
  editedDescription,
  references,
  targetId,
  newTitle
) {
  const targetedLabels = new Set((references || [])
    .filter((reference) => reference.targetId === targetId)
    .map((reference) => normalize(reference.label)));
  const countLabels = (description) => {
    const counts = new Map();
    for (const link of parseLinkOccurrences(description)) {
      if (targetedLabels.has(link.key)) counts.set(link.key, (counts.get(link.key) || 0) + 1);
    }
    return counts;
  };
  const baseCounts = countLabels(baseDescription);
  const editedCounts = countLabels(editedDescription);
  for (const label of targetedLabels) {
    if ((baseCounts.get(label) || 0) !== (editedCounts.get(label) || 0)) {
      return {
        description: editedDescription,
        linkReferences: references || [],
        changed: false,
        conflict: true
      };
    }
  }
  return {
    ...renameLinkedReferences(editedDescription, references, targetId, newTitle),
    conflict: false
  };
}

export function renameMetadataLinks(metadata, targetId, newTitle) {
  const updated = { ...metadata };
  const changes = [];
  for (const [sourceId, entry] of Object.entries(metadata)) {
    if (!entry?.description || !Array.isArray(entry.linkReferences)) continue;
    const result = renameLinkedReferences(entry.description, entry.linkReferences, targetId, newTitle);
    if (!result.changed) continue;
    const updatedAt = Date.now();
    const revision = (entry.revision || 0) + 1;
    updated[sourceId] = {
      ...entry,
      description: result.description,
      linkReferences: result.linkReferences,
      updatedAt,
      revision
    };
    changes.push({
      sourceId,
      beforeDescription: entry.description,
      beforeLinkReferences: entry.linkReferences,
      afterDescription: result.description,
      linkReferences: result.linkReferences,
      updatedAt,
      revision
    });
  }
  return { metadata: updated, changes };
}

export function buildLinkSuggestions(nodes, metadata) {
  const suggestions = [];
  const seen = new Set();
  const add = (label, detail) => {
    const value = label?.trim();
    const key = normalize(value);
    if (!value || seen.has(key)) return;
    seen.add(key);
    suggestions.push({ label: value, detail });
  };

  for (const node of nodes) add(node.title, nodeType(node) === "folder" ? "フォルダ" : "ブックマーク");
  for (const value of Object.values(metadata)) {
    for (const link of extractLinks(value?.description || "")) add(link, "リンク");
  }
  return suggestions;
}

export function parseDescriptionLines(description = "") {
  return description.split("\n").map((line) => {
    const prefix = line.match(/^[ \t　]+/u)?.[0] || "";
    return { depth: [...prefix].length, prefix, text: line.slice(prefix.length) };
  });
}

export function flattenNodes(nodes, parentPath = [], parentId = null) {
  const result = [];

  for (const node of nodes) {
    const type = node.url ? "bookmark" : "folder";
    const visible = type === "bookmark" || Boolean(node.title);
    const currentPath = parentPath.join(" / ");
    if (visible) {
      result.push({
        id: node.id,
        parentId: node.parentId ?? parentId,
        type,
        title: node.title || node.url,
        url: node.url || "",
        dateAdded: node.dateAdded || 0,
        folder: currentPath
      });
    }

    if (node.children) {
      const nextPath = type === "folder" && node.title ? [...parentPath, node.title] : parentPath;
      result.push(...flattenNodes(node.children, nextPath, node.id));
    }
  }

  return result;
}

export function flattenBookmarks(nodes, parentPath = []) {
  return flattenNodes(nodes, parentPath)
    .filter(({ type }) => type === "bookmark")
    .map(({ parentId: _parentId, type: _type, ...bookmark }) => bookmark);
}

export function childNodes(nodes, folderId) {
  return nodes.filter(({ parentId }) => parentId === folderId);
}

export function descendantNodes(nodes, folderId) {
  const descendants = [];
  const pending = [folderId];
  while (pending.length) {
    const parentId = pending.shift();
    for (const node of childNodes(nodes, parentId)) {
      descendants.push(node);
      if (node.type === "folder") pending.push(node.id);
    }
  }
  return descendants;
}

export function searchFolderNodes(nodes, metadata, folderId, query) {
  return query.trim()
    ? searchNodes(descendantNodes(nodes, folderId), metadata, query)
    : childNodes(nodes, folderId);
}

/*
 * Chromeのツリーを正本とし、mybmでは検索と表示に必要な平坦な参照だけを作る
 */
export function nodeById(nodes, id) {
  return nodes.find((node) => node.id === id) || null;
}

export function removedNodeIds(id, node = {}) {
  const ids = [id];
  const collect = (children = []) => {
    for (const child of children) {
      ids.push(child.id);
      collect(child.children);
    }
  };
  collect(node.children);
  return ids;
}

export function pendingFolderTargetKey(windowId) {
  return `pendingFolderTarget:${windowId}`;
}

export function isPendingFolderTargetFresh(target, now = Date.now(), lifetime = 30000) {
  return Boolean(target?.folderId && Number.isFinite(target.createdAt)
    && now - target.createdAt >= 0 && now - target.createdAt <= lifetime);
}

function normalize(value) {
  return (value || "").normalize("NFKC").toLocaleLowerCase().trim();
}

function normalizeWithOffsets(value = "") {
  let text = "";
  const offsets = [];
  let originalOffset = 0;
  for (const character of value) {
    const normalized = character.normalize("NFKC").toLocaleLowerCase();
    for (let index = 0; index < normalized.length; index += 1) {
      offsets.push({ from: originalOffset, to: originalOffset + character.length });
    }
    text += normalized;
    originalOffset += character.length;
  }
  return { text, offsets };
}

export function findTextMatches(value, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return [];
  const normalized = normalizeWithOffsets(value);
  const matches = [];
  let offset = 0;
  while (offset <= normalized.text.length - query.length) {
    const index = normalized.text.indexOf(query, offset);
    if (index < 0) break;
    const first = normalized.offsets[index];
    const last = normalized.offsets[index + query.length - 1];
    if (first && last) matches.push({ from: first.from, to: last.to });
    offset = index + query.length;
  }
  return matches;
}

export function findMatchingDescriptionLine(description, query) {
  return description.split("\n")
    .map((line) => line.trim())
    .find((line) => findTextMatches(line, query).length) || "";
}

export function buildMatchContext(node, metadataEntry, query, radius = 8, hideLinkSyntax = false) {
  if (!normalize(query)) return { text: "", matches: [] };
  const descriptionLine = findMatchingDescriptionLine(metadataEntry?.description || "", query);
  const source = [
    { text: node.title, description: false },
    { text: node.url || "", description: false },
    { text: descriptionLine, description: true }
  ].find(({ text }) => text && findTextMatches(text, query).length);
  if (!source) return { text: "", matches: [] };

  const match = findTextMatches(source.text, query)[0];
  const beforeCharacters = [...source.text.slice(0, match.from)];
  const matchedText = source.text.slice(match.from, match.to);
  const afterCharacters = [...source.text.slice(match.to)];
  const before = beforeCharacters.slice(-radius).join("");
  const after = afterCharacters.slice(0, radius).join("");
  const prefix = beforeCharacters.length > radius ? "…" : "";
  const suffix = afterCharacters.length > radius ? "…" : "";
  let text = `${prefix}${before}${matchedText}${after}${suffix}`;
  let from = prefix.length + before.length;
  let to = from + matchedText.length;
  if (source.description && hideLinkSyntax) {
    const bracketsBeforeMatch = [...text.slice(0, from)].filter((value) => value === "[" || value === "]").length;
    const bracketsInsideMatch = [...text.slice(from, to)].filter((value) => value === "[" || value === "]").length;
    text = text.replaceAll("[", "").replaceAll("]", "");
    from -= bracketsBeforeMatch;
    to -= bracketsBeforeMatch + bracketsInsideMatch;
  }
  return {
    text,
    matches: [{ from, to }]
  };
}

export function resolveLinkTarget(title, nodes) {
  const normalizedTitle = normalize(title);
  const matches = nodes.filter((node) => normalize(node.title) === normalizedTitle);
  if (matches.length === 1) return { type: nodeType(matches[0]), node: matches[0] };
  return { type: "virtual", title: title.trim(), matches };
}

export function targetKey(target) {
  return target.type === "virtual"
    ? `virtual:${normalize(target.title)}`
    : `node:${target.node.id}`;
}

export function buildLinkGraph(nodes, metadata) {
  const relations = new Map();
  const add = (key, label) => {
    if (!relations.has(key)) relations.set(key, new Set());
    relations.get(key).add(label);
  };

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const sourceKey = `node:${node.id}`;
    const entry = metadata[node.id] || {};
    const references = new Map((entry.linkReferences || []).map((reference) => [
      referenceKey(reference.label, reference.occurrence), reference.targetId
    ]));
    for (const link of parseLinkOccurrences(entry.description || "")) {
      const targetId = references.get(referenceKey(link.label, link.occurrence));
      const targetNode = nodesById.get(targetId);
      const target = targetNode
        ? { type: nodeType(targetNode), node: targetNode }
        : targetId ? { type: "virtual", title: link.label, matches: [] }
          : resolveLinkTarget(link.label, nodes);
      const destinationKey = targetKey(target);
      add(sourceKey, link.label);
      add(destinationKey, node.title);
    }
  }

  return new Map([...relations].map(([key, labels]) => [key, [...labels]]));
}

export function buildLinksForTarget(nodes, metadata, target) {
  const selectedKey = targetKey(target);
  const links = new Set();
  const nodesByTitle = new Map();
  for (const node of nodes) {
    const key = normalize(node.title);
    const matches = nodesByTitle.get(key) || [];
    matches.push(node);
    nodesByTitle.set(key, matches);
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const sourceKey = `node:${node.id}`;
    const entry = metadata[node.id] || {};
    const references = new Map((entry.linkReferences || []).map((reference) => [
      referenceKey(reference.label, reference.occurrence), reference.targetId
    ]));
    for (const link of parseLinkOccurrences(entry.description || "")) {
      const targetId = references.get(referenceKey(link.label, link.occurrence));
      const targetNode = nodesById.get(targetId);
      const matches = nodesByTitle.get(normalize(link.label)) || [];
      const destinationKey = targetNode
        ? `node:${targetNode.id}`
        : targetId ? `virtual:${normalize(link.label)}`
          : matches.length === 1 ? `node:${matches[0].id}` : `virtual:${normalize(link.label)}`;
      if (sourceKey === selectedKey) links.add(link.label);
      if (destinationKey === selectedKey) links.add(node.title);
    }
  }
  return [...links];
}

function fieldScore(value, query, base) {
  const text = normalize(value);
  if (!text) return null;
  if (text === query) return base;
  if (text.startsWith(query)) return base + 10;
  const index = text.indexOf(query);
  if (index < 0) return null;
  const previous = index === 0 ? "" : text[index - 1];
  return /[^\p{L}\p{N}]/u.test(previous) ? base + 20 : base + 30;
}

export function searchNodes(nodes, metadata, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) {
    return [...nodes].sort((a, b) => b.dateAdded - a.dateAdded);
  }

  return nodes
    .map((node) => {
      const description = metadata[node.id]?.description || "";
      const scores = [
        fieldScore(node.title, query, 0),
        fieldScore(node.url || "", query, 40),
        fieldScore(description, query, 70),
        ...extractLinks(description).map((link) => fieldScore(link, query, 60))
      ].filter((score) => score !== null);

      return scores.length ? { node, score: Math.min(...scores) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || b.node.dateAdded - a.node.dateAdded)
    .map(({ node }) => node);
}

export function searchBookmarks(bookmarks, metadata, rawQuery) {
  return searchNodes(bookmarks, metadata, rawQuery);
}

const OMNIBOX_BOOKMARK_PREFIX = "mybm-bookmark:";
const OMNIBOX_NODE_PREFIX = "mybm-node:";

export function omniboxBookmarkContent(bookmarkId) {
  return `${OMNIBOX_BOOKMARK_PREFIX}${encodeURIComponent(bookmarkId)}`;
}

export function parseOmniboxBookmarkContent(content = "") {
  if (!content.startsWith(OMNIBOX_BOOKMARK_PREFIX)) return null;
  try {
    return decodeURIComponent(content.slice(OMNIBOX_BOOKMARK_PREFIX.length));
  } catch {
    return null;
  }
}

export function omniboxNodeContent(node) {
  return `${OMNIBOX_NODE_PREFIX}${encodeURIComponent(nodeType(node))}:${encodeURIComponent(node.id)}`;
}

export function parseOmniboxNodeContent(content = "") {
  if (content.startsWith(OMNIBOX_BOOKMARK_PREFIX)) {
    const id = parseOmniboxBookmarkContent(content);
    return id === null ? null : { type: "bookmark", id };
  }
  if (!content.startsWith(OMNIBOX_NODE_PREFIX)) return null;
  const separator = content.indexOf(":", OMNIBOX_NODE_PREFIX.length);
  if (separator < 0) return null;
  try {
    return {
      type: decodeURIComponent(content.slice(OMNIBOX_NODE_PREFIX.length, separator)),
      id: decodeURIComponent(content.slice(separator + 1))
    };
  } catch {
    return null;
  }
}

function escapeOmniboxDescription(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatOmniboxMatchContext(context) {
  if (!context.text) return "—";
  const match = context.matches[0];
  if (!match) return escapeOmniboxDescription(context.text);
  return [
    escapeOmniboxDescription(context.text.slice(0, match.from)),
    "<match>",
    escapeOmniboxDescription(context.text.slice(match.from, match.to)),
    "</match>",
    escapeOmniboxDescription(context.text.slice(match.to))
  ].join("");
}

export function buildOmniboxSuggestions(nodes, metadata, query, limit = 6) {
  return searchNodes(nodes, metadata, query).slice(0, limit).map((node) => {
    const context = buildMatchContext(node, metadata[node.id], query, 8, true);
    const suffix = nodeType(node) === "folder" ? "フォルダ" : node.url;
    return {
      content: omniboxNodeContent(node),
      description: [
        escapeOmniboxDescription(node.title),
        "<dim>｜</dim>",
        formatOmniboxMatchContext(context),
        "<dim>｜</dim>",
        `<dim>${escapeOmniboxDescription(suffix)}</dim>`
      ].join("")
    };
  });
}

export function resolveOmniboxNode(nodes, metadata, input) {
  const parsed = parseOmniboxNodeContent(input);
  return parsed
    ? nodes.find((node) => node.id === parsed.id && nodeType(node) === parsed.type) || null
    : searchNodes(nodes, metadata, input)[0] || null;
}

export function resolveOmniboxBookmark(bookmarks, metadata, input) {
  return resolveOmniboxNode(bookmarks, metadata, input);
}

export function isImeKeyEvent(event) {
  return Boolean(event.isComposing || event.keyCode === 229);
}

export function shouldInsertIndent(event) {
  return event.key === "Tab" && !isImeKeyEvent(event);
}
