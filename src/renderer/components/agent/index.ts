// Barrel for the structured agent view's components. Two groups:
//   • A3 — presentational components (markdown bubbles, tool cards, diffs,
//     thinking spinner). StructuredView imports `AgentMessage` (the
//     per-RenderMessage router); the rest are exported for direct use / A5.
//   • A4 — interaction surfaces (permission dialog, AskUserQuestion UI,
//     model/permission-mode controls, turn footer). StructuredView mounts these
//     from the PermissionSlot / SessionControls slots.
// Importing everything from this single barrel keeps the StructuredView wiring
// a stable entry point.

// ── A3: presentational ───────────────────────────────────────────────────────
export { AgentMessage } from './AgentMessage';
export { MessageBubble } from './MessageBubble';
export { ToolCard } from './ToolCard';
export { ToolGroup } from './ToolGroup';
export { ToolDiff } from './ToolDiff';
export { ThinkingIndicator } from './ThinkingIndicator';
export { Collapsible } from './Collapsible';
export { CodeBlock } from './CodeBlock';
export { MarkdownView } from './MarkdownView';
export { parseMarkdown, langFromPath } from './markdown-parse';
export type { MdBlock } from './markdown-parse';

// ── A4: interaction ──────────────────────────────────────────────────────────
export { PermissionDialog } from './PermissionDialog';
export { AgentControls } from './AgentControls';
export { TurnFooter } from './TurnFooter';
export {
  BackgroundTasksPanel,
  runningTaskCount,
  totalTaskCount,
} from './BackgroundTasksPanel';
export { AskUserQuestionCard } from './AskUserQuestionCard';
export { ToolInput } from './toolInput';
export {
  ASK_USER_QUESTION,
  parseAskUserQuestion,
  buildAskUserQuestionReply,
} from './askUserQuestion';
