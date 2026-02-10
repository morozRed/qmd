#!/usr/bin/env bun
/**
 * QMD Socket Server - Unix socket server for UI communication
 *
 * Provides JSON-RPC style API for the native macOS app.
 * Unix socket: ~/.cache/qmd/app.sock
 *
 * Endpoints:
 *   - search: BM25 + vector hybrid search
 *   - ask: RAG with streaming response
 *   - get: Retrieve single document
 *   - create: Create new note with timestamp naming
 *   - collections: List all collections
 *   - status: Server health check
 */

import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { existsSync, mkdirSync, unlinkSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Socket } from "bun";
import {
  createStore,
  searchFTS,
  searchVec,
  reciprocalRankFusion,
  extractSnippet,
  getContextForFile,
  findDocument,
  getDocumentBody,
  listCollections,
  hashContent,
  extractTitle,
  handelize,
  insertContent,
  insertDocument,
  findActiveDocument,
  updateDocument,
  updateDocumentTitle,
  deactivateDocument,
  getActiveDocumentPaths,
  cleanupOrphanedContent,
  clearCache,
  getHashesNeedingEmbedding,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  enableProductionMode,
} from "./store.js";
import {
  getDefaultLlamaCpp,
  withLLMSession,
  type GenerateResult,
} from "./llm.js";
import type { RankedResult, SearchResult } from "./store.js";
import { addCollection as addCollectionToConfig, getCollection as getCollectionFromConfig } from "./collections.js";

// =============================================================================
// Configuration
// =============================================================================

const HOME = Bun.env.HOME || "/tmp";
const SOCKET_DIR = join(HOME, ".cache", "qmd");
const SOCKET_PATH = join(SOCKET_DIR, "app.sock");
const PID_FILE = join(SOCKET_DIR, "server.pid");

// =============================================================================
// Types
// =============================================================================

type JSONRPCRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type JSONRPCResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type SearchRequest = {
  query: string;
  limit?: number;
  minScore?: number;
  collection?: string;
};

type SearchResultItem = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
  line: number;
};

type AskRequest = {
  query: string;
  limit?: number;
  collection?: string;
  stream?: boolean;
};

type AskResult = {
  answer: string;
  sources: SearchResultItem[];
  model: string;
};

type GetRequest = {
  file: string;
  fromLine?: number;
  maxLines?: number;
};

type GetResult = {
  file: string;
  title: string;
  content: string;
  context: string | null;
};

type CreateRequest = {
  collection: string;
  content: string;
  title?: string;
};

type CreateResult = {
  success: boolean;
  file: string;
  path: string;
};

type CollectionInfo = {
  name: string;
  path: string;
  pattern: string;
  documents: number;
  lastModified: string | null;
};

type StatusResult = {
  status: "ok" | "error";
  version: string;
  collections: number;
  documents: number;
  hasVectorIndex: boolean;
};

type CreateCollectionRequest = {
  name: string;
  path: string;
  pattern?: string;
};

// =============================================================================
// Helper Functions
// =============================================================================

function getTimestampPath(): { dateDir: string; filename: string } {
  const now = new Date();
  const dateDir = now.toISOString().split("T")[0]!; // YYYY-MM-DD
  const timeStr = now
    .toTimeString()
    .split(" ")[0]!
    .replace(/:/g, ""); // HHMMSS
  const filename = `${timeStr}.md`;
  return { dateDir, filename };
}

function formatSearchSummary(results: SearchResultItem[]): string {
  if (results.length === 0) {
    return "No results found";
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? "" : "s"}:`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file}`);
  }
  return lines.join("\n");
}

// =============================================================================
// Request Handlers
// =============================================================================

class QMDServer {
  private store: ReturnType<typeof createStore>;
  private server: ReturnType<typeof Bun.listen> | null = null;

  constructor() {
    this.store = createStore();
  }

  async handleSearch(params: SearchRequest): Promise<SearchResultItem[]> {
    const limit = params.limit ?? 5;
    const minScore = params.minScore ?? 0.3;
    const collection = params.collection;

    // Check if we have vectors
    const hasVectors = !!this.store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
      .get();

    const rankedLists: RankedResult[][] = [];
    const docidMap = new Map<string, string>();

    // BM25 search
    const ftsResults = searchFTS(this.store.db, params.query, 20);
    if (ftsResults.length > 0) {
      for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
      rankedLists.push(
        ftsResults.map((r) => ({
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
        }))
      );
    }

    // Vector search if available
    if (hasVectors) {
      const vecResults = await searchVec(
        this.store.db,
        params.query,
        DEFAULT_EMBED_MODEL,
        20
      );
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(
          vecResults.map((r) => ({
            file: r.filepath,
            displayPath: r.displayPath,
            title: r.title,
            body: r.body || "",
            score: r.score,
          }))
        );
      }
    }

