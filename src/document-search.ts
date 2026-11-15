import type { MarkdownView } from 'obsidian';
import { Compartment, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

export interface TextMatch { from: number; to: number; line: number; context: string }

/** Literal search; offsets always refer to the original text, including Unicode. */
export function findTextMatches(text: string, query: string, caseSensitive = false): TextMatch[] {
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
    const matches: TextMatch[] = [];
    let line = 1;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
        const from = match.index;
        for (; cursor < from; cursor++) if (text[cursor] === '\n') line++;
        matches.push({ from, to: from + match[0].length, line,
            context: text.slice(Math.max(0, from - 24), Math.min(text.length, from + match[0].length + 50)).replace(/\s+/g, ' ') });
    }
    return matches;
}

const setMarks = StateEffect.define<DecorationSet>();
const marks = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        value = value.map(tr.changes);
        for (const effect of tr.effects) if (effect.is(setMarks)) value = effect.value;
        return value;
    },
    provide: field => EditorView.decorations.from(field),
});

/** One controller per Markdown pane; no global search state or note writes. */
export function createDocumentSearch(view: MarkdownView, toolbar: HTMLElement, trigger: HTMLButtonElement) {
    let cm = (view.editor as typeof view.editor & { cm?: EditorView }).cm;
    const slot = new Compartment();
    let installed = false;
    let panel: HTMLElement | null = null;
    let input: HTMLInputElement;
    let replacement: HTMLInputElement;
    let count: HTMLElement;
    let list: HTMLElement;
    let prev: HTMLButtonElement;
    let next: HTMLButtonElement;
    let replaceRow: HTMLElement;
    let replaceToggle: HTMLButtonElement;
    let sensitive = false;
    let current = -1;
    let matches: TextMatch[] = [];
    let composing = false;
    let timer = 0;
    let limit = 100;
    let text = '';
    let nodes: { node: Text; from: number; to: number }[] = [];
    let observer: MutationObserver | null = null;
    let previewMode = false;
    let previewSource = false;
    let lastPreview: Element | null = null;
    const viewport = window.visualViewport;
    const fitPanel = () => {
        if (!panel) return;
        const top = toolbar.offsetTop + toolbar.offsetHeight + 6;
        panel.style.top = `${top}px`;
        const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        panel.style.setProperty('--mt-search-available-height', `${Math.max(0, visibleBottom - panel.getBoundingClientRect().top - 8)}px`);
    };

    const button = (parent: HTMLElement, label: string, content: string, click: () => void) => {
        const el = createEl('button');
        el.type = 'button'; el.textContent = content; el.title = label; el.setAttribute('aria-label', label);
        el.addEventListener('click', click); parent.append(el); return el;
    };
    const readText = () => {
        previewMode = view.getMode() === 'preview';
        const nextEditor = (view.editor as typeof view.editor & { cm?: EditorView }).cm;
        if (nextEditor !== cm) {
            if (installed && cm?.dom.isConnected) cm.dispatch({ effects: slot.reconfigure([]) });
            installed = false; cm = nextEditor;
        }
        if (!previewMode && panel && cm && !installed) {
            installed = true;
            cm.dispatch({ effects: StateEffect.appendConfig.of(slot.of([marks, EditorView.updateListener.of(update => {
                if (update.docChanged) schedule();
            })])) });
        }
        nodes = [];
        if (!previewMode) return cm?.state.doc.toString() ?? view.editor.getValue();
        // Reading view virtualizes off-screen sections. Search the complete
        // note whenever the host supplies its public preview scroll API.
        previewSource = typeof view.getViewData === 'function' && typeof view.previewMode?.applyScroll === 'function';
        if (previewSource) return view.getViewData();
        const root = view.containerEl.querySelector('.markdown-preview-view .markdown-preview-sizer, .markdown-preview-view, .markdown-rendered');
        if (!root) return '';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: node => node.parentElement?.closest('script,style,button,textarea,.mt-document-search,[aria-hidden="true"]')
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        let result = '';
        let previousBlock: Element | null = null;
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const block = node.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,div') ?? null;
            if (previousBlock && block !== previousBlock && !result.endsWith('\n')) result += '\n';
            nodes.push({ node, from: result.length, to: result.length + node.length });
            result += node.textContent;
            previousBlock = block;
        }
        return result;
    };
    const clearPreview = () => {
        lastPreview?.classList.remove('mt-search-preview-current'); lastPreview = null;
    };
    const jump = (index: number) => {
        window.clearTimeout(timer);
        refresh();
        if (!matches.length) return;
        current = (index + matches.length) % matches.length;
        const match = matches[current];
        clearPreview();
        if (previewMode) {
            if (previewSource) {
                view.previewMode.applyScroll(match.line - 1);
                render(); return;
            }
            const start = nodes.find(n => n.to > match.from);
            const end = nodes.find(n => n.to >= match.to);
            if (start?.node.isConnected && end?.node.isConnected) {
                const range = document.createRange();
                range.setStart(start.node, match.from - start.from); range.setEnd(end.node, match.to - end.from);
                // Keep the input focused so Android's keyboard stays open.
                const element = start.node.parentElement;
                element?.scrollIntoView({ block: 'center', behavior: 'auto' });
                element?.classList.add('mt-search-preview-current'); lastPreview = element;
            }
        } else if (cm) {
            cm.dispatch({ selection: { anchor: match.from, head: match.to }, effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
        } else {
            const from = view.editor.offsetToPos(match.from), to = view.editor.offsetToPos(match.to);
            view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
        }
        render();
    };
    const render = () => {
        if (!panel) return;
        count.textContent = !input.value ? '输入关键词' : matches.length ? `${current + 1} / ${matches.length}` : '无匹配';
        prev.disabled = next.disabled = matches.length === 0;
        replaceToggle.disabled = previewMode;
        replaceRow.hidden = previewMode || replaceToggle.getAttribute('aria-expanded') !== 'true';
        list.replaceChildren();
        matches.slice(0, limit).forEach((match, index) => {
            const item = button(list, `第 ${index + 1} 处，第 ${match.line} 行：${match.context}`, '', () => jump(index));
            item.className = 'mt-search-result'; item.classList.toggle('is-current', index === current);
            item.setAttribute('aria-current', String(index === current));
            const position = createEl('small'); position.textContent = previewMode && !previewSource ? `${index + 1} · 阅读内容` : `${index + 1} · 第 ${match.line} 行`;
            const snippet = createSpan();
            let end = 0;
            for (const hit of findTextMatches(match.context, input.value, sensitive)) {
                snippet.append(document.createTextNode(match.context.slice(end, hit.from)));
                const highlight = createEl('mark'); highlight.textContent = match.context.slice(hit.from, hit.to); snippet.append(highlight);
                end = hit.to;
            }
            snippet.append(document.createTextNode(match.context.slice(end)));
            item.append(position, snippet);
        });
        if (matches.length > limit) button(list, '显示更多结果', `显示更多（共 ${matches.length} 处）`, () => { limit += 100; render(); });
        if (cm?.dom.isConnected && installed) cm.dispatch({ effects: setMarks.of(previewMode ? Decoration.none : Decoration.set(matches.map((m, i) =>
            Decoration.mark({ class: i === current ? 'mt-search-hit is-current' : 'mt-search-hit' }).range(m.from, m.to)), true)) });
    };
    const refresh = () => {
        if (!panel || composing) return;
        const oldFrom = matches[current]?.from;
        text = readText(); matches = findTextMatches(text, input.value, sensitive);
        current = matches.length ? Math.max(0, matches.findIndex(m => m.from === oldFrom)) : -1;
        clearPreview(); render();
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 80); };
    const replace = (all: boolean) => {
        if (view.getMode() === 'preview' || !input.value) return;
        // Recompute after any document update before using stored offsets.
        refresh();
        const chosen = all ? matches : matches[current] ? [matches[current]] : [];
        if (!chosen.length) return;
        if (cm) cm.dispatch({ changes: chosen.map(m => ({ from: m.from, to: m.to, insert: replacement.value })), annotations: isolateHistory.of('full') });
        else view.editor.transaction({ changes: chosen.map(m => ({ from: view.editor.offsetToPos(m.from), to: view.editor.offsetToPos(m.to), text: replacement.value })) });
        refresh();
    };
    const close = () => {
        window.clearTimeout(timer); observer?.disconnect(); observer = null;
        window.removeEventListener('resize', fitPanel);
        viewport?.removeEventListener('resize', fitPanel); viewport?.removeEventListener('scroll', fitPanel);
        panel?.remove(); panel = null; clearPreview();
        trigger.setAttribute('aria-expanded', 'false'); trigger.classList.remove('is-active');
        if (cm?.dom.isConnected && installed) cm.dispatch({ effects: setMarks.of(Decoration.none) });
    };
    const open = () => {
        if (panel) { input.focus(); input.select(); return; }
        panel = createEl('section'); panel.className = 'mt-document-search';
        panel.setAttribute('aria-label', '本文查找结果');
        panel.setAttribute('data-ignore-swipe', 'true');
        const row = createDiv(); row.className = 'mt-search-row'; panel.append(row);
        input = createEl('input'); input.type = 'search'; input.placeholder = '查找本文…';
        input.setAttribute('aria-label', '查找本文'); row.append(input);
        const caseButton = button(row, '区分大小写', 'Aa', () => { sensitive = !sensitive; caseButton.setAttribute('aria-pressed', String(sensitive)); current = -1; refresh(); });
        caseButton.setAttribute('aria-pressed', String(sensitive));
        button(row, '关闭查找', '×', () => { close(); trigger.focus({ preventScroll: true }); });
        const navigation = createDiv(); navigation.className = 'mt-search-row'; panel.append(navigation);
        count = createSpan(); count.className = 'mt-search-count'; count.setAttribute('aria-live', 'polite'); navigation.append(count);
        prev = button(navigation, '上一处', '↑', () => jump(current - 1));
        next = button(navigation, '下一处', '↓', () => jump(current + 1));
        replaceToggle = button(navigation, '展开替换', '替换', () => {
            const expanded = replaceToggle.getAttribute('aria-expanded') !== 'true';
            replaceToggle.setAttribute('aria-expanded', String(expanded)); render();
        });
        replaceToggle.setAttribute('aria-expanded', 'false');
        replaceRow = createDiv(); replaceRow.className = 'mt-search-row mt-search-replace'; panel.append(replaceRow);
        replacement = createEl('input'); replacement.placeholder = '替换为…'; replacement.setAttribute('aria-label', '替换为'); replaceRow.append(replacement);
        button(replaceRow, '替换当前', '替换', () => replace(false)); button(replaceRow, '替换全部', '全部', () => replace(true));
        list = createDiv(); list.className = 'mt-search-results'; list.setAttribute('aria-label', '定位结果列表'); panel.append(list);
        panel.addEventListener('pointerdown', event => event.stopPropagation());
        panel.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.isComposing || composing) return;
            if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus({ preventScroll: true }); }
            else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); refresh(); jump(current + (event.shiftKey ? -1 : 1)); }
        });
        input.addEventListener('input', () => { current = -1; limit = 100; schedule(); });
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; schedule(); });
        toolbar.parentElement?.insertBefore(panel, toolbar.nextSibling);
        window.addEventListener('resize', fitPanel);
        viewport?.addEventListener('resize', fitPanel); viewport?.addEventListener('scroll', fitPanel);
        fitPanel();
        observer = new MutationObserver(records => {
            if (records.some(record => !panel?.contains(record.target) && !(record.target.instanceOf(Element) && record.target.closest('.cm-editor')))) schedule();
        });
        observer.observe(view.containerEl, { childList: true, characterData: true, subtree: true });
        trigger.setAttribute('aria-expanded', 'true'); trigger.classList.add('is-active');
        refresh(); input.focus();
    };
    return { open, dispose: () => { close(); if (cm?.dom.isConnected && installed) cm.dispatch({ effects: slot.reconfigure([]) }); installed = false; } };
}
