const fs = require("fs");
const path = require("path");
const {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} = require("worker_threads");
const { loadPyodide } = require("pyodide");
const Anthropic = require("@anthropic-ai/sdk");

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

async function executePythonCode(pyodide, code, outputCapture) {
  try {
    // Run the user code
    await pyodide.loadPackagesFromImports(code);
    await pyodide.runPythonAsync(code);

    return {
      stdout: outputCapture.stdout,
      stderr: outputCapture.stderr,
      success: true,
    };
  } catch (error) {
    return {
      stdout: outputCapture.stdout,
      stderr: outputCapture.stderr + error.message,
      success: false,
    };
  } finally {
    // Reset capture buffers
    outputCapture.stdout = "";
    outputCapture.stderr = "";
  }
}

async function exposeFiles(pyodide) {
  // Extract files from /output to local output folder
  const outputDir = path.join(__dirname, "output");

  try {
    // Create local output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all files from /output in Pyodide FS
    const files = pyodide.FS.readdir("/output").filter(
      (name) => name !== "." && name !== "..",
    );

    if (files.length > 0) {
      console.log(`\nMaking ${files.length} file(s) available in ./output:`);

      for (const filename of files) {
        const pyodidePath = `/output/${filename}`;
        const localPath = path.join(outputDir, filename);

        try {
          const data = pyodide.FS.readFile(pyodidePath);
          fs.writeFileSync(localPath, data);
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

async function main() {
  // Create output capture object
  const outputCapture = {
    stdout: "",
    stderr: "",
  };

  // Initialize Pyodide with stdout/stderr handlers
  const pyodide = await loadPyodide({
    stdout: (msg) => {
      outputCapture.stdout += msg;
    },
    stderr: (msg) => {
      outputCapture.stderr += msg;
    },
  });
  const networkFS = new NetworkFileSystem(pyodide);
  networkFS.mount();
  pyodide.FS.mkdir("/output");

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

  // Agent loop
  const messages = [
    {
      role: "user",
      content: "Figure out the current ip address and make me a picture of it",
    },
  ];

  const maxSteps = 10;
  let stepCount = 0;

  while (stepCount < maxSteps) {
    stepCount++;
    console.log(`\nStep ${stepCount}:`);

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    console.log(`Stop reason: ${response.stop_reason}`);

    // Add assistant response to messages
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // If no tool use, we're done
    if (response.stop_reason === "end_turn") {
      const textContent = response.content.find(
        (block) => block.type === "text",
      );
      console.log("\nFinal result:", textContent?.text || "");
      break;
    }

    // Handle tool calls
    if (response.stop_reason === "tool_use") {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`Tool call: ${block.name}`, block.input);

          let result;
          if (block.name === "execute_python") {
            result = await executePythonCode(
              pyodide,
              block.input.code,
              outputCapture,
            );
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
      messages.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  console.log(`\nTotal steps: ${stepCount}`);

  await exposeFiles(pyodide);
  await networkFS.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
