import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { createLivePreview } from './livePreview.ts';
import type { DocKind } from '../types.ts';

export interface EditorHandle {
  getBody: () => string;
  setBody: (body: string) => void;
  markSaved: () => void;
  focus: () => void;
}

interface EditorViewProps {
  docId: string;
  kind?: DocKind;
  initialBody: string;
  docs: { id: string; title: string; aliases: string[] }[];
  autosave: boolean;
  imageUrl: (src: string) => string;
  resolveWiki: (target: string) => { href: string } | null;
  onBodyChange: (body: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveRequest: () => void;
  onExitRequest: () => void;
  onUploadImage: (file: File) => Promise<string | null>;
}

function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  return true;
}

export const EditorViewPane = forwardRef<EditorHandle, EditorViewProps>(function EditorViewPane(props, ref) {
  const { docId, initialBody } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dirtyRef = useRef(false);
  const suppressRef = useRef(false);
  const autosaveTimer = useRef<number | null>(null);

  const callbacks = useRef(props);
  callbacks.current = props;

  useImperativeHandle(
    ref,
    () => ({
      getBody: () => viewRef.current?.state.doc.toString() ?? initialBody,
      setBody: (body: string) => {
        const view = viewRef.current;
        if (!view) return;
        suppressRef.current = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
        suppressRef.current = false;
        dirtyRef.current = false;
        callbacks.current.onDirtyChange(false);
      },
      markSaved: () => {
        dirtyRef.current = false;
        if (autosaveTimer.current !== null) {
          window.clearTimeout(autosaveTimer.current);
          autosaveTimer.current = null;
        }
        callbacks.current.onDirtyChange(false);
      },
      focus: () => viewRef.current?.focus(),
    }),
    [initialBody],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const kind = callbacks.current.kind ?? 'md';
    const markdownMode = kind === 'md';

    const scheduleAutosave = (): void => {
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
      if (!callbacks.current.autosave) return;
      autosaveTimer.current = window.setTimeout(() => {
        autosaveTimer.current = null;
        if (dirtyRef.current) callbacks.current.onSaveRequest();
      }, 800);
    };

    const wikiCompletion = (context: CompletionContext): CompletionResult | null => {
      const before = context.matchBefore(/\[\[[^\[\]\n]*$/);
      if (!before) return null;
      const typed = before.text.slice(2).toLowerCase();
      const options = callbacks.current.docs
        .filter((d) => !typed || d.title.toLowerCase().includes(typed) || d.aliases.some((a) => a.toLowerCase().includes(typed)))
        .slice(0, 20)
        .map((d) => ({ label: d.title, apply: `${d.title}]]` }));
      if (options.length === 0) return null;
      return { from: before.from + 2, options, validFor: /^[^\[\]\n]*$/ };
    };

    const handlePaste = (event: ClipboardEvent, view: EditorView): boolean => {
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return false;
      const image = [...files].find((file) => file.type.startsWith('image/'));
      if (!image) return false;
      event.preventDefault();
      void callbacks.current.onUploadImage(image).then((relPath) => {
        if (!relPath) return;
        const selection = view.state.selection.main;
        const insert = `![](${relPath})`;
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
          selection: { anchor: selection.from + insert.length },
        });
      });
      return true;
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialBody,
        extensions: [
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          ...(markdownMode ? [autocompletion({ override: [wikiCompletion] })] : []),
          ...(markdownMode ? [markdown({ base: markdownLanguage })] : []),
          ...(markdownMode
            ? [
                createLivePreview({
                  imageUrl: (src) => callbacks.current.imageUrl(src),
                  resolveWiki: (target) => callbacks.current.resolveWiki(target),
                }),
              ]
            : []),
          ...(callbacks.current.kind === 'sql' ? [lineNumbers()] : []),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            spellcheck: 'false',
            autocapitalize: 'off',
            'data-gramm': 'false',
          }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                callbacks.current.onSaveRequest();
                return true;
              },
            },
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                callbacks.current.onExitRequest();
                return true;
              },
            },
            {
              key: 'Escape',
              run: () => {
                callbacks.current.onExitRequest();
                return true;
              },
            },
            { key: 'Mod-b', run: (v) => wrapSelection(v, '**', '**') },
            { key: 'Mod-i', run: (v) => wrapSelection(v, '*', '*') },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || suppressRef.current) return;
            callbacks.current.onBodyChange(update.state.doc.toString());
            if (!dirtyRef.current) {
              dirtyRef.current = true;
              callbacks.current.onDirtyChange(true);
            }
            scheduleAutosave();
          }),
          ...(markdownMode ? [EditorView.domEventHandlers({ paste: handlePaste })] : []),
        ],
      }),
    });

    viewRef.current = view;
    view.focus();
    return () => {
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
      view.destroy();
      viewRef.current = null;
    };
    // 每个文档重建一次编辑器；body 重载用 setBody
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return <div className={`editor-host kind-${props.kind ?? 'md'}`} ref={hostRef} />;
});
