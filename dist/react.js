"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolsFromNodes = toolsFromNodes;
exports.react = react;
exports.agent = agent;
// ---------------------------------------------------------------------------
// toolsFromNodes: auto-generate tool schemas from node() functions
// ---------------------------------------------------------------------------
/**
 * Convert a list of node()-wrapped functions into tool schemas.
 *
 * Each node's `_nodeKey` becomes the tool name. Description is
 * pulled from a `_description` property if available, otherwise generated.
 *
 * @example
 * const schemas = toolsFromNodes([search, scrape, summarize]);
 */
function toolsFromNodes(nodes) {
    const tools = [];
    for (const fn of nodes) {
        const nodeKey = fn._nodeKey || fn.name || "anonymous";
        const description = fn._description || `Execute the ${nodeKey} tool`;
        // Try to get parameter info from _paramSchema if defined
        const paramSchema = fn._paramSchema;
        const properties = paramSchema?.properties ?? { input: { type: "string" } };
        const required = paramSchema?.required ?? Object.keys(properties);
        tools.push({
            type: "function",
            function: {
                name: nodeKey,
                description,
                parameters: {
                    type: "object",
                    properties,
                    required,
                },
            },
        });
    }
    return tools;
}
// ---------------------------------------------------------------------------
// OpenAI Provider (also used for platform proxy)
// ---------------------------------------------------------------------------
class OpenAIProvider {
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    async chat(messages, tools, temperature, model) {
        const url = `${this.baseUrl || "https://api.openai.com/v1"}/chat/completions`;
        const key = this.apiKey || process.env.OPENAI_API_KEY || "";
        const body = {
            model,
            messages,
            temperature,
        };
        if (tools.length > 0) {
            body.tools = tools;
        }
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`LLM API error (${res.status}): ${text}`);
        }
        const data = (await res.json());
        const choice = data.choices?.[0];
        const msg = choice?.message;
        const toolCalls = [];
        if (msg?.tool_calls) {
            for (const tc of msg.tool_calls) {
                toolCalls.push({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments || "{}"),
                });
            }
        }
        return { content: msg?.content ?? null, toolCalls };
    }
    appendAssistant(messages, response) {
        const msg = { role: "assistant" };
        if (response.content)
            msg.content = response.content;
        if (response.toolCalls.length > 0) {
            msg.tool_calls = response.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                },
            }));
        }
        messages.push(msg);
    }
    appendToolResult(messages, toolCall, result) {
        messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
        });
    }
}
// ---------------------------------------------------------------------------
// Anthropic Provider
// ---------------------------------------------------------------------------
class AnthropicProvider {
    async chat(messages, tools, temperature, model) {
        const key = process.env.ANTHROPIC_API_KEY || "";
        // Convert to Anthropic format
        const anthropicTools = tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
        }));
        let system = "";
        const filtered = messages.filter((m) => {
            if (m.role === "system") {
                system = String(m.content || "");
                return false;
            }
            return true;
        });
        const body = {
            model,
            messages: filtered,
            max_tokens: 4096,
            temperature,
        };
        if (anthropicTools.length > 0)
            body.tools = anthropicTools;
        if (system)
            body.system = system;
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Anthropic API error (${res.status}): ${text}`);
        }
        const data = (await res.json());
        let content = "";
        const toolCalls = [];
        for (const block of data.content || []) {
            if (block.type === "text")
                content += block.text;
            else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: typeof block.input === "object" ? block.input : JSON.parse(block.input || "{}"),
                });
            }
        }
        return { content: content || null, toolCalls };
    }
    appendAssistant(messages, response) {
        const contentBlocks = [];
        if (response.content)
            contentBlocks.push({ type: "text", text: response.content });
        for (const tc of response.toolCalls) {
            contentBlocks.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
            });
        }
        messages.push({ role: "assistant", content: contentBlocks });
    }
    appendToolResult(messages, toolCall, result) {
        messages.push({
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: toolCall.id, content: result },
            ],
        });
    }
}
// ---------------------------------------------------------------------------
// Google Gemini Provider
// ---------------------------------------------------------------------------
class GeminiProvider {
    async chat(messages, tools, temperature, model) {
        const key = process.env.GOOGLE_API_KEY || "";
        // Convert tools to Gemini format
        const functionDeclarations = tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        }));
        // Build contents
        let systemInstruction;
        const contents = [];
        for (const m of messages) {
            if (m.role === "system") {
                systemInstruction = String(m.content || "");
            }
            else if (m.role === "user") {
                contents.push({
                    role: "user",
                    parts: [{ text: String(m.content || "") }],
                });
            }
            else if (m.role === "assistant") {
                const parts = [];
                if (m.content)
                    parts.push({ text: String(m.content) });
                const tcs = m._toolCalls;
                if (tcs) {
                    for (const tc of tcs) {
                        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
                    }
                }
                if (parts.length > 0)
                    contents.push({ role: "model", parts });
            }
            else if (m.role === "tool_result") {
                contents.push({
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: m.name,
                                response: { result: m.content },
                            },
                        },
                    ],
                });
            }
        }
        const body = {
            contents,
            generationConfig: { temperature },
        };
        if (functionDeclarations.length > 0) {
            body.tools = [{ functionDeclarations }];
        }
        if (systemInstruction) {
            body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Gemini API error (${res.status}): ${text}`);
        }
        const data = (await res.json());
        let content = "";
        const toolCalls = [];
        const parts = data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            if (part.text)
                content += part.text;
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Math.random().toString(36).slice(2, 10)}`,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {},
                });
            }
        }
        return { content: content || null, toolCalls };
    }
    appendAssistant(messages, response) {
        const msg = {
            role: "assistant",
            content: response.content || "",
        };
        msg._toolCalls = response.toolCalls.map((tc) => ({
            name: tc.name,
            arguments: tc.arguments,
        }));
        messages.push(msg);
    }
    appendToolResult(messages, toolCall, result) {
        messages.push({
            role: "tool_result",
            name: toolCall.name,
            content: result,
        });
    }
}
// ---------------------------------------------------------------------------
// Provider auto-detection
// ---------------------------------------------------------------------------
const PLATFORM_TIERS = {
    standard: "gemini-2.5-flash",
    high: "gemini-2.5-pro",
};
function getProvider(model) {
    // Platform-managed tiers
    if (model in PLATFORM_TIERS) {
        const platformUrl = process.env.GRAPHINGEST_API_URL || "";
        const apiKey = process.env.GRAPHINGEST_API_KEY || "";
        if (!platformUrl) {
            throw new Error(`model="${model}" requires GRAPHINGEST_API_URL. Run deploy() first or set the env var.`);
        }
        return {
            provider: new OpenAIProvider(`${platformUrl}/llm/v1`, apiKey),
            resolvedModel: PLATFORM_TIERS[model],
        };
    }
    // BYOK auto-detection
    const lower = model.toLowerCase();
    if (lower.startsWith("gpt-") ||
        lower.startsWith("o1") ||
        lower.startsWith("o3") ||
        lower.startsWith("o4")) {
        return { provider: new OpenAIProvider(), resolvedModel: model };
    }
    if (lower.startsWith("claude")) {
        return { provider: new AnthropicProvider(), resolvedModel: model };
    }
    if (lower.startsWith("gemini")) {
        return { provider: new GeminiProvider(), resolvedModel: model };
    }
    // Default to OpenAI (works for OpenAI-compatible: Together, Groq, etc.)
    return { provider: new OpenAIProvider(), resolvedModel: model };
}
/**
 * Run a ReAct loop: LLM reasons → picks tools → tools execute on managed infra → repeat.
 *
 * @example
 * const result = await react({ query: "Research fusion", tools: [search] });
 * console.log(result.answer);
 */
async function react(options) {
    const { query, tools, model = "standard", systemPrompt = "", maxIterations = 10, temperature = 0, } = options;
    const { provider, resolvedModel } = getProvider(model);
    const toolSchemas = toolsFromNodes(tools);
    // Build tool lookup: nodeKey → node function
    const toolMap = new Map();
    for (const fn of tools) {
        const nodeKey = fn._nodeKey || fn.name || "anonymous";
        toolMap.set(nodeKey, fn);
    }
    // Build initial messages
    const messages = [];
    if (systemPrompt)
        messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: query });
    const allToolCalls = [];
    const start = performance.now();
    for (let step = 0; step < maxIterations; step++) {
        const response = await provider.chat(messages, toolSchemas, temperature, resolvedModel);
        provider.appendAssistant(messages, response);
        // No tool calls → LLM is done
        if (response.toolCalls.length === 0) {
            return {
                answer: response.content || "",
                toolCalls: allToolCalls,
                steps: step + 1,
                elapsedSeconds: Math.round((performance.now() - start) / 1000 * 100) / 100,
                model,
            };
        }
        // Execute tool calls sequentially
        for (const tc of response.toolCalls) {
            const toolFn = toolMap.get(tc.name);
            let toolResult;
            if (!toolFn) {
                toolResult = `Unknown tool: ${tc.name}`;
            }
            else {
                try {
                    // Pack args: if single arg, unwrap it
                    const argKeys = Object.keys(tc.arguments);
                    const input = argKeys.length === 1
                        ? tc.arguments[argKeys[0]]
                        : tc.arguments;
                    const result = await toolFn(input);
                    toolResult = String(result);
                }
                catch (e) {
                    toolResult = `Error: ${e instanceof Error ? e.message : String(e)}`;
                }
            }
            allToolCalls.push({ tool: tc.name, args: tc.arguments, result: toolResult });
            provider.appendToolResult(messages, tc, toolResult);
        }
    }
    // Max iterations reached
    return {
        answer: `Max iterations (${maxIterations}) reached without a final answer.`,
        toolCalls: allToolCalls,
        steps: maxIterations,
        elapsedSeconds: Math.round((performance.now() - start) / 1000 * 100) / 100,
        model,
    };
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
function agent(options, fn) {
    const { name, tools, model = "standard", systemPrompt = "", maxIterations = 10, temperature = 0, timeoutMs = 600000, } = options;
    const wrapped = async (input) => {
        // Convert input to query string
        const query = typeof input === "string" ? input : JSON.stringify(input);
        const result = await react({
            query,
            tools,
            model,
            systemPrompt,
            maxIterations,
            temperature,
        });
        console.log(`[agent:${name}] Completed in ${result.elapsedSeconds}s ` +
            `(${result.steps} steps, ${result.toolCalls.length} tool calls)`);
        return result.answer;
    };
    // Attach metadata for deploy() scanner
    Object.defineProperty(wrapped, "_nodeKey", { value: name });
    Object.defineProperty(wrapped, "_isAgent", { value: true });
    Object.defineProperty(wrapped, "name", { value: name, writable: false });
    return wrapped;
}
