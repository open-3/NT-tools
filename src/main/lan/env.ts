/**
 * 惰性访问 electron 的 app 路径，避免在纯 Node 测试环境下 eager import electron
 * （plain node 下 `require('electron')` 会触发 install shim 报错）。
 *
 * 测试可设 env 覆盖，绕过 electron：
 *  - AGENT_PULSE_LAN_DB       覆盖 userData 下的 lan.db 路径
 *  - AGENT_PULSE_LAN_ID_DIR   覆盖 userData 路径（identity 存 lan-id.txt）
 *  - AGENT_PULSE_DOWNLOAD_DIR 覆盖下载目录（接收文件默认保存目录）
 */

let _app: typeof import('electron').app | null = null;

function getApp(): typeof import('electron').app {
  if (!_app) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron');
    _app = electron.app;
  }
  return _app;
}

/** userData 目录（%APPDATA%\agent-pulse）。测试用 AGENT_PULSE_LAN_ID_DIR 覆盖。 */
export function userDataPath(): string {
  if (process.env.AGENT_PULSE_LAN_ID_DIR) return process.env.AGENT_PULSE_LAN_ID_DIR;
  return getApp().getPath('userData');
}

/** 下载目录（接收文件默认保存父目录）。测试用 AGENT_PULSE_DOWNLOAD_DIR 覆盖。 */
export function downloadsPath(): string {
  if (process.env.AGENT_PULSE_DOWNLOAD_DIR) return process.env.AGENT_PULSE_DOWNLOAD_DIR;
  return getApp().getPath('downloads');
}
