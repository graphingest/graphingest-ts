/**
 * GraphIngest ReAct Agent Primitives (TypeScript)
 *
 * Automatic tool-call routing: node() functions become LLM tools.
 * The SDK generates tool schemas, routes LLM tool calls to node.run()
 * on managed infrastructure, and feeds results back in a ReAct loop.
 *
 * Supported models:
 *   Platform-managed (no API key needed, billed to your account):
 *   - "standard"  — fast and cost-effective (default)
 *   - "high"      — premium quality for complex reasoning
 *
 *   Bring Your Own Key (BYOK):
 *   - OpenAI:    gpt-4o, gpt-4o-mini, o1, o3-mini, ...
 *   - Anthropic: claude-3.5-sonnet, claude-3-opus, ...
 *   - Google:    gemini-2.5-flash, gemini-2.5-pro, ...
 *
 * Usage:
 *   import { node, deploy } from "graphingest";
 *   import { agent } from "graphingest/react";
 *
 *   const search = node({ name: "search" }, async (query: string) => [...]);
 *
 *   const researcher = agent({
 *     name: "researcher",
 *     tools: [search],
 *     model: "standard",
 *   }, async (query: string) => query);
 *
 *   await deploy();
 *   const answer = await researcher("What is quantum computing?");
 */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface LLMResponse {
    content: string | null;
    toolCalls: ToolCall[];
}
export interface ReactResult {
    answer: string;
    toolCalls: Array<{
        tool: string;
        args: unknown;
        result: string;
    }>;
    steps: number;
    elapsedSeconds: number;
    model: string;
}
export interface ToolSchema {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, {
                type: string;
                description?: string;
            }>;
            required: string[];
        };
    };
}
/**
 * Convert a list of node()-wrapped functions into tool schemas.
 *
 * Each node's `_nodeKey` becomes the tool name. Description is
 * pulled from a `_description` property if available, otherwise generated.
 *
 * @example
 * const schemas = toolsFromNodes([search, scrape, summarize]);
 */
export declare function toolsFromNodes(nodes: unknown[]): ToolSchema[];
export interface ReactOptions {
    /** User's question or task */
    query: string;
    /** List of node()-wrapped functions to use as tools */
    tools: unknown[];
    /** Model: "standard", "high", or a BYOK model name (default: "standard") */
    model?: string;
    /** System prompt prepended to the conversation */
    systemPrompt?: string;
    /** Max reasoning loops before stopping (default: 10) */
    maxIterations?: number;
    /** LLM temperature (default: 0) */
    temperature?: number;
}
/**
 * Run a ReAct loop: LLM reasons → picks tools → tools execute on managed infra → repeat.
 *
 * @example
 * const result = await react({ query: "Research fusion", tools: [search] });
 * console.log(result.answer);
 */
export declare function react(options: ReactOptions): Promise<ReactResult>;
export interface AgentOptions {
    /** Agent name (shown in dashboard) */
    name: string;
    /** List of node() functions available as tools */
    tools: unknown[];
    /** Model: "standard", "high", or a BYOK model name (default: "standard") */
    model?: string;
    /** System prompt. If empty, uses the function's description. */
    systemPrompt?: string;
    /** Max ReAct loop iterations (default: 10) */
    maxIterations?: number;
    /** LLM temperature (default: 0) */
    temperature?: number;
    /** Timeout in ms (default: 600_000) */
    timeoutMs?: number;
}
/**
 * Create an AI agent backed by node() tools.
 *
 * Combines graph() with a built-in ReAct loop. The LLM automatically
 * decides which node() tools to call.
 *
 * @example
 * const researcher = agent({
 *   name: "researcher",
 *   tools: [search, scrape],
 *   model: "standard",
 *   systemPrompt: "You are a research assistant.",
 * }, async (query: string) => query);
 *
 * const answer = await researcher("What is quantum computing?");
 */
export declare function agent<TInput = string>(options: AgentOptions, fn: (input: TInput) => Promise<string> | string): (input: TInput) => Promise<string>;
