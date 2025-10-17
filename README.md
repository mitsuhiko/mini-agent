# Mini Agent

A lightweight example demonstrating how to build a simple agent using the
Anthropic SDK with a virtual file system and Pyodide.

This is a contrived example that demonstrates agent capabilities. The agent:

1. Looks up the current IP address from a well-known file
2. Generates an image based on that IP address

## Usage

```bash
npm i
export ANTHROPIC_API_KEY='...'
node mini-agent.js
```

## File System

The agent uses a virtual file system which provides a magic `/network` folder.
It only has a single file in it called `current-ip` and accessing it will
asynchronously fetch the current ip from `icanhazip.com` in a web worker.

## Caching and Output

The agent persists per-turn state in `./agent-cache`.  You can delete cache files
after a run to observe how the agent recovers from a missed turn.  This attempts
to demonstrate how to implement durable execution.

Final output artifacts are placed in `./output`.
