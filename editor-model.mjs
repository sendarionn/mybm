export function describeEditorLine(text, active) {
  const prefix = text.match(/^[ \t　]+/u)?.[0] || "";
  const links = active
    ? []
    : [...text.matchAll(/\[([^\[\]\n]+)\]/g)].map((match) => ({
      from: match.index,
      to: match.index + match[0].length,
      label: match[1].trim()
    }));
  return {
    bullet: Boolean(prefix),
    depth: [...prefix].length,
    prefixLength: prefix.length,
    links
  };
}

export function linkCompletionInsertion(label, nextCharacter) {
  return {
    insert: nextCharacter === "]" ? label : `${label}]`,
    movePastExistingBracket: nextCharacter === "]"
  };
}

export function wrapSelectionAsLink(text, from, to) {
  if (from === to) return null;
  const selected = text.slice(from, to);
  if (selected.includes("\n")) return null;
  return {
    from,
    to,
    insert: `[${selected}]`,
    cursor: from + selected.length + 2
  };
}

export function resolveLinkWrapAfterInput(originalText, currentText, from, to) {
  const selected = originalText.slice(from, to);
  if (selected.includes("\n")) return null;
  const prefix = originalText.slice(0, from);
  const suffix = originalText.slice(to);
  if (!currentText.startsWith(prefix) || !currentText.endsWith(suffix)) return null;
  const insertedEnd = suffix ? currentText.length - suffix.length : currentText.length;
  const inserted = currentText.slice(prefix.length, insertedEnd);
  if (!/^\[+\]*$/u.test(inserted)) return null;
  if (!selected) {
    if (inserted === "[[") {
      return { from, to: from + 2, insert: "[", cursor: from + 1 };
    }
    if (inserted === "[[]") {
      return { from, to: from + 3, insert: "[]", cursor: from + 1 };
    }
    return null;
  }
  const replacement = `[${selected}]`;
  return {
    from,
    to: from + inserted.length,
    insert: replacement,
    cursor: from + replacement.length
  };
}
