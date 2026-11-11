import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * 网卡枚举与智能选择：解决多网卡（以太网 + 无线 + VMware/虚拟网卡 + 蓝牙）下
 * 选错网卡导致局域网发现/通信失效的问题。
 *
 * 策略（自动检测 + 手动指定兜底）：
 *  1. 枚举所有非内部 IPv4 网卡，附带「是否虚拟/无用」「是否 APIPA 链路本地」标记。
 *  2. 通过系统路由表反查「默认网关所在网卡」，优先选它（真实联网的那张）。
 *  3. 无默认网关时，按「非 APIPA 私有地址 > 非虚拟网卡」排序取第一个。
 *  4. 用户可在 UI 手动指定某个网卡 IP，覆盖自动结果（持久化，见 LanStore settings）。
 */

export interface NetInterface {
  name: string; // 网卡名（如 "WLAN" / "以太网" / "VMware Network Adapter VMnet1"）
  address: string; // IPv4
  netmask: string;
  mac: string;
  family: string;
  internal: boolean;
  /** 虚拟/无实际用途的网卡（VMware / VirtualBox / Hyper-V / Tailscale 等） */
  virtual: boolean;
  /** 169.254.x 链路本地地址（未拿到 DHCP，通常代表「网线插着但没网」） */
  apipa: boolean;
}

/** 判定 APIPA 链路本地地址 169.254.0.0/16 */
function isApipa(ip: string): boolean {
  return ip.startsWith('169.254.');
}

/** 判定虚拟网卡（名字含这些关键字则视为虚拟，不参与自动选择） */
function isVirtualName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('vmware') ||
    lower.includes('virtualbox') ||
    lower.includes('hyper-v') ||
    lower.includes('vbox') ||
    lower.includes('tailscale') ||
    lower.includes('zerotier') ||
    lower.includes('wsl') ||
    lower.includes('loopback') ||
    lower.includes('vethernet') ||
    lower.includes('tunnel') ||
    lower.includes('vpn') ||
    lower.includes('docker') ||
    lower.includes('vsw') ||
    lower.includes('蓝牙') ||
    lower.includes('bluetooth')
  );
}

/** 获取所有非内部 IPv4 网卡（含虚拟/APIPA 标记） */
export function listInterfaces(): NetInterface[] {
  const out: NetInterface[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push({
        name,
        address: iface.address,
        netmask: iface.netmask,
        mac: iface.mac,
        family: iface.family,
        internal: false,
        virtual: isVirtualName(name),
        apipa: isApipa(iface.address),
      });
    }
  }
  return out;
}

/**
 * 反查默认网关所在的网卡 IP（Windows：解析 `route print -4` 的 0.0.0.0 默认路由，
 * Interface 列即该网卡的 IPv4）。失败返回 null。
 */
export function defaultGatewayIp(): string | null {
  try {
    const output = execFileSync('route', ['print', '-4'], { encoding: 'utf8', timeout: 3000 });
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      // 找默认路由：Network Destination=0.0.0.0 且 Netmask=0.0.0.0
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[0] === '0.0.0.0' && parts[1] === '0.0.0.0') {
        // 列：0.0.0.0 0.0.0.0 <Gateway> <Interface> <Metric>
        if (parts[2] !== 'On-link' && isPrivate(parts[3])) return parts[3];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 智能选网卡：默认网关网卡优先，否则按「非 APIPA 且非虚拟」+「私有地址」排序。
 * 返回选中网卡；无可用返回 null。
 */
export function selectBestInterface(prefer?: string): NetInterface | null {
  const all = listInterfaces();

  // 手动指定优先
  if (prefer) {
    const hit = all.find((i) => i.address === prefer || i.name === prefer);
    if (hit) return hit;
  }

  // 默认网关网卡优先
  const gw = defaultGatewayIp();
  if (gw) {
    const hit = all.find((i) => i.address === gw);
    if (hit) return hit;
  }

  // 打分排序：非 APIPA 私有 > 非虚拟 > 其它
  const scored = all
    .map((i) => {
      let score = 0;
      if (!i.virtual) score += 100;
      if (!i.apipa) score += 200;
      if (isPrivate(i.address)) score += 50;
      return { i, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.i ?? null;
}

/** 10.x / 172.16-31.x / 192.168.x 私有地址 */
function isPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

/** 用选择逻辑取本机「正确的」局域网 IPv4（自动） */
export function primaryIp(): string {
  return selectBestInterface()?.address ?? '127.0.0.1';
}