    // RRF fusion
    const weights = rankedLists.map((_, i) => (i < 2 ? 2.0 : 1.0));
    const fused = reciprocalRankFusion(rankedLists, weights);
    const candidates = fused.slice(0, limit * 2);

    // Rerank
    const reranked = await this.store.rerank(
      params.query,
      candidates.map((c) => ({ file: c.file, text: c.body })),
      DEFAULT_RERANK_MODEL
    );

    // Blend scores and format results
    const candidateMap = new Map(
      candidates.map((c) => [
        c.file,
        { displayPath: c.displayPath, title: c.title, body: c.body },
      ])
    );
    const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

    const results: SearchResultItem[] = reranked
      .map((r) => {
        const rrfRank = rrfRankMap.get(r.file) || candidates.length;
        let rrfWeight: number;
        if (rrfRank <= 3) rrfWeight = 0.75;
        else if (rrfRank <= 10) rrfWeight = 0.6;
        else rrfWeight = 0.4;
        const rrfScore = 1 / rrfRank;
        const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;
        const candidate = candidateMap.get(r.file);
        const { line, snippet } = extractSnippet(candidate?.body || "", params.query, 300);
        return {
          docid: `#${docidMap.get(r.file) || ""}`,
          file: candidate?.displayPath || "",
          title: candidate?.title || "",
          score: Math.round(blendedScore * 100) / 100,
          context: getContextForFile(this.store.db, r.file),
          snippet,
          line,
        };
      })
      .filter((r) => r.score >= minScore)
      .slice(0, limit);

