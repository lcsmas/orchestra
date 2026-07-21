// Barrel for the structured-agent-view presentational components (A3).
// A2's StructuredView imports `AgentMessage` (the per-RenderMessage router) —
// the rest are exported for direct use / A4 / A5 as needed.

export { AgentMessage } from './AgentMessage';
export { MessageBubble } from './MessageBubble';
export { ToolCard } from './ToolCard';
export { ToolDiff } from './ToolDiff';
export { ThinkingIndicator } from './ThinkingIndicator';
export { Collapsible } from './Collapsible';
export { CodeBlock } from './CodeBlock';
export { MarkdownProse, renderInline } from './markdown';
export { parseMarkdown, monacoLang, langFromPath } from './markdown-parse';
export type { MdBlock } from './markdown-parse';
