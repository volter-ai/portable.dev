/**
 * PortDetectionService
 *
 * Detects server ports from stdout logs using framework-specific patterns.
 * Supports Next.js, Vite, Create React App, Express, and generic patterns.
 */
export class PortDetectionService {
  /**
   * Regex patterns for detecting ports in server logs.
   * Ordered by specificity (most specific first).
   */
  private static readonly PORT_PATTERNS = [
    // Next.js: "ready - started server on 0.0.0.0:65534"
    /ready.*?server on.*?:(\d+)/i,

    // Vite: "Local:   http://localhost:5173/"
    /local:?\s+https?:\/\/localhost:(\d+)/i,

    // Create React App / Express: "Listening on port 65534"
    /listening on (?:port )?(\d+)/i,

    // Generic server patterns
    /server.*?(?:port|:)\s*(\d+)/i,

    // Generic localhost/0.0.0.0 patterns
    /localhost:(\d+)/,
    /0\.0\.0\.0:(\d+)/,

    // Port flag: "--port 65534" or "-p 65534"
    /(?:--port|-p)\s+(\d+)/i,
  ];

  /**
   * Common development server ports, ordered by frequency.
   */
  private static readonly COMMON_PORTS = [
    65534, // Next.js, Create React App, Express default
    5173, // Vite
    4000, // Common alternative
    5000, // Flask, alternative Node
    8080, // Common HTTP alternative
    8000, // Python HTTP server
    4200, // Angular CLI
    3001, // Common alternative
  ];

  /**
   * Detect port from server logs using regex patterns.
   *
   * @param logs - Server stdout/stderr logs
   * @returns Port number if detected, null otherwise
   */
  static detectPortFromLogs(logs: string): number | null {
    if (!logs || logs.trim() === "") {
      return null;
    }

    // Try each pattern in order
    for (const pattern of this.PORT_PATTERNS) {
      const match = logs.match(pattern);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (this.isValidPort(port)) {
          console.log(
            `[PortDetection] Detected port ${port} from logs using pattern: ${pattern}`
          );
          return port;
        }
      }
    }

    return null;
  }

  /**
   * Validate if a port number is in valid range.
   *
   * @param port - Port number to validate
   * @returns true if port is valid (1024-65535)
   */
  private static isValidPort(port: number): boolean {
    return !isNaN(port) && port >= 1024 && port <= 65535;
  }

  /**
   * Get list of common development server ports.
   *
   * @returns Array of port numbers
   */
  static getCommonPorts(): number[] {
    return [...this.COMMON_PORTS];
  }

  /**
   * Detect port using multi-strategy approach.
   *
   * Strategy:
   * 1. Try to parse from provided logs
   * 2. Fallback to common ports (if you want to check availability)
   * 3. Default to 65534
   *
   * @param processLogs - Optional server stdout/stderr logs
   * @returns Detected or default port number
   */
  static async detectPort(processLogs?: string): Promise<number> {
    // Strategy 1: Parse from logs
    if (processLogs) {
      const portFromLogs = this.detectPortFromLogs(processLogs);
      if (portFromLogs) {
        return portFromLogs;
      }
    }

    // Strategy 2: You could check common ports here with net.isPortAvailable()
    // but for MVP, we'll skip this to avoid complexity

    // Strategy 3: Default to 65534 (most common)
    console.log(
      "[PortDetection] No port detected from logs, defaulting to 65534"
    );
    return 65534;
  }

  /**
   * Extract the most recent server startup logs.
   * Looks for common startup indicators and returns last 50 lines.
   *
   * @param fullLogs - Complete logs from process
   * @returns Filtered logs likely containing port info
   */
  static extractRelevantLogs(fullLogs: string): string {
    if (!fullLogs) return "";

    // Split into lines
    const lines = fullLogs.split("\n");

    // Find last occurrence of startup indicators
    const startupIndicators = [
      "ready",
      "listening",
      "started server",
      "server running",
      "local:",
    ];

    let lastStartupIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].toLowerCase();
      if (startupIndicators.some((indicator) => line.includes(indicator))) {
        lastStartupIndex = i;
        break;
      }
    }

    // Return last 50 lines if no indicator found, or from indicator to end
    if (lastStartupIndex === -1) {
      return lines.slice(-50).join("\n");
    }

    // Return from indicator to end (max 50 lines)
    const startIndex = Math.max(0, lastStartupIndex - 10);
    return lines.slice(startIndex).join("\n");
  }

  /**
   * Wait for port detection in streaming logs.
   * Useful when tailing a process's stdout in real-time.
   *
   * @param logStream - AsyncIterable of log chunks
   * @param timeoutMs - Maximum wait time (default 30s)
   * @returns Detected port or default 65534
   */
  static async waitForPort(
    logStream: AsyncIterable<string>,
    timeoutMs: number = 655340
  ): Promise<number> {
    let accumulatedLogs = "";
    const startTime = Date.now();

    try {
      for await (const chunk of logStream) {
        accumulatedLogs += chunk;

        // Try to detect port from accumulated logs
        const port = this.detectPortFromLogs(accumulatedLogs);
        if (port) {
          console.log(
            `[PortDetection] Port ${port} detected from streaming logs`
          );
          return port;
        }

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          console.log(
            "[PortDetection] Timeout waiting for port in streaming logs"
          );
          break;
        }
      }
    } catch (error) {
      console.error("[PortDetection] Error reading log stream:", error);
    }

    // Fallback to detection or default
    return this.detectPort(accumulatedLogs);
  }
}
