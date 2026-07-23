import { z } from 'zod';
// TYPE-ONLY import: the SDK is pure-ESM (type:module, exports only ./sdk.mjs).
// A static VALUE import would compile to `require()` in this CJS main bundle and
// crash Electron at boot with ERR_REQUIRE_ESM (see agent-sdk.ts loadSdk). We
// pull `createSdkMcpServer`/`tool` via a cached dynamic import() below instead.
// `zod` is CJS, so its static import is fine.
import type {
  McpSdkServerConfigWithInstance,
  createSdkMcpServer as CreateSdkMcpServer,
  tool as ToolFn,
} from '@anthropic-ai/claude-agent-sdk';
import * as bp from './browser-panel';

/** Cached dynamic import of the SDK's in-process-MCP builders (ESM-only). */
let sdkMcp: { createSdkMcpServer: typeof CreateSdkMcpServer; tool: typeof ToolFn } | null = null;
async function loadSdkMcp(): Promise<{
  createSdkMcpServer: typeof CreateSdkMcpServer;
  tool: typeof ToolFn;
}> {
  if (!sdkMcp) {
    const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      createSdkMcpServer: typeof CreateSdkMcpServer;
      tool: typeof ToolFn;
    };
    sdkMcp = { createSdkMcpServer: mod.createSdkMcpServer, tool: mod.tool };
  }
  return sdkMcp;
}

// The agent's embedded-browser tool surface, exposed to the structured SDK
// session as an IN-PROCESS MCP server (createSdkMcpServer — no subprocess, no
// port). Every tool closes over the session's `wsId`, so an agent can only ever
// drive its OWN workspace's browser panel (browser-panel.ts keys views by
// wsId). This mirrors the Claude Code desktop app's Browser-pane tools
// (navigate / read_page / computer / form_input / find), but backed by
// Orchestra's `WebContentsView` + `webContents.debugger` instead of an external
// chrome-devtools-mcp process.
//
// The server is built per-session in agent-sdk.ts and passed into the SDK
// `query({ mcpServers: { browser: buildBrowserToolServer(wsId) } })`. Tools
// therefore appear to the model as `mcp__browser__<name>`.

/** A text tool result. */
function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/** A screenshot (base64 JPEG) tool result — an image block the model can see. */
function image(base64: string, caption?: string) {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'image', data: base64, mimeType: 'image/jpeg' }];
  if (caption) content.unshift({ type: 'text', text: caption });
  return { content };
}

/** An error tool result — surfaced to the model so it can recover, not thrown. */
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/**
 * Build the in-process browser MCP server for one workspace's SDK session.
 * All handlers route through browser-panel.ts against `wsId`. Async because the
 * SDK builders are loaded via dynamic import (ESM-only; see loadSdkMcp).
 */
export async function buildBrowserToolServer(
  wsId: string,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await loadSdkMcp();
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    instructions:
      'Drive the embedded Browser pane for this workspace. The pane is shared ' +
      'with the user: they see exactly what you navigate to. Use `navigate` to ' +
      'open a URL, `read_page` to get an accessibility outline (each interactive ' +
      'element tagged [ref_N]), `screenshot` to see the page, and `click`/`type`/' +
      '`form_input` to interact. Prefer read_page + ref-based actions over ' +
      'coordinate clicks. Open the pane with `navigate` before other tools.',
    tools: [
      tool(
        'navigate',
        'Open the Browser pane and navigate it to a URL (http/https/file), or go "back"/"forward" in history. A bare domain gets https:// prepended.',
        {
          to: z
            .string()
            .describe('A URL, a bare domain (example.com), or the literal "back"/"forward".'),
        },
        async (args) => {
          try {
            if (args.to === 'back') {
              bp.goBack(wsId);
              return text('Went back.');
            }
            if (args.to === 'forward') {
              bp.goForward(wsId);
              return text('Went forward.');
            }
            bp.showPanel(wsId);
            const state = await bp.navigate(wsId, args.to);
            return text(`Navigated to ${state.url || args.to}${state.error ? ` (error: ${state.error})` : ''}`);
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'read_page',
        'Read the current page in the Browser pane as a compact accessibility outline. Each interactive element is tagged [ref_N] for use with click/form_input. Prefer this over screenshot for finding things to interact with.',
        {},
        async () => {
          try {
            return text(await bp.readPage(wsId));
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'screenshot',
        'Capture the current Browser pane as an image so you can see the rendered page. Returns a JPEG.',
        {
          quality: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe('JPEG quality 1-100 (default 75).'),
        },
        async (args) => {
          try {
            const b64 = await bp.capture(wsId, args.quality ?? 75);
            return image(b64, 'Current Browser pane:');
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'click',
        'Click an element in the Browser pane, either by [ref_N] (from read_page) or by viewport coordinates (from a screenshot).',
        {
          ref: z.number().int().optional().describe('The N from a [ref_N] tag returned by read_page.'),
          x: z.number().optional().describe('Viewport x (with y) to click at.'),
          y: z.number().optional().describe('Viewport y (with x) to click at.'),
        },
        async (args) => {
          try {
            if (typeof args.ref === 'number') {
              await bp.clickRef(wsId, args.ref);
              return text(`Clicked ref_${args.ref}.`);
            }
            if (typeof args.x === 'number' && typeof args.y === 'number') {
              await bp.clickAt(wsId, args.x, args.y);
              return text(`Clicked (${args.x}, ${args.y}).`);
            }
            return fail('Provide either `ref` or both `x` and `y`.');
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'type',
        'Type text into the currently focused element in the Browser pane (e.g. after clicking an input). For setting a specific field value prefer form_input.',
        {
          text: z.string().describe('Text to type into the focused element.'),
        },
        async (args) => {
          try {
            await bp.typeText(wsId, args.text);
            return text('Typed.');
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'form_input',
        'Set the value of a form field identified by [ref_N] (from read_page), firing input/change events. Works for inputs and textareas.',
        {
          ref: z.number().int().describe('The N from a [ref_N] tag on the field.'),
          value: z.string().describe('The value to set.'),
        },
        async (args) => {
          try {
            await bp.formInput(wsId, args.ref, args.value);
            return text(`Set ref_${args.ref}.`);
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'evaluate',
        'Evaluate a JavaScript expression in the Browser pane page and return its value. For inspection/debugging (e.g. reading document state).',
        {
          expression: z.string().describe('A JS expression evaluated in the page; its value is returned (JSON-serializable).'),
        },
        async (args) => {
          try {
            const val = await bp.evaluate(wsId, args.expression);
            return text(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
      tool(
        'scroll',
        'Scroll the Browser pane vertically by a pixel delta (positive = down).',
        {
          deltaY: z.number().describe('Pixels to scroll; positive scrolls down.'),
        },
        async (args) => {
          try {
            await bp.scrollBy(wsId, args.deltaY);
            return text(`Scrolled ${args.deltaY}px.`);
          } catch (err) {
            return fail(String((err as Error)?.message ?? err));
          }
        },
      ),
    ],
  });
}
