const LINK_PATTERN = /\[([^\[\]\n]+)\]/g;
const BOOKMARKLET_PATTERN = /^\s*javascript:/i;

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

export function buildLinkSuggestions(bookmarks, metadata) {
  const suggestions = [];
  const seen = new Set();
  const add = (label, detail) => {
    const value = label?.trim();
    const key = normalize(value);
    if (!value || seen.has(key)) return;
    seen.add(key);
    suggestions.push({ label: value, detail });
  };

  for (const bookmark of bookmarks) add(bookmark.title, "ブックマーク");
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

export function flattenBookmarks(nodes, parentPath = []) {
  const result = [];

  for (const node of nodes) {
    if (node.url) {
      result.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        dateAdded: node.dateAdded || 0,
        folder: parentPath.join(" / ")
      });
    }

    if (node.children) {
      const nextPath = node.url || !node.title ? parentPath : [...parentPath, node.title];
      result.push(...flattenBookmarks(node.children, nextPath));
    }
  }

  return result;
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

export function buildMatchContext(bookmark, metadataEntry, query, radius = 8, hideLinkSyntax = false) {
  if (!normalize(query)) return { text: "", matches: [] };
  const descriptionLine = findMatchingDescriptionLine(metadataEntry?.description || "", query);
  const source = [
    { text: bookmark.title, description: false },
    { text: bookmark.url, description: false },
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

export function resolveLinkTarget(title, bookmarks) {
  const normalizedTitle = normalize(title);
  const matches = bookmarks.filter((bookmark) => normalize(bookmark.title) === normalizedTitle);
  if (matches.length === 1) return { type: "bookmark", bookmark: matches[0] };
  return { type: "virtual", title: title.trim(), matches };
}

export function targetKey(target) {
  return target.type === "bookmark"
    ? `bookmark:${target.bookmark.id}`
    : `virtual:${normalize(target.title)}`;
}

export function buildLinkGraph(bookmarks, metadata) {
  const relations = new Map();
  const add = (key, label) => {
    if (!relations.has(key)) relations.set(key, new Set());
    relations.get(key).add(label);
  };

  for (const bookmark of bookmarks) {
    const sourceKey = `bookmark:${bookmark.id}`;
    for (const label of extractLinks(metadata[bookmark.id]?.description || "")) {
      const target = resolveLinkTarget(label, bookmarks);
      const destinationKey = targetKey(target);
      add(sourceKey, label);
      add(destinationKey, bookmark.title);
    }
  }

  return new Map([...relations].map(([key, labels]) => [key, [...labels]]));
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

export function searchBookmarks(bookmarks, metadata, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) {
    return [...bookmarks].sort((a, b) => b.dateAdded - a.dateAdded);
  }

  return bookmarks
    .map((bookmark) => {
      const description = metadata[bookmark.id]?.description || "";
      const scores = [
        fieldScore(bookmark.title, query, 0),
        fieldScore(bookmark.url, query, 40),
        fieldScore(description, query, 70),
        ...extractLinks(description).map((link) => fieldScore(link, query, 60))
      ].filter((score) => score !== null);

      return scores.length ? { bookmark, score: Math.min(...scores) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || b.bookmark.dateAdded - a.bookmark.dateAdded)
    .map(({ bookmark }) => bookmark);
}

const OMNIBOX_BOOKMARK_PREFIX = "mybm-bookmark:";

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

export function buildOmniboxSuggestions(bookmarks, metadata, query, limit = 6) {
  return searchBookmarks(bookmarks, metadata, query).slice(0, limit).map((bookmark) => {
    const context = buildMatchContext(bookmark, metadata[bookmark.id], query, 8, true);
    return {
      content: omniboxBookmarkContent(bookmark.id),
      description: [
        escapeOmniboxDescription(bookmark.title),
        "<dim>｜</dim>",
        formatOmniboxMatchContext(context),
        "<dim>｜</dim>",
        `<dim>${escapeOmniboxDescription(bookmark.url)}</dim>`
      ].join("")
    };
  });
}

export function resolveOmniboxBookmark(bookmarks, metadata, input) {
  const bookmarkId = parseOmniboxBookmarkContent(input);
  return bookmarkId
    ? bookmarks.find(({ id }) => id === bookmarkId) || null
    : searchBookmarks(bookmarks, metadata, input)[0] || null;
}

export function isImeKeyEvent(event) {
  return Boolean(event.isComposing || event.keyCode === 229);
}

export function shouldInsertIndent(event) {
  return event.key === "Tab" && !isImeKeyEvent(event);
}
