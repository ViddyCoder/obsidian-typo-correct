import { Plugin, Notice, Editor, EditorPosition, App, PluginSettingTab, Setting } from "obsidian";
import nspell from "nspell";

interface MisspellSettings {
  lang: string;
  dictFolder: string;    // e.g. ".obsidian/plugins/typo-first-misspelling/dict"
  customWords: string[]; // lowercase list
}

const DEFAULT_SETTINGS: MisspellSettings = {
  lang: "en_US",
  dictFolder: ".obsidian/plugins/obsidian-typo-correct/dict",
  customWords: []
};

export default class TypoFirstMisspellingPlugin extends Plugin {
  private nspell: any | null = null;
  public customSet: Set<string> = new Set();
  private tempIgnore: Set<string> = new Set(); // cleared when paragraph has no remaining misspellings
  settings: MisspellSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.customSet = new Set(this.settings.customWords.map(w => w.toLowerCase().trim()).filter(Boolean));
    await this.loadDictionary(this.settings.lang);

    // Ctrl+L: smart action (select first misspelling OR act on current misspelling)
    this.addCommand({
      id: "smart-misspelling-action",
      name: "Misspelling: select/replace/skip",
      hotkeys: [{ modifiers: ["Alt"], key: "j" }],
      editorCallback: (editor) => this.handleCtrlL(editor),
    });

    // Ctrl+;: add selected word to custom dictionary
    this.addCommand({
      id: "add-selected-word-to-custom-dictionary",
      name: "Add selected word to custom dictionary",
      hotkeys: [{ modifiers: ["Alt"], key: ";" }],
      editorCallback: (editor) => this.addSelectedToCustom(editor),
    });

