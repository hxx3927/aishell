/**
 * Monitoring owns a dedicated SSH connection per session. Keeping it separate
 * from terminal tabs means closing a terminal cannot stop sampling, and the
 * monitor tab does not depend on which terminal instance happens to be open.
 */
export const MONITOR_CONN_PREFIX = 'monitor:'

export function monitorConnId(sessionId: string): string {
  return `${MONITOR_CONN_PREFIX}${sessionId}`
}

export function isMonitorConn(connId: string): boolean {
  return connId.startsWith(MONITOR_CONN_PREFIX)
}