    return results;
  }

  async handleAsk(
    params: AskRequest,
    socket: Socket<unknown>
  ): Promise<AskResult | void> {
    const limit = params.limit ?? 5;
    const query = params.query;
    const stream = params.stream ?? false;

    // Step 1: Search for relevant documents
    const searchResults = await this.handleSearch({ query, limit });

    if (searchResults.length === 0) {
      const result: AskResult = {
        answer: "I couldn't find any relevant documents to answer your question.",
        sources: [],
        model: DEFAULT_QUERY_MODEL,
      };
      return result;
    }

    // Step 2: Retrieve full content of top documents
    const sources: SearchResultItem[] = searchResults.slice(0, 5);
    const contextParts: string[] = [];

    for (const source of sources) {
      // Get full document content
      const doc = this.store.db
        .prepare(
          `
          SELECT c.doc as body
          FROM documents d
          JOIN content c ON c.hash = d.hash
          WHERE d.active = 1 AND 'qmd://' || d.collection || '/' || d.path = ?
        `
        )
        .get(source.file) as { body: string } | null;

      if (doc) {
        contextParts.push(`File: ${source.file}\n${doc.body}\n---`);
      }
    }

    const context = contextParts.join("\n");

    // Step 3: Generate answer using Qwen3
    const prompt = `Based on the following documents, answer the question: "${query}"

Documents:
${context}

Provide a clear, concise answer based on the information in the documents. If the documents don't contain enough information, say so.

Answer:`;

    if (stream) {
      // Streaming mode - send chunks as they arrive
      let fullAnswer = "";

      await withLLMSession(async (session) => {
        // Get the LLM instance from session
        const llm = getDefaultLlamaCpp();
        const result = await llm.generate(prompt, {
          maxTokens: 500,
          temperature: 0.7,
        });

        if (result) {
          fullAnswer = result.text;
          // Send streaming chunks (for now, just send the whole thing)
          const streamResponse: JSONRPCResponse = {
            jsonrpc: "2.0",
            id: "stream",
            result: {
              type: "chunk",
              content: result.text,
              done: true,
            },
          };
          socket.write(JSON.stringify(streamResponse) + "\n");
        }
      });

      return {
        answer: fullAnswer,
        sources,
        model: DEFAULT_QUERY_MODEL,
      };
    } else {
      // Non-streaming mode
      let answer = "";

      await withLLMSession(async (session) => {
        const llm = getDefaultLlamaCpp();
        const result = await llm.generate(prompt, {
          maxTokens: 500,
          temperature: 0.7,
        });

        if (result) {
          answer = result.text;
        }
      });

      return {
        answer,
        sources,
        model: DEFAULT_QUERY_MODEL,
      };
    }
  }

  async handleGet(params: GetRequest): Promise<GetResult> {
    const result = findDocument(this.store.db, params.file, {
      includeBody: false,
    });

    if ("error" in result) {
      throw new Error(`Document not found: ${params.file}`);
    }

    const body = getDocumentBody(
      this.store.db,
      result,
      params.fromLine,
      params.maxLines
    );

    return {
      file: result.displayPath,
      title: result.title,
      content: body ?? "",
      context: result.context,
    };
  }

  async handleCreate(params: CreateRequest): Promise<CreateResult> {
    const { dateDir, filename } = getTimestampPath();
    const relativePath = `${dateDir}/${filename}`;

    // Get collection info
    const collection = listCollections(this.store.db).find(
      (c) => c.name === params.collection
    );

    if (!collection) {
      throw new Error(`Collection not found: ${params.collection}`);
    }

    const now = new Date().toISOString();
    const content = params.content;
    const hash = await hashContent(content);

    // Check if content already exists
    const existing = this.store.db
      .prepare(`SELECT hash FROM content WHERE hash = ?`)
      .get(hash) as { hash: string } | null;

    if (!existing) {
      insertContent(this.store.db, hash, content, now);
    }

    // Check if document already exists in this collection/path
    const existingDoc = findActiveDocument(
      this.store.db,
      params.collection,
      relativePath
    );

    if (existingDoc) {
      // Update existing
      updateDocument(this.store.db, existingDoc.id, params.title || filename, hash, now);
    } else {
      // Insert new
      insertDocument(
        this.store.db,
        params.collection,
        relativePath,
        params.title || filename,
        hash,
        now,
        now
      );
    }

    return {
      success: true,
      file: filename,
      path: `qmd://${params.collection}/${relativePath}`,
    };
  }

  handleCollections(): CollectionInfo[] {
    const collections = listCollections(this.store.db);
    return collections.map((c) => ({
      name: c.name,
      path: c.pwd,
      pattern: c.glob_pattern,
      documents: c.active_count,
      lastModified: c.last_modified,
    }));
  }

  handleStatus(): StatusResult {
    const totalDocs = this.store.db
      .prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`)
      .get() as { count: number };

    const hasVectorIndex = !!this.store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
      .get();

    const collections = listCollections(this.store.db);

    return {
      status: "ok",
      version: "1.0.0",
      collections: collections.length,
      documents: totalDocs.count,
      hasVectorIndex,
    };
  }

  handleCollectionCreate(params: CreateCollectionRequest): CollectionInfo {
    const name = params.name.trim();
    const path = params.path.trim();
    const pattern = (params.pattern || "**/*.md").trim() || "**/*.md";

    if (!name) {
      throw new Error("Collection name is required");
    }
    if (!path) {
      throw new Error("Collection path is required");
    }
    if (!existsSync(path)) {
      throw new Error(`Collection path does not exist: ${path}`);
    }
    if (!statSync(path).isDirectory()) {
      throw new Error(`Collection path is not a directory: ${path}`);
    }

    const existing = getCollectionFromConfig(name);
    if (existing) {
      throw new Error(`Collection already exists: ${name}`);
    }

    addCollectionToConfig(name, path, pattern);
    this.startCollectionIndexing(name, path, pattern);

    return {
      name,
      path,
      pattern,
      documents: 0,
      lastModified: null,
    };
  }

  private startCollectionIndexing(collectionName: string, path: string, pattern: string): void {
    void this.indexCollection(collectionName, path, pattern).catch((error) => {
      console.error(`Failed to index collection '${collectionName}':`, error);
    });
  }

  private async indexCollection(
    collectionName: string,
    collectionPath: string,
    pattern: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const excludeDirs = new Set(["node_modules", ".git", ".cache", "vendor", "dist", "build"]);

    clearCache(this.store.db);

    const glob = new Glob(pattern);
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: collectionPath, onlyFiles: true, followSymlinks: true })) {
      const parts = file.split("/");
      const shouldSkip = parts.some((part) =>
        part === "node_modules" || part.startsWith(".") || excludeDirs.has(part)
      );
      if (!shouldSkip) {
        files.push(file);
      }
    }

    if (files.length === 0) {
      console.log(`Collection '${collectionName}' has no files matching ${pattern}`);
      return;
    }

    let indexed = 0;
    let updated = 0;
    let unchanged = 0;
    const seenPaths = new Set<string>();

    for (const relativeFile of files) {
      const fullPath = join(collectionPath, relativeFile);
      const content = readFileSync(fullPath, "utf-8");
      if (!content.trim()) {
        continue;
      }

      const path = handelize(relativeFile);
      seenPaths.add(path);
      const hash = await hashContent(content);
      const title = extractTitle(content, relativeFile);
      const existing = findActiveDocument(this.store.db, collectionName, path);
      const stat = statSync(fullPath);

      if (existing) {
        if (existing.hash === hash) {
          if (existing.title !== title) {
            updateDocumentTitle(this.store.db, existing.id, title, now);
            updated++;
          } else {
            unchanged++;
          }
          continue;
        }

        insertContent(this.store.db, hash, content, now);
        updateDocument(
          this.store.db,
          existing.id,
          title,
          hash,
          new Date(stat.mtime).toISOString()
        );
        updated++;
        continue;
      }

      insertContent(this.store.db, hash, content, now);
      insertDocument(
        this.store.db,
        collectionName,
        path,
        title,
        hash,
        new Date(stat.birthtime).toISOString(),
        new Date(stat.mtime).toISOString()
      );
      indexed++;
    }

    let removed = 0;
    const activePaths = getActiveDocumentPaths(this.store.db, collectionName);
    for (const path of activePaths) {
      if (!seenPaths.has(path)) {
        deactivateDocument(this.store.db, collectionName, path);
        removed++;
      }
    }

    cleanupOrphanedContent(this.store.db);
    const needsEmbedding = getHashesNeedingEmbedding(this.store.db);
    console.log(
      `Collection '${collectionName}' indexed: ${indexed} new, ${updated} updated, ${unchanged} unchanged, ${removed} removed.`
    );
    if (needsEmbedding > 0) {
      console.log(`Embedding refresh needed: ${needsEmbedding} content hashes.`);
    }
  }

  // =============================================================================
  // Server Lifecycle
  // =============================================================================

  start(): void {
    // Ensure socket directory exists
    if (!existsSync(SOCKET_DIR)) {
      mkdirSync(SOCKET_DIR, { recursive: true });
    }

    // Clean up old socket if it exists
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // Socket might be in use
      }
    }

    this.server = Bun.listen({
      unix: SOCKET_PATH,
      socket: {
        data: (socket, data) => {
          this.handleSocketData(socket, data).catch((err) => {
            console.error("Error handling request:", err);
          });
        },
        open: (socket) => {
          console.log("Client connected");
        },
        close: (socket) => {
          console.log("Client disconnected");
        },
        error: (socket, error) => {
          console.error("Socket error:", error);
        },
      },
    });

    // Write PID file
    Bun.write(PID_FILE, process.pid.toString());

    console.log(`QMD Server listening on ${SOCKET_PATH}`);
    console.log(`PID: ${process.pid}`);

    // Handle shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  stop(): void {
    console.log("\nShutting down QMD Server...");

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }

    // Close store
    this.store.close();

    process.exit(0);
  }

  private async handleSocketData(socket: Socket<unknown>, data: Buffer): Promise<void> {
    const text = data.toString("utf-8");

    // Handle newline-delimited JSON (could be multiple messages)
    const lines = text.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const request: JSONRPCRequest = JSON.parse(line);

        if (request.jsonrpc !== "2.0") {
          this.sendError(socket, request.id ?? null, -32600, "Invalid Request");
          continue;
        }

        const response = await this.handleRequest(request, socket);
        if (response) {
          socket.write(JSON.stringify(response) + "\n");
        }
      } catch (err) {
        console.error("Error parsing request:", err);
        this.sendError(socket, null, -32700, "Parse error");
      }
    }
  }

  private async handleRequest(
    request: JSONRPCRequest,
    socket: Socket<unknown>
  ): Promise<JSONRPCResponse | null> {
    const { id, method, params = {} } = request;

    try {
      let result: unknown;

      switch (method) {
        case "search":
          result = await this.handleSearch(params as SearchRequest);
          break;

        case "ask":
          result = await this.handleAsk(params as AskRequest, socket);
          break;

        case "get":
          result = await this.handleGet(params as GetRequest);
          break;

        case "create":
          result = await this.handleCreate(params as CreateRequest);
          break;

        case "collections":
          result = this.handleCollections();
          break;

        case "status":
          result = this.handleStatus();
          break;

        case "collection_create":
          result = this.handleCollectionCreate(params as CreateCollectionRequest);
          break;

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message,
        },
      };
    }
  }

  private sendError(
    socket: Socket<unknown>,
    id: string | number | null,
    code: number,
    message: string
  ): void {
    const response: JSONRPCResponse = {
      jsonrpc: "2.0",
      id: id ?? 0,
      error: { code, message },
    };
    socket.write(JSON.stringify(response) + "\n");
  }
}

// =============================================================================
// PID File Management
// =============================================================================

export function isServerRunning(): boolean {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8"), 10);
    // Check if process exists (this is a simple check, not foolproof)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getServerPid(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  try {
    return parseInt(readFileSync(PID_FILE, "utf-8"), 10);
  } catch {
    return null;
  }
}

export function stopServer(): boolean {
  const pid = getServerPid();
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

export function startServer(): void {
  enableProductionMode();
  const server = new QMDServer();
  server.start();
}

// Run if this is the main module
if (import.meta.main) {
  startServer();
}
