// Mini agent is an implementation of the "agents write throwaway code" demo from the blog post.
//
// The idea is to give an LLM a Python scratchpad (Pyodide) and a predictable file system facade
// so it can iteratively script its way to a solution.  Everything here is geared towards showing
// how little infrastructure is required: we stand up Pyodide in-process, expose curated resources
// through a virtual FS, and persist the run state so the workflow survives retries.
const fs = require("fs");
const path = require("path");
const {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} = require("worker_threads");
const { loadPyodide } = require("pyodide");
const Anthropic = require("@anthropic-ai/sdk");

// Prompt that teaches the model about its execution environment and nudges it towards the
// file-system-first mental model described in the blog post.
const SYSTEM_PROMPT = `
You are a helpful agent that can execute Python code in a sandbox (execute_python)

You don't have network access, but you have a powerful file system which allows
you to access system resources.

<file-system-paths>
Special file system paths:

/network/current-ip   has the current IP address.
/output               files produced here the user can see.
</file-system-paths>
`;

const KNOWN_RESOURCES = {
  "current-ip": "https://icanhazip.com/",
};

// Carries everything we need to resurrect the agent mid-flight. This is the durable execution
// trick: serialize messages, FS snapshots, and cached fetches so a rerun can pick up where the
// last attempt stopped.
class AgentState {
  constructor(data = {}) {
    this.messages = data.messages || [];
    this.stepCount = data.stepCount || 0;
    this.outputCapture = data.outputCapture || { stdout: "", stderr: "" };
    this.networkCache = data.networkCache || {};
    this.outputFiles = data.outputFiles || {};
    this.done = data.done || false;
    this.metadata = data.metadata || {
      taskId: null,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };
  }

  // Serialize state to JSON-compatible object
  serialize() {
    return {
      messages: this.messages,
      stepCount: this.stepCount,
      outputCapture: this.outputCapture,
      networkCache: this.networkCache,
      outputFiles: this.outputFiles,
      done: this.done,
      metadata: {
        ...this.metadata,
        lastModified: Date.now(),
      },
    };
  }

  // Deserialize state from JSON-compatible object
  static deserialize(data) {
    return new AgentState(data);
  }

  // Extract network cache from NetworkFileSystem and store in state
  captureNetworkCache(networkFS) {
    const cache = {};
    for (const [key, value] of networkFS.cache.entries()) {
      cache[key] = Buffer.from(value).toString("base64");
    }
    this.networkCache = cache;
  }

  // Restore network cache to NetworkFileSystem from state
  restoreNetworkCache(networkFS) {
    networkFS.cache.clear();
    for (const [key, base64Value] of Object.entries(this.networkCache)) {
      // Convert base64 back to Uint8Array
      const buffer = Buffer.from(base64Value, "base64");
      networkFS.cache.set(key, new Uint8Array(buffer));
    }
  }

