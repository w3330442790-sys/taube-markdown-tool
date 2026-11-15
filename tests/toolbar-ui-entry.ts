import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { mountMarkdownToolbar } from '../src/markdown-toolbar';

declare global {
    interface Window {
        setup(): void;
        doc(): string;
        select(from: number, to: number): void;
        setMode(mode: string): void;
        selection(): { from: number; to: number } | null;
        notices: string[];
        calls: string[];
        clozeHidden(): boolean;
        setText(text: string): void;
        swapEditor(text: string): void;
        virtualPreview(text: string): void;
        previewLine: number;
    }
}

let view: EditorView | null = null;
let mode = 'source';
let dispose: (() => void) | null = null;

window.notices = [];
window.calls = [];
window.setup = () => {
    dispose?.();
    window.notices = [];
    window.calls = [];
    mode = 'source';
    view?.destroy();
    const host = document.getElementById('host');
    if (!host) throw new Error('missing host');
    host.replaceChildren();
    const containerEl = document.createElement('div');
    containerEl.className = 'view-container';
    const content = document.createElement('div');
    content.className = 'view-content';
    containerEl.appendChild(content);
    host.appendChild(containerEl);
    view = new EditorView({ doc: 'hello world', parent: content, extensions: [history()] });
    const fakeView = {
        containerEl,
        editor: {
            cm: view,
            focus: () => view?.focus(),
            undo: () => { window.calls.push('undo'); if (view) undo(view); },
            redo: () => { window.calls.push('redo'); if (view) redo(view); },
        },
        getMode: () => mode,
        showSearch: (replace: boolean) => window.calls.push(`search:${replace}`),
    };
    dispose = mountMarkdownToolbar(fakeView as never, { onNotice: message => window.notices.push(message) });
    window.swapEditor = (text: string) => {
        view?.destroy(); view = new EditorView({ doc: text, parent: content, extensions: [history()] });
        fakeView.editor.cm = view;
    };
    window.virtualPreview = (text: string) => {
        Object.assign(fakeView, { getViewData: () => text, previewMode: { applyScroll: (line: number) => { window.previewLine = line; } } });
        mode = 'preview';
    };
    window.clozeHidden = () => containerEl.classList.contains('mt-cloze-hidden');
};

window.doc = () => view?.state.doc.toString() ?? '';
window.setText = (text: string) => view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
window.select = (from: number, to: number) => {
    if (!view) return;
    view.dispatch({ selection: { anchor: from, head: to } });
    view.focus();
};
window.setMode = (next: string) => { mode = next; };
window.selection = () => {
    if (!view) return null;
    const main = view.state.selection.main;
    return { from: main.from, to: main.to };
};
