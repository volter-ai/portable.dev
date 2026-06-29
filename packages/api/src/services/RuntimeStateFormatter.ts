import type { ProcessTrackerService } from './ProcessTrackerService.js';
import type { TunnelService } from './TunnelService.js';

/**
 * RuntimeStateFormatter
 *
 * Formats runtime state (processes, tunnels) for inclusion in system prompts.
 * Helps Claude make informed decisions about reusing existing resources.
 */
export class RuntimeStateFormatter {
  /**
   * Format runtime state for a specific repository
   *
   * @param userId - User ID to filter resources
   * @param repoPath - Repository path to scope the information
   * @param services - Required services (tunnelService, processTrackerService)
   * @returns Formatted markdown string with process history and active tunnels
   */
  static async formatRuntimeStateForRepo(
    userId: string,
    repoPath: string,
    services: {
      tunnelService: TunnelService;
      processTrackerService: ProcessTrackerService;
    }
  ): Promise<string> {
    const { tunnelService, processTrackerService } = services;

    // Get process history for this repo (last 10)
    const allProcesses = processTrackerService.getAllProcesses();
    const repoProcesses = allProcesses
      .filter((p) => p.userId === userId && p.repoPath === repoPath)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10);

    // Get tunnels for this repo
    const allTunnels = tunnelService.getUserTunnels(userId);
    const repoTunnels = allTunnels.filter((t) => t.createdByRepoPath === repoPath);

    // Check which tunnels are actually active (port listening)
    const activeTunnels = [];
    for (const tunnel of repoTunnels) {
      const isActive = await tunnelService.isPortActive(tunnel.port);
      if (isActive) {
        activeTunnels.push(tunnel);
      }
    }

    // Build markdown sections
    const sections: string[] = [];

    // Section 1: Process History
    if (repoProcesses.length > 0) {
      sections.push('## Process History for this Project\n');
      sections.push('Recent process runs (last 10):\n');

      repoProcesses.forEach((proc, index) => {
        const statusIcon =
          proc.status === 'running' ? '▶' : proc.status === 'completed' ? '✓' : '✗';
        const statusText = proc.status.toUpperCase();
        const timeAgo = RuntimeStateFormatter.formatTimeAgo(Date.now() - proc.startedAt);
        const chatInfo = proc.chatId ? ` (chat: ${proc.chatId.slice(0, 8)})` : '';
        const description = proc.description || proc.command;

        sections.push(
          `${index + 1}. ${statusIcon} ${description} - ${statusText} (${timeAgo})${chatInfo}\n`
        );

        // For non-running processes, show the restart command
        if (proc.status !== 'running' && proc.command) {
          sections.push(`   → To restart: ${proc.command}\n`);
        }
      });

      sections.push('\n');
    }

    // Section 2: Active Tunnels
    if (activeTunnels.length > 0) {
      sections.push('## Active Tunnels for this Project\n\n');
      sections.push('| Port | Tunnel URL |\n');
      sections.push('|------|------------|\n');

      activeTunnels.forEach((tunnel) => {
        sections.push(`| ${tunnel.port} | ${tunnel.url} |\n`);
      });

      sections.push(
        '\n**IMPORTANT**: These tunnels are already running with active listeners. Reuse them instead of creating new tunnels.\n'
      );
    }

    // If we have any sections, wrap them with a header
    if (sections.length > 0) {
      return ['\n---\n', '# Current Runtime State\n\n', ...sections, '---\n'].join('');
    }

    // No runtime state to report
    return '';
  }

  /**
   * Format time duration in human-readable format
   *
   * @param ms - Milliseconds elapsed
   * @returns Human-readable string (e.g., "5 min ago", "2 hours ago")
   */
  private static formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} min ago`;
    } else {
      return 'just now';
    }
  }
}
