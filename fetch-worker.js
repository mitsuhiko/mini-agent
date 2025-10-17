const { parentPort } = require('worker_threads');

function normalizeError(error, url) {
  if (!error) {
    return { message: `Unknown error fetching ${url}` };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack
    };
  }
  if (typeof error === 'object') {
    return {
      ...error,
      message: error.message || `Unknown error fetching ${url}`
    };
  }
  return { message: String(error) };
}

async function handleFetchRequest({ id, url, signalBuffer, port }) {
  const signal = new Int32Array(signalBuffer);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    port.postMessage({ id, status: 'ok', data: bytes }, [bytes.buffer]);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  } catch (error) {
    port.postMessage({
      id,
      status: 'error',
      error: normalizeError(error, url)
    });
    Atomics.store(signal, 0, -1);
    Atomics.notify(signal, 0);
  } finally {
    port.close();
  }
}

parentPort.on('message', (message) => {
  handleFetchRequest(message);
});
