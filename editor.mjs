import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { describeEditorLine } from "./editor-model.mjs";

class BulletWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-mybm-bullet";
    element.textContent = "•";
    return element;
  }
}

function buildDecorations(view) {
  const values = [];
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    const presentation = describeEditorLine(line.text, number === activeLine);
    if (presentation.bullet) {
      values.push(Decoration.line({ attributes: {
        class: "cm-mybm-indented",
        style: `--indent-depth:${presentation.depth}`
      } }).range(line.from));
      values.push(Decoration.replace({ widget: new BulletWidget() })
        .range(line.from, line.from + presentation.prefixLength));
    }
    for (const link of presentation.links) {
      const from = line.from + link.from;
      const to = line.from + link.to;
      values.push(Decoration.replace({}).range(from, from + 1));
      values.push(Decoration.mark({
        class: "cm-mybm-link",
        attributes: { "data-link": link.label }
      }).range(from + 1, to - 1));
      values.push(Decoration.replace({}).range(to - 1, to));
    }
  }
  return Decoration.set(values, true);
}

export function createDescriptionEditor(parent, { onChange, onLink }) {
  let settingValue = false;
  const decorationPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
      if (update.docChanged && !settingValue) onChange(update.state.doc.toString());
    }
  }, { decorations: (plugin) => plugin.decorations });
  const view = new EditorView({
    parent,
    state: EditorState.create({ extensions: [
      decorationPlugin,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "説明" }),
      EditorView.domEventHandlers({
        click(event) {
          const link = event.target.closest?.(".cm-mybm-link")?.dataset.link;
          if (!link) return false;
          event.preventDefault();
          onLink(link);
          return true;
        },
        keydown(event, currentView) {
          if (event.key !== "Tab" || event.isComposing || event.keyCode === 229) return false;
          event.preventDefault();
          const range = currentView.state.selection.main;
          currentView.dispatch({
            changes: { from: range.from, to: range.to, insert: "\t" },
            selection: { anchor: range.from + 1 }
          });
          return true;
        }
      }),
      EditorView.theme({
        "&": { minHeight: "210px", fontSize: "13px" },
        ".cm-content": { padding: "11px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        ".cm-line": { lineHeight: "1.55" },
        ".cm-scroller": { overflow: "auto" },
        "&.cm-focused": { outline: "none" }
      })
    ] })
  });
  return {
    focus(offset = null) {
      if (offset !== null) {
        const anchor = Math.max(0, Math.min(offset, view.state.doc.length));
        view.dispatch({ selection: { anchor } });
      }
      view.requestMeasure();
      view.focus();
    },
    setValue(value) {
      if (view.state.doc.toString() === value) return;
      settingValue = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      settingValue = false;
    }
  };
}