  // Extract output files from Pyodide FS and store in state
  captureOutputFiles(pyodide) {
    const files = {};
    try {
      const fileList = pyodide.FS.readdir("/output").filter(
        (name) => name !== "." && name !== "..",
      );

      for (const filename of fileList) {
        const pyodidePath = `/output/${filename}`;
        try {
          const data = pyodide.FS.readFile(pyodidePath);
          files[filename] = Buffer.from(data).toString("base64");
        } catch (err) {
          console.error(`Error reading ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
    }
    this.outputFiles = files;
  }

  // Restore output files to Pyodide FS from state
  restoreOutputFiles(pyodide) {
    try {
      pyodide.FS.mkdir("/output");
    } catch {}

    for (const [filename, base64Data] of Object.entries(this.outputFiles)) {
      const pyodidePath = `/output/${filename}`;
      try {
        const buffer = Buffer.from(base64Data, "base64");
        pyodide.FS.writeFile(pyodidePath, new Uint8Array(buffer));
      } catch (err) {
        console.error(`Error restoring ${filename}: ${err.message}`);
      }
    }
  }
}

// Thin wrapper around the on-disk cache. Each step is keyed by task + step
// number, matching the queue-based retry story from the article.
const StateCache = {
  cacheDir: path.join(__dirname, "agent-cache"),

  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  },

  getCachePath(taskId, stepCount) {
    return path.join(this.cacheDir, `${taskId}-step-${stepCount}.json`);
  },

  saveState(taskId, stepCount, state) {
    this.ensureCacheDir();
    const cachePath = this.getCachePath(taskId, stepCount);
    const serialized = state.serialize();
    fs.writeFileSync(cachePath, JSON.stringify(serialized, null, 2), "utf-8");
    console.log(`[Cache] Saved state to: ${cachePath}`);
  },

  loadState(taskId, stepCount) {
    const cachePath = this.getCachePath(taskId, stepCount);
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    try {
      const data = fs.readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(data);
      console.log(`[Cache] Loaded state from: ${cachePath}`);
      return AgentState.deserialize(parsed);
    } catch (err) {
      console.error(`[Cache] Error loading state: ${err.message}`);
      return null;
    }
  },

  clearCache(taskId) {
    if (!fs.existsSync(this.cacheDir)) {
      return;
    }
    const files = fs.readdirSync(this.cacheDir);
    for (const file of files) {
      if (file.startsWith(`${taskId}-`)) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
    }
    console.log(`[Cache] Cleared cache for task: ${taskId}`);
  },
};

// Small helper that lets us hide async fetch behind the synchronous Emscripten FS API by farming
// requests out to a dedicated worker and parking on Atomics. This mirrors the "second web worker"
// pattern from the post.
class SyncFetchWorker {
  constructor(scriptPath) {
    this.worker = new Worker(scriptPath);
    this.nextJobId = 1;
  }

  fetch(url) {
    const jobId = this.nextJobId++;
    const sharedBuffer = new SharedArrayBuffer(4);
    const control = new Int32Array(sharedBuffer);
    const { port1, port2 } = new MessageChannel();

    this.worker.postMessage(
      {
        type: "fetch",
        id: jobId,
        url,
        signalBuffer: sharedBuffer,
        port: port2,
      },
      [port2],
    );

    Atomics.wait(control, 0, 0);

    let message;
    do {
      message = receiveMessageOnPort(port1);
    } while (!message);

    port1.close();
    const payload = message.message;

    if (!payload) {
      throw new Error(`Fetch worker returned no payload for ${url}`);
    }

    if (payload.status !== "ok") {
      const errorMessage = payload.error?.message || `Failed to fetch ${url}`;
      const error = new Error(errorMessage);
      if (payload.error) {
        error.name = payload.error.name || error.name;
        error.cause = payload.error;
      }
      throw error;
    }

    return payload.data instanceof Uint8Array
      ? payload.data
      : new Uint8Array(payload.data);
  }

  terminate() {
    return this.worker.terminate();
  }
}

// Mounts a read-only tree under /network that lazily maps file reads to curated remote resources.
// The LLM only sees normal files, while we stay in control of what can be fetched.
class NetworkFileSystem {
  constructor(pyodide, options = {}) {
    const { mountPoint = "/network", scheme = "https" } = options;
    this.pyodide = pyodide;
    this.FS = pyodide.FS;
    this.scheme = scheme;
    this.mountPoint = mountPoint;
    this.cache = new Map();
    this.fetcher = new SyncFetchWorker(path.join(__dirname, "fetch-worker.js"));

    // Emscripten FS constants
    this.S_IFREG = 0o100000; // Regular file
    this.S_IFDIR = 0o040000; // Directory
  }

  isDir(mode) {
    return (mode & this.S_IFDIR) === this.S_IFDIR;
  }

  pathToURL(remotePath) {
    return `${this.scheme}://${remotePath}`;
  }

  createNodeOps() {
    const self = this;
    const FS = this.FS;

    return {
      getattr(node) {
        const now = new Date();
        const isDirectory = self.isDir(node.mode);
        const size = isDirectory
          ? 4096
          : (() => {
              try {
                const remotePath = node.remote_path;
                if (!remotePath) return 0;
                if (self.cache.has(remotePath)) {
                  return self.cache.get(remotePath).length;
                }
                return 0;
              } catch (_) {
                return 0;
              }
            })();
        return {
          dev: 1,
          ino: 0,
          mode: node.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size,
          atime: now,
          mtime: now,
          ctime: now,
          blksize: 4096,
          blocks: Math.ceil(size / 4096),
        };
      },

      lookup(parent, name) {
        // Build the remote path from parent path + name
        const remotePath = parent.remote_path + "/" + name;

        // Automatically fetch the file when it's looked up
        if (!self.cache.has(remotePath)) {
          const url = KNOWN_RESOURCES[name];
          if (!url) {
            // File doesn't exist - throw ENOENT
            const ErrnoError = FS.ErrnoError || Error;
            const err = new ErrnoError(44); // ENOENT
            err.message = `No such file: ${remotePath}`;
            throw err;
          }
          try {
            const data = self.fetcher.fetch(url);
            self.cache.set(remotePath, data);
          } catch (error) {
            // File doesn't exist - throw ENOENT
            const ErrnoError = FS.ErrnoError || Error;
            const err = new ErrnoError(44); // ENOENT
            err.message = `No such file: ${remotePath}`;
            throw err;
          }
        }

        // Create as a file
        const node = FS.createNode(parent, name, self.S_IFREG | 0o444, 0);
        node.node_ops = this;
        node.stream_ops = self.createStreamOps();
        node.remote_path = remotePath;
        return node;
      },

      readdir(node) {
        // Return cached files that are children of this directory
        const dirPath = node.remote_path || "";
        const children = new Set();

        for (const cachedPath of self.cache.keys()) {
          if (dirPath === "") {
            // Root directory - show top-level paths
            const parts = cachedPath.split("/");
            if (parts.length > 0) {
              children.add(parts[0]);
            }
          } else if (cachedPath.startsWith(dirPath + "/")) {
            // Show immediate children
            const remainder = cachedPath.slice(dirPath.length + 1);
            const parts = remainder.split("/");
            if (parts.length > 0) {
              children.add(parts[0]);
            }
          }
        }

        return [".", "..", ...Array.from(children)];
      },

      mknod() {
        const ErrnoError = FS.ErrnoError || Error;
        throw new ErrnoError(30); // EROFS - Read-only file system
      },

      rename() {
        const ErrnoError = FS.ErrnoError || Error;
        throw new ErrnoError(30); // EROFS
      },

      rmdir() {
        const ErrnoError = FS.ErrnoError || Error;
        throw new ErrnoError(30); // EROFS
      },

      unlink() {
        const ErrnoError = FS.ErrnoError || Error;
        throw new ErrnoError(30); // EROFS
      },

      setattr() {
        const ErrnoError = FS.ErrnoError || Error;
        throw new ErrnoError(30); // EROFS
      },
    };
  }

  createStreamOps() {
    const self = this;
    const FS = this.FS;

    return {
      read(stream, buffer, offset, length, position) {
        const remotePath = stream.node.remote_path;

        if (!self.cache.has(remotePath)) {
          console.error(
            `File ${remotePath} not cached. This should not happen as lookup() fetches files.`,
          );
          return 0;
        }

        const bytes = self.cache.get(remotePath);
        const start = position;
        const end = Math.min(bytes.length, position + length);
        const slice = bytes.slice(start, end);
        buffer.set(slice, offset);
        return end - start;
      },

      llseek(stream, offset, whence) {
        const SEEK_SET = 0;
        const SEEK_CUR = 1;
        const SEEK_END = 2;
        const remotePath = stream.node.remote_path;

        let size = 0;
        if (self.cache.has(remotePath)) {
          size = self.cache.get(remotePath).length;
        }

        let pos = stream.position;
        if (whence === SEEK_SET) pos = offset;
        else if (whence === SEEK_CUR) pos += offset;
        else if (whence === SEEK_END) pos = size + offset;
        if (pos < 0) {
          const ErrnoError = FS.ErrnoError || Error;
          throw new ErrnoError(22); // EINVAL
        }
        stream.position = pos;
        return pos;
      },

      close() {},
    };
  }

  createFS() {
    const self = this;
    const FS = this.FS;

    return {
      mount(mount) {
        const node = FS.createNode(null, "/", self.S_IFDIR | 0o555, 0);
        node.node_ops = self.createNodeOps();
        node.remote_path = ""; // Root has empty remote path
        return node;
      },
    };
  }

  mount() {
    const FS = this.FS;

    // Clean up any existing mount
    try {
      FS.unmount(this.mountPoint);
    } catch {}

    try {
      FS.mkdir(this.mountPoint);
    } catch {}

    FS.mount(this.createFS(), {}, this.mountPoint);
  }

  async dispose() {
    // Clean up the mount
    try {
      this.FS.unmount(this.mountPoint);
    } catch {}

    await this.fetcher.terminate();
  }
}

// Executes arbitrary code emitted by the model while capturing stdout/stderr so the transcript
// reflects what Pyodide produced. Packages are resolved on the fly to keep the sandbox flexible.
async function executePythonCode(pyodide, code, state) {
  try {
    // Run the user code
    await pyodide.loadPackagesFromImports(code);
    await pyodide.runPythonAsync(code);

    return {
      stdout: state.outputCapture.stdout,
      stderr: state.outputCapture.stderr,
      success: true,
    };
  } catch (error) {
    return {
      stdout: state.outputCapture.stdout,
      stderr: state.outputCapture.stderr + error.message,
      success: false,
    };
  } finally {
    // Reset capture buffers for next execution
    state.outputCapture.stdout = "";
    state.outputCapture.stderr = "";
  }
}

// Copies any sandbox artifacts from /output back into the host file system so the demo can surface
// generated files to the reader.
async function exposeFiles(state) {
  // Extract files from state to local output folder
  const outputDir = path.join(__dirname, "output");

  try {
    // Create local output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fileCount = Object.keys(state.outputFiles).length;

    if (fileCount > 0) {
      console.log(`\nMaking ${fileCount} file(s) available in ./output:`);

      for (const [filename, base64Data] of Object.entries(state.outputFiles)) {
        const localPath = path.join(outputDir, filename);

        try {
          const buffer = Buffer.from(base64Data, "base64");
          fs.writeFileSync(localPath, buffer);
          console.log(`  ✓ ${filename}`);
        } catch (err) {
          console.error(`  ✗ ${filename}: ${err.message}`);
        }
      }
    } else {
      console.log("\nNo files in /output to copy.");
    }
  } catch (err) {
    console.error(`Error copying output files: ${err.message}`);
  }
}

// One round-trip with the LLM: ask for the next action, optionally execute Python on its behalf,
// and persist everything back into state so the next loop iteration has full context.
async function runAgenticStep(state, pyodide, networkFS, client, tools) {
  // Increment step count
  state.stepCount++;
  console.log(`\nStep ${state.stepCount}:`);

  // Make API call
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools,
    messages: state.messages,
  });

  console.log(`Stop reason: ${response.stop_reason}`);

  // Add assistant response to messages
  state.messages.push({
    role: "assistant",
    content: response.content,
  });

  // Check if we've reached an end condition
  if (response.stop_reason === "end_turn") {
    const textContent = response.content.find((block) => block.type === "text");
    console.log("\nFinal result:", textContent?.text || "");
    state.done = true;
    return state;
  }

  // Handle tool calls
  if (response.stop_reason === "tool_use") {
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`Tool call: ${block.name}`, block.input);

        let result;
        if (block.name === "execute_python") {
          result = await executePythonCode(pyodide, block.input.code, state);
        }

        console.log("Tool result:", result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Add tool results to messages
    state.messages.push({
      role: "user",
      content: toolResults,
    });
  }

  // Capture current state from file systems
  state.captureNetworkCache(networkFS);
  state.captureOutputFiles(pyodide);

  return state;
}

// Orchestrates the whole durable loop: bootstrap Pyodide, replay cached state if available, and
// keep iterating until the model declares victory or we hit the step budget.
async function agenticLoop(taskId, initialState, options = {}) {
  const { maxSteps = 10, useCache = true, clearCacheOnStart = false } = options;

  // Clear cache if requested
  if (clearCacheOnStart) {
    StateCache.clearCache(taskId);
  }

  // Initialize environment
  let state = initialState;
  state.metadata.taskId = taskId;

  // Create output capture object that will be updated by Pyodide
  const outputCaptureRef = state.outputCapture;

  // Initialize Pyodide with stdout/stderr handlers that update state
  const pyodide = await loadPyodide({
    stdout: (msg) => {
      outputCaptureRef.stdout += msg;
    },
    stderr: (msg) => {
      outputCaptureRef.stderr += msg;
    },
  });

  const networkFS = new NetworkFileSystem(pyodide);
  networkFS.mount();
  pyodide.FS.mkdir("/output");

  // Restore state to file systems if needed
  state.restoreNetworkCache(networkFS);
  state.restoreOutputFiles(pyodide);

  // Initialize Anthropic client
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Define tools
  const tools = [
    {
      name: "execute_python",
      description:
        "Execute Python code using Pyodide. Returns the output of the code execution.",
      input_schema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The Python code to execute",
          },
        },
        required: ["code"],
      },
    },
  ];

  // Main loop
  while (state.stepCount < maxSteps) {
    const nextStepCount = state.stepCount + 1;

    // Try to load cached state
    let cachedState = null;
    if (useCache) {
      cachedState = StateCache.loadState(taskId, nextStepCount);
    }

    if (cachedState !== null) {
      console.log(`[Cache] Using cached state for step ${nextStepCount}`);
      state = cachedState;
      // Restore cached state to file systems
      state.restoreNetworkCache(networkFS);
      state.restoreOutputFiles(pyodide);
      result = { done: state.done, state };
    } else {
      // Run the agentic step
      state = await runAgenticStep(state, pyodide, networkFS, client, tools);

      // Cache the new state
      if (useCache) {
        StateCache.saveState(taskId, state.stepCount, state);
      }
    }

    // Check if we're done
    if (state.done) {
      break;
    }
  }

  console.log(`\nTotal steps: ${state.stepCount}`);

  // Cleanup
  await networkFS.dispose();

  return state;
}

async function main() {
  // Define task ID and initial state
  const taskId = "task-0";
  const initialState = new AgentState({
    messages: [
      {
        role: "user",
        content:
          "Figure out the current ip address and make me a picture of it",
      },
    ],
    stepCount: 0,
  });

  // Run the agentic loop
  const finalState = await agenticLoop(taskId, initialState, {
    maxSteps: 10,
    useCache: true,
    clearCacheOnStart: false,
  });

  // Expose final output files
  await exposeFiles(finalState);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
