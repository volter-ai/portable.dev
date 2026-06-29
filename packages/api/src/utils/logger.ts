/**
 * Console logger utility that adds timestamps to all console output
 * Must be imported at the very top of server.ts to override console methods
 */

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function getTimestamp() {
  return new Date().toLocaleTimeString();
}

// Override console methods - only add timestamp
console.log = (...args: any[]) => {
  const timestamp = getTimestamp();
  originalLog(`[${timestamp}]`, ...args);
};

console.error = (...args: any[]) => {
  const timestamp = getTimestamp();
  originalError(`[${timestamp}]`, ...args);
};

console.warn = (...args: any[]) => {
  const timestamp = getTimestamp();
  originalWarn(`[${timestamp}]`, ...args);
};

// Export empty object to make this a proper module
export {};
