/**
 * Graph Run Context & Node Run Context
 *
 * Provides access to current run metadata from anywhere inside
 * a running graph or node, using AsyncLocalStorage for async safety.
 *
 * Usage:
 *   import { GraphRunContext } from "graphingest";
 *   const ctx = GraphRunContext.get();
 *   console.log(ctx?.graphRunId, ctx?.graphName, ctx?.parameters);
 */
export interface GraphRunContextData {
    graphRunId: string;
    graphName: string;
    graphVersion?: string;
    parameters: Record<string, unknown>;
    tags: string[];
    parentGraphRunId?: string;
}
export interface NodeRunContextData {
    nodeRunId: string;
    nodeKey: string;
    graphRunId: string;
    mapIndex?: number;
    retryCount: number;
}
export declare const GraphRunContext: {
    /**
     * Get the current graph run context, or undefined if not inside a graph.
     */
    get(): GraphRunContextData | undefined;
    /**
     * Get the current graph run context, throwing if not inside a graph.
     */
    getOrThrow(): GraphRunContextData;
    /**
     * Run a function within a graph run context. Internal use only.
     */
    run<T>(data: GraphRunContextData, fn: () => T): T;
    /**
     * Run an async function within a graph run context. Internal use only.
     */
    runAsync<T>(data: GraphRunContextData, fn: () => Promise<T>): Promise<T>;
};
export declare const NodeRunContext: {
    /**
     * Get the current node run context, or undefined if not inside a node.
     */
    get(): NodeRunContextData | undefined;
    /**
     * Get the current node run context, throwing if not inside a node.
     */
    getOrThrow(): NodeRunContextData;
    /**
     * Run a function within a node run context. Internal use only.
     */
    run<T>(data: NodeRunContextData, fn: () => T): T;
    runAsync<T>(data: NodeRunContextData, fn: () => Promise<T>): Promise<T>;
};
