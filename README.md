# Mini Agent

This is a tiny example of how to build a simple agent on top of the
anthropic SDK which uses a magic file system and pyodide.

It's a very contrieved example which instructs the agent to look up
the current IP (which it gets from a well known file) an then create
an image from that IP address.

```
npm i
export ANTHROPIC_API_KEY='...'
node mini-agent.js
```
