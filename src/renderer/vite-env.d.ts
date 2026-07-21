// Targeted ambient declaration for vite's `?worker` import used by
// monaco-loader.ts (tsconfig deliberately doesn't pull in all of
// `vite/client`; this is the one vite-specific import in the codebase).
declare module 'monaco-editor/editor/editor.worker.js?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