    this.addSettingTab(new MisspellSettingTab(this.app, this));
  }

  onunload() {
    this.nspell = null;
    this.tempIgnore.clear();
  }

  // --- Dictionary loading ---

  private async loadDictionary(lang: string) {
    try {
      const base = this.settings.dictFolder.replace(/\/+$/, "");
      const affPath = `${base}/${lang}.aff`;
      const dicPath = `${base}/${lang}.dic`;

      const affData = await this.app.vault.adapter.read(affPath);
      const dicData = await this.app.vault.adapter.read(dicPath);

      this.nspell = new (nspell as any)(affData, dicData);
    } catch (e) {
      console.error(e);
      new Notice("Typo.js dictionary failed to load. Check settings & dict files.");
      this.nspell = null;
    }
  }

  // --- Helpers ---

  private stripEdgePunct(raw: string): string {
    return raw.replace(/^[^A-Za-z'-]+|[^A-Za-z'-]+$/g, "");
  }

  private normalizeForSet(raw: string): string {
    return this.stripEdgePunct(raw).toLowerCase();
  }

  private isCustom(word: string): boolean {
    return this.customSet.has(this.normalizeForSet(word));
  }

  private isTempIgnored(word: string): boolean {
    return this.tempIgnore.has(this.normalizeForSet(word));
  }

  private isMisspelled(word: string): boolean {
    if (!this.nspell) return false;
	const clean = this.stripEdgePunct(word);
    if (!clean) return false;
    if (this.isCustom(clean) || this.isTempIgnored(clean)) return false;
    return !this.nspell.correct(clean);
  }

  private preserveCase(suggestion: string, original: string): string {
    const isAllCaps = original === original.toUpperCase();
    const isAllLower = original === original.toLowerCase();
    const isTitle = /^[A-Z][a-z'’-]*$/.test(original);
    if (isAllCaps) return suggestion.toUpperCase();
    if (isTitle) return suggestion.charAt(0).toUpperCase() + suggestion.slice(1).toLowerCase();
    if (isAllLower) return suggestion.toLowerCase();
    // Mixed case: leave as dictionary suggests
    return suggestion;
  }

  private getParagraphBounds(editor: Editor): { start: number; end: number } | null {
    const cursorLine = editor.getCursor().line;
    const lastLine = editor.lastLine();

    let start = cursorLine;
    while (start > 0 && editor.getLine(start).trim() !== "") start--;
    if (editor.getLine(start).trim() === "") start++;

    let end = cursorLine;
    while (end <= lastLine && editor.getLine(end).trim() !== "") end++;
    end--;

    if (start > end || start < 0 || end > lastLine) return null;
    return { start, end };
  }

  private getParagraphData(editor: Editor, start: number, end: number) {
    const lines: string[] = [];
    for (let i = start; i <= end; i++) lines.push(editor.getLine(i));
    const paraText = lines.join("\n");

    const lineStartOffsets: number[] = [];
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      lineStartOffsets.push(acc);
      acc += lines[i].length + (i < lines.length - 1 ? 1 : 0); // +1 for '\n'
    }

    const offsetToPos = (offset: number): EditorPosition => {
      let li = 0;
      while (li + 1 < lineStartOffsets.length && lineStartOffsets[li + 1] <= offset) li++;
      const ch = offset - lineStartOffsets[li];
      return { line: start + li, ch };
    };

    return { lines, paraText, lineStartOffsets, offsetToPos };
  }

  private trimSelectionToWord(editor: Editor, selText: string, from: EditorPosition, to: EditorPosition) {
    const leading = selText.match(/^[^A-Za-z'-]+/)?.[0]?.length ?? 0;
    const trailing = selText.match(/[^A-Za-z'-]+$/)?.[0]?.length ?? 0;
    const newFrom: EditorPosition = { line: from.line, ch: from.ch + leading };
    const newTo: EditorPosition = { line: to.line, ch: to.ch - trailing };
    const cleaned = selText.slice(leading, selText.length - trailing);
    return { newFrom, newTo, cleaned };
  }

  // --- Core behaviors ---

  private async handleCtrlL(editor: Editor) {
    // If there is a selected misspelled word, act on it
    const selectedText = editor.getSelection();
    const from: EditorPosition = (editor as any).getCursor?.("from") ?? editor.getCursor();
    const to: EditorPosition = (editor as any).getCursor?.("to") ?? editor.getCursor();

    if (selectedText && selectedText.trim()) {
      const { newFrom, newTo, cleaned } = this.trimSelectionToWord(editor, selectedText, from, to);
      if (cleaned && this.isMisspelled(cleaned)) {
        // Try to replace with first suggestion
        const suggestions: string[] = this.nspell?.suggest(this.stripEdgePunct(cleaned)) ?? [];
        if (suggestions.length > 0) {
          const s0 = this.preserveCase(suggestions[0], cleaned);
          // Replace and keep the suggestion selected
          editor.setSelection(newFrom, newTo);
          editor.replaceSelection(s0);
          const after: EditorPosition = { line: newFrom.line, ch: newFrom.ch + s0.length };
		  editor.setSelection(newFrom, after);
          try {
            // @ts-ignore
            editor.scrollIntoView({ from: newFrom, to: after }, true);
          } catch (_) {}
          return; // do not auto-advance; keep replacement selected
        } else {
          // No suggestions: add to temp ignore, then move to next misspelling
          const norm = this.normalizeForSet(cleaned);
          this.tempIgnore.add(norm);
          // new Notice(`No suggestions for "${cleaned}". Temporarily ignoring in this paragraph.`);
          // fall through to "select next misspelling"
		  editor.setSelection(to, to);
		  return;
        }
      }
    }

    // Otherwise (or after ignoring), select the first misspelling in the paragraph
    this.selectFirstMisspellingInParagraph(editor);
  }

  private selectFirstMisspellingInParagraph(editor: Editor) {
    if (!this.nspell) {
      new Notice("Dictionary not loaded.");
      return;
    }

    const bounds = this.getParagraphBounds(editor);
    if (!bounds) {
      // new Notice("No paragraph here.");
      return;
    }

    const { start, end } = bounds;
    const { paraText, offsetToPos } = this.getParagraphData(editor, start, end);

    const wordRe = /[A-Za-z0-9][A-Za-z0-9']*/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(paraText)) !== null) {
      const word = match[0];
      // Acronym
      if (word.toUpperCase() === word) continue;
      // Has numbers
      if (/\d/.test(word)) continue;

      const norm = this.normalizeForSet(word);
      if (this.customSet.has(norm) || this.tempIgnore.has(norm)) continue;

      const ok = this.nspell.check(word);
      if (!ok) {
        const from = offsetToPos(match.index);
        const to = offsetToPos(match.index + word.length);
        editor.setSelection(from, to);
        try {
          // @ts-ignore
          editor.scrollIntoView({ from, to }, true);
        } catch (_) {}
        return;
      }
    }

    // No misspellings remain in this paragraph -> clear temp ignore
    if (this.tempIgnore.size) this.tempIgnore.clear();
    // new Notice("No misspellings in paragraph 🎉");
	let lineText = editor.getLine(editor.getCursor().line);
	let line = editor.getCursor().line;
	editor.setSelection({ line: line, ch: lineText.length }, { line: line, ch: lineText.length });
  }

  // --- Custom dictionary command (Ctrl+;) ---

  private async addSelectedToCustom(editor: Editor) {
    const sel = editor.getSelection();
    if (!sel || !sel.trim()) {
      new Notice("Select a word, then press Alt+N to add it.");
      return;
    }
    const from: EditorPosition = (editor as any).getCursor?.("from") ?? editor.getCursor();
    const to: EditorPosition = (editor as any).getCursor?.("to") ?? editor.getCursor();
    const { cleaned } = this.trimSelectionToWord(editor, sel, from, to);

    const norm = this.normalizeForSet(cleaned);
    if (!norm) {
      new Notice("That selection doesn't look like a word.");
      return;
    }
    if (this.customSet.has(norm)) {
      new Notice(`"${cleaned}" is already in your custom dictionary.`);
      return;
    }

    this.customSet.add(norm);
    this.settings.customWords.push(norm);
    await this.saveSettings();
    new Notice(`Added "${cleaned}" to custom dictionary.`);
  }

  // --- Settings persistence ---

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class MisspellSettingTab extends PluginSettingTab {
  plugin: TypoFirstMisspellingPlugin;

  constructor(app: App, plugin: TypoFirstMisspellingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Typo.js Misspelling Finder" });

    new Setting(containerEl)
      .setName("Language code")
      .setDesc("Base name of dictionary files (e.g., en_US.aff & en_US.dic).")
      .addText((t) =>
        t
          .setPlaceholder("en_US")
          .setValue(this.plugin.settings.lang)
          .onChange(async (v) => {
            this.plugin.settings.lang = v.trim() || "en_US";
            await this.plugin.saveSettings();
            await this.plugin["loadDictionary"](this.plugin.settings.lang);
          })
      );

    new Setting(containerEl)
      .setName("Dictionary folder")
      .setDesc("Path relative to the vault root where .aff/.dic live.")
      .addText((t) =>
        t
          .setPlaceholder(".obsidian/plugins/typo-first-misspelling/dict")
          .setValue(this.plugin.settings.dictFolder)
          .onChange(async (v) => {
            this.plugin.settings.dictFolder = v.trim() || DEFAULT_SETTINGS.dictFolder;
            await this.plugin.saveSettings();
            await this.plugin["loadDictionary"](this.plugin.settings.lang);
          })
      );

    // Simple custom dictionary editor (newline-separated)
    const wrap = containerEl.createDiv();
    wrap.createEl("div", { text: "Custom dictionary (one word per line)" });
    const ta = wrap.createEl("textarea", {
      attr: { rows: "8", spellcheck: "false", style: "width:100%;resize:vertical;" },
      text: this.plugin.settings.customWords.join("\n"),
    });

    const btnRow = wrap.createDiv({ attr: { style: "margin-top: 8px; display:flex; gap: 8px;" } });

    const saveBtn = btnRow.createEl("button", { text: "Save custom dictionary" });
    saveBtn.addEventListener("click", async () => {
      const words = ta.value
        .split(/\r?\n/)
        .map((w) => w.toLowerCase().trim())
        .filter(Boolean);
      this.plugin.settings.customWords = Array.from(new Set(words));
      this.plugin.customSet = new Set(this.plugin.settings.customWords);
      await this.plugin.saveSettings();
      new Notice("Custom dictionary saved.");
    });

    const clearBtn = btnRow.createEl("button", { text: "Clear" });
    clearBtn.addEventListener("click", async () => {
      this.plugin.settings.customWords = [];
      this.plugin.customSet = new Set();
      ta.value = "";
      await this.plugin.saveSettings();
      new Notice("Custom dictionary cleared.");
    });
  }
}
