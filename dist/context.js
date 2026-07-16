"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeRunContext = exports.GraphRunContext = void 0;
const node_async_hooks_1 = require("node:async_hooks");
const graphRunStorage = new node_async_hooks_1.AsyncLocalStorage();
const nodeRunStorage = new node_async_hooks_1.AsyncLocalStorage();
exports.GraphRunContext = {
    /**
     * Get the current graph run context, or undefined if not inside a graph.
     */
    get() {
        return graphRunStorage.getStore();
    },
    /**
     * Get the current graph run context, throwing if not inside a graph.
     */
    getOrThrow() {
        const ctx = graphRunStorage.getStore();
        if (!ctx) {
            throw new Error("No active GraphRunContext. " +
                "This can only be called from within a graph() wrapped function.");
        }
        return ctx;
    },
    /**
     * Run a function within a graph run context. Internal use only.
     */
    run(data, fn) {
        return graphRunStorage.run(data, fn);
    },
    /**
     * Run an async function within a graph run context. Internal use only.
     */
    runAsync(data, fn) {
        return graphRunStorage.run(data, fn);
    },
};
exports.NodeRunContext = {
    /**
     * Get the current node run context, or undefined if not inside a node.
     */
    get() {
        return nodeRunStorage.getStore();
    },
    /**
     * Get the current node run context, throwing if not inside a node.
     */
    getOrThrow() {
        const ctx = nodeRunStorage.getStore();
        if (!ctx) {
            throw new Error("No active NodeRunContext. " +
                "This can only be called from within a node() wrapped function.");
        }
        return ctx;
    },
    /**
     * Run a function within a node run context. Internal use only.
     */
    run(data, fn) {
        return nodeRunStorage.run(data, fn);
    },
    runAsync(data, fn) {
        return nodeRunStorage.run(data, fn);
    },
};
