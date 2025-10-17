const path = require("path");
const {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} = require("worker_threads");
const { loadPyodide } = require("pyodide");

const O_ACCMODE = 3;
const O_WRONLY = 1;

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
      [port2]
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

    this.original = {
      open: this.FS.open.bind(this.FS),
      stat: this.FS.stat.bind(this.FS),
      lstat: this.FS.lstat ? this.FS.lstat.bind(this.FS) : null,
    };

    this.ensureMountPoint();
    this.hookFS();
  }

  ensureMountPoint() {
    if (this.mountPoint === "/") {
      return;
    }
    try {
      this.FS.mkdirTree(this.mountPoint);
    } catch (error) {
      const errno = this.pyodide.ERRNO_CODES.EEXIST;
      if (
        !(error instanceof this.pyodide.FS.ErrnoError) ||
        error.errno !== errno
      ) {
        throw error;
      }
    }
  }

  isWithinMount(fsPath) {
    if (fsPath === this.mountPoint) {
      return true;
    }
    return fsPath.startsWith(`${this.mountPoint}/`);
  }

  extractRemotePath(fsPath) {
    if (!this.isWithinMount(fsPath)) {
      return "";
    }
    const prefix = this.mountPoint === "/" ? "/" : `${this.mountPoint}/`;
    const remote = fsPath.startsWith(prefix)
      ? fsPath.slice(prefix.length)
      : fsPath;
    return remote.replace(/^\/+/, "");
  }

  pathToURL(fsPath) {
    const remotePath = this.extractRemotePath(fsPath);
    if (!remotePath) {
      throw new Error(`No remote resource specified for ${fsPath}`);
    }
    return `${this.scheme}://${remotePath}`;
  }

  ensureParentDirectories(fsPath) {
    const dirname = fsPath.substring(0, fsPath.lastIndexOf("/")) || "/";
    if (!dirname || dirname === "/" || dirname === this.mountPoint) {
      return;
    }
    try {
      this.original.stat(dirname);
    } catch (error) {
      const errno = this.pyodide.ERRNO_CODES;
      if (
        error instanceof this.pyodide.FS.ErrnoError &&
        error.errno === errno.ENOENT
      ) {
        this.FS.mkdirTree(dirname);
      } else {
        throw error;
      }
    }
  }

  normalizePathArg(pathArg) {
    if (typeof pathArg === "string") {
      return this.normalizeToMount(pathArg);
    }
    if (pathArg && typeof pathArg === "object" && "mount" in pathArg) {
      return this.FS.getPath(pathArg);
    }
    return null;
  }

  normalizeToMount(path) {
    if (!path) {
      return null;
    }
    if (path.startsWith(this.mountPoint)) {
      return path;
    }
    if (path.startsWith("/")) {
      return `${this.mountPoint}${path}`;
    }
    return `${this.mountPoint}/${path}`;
  }

  fileExists(fsPath) {
    try {
      this.original.stat(fsPath);
      return true;
    } catch (error) {
      if (
        error instanceof this.pyodide.FS.ErrnoError &&
        error.errno === this.pyodide.ERRNO_CODES.ENOENT
      ) {
        return false;
      }
      throw error;
    }
  }

  shouldFetchForOpen(flags) {
    if (typeof flags === "string") {
      return !flags.includes("w") && !flags.includes("a");
    }
    return (flags & O_ACCMODE) !== O_WRONLY;
  }

  ensureFileSync(path) {
    const fsPath = this.normalizeToMount(path);
    if (!fsPath || !this.isWithinMount(fsPath)) {
      return null;
    }

    const remotePath = this.extractRemotePath(fsPath);
    if (!remotePath) {
      return null;
    }

    if (this.cache.has(fsPath) && this.fileExists(fsPath)) {
      return this.cache.get(fsPath);
    }

    const url = this.pathToURL(fsPath);
    let data;
    try {
      data = this.fetcher.fetch(url);
    } catch (error) {
      const errno = this.pyodide.ERRNO_CODES;
      const err = new this.pyodide.FS.ErrnoError(errno.ENOENT);
      err.message = `${error.message}`;
      throw err;
    }

    this.ensureParentDirectories(fsPath);
    this.FS.writeFile(fsPath, data, { canOwn: true });
    const stat = this.original.stat(fsPath);
    const meta = {
      path: fsPath,
      url,
      bytes: data.length,
      timestamp: stat.mtime,
    };
    this.cache.set(fsPath, meta);
    return meta;
  }

  hookFS() {
    const self = this;

    this.FS.open = function patchedOpen(pathArg, flags, mode = 0o666) {
      const normalized = self.normalizePathArg(pathArg);
      if (normalized && self.shouldFetchForOpen(flags)) {
        self.ensureFileSync(normalized);
      }
      return self.original.open(pathArg, flags, mode);
    };

    this.FS.stat = function patchedStat(pathArg, dontFollow) {
      const normalized = self.normalizePathArg(pathArg);
      if (normalized) {
        self.ensureFileSync(normalized);
      }
      return self.original.stat(pathArg, dontFollow);
    };

    if (this.original.lstat) {
      this.FS.lstat = function patchedLstat(pathArg) {
        const normalized = self.normalizePathArg(pathArg);
        if (normalized) {
          self.ensureFileSync(normalized);
        }
        return self.original.lstat(pathArg);
      };
    }
  }

  registerPythonModule(name = "networkfs") {
    this.pyodide.registerJsModule(name, {
      ensure: (path) => this.ensureFileSync(path),
      stat: (path) => {
        const fsPath = this.normalizeToMount(path);
        if (!fsPath) {
          return null;
        }
        if (!this.fileExists(fsPath)) {
          return null;
        }
        const stats = this.original.stat(fsPath);
        return {
          path: fsPath,
          size: stats.size,
          timestamp: stats.mtime,
        };
      },
      path_to_url: (path) => {
        try {
          const target = this.normalizeToMount(path);
          if (!target) {
            return null;
          }
          return this.pathToURL(target);
        } catch (_error) {
          return null;
        }
      },
    });
  }

  async dispose() {
    await this.fetcher.terminate();
  }
}

async function main() {
  const pyodide = await loadPyodide();
  const networkFS = new NetworkFileSystem(pyodide);
  networkFS.registerPythonModule();

  await pyodide.runPythonAsync(`
with open('/network/icanhazip.com/get', 'r', encoding='utf-8') as fp:
    print(fp.read())
  `);

  await networkFS.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
