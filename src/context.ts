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

import { AsyncLocalStorage } from "node:async_hooks";

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

const graphRunStorage = new AsyncLocalStorage<GraphRunContextData>();
const nodeRunStorage = new AsyncLocalStorage<NodeRunContextData>();

export const GraphRunContext = {
  /**
   * Get the current graph run context, or undefined if not inside a graph.
   */
  get(): GraphRunContextData | undefined {
    return graphRunStorage.getStore();
  },

  /**
   * Get the current graph run context, throwing if not inside a graph.
   */
  getOrThrow(): GraphRunContextData {
    const ctx = graphRunStorage.getStore();
    if (!ctx) {
      throw new Error(
        "No active GraphRunContext. " +
          "This can only be called from within a graph() wrapped function."
      );
    }
    return ctx;
  },

  /**
   * Run a function within a graph run context. Internal use only.
   */
  run<T>(data: GraphRunContextData, fn: () => T): T {
    return graphRunStorage.run(data, fn);
  },

  /**
   * Run an async function within a graph run context. Internal use only.
   */
  runAsync<T>(data: GraphRunContextData, fn: () => Promise<T>): Promise<T> {
    return graphRunStorage.run(data, fn);
  },
};

export const NodeRunContext = {
  /**
   * Get the current node run context, or undefined if not inside a node.
   */
  get(): NodeRunContextData | undefined {
    return nodeRunStorage.getStore();
  },

  /**
   * Get the current node run context, throwing if not inside a node.
   */
  getOrThrow(): NodeRunContextData {
    const ctx = nodeRunStorage.getStore();
    if (!ctx) {
      throw new Error(
        "No active NodeRunContext. " +
          "This can only be called from within a node() wrapped function."
      );
    }
    return ctx;
  },

  /**
   * Run a function within a node run context. Internal use only.
   */
  run<T>(data: NodeRunContextData, fn: () => T): T {
    return nodeRunStorage.run(data, fn);
  },

  runAsync<T>(data: NodeRunContextData, fn: () => Promise<T>): Promise<T> {
    return nodeRunStorage.run(data, fn);
  },
};
