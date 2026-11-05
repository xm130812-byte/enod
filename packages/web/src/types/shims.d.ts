/**
 * Ambient declarations for markdown-it plugins that do not ship their own
 * type definitions (and have no @types packages installed).
 */
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';

  const footnotePlugin: (md: MarkdownIt) => void;
  export default footnotePlugin;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';

  export interface TaskListOptions {
    /** When false (default), checkbox inputs get the `disabled` attribute. */
    enabled?: boolean;
    /** Wrap item text in a <label>. */
    label?: boolean;
    /** Put the <label> after the checkbox instead of wrapping it. */
    labelAfter?: boolean;
  }

  const taskListsPlugin: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default taskListsPlugin;
}
