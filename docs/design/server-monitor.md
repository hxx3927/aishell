# 服务器资源监控

状态：已实施（v2，仅 Linux；mock 服务器走查通过）
日期：2026-11-06
范围：独立监控标签页 · 总览卡 + 资源详情（CPU / 内存 / 磁盘 / 网络） · 仅 Linux

## 1. 背景

AIShell 当前的主界面由连接栏、终端、文件面板、Agent 面板和状态栏组成：

- 连接栏（252px）按分组列出服务器与连接状态；
- 中央工作区用标签页承载终端、远程文件编辑器和选服务器页；
- 底部文件面板是本地 ⇄ 远程双栏；
- 右侧 Agent 面板承载 Agent 窗口、终端与活动流；
- 状态栏显示连接状态、`user@host:port`、OS、延迟、Agent 状态、MCP 服务、凭据与版本。

现有代码里没有监控界面。可复用的只有：

- `SshManager.exec()`：在已连接会话上执行只读命令；
- 连接时采集的 `HostInfo`（OS、内核、home）；
- 审计快照的采样思路和解析器：`free -m`、`df -hP`、负载、进程数、核心数；
- 每 15 秒一次的延迟探测。

## 2. 目标与非目标

### 目标

1. 一眼看清服务器当前资源水位：CPU、内存、磁盘、网络。
2. 看到最近几分钟的变化趋势，而不是只有一个瞬时数字。
3. 在终端里跑命令时，能同时观察资源变化。
4. 看清 CPU 详情：负载、逻辑处理器，以及占用最高的进程。
5. 有 GPU 的机器（NVIDIA / AMD）能直接看到使用率、显存与温度。
6. 不安装任何远程组件、不需要 root、不新增监听端口。
7. 断线、超时、非 Linux、数据过期都能明确说明，不静默失败。

### 非目标（v2）

- 多服务器总览大盘；
- 持久化历史、导出、告警通知；
- 远程结束进程或调整进程优先级；
- SMART、RAID、ECC、风扇等其余硬件健康信息；
- Intel 核显使用率（内核不提供统一接口，仅识别不展示）；
- GPU 使用率趋势图（v2 只显示当前值）；
- Windows、macOS、BSD 服务器；
- 远程执行写操作（重启、杀进程、清理磁盘等）。

## 3. 交互设计

### 3.1 放置与入口

新增标签页类型 `monitor`，每台服务器最多一个。

入口：

- 连接右键菜单：「打开资源监控」；
- 会话行悬浮操作图标；
- 标题栏 `Activity` 图标，作用于当前服务器；
- 快捷键 `Ctrl+Shift+M`。

监控使用**独立的 SSH 连接**（连接 id 为 `monitor:<sessionId>`），不复用终端连接：

- 终端全部关闭后监控仍可继续采样；
- 关闭监控标签不会打断终端或其他 Agent 窗口；
- 只有同一台服务器的最后一个消费者（终端 / 监控 / Agent）关闭时，才断开这条会话的所有连接。

关闭标签页即停止采样并清除该会话的历史。切到其他标签页时监控组件保持挂载，采样继续，状态栏仍能显示实时指标。

### 3.2 页面布局

采用「总览卡 + 详情切换」：四张 KPI 卡是速览，也是详情区的选择器；详情区一次只展开一种资源，避免首屏塞入多张图。文件系统表始终在详情区下方，因为它是按需查看的完整清单。

```
┌ 服务器名 · Ubuntu 24.04 · 内核 6.8 · 已运行 12 天 4 小时   [2s▾][暂停][刷新][详情] ┐
├───────────────┬───────────────┬───────────────┬───────────────┤
│ CPU 使用率     │ 内存           │ 磁盘           │ 网络           │
│ 23%           │ 62%           │ 68%           │ ↓1.2M ↑86K     │
│ 8 核  ▬▬▬░░   │ 9.8/16 GB     │ /data 82%     │ eth0           │
├───────────────┴───────────────┴───────────────┴───────────────┤
│ [CPU|内存|磁盘|网络]                                    [接口 eth0▾]  │
│ 详情趋势图（固定时间窗）                                  [图表|表格] │
│ 指标网格：速度 / 负载(1/5/15) / 进程 / 线程 / 句柄 / 运行时间          │
│ 逻辑处理器网格（每核仪表条）                                          │
│ GPU（仅有 GPU 时）：使用率 / 显存 / 温度，每块一张小卡                  │
│ 进程 TOP（前 5）：进程 / PID / CPU / 内存          [按 CPU|按内存]      │
├──────────────────────────────────────────────────────────────────────┤
│ 文件系统（按使用率排序，容器挂载默认隐藏）      [容器挂载 9] [表格排序]  │
│ 挂载点  类型  已用/总量  使用率                                       │
│ /      ext4  12/40G   30% ▬▬░                                        │
│ /data  xfs  410/500G  82% ▬▬▬ ⚠                                      │
└──────────────────────────────────────────────────────────────────────┘
```

点击 KPI 卡会把详情区切到对应资源，并给该卡片加选中描边；点击详情页签也会同步卡片选中态，任一时刻只有一张卡处于选中状态。

详情区内容：

| 页签 | 趋势图 | 指标区 |
|---|---|---|
| CPU | CPU 使用率 | 速度、负载（1/5/15 分钟）、进程、线程、句柄、运行时间；逻辑处理器网格；GPU（仅有 GPU 时）；进程 TOP（按 CPU / 按内存切换） |
| 内存 | 内存使用率 | 使用中/总量、可用、已缓存、已提交/上限、交换；内存构成条（使用中/已缓存/空闲） |
| 磁盘 | 读/写吞吐 | 活动时间、IOPS、平均响应、容量使用、块设备数；逐设备读写/活动/IOPS/响应表 |
| 网络 | 选定接口的下行/上行 | 下行、上行、链路速度、累计收发；接口表（物理在前，虚拟标注） |

### 3.3 组件规格

**头部**

- 服务器名、OS、内核、uptime；
- 采样间隔选择：2s（默认）/ 5s / 10s / 30s，存 `localStorage`；
- 暂停/继续、立即刷新；
- 「系统详情」浮层：hostname、CPU 型号、核心数、总内存、接口列表、启动时间。

**KPI 卡片**

| 卡片 | 主值 | 次值 | 图形 | 对应详情 |
|---|---|---|---|---|
| CPU | 使用率 % | 核心数、进程数 | 细仪表条 | CPU |
| 内存 | 使用率 % | 已用/总量、swap（未启用时明示） | 细仪表条 | 内存 |
| 磁盘 | 最高使用率 %（只算宿主挂载点） | 最满挂载点、宿主挂载点数量 | 细仪表条 | 磁盘 |
| 网络 | 下行速率 | 上行速率、接口名 | 无 | 网络 |

卡片整体是按钮：`aria-pressed` 表示选中，标题 11px `text-dim`（v1 的 10px `text-faint` 在浅色下对比不足、看起来像被遮挡），标题与告警标记都 `shrink-0` / `truncate`，窄卡片下不会互相挤压。

仪表条：4px 高，轨道是同状态色约 15% 透明度，填充色按阈值切换（<70% 正常、70–90% 警告、>90% 危险）。阈值状态必须同时有图标或文字，不能只靠颜色。

**详情趋势图**

- 每种资源一张图，不把不同量纲塞进双轴；
- 时间窗固定：`max(60 秒, 采样间隔 × 30)`，窗口从左到右稳定填充，不再出现「近 11 秒」这种被两点撑满的横轴；
- 2px 线、10% 面积填充、1px 实线网格、图例 + 末端当前值；
- 悬停显示十字线和时间点数值；键盘聚焦也能读到同样信息；
- 每张图提供「表格」视图，列出最近样本，保证数值不只存在于 tooltip 里。

**Windows 任务管理器性能页的指标映射**

| Windows | Linux 来源 | 展示位置 |
|---|---|---|
| 速度（GHz） | `/proc/cpuinfo` 的 `cpu MHz` 均值 | CPU 指标「速度」 |
| 系统负载 | `/proc/loadavg` 前三个数（1/5/15 分钟） | CPU 指标「负载（1/5/15 分钟）」 |
| 线程数 | `/proc/loadavg` 的 `running/total tasks` | CPU 指标「线程」 |
| 句柄数 | `/proc/sys/fs/file-nr` 第一列 | CPU 指标「句柄（打开文件）」 |
| 逻辑处理器网格 | `/proc/stat` 的 `cpu0…cpuN` | CPU 详情逐核仪表条 |
| 进程占比 | `/proc/<pid>/stat` 的 utime+stime 增量 + RSS | CPU 详情「进程 TOP」 |
| GPU 使用率/显存 | `nvidia-smi` 查询或 amdgpu sysfs | CPU 详情「GPU」区块 |
| 使用中/已缓存/可用 | `MemTotal − MemAvailable`、`Buffers + Cached + SReclaimable` | 内存构成条与指标 |
| 已提交/上限 | `Committed_AS / CommitLimit` | 内存指标「已提交」 |
| 磁盘活动时间 | `/proc/diskstats` 第 10 字段增量 / 采样间隔 | 磁盘指标「活动时间」 |
| 磁盘响应时间 | `Δio_ms / ΔIOPS` | 逐设备「响应」 |
| 磁盘读写速率 | 512 字节扇区增量 / 采样间隔 | 磁盘趋势与逐设备表 |
| 网络链路速度 | `/sys/class/net/<if>/speed`（Mbps） | 网络「链路速度」 |

**文件系统表**

- 列：挂载点、文件系统、已用/总量、使用率；
- 按使用率降序，挂载点完整路径通过 `title` 悬浮显示；
- 过滤 `/proc`、`/sys`、`/dev`、`/run` 下的伪挂载和 `tmpfs`、`devtmpfs`、`squashfs`；
- Docker/containerd/Kubernetes 的 overlay 与运行时挂载仍然保留，但标为容器挂载：默认隐藏，表头按钮「容器挂载 N」可展开，再点「隐藏容器挂载」收起；
- 超过 90% 显示警告图标和文字；
- 挂载点超过 8 个时显示前 8 个，其余折叠为「还有 N 个」。

**状态栏联动**

监控页打开期间，状态栏显示 `CPU 23% · MEM 62%`，点击回到监控标签页。关闭监控页后消失，不常驻采样。

### 3.4 状态

| 场景 | 表现 |
|---|---|
| 未连接 | 服务器信息 + 「连接并开始监控」按钮，不静默建连 |
| 连接中 / 首个样本未到 | 骨架屏，保持最终布局，避免跳动 |
| 采样失败但有过数据 | 保留最后一次数据，整体降到 60% 透明度；顶部提示「数据可能已过期 · 12 秒前 · 重试」 |
| 暂停 | 顶部「已暂停」横幅 + 继续按钮 |
| 连接断开 | 保留标签与历史，顶部横幅「连接已断开，保留最后一次数据」+ 重新连接按钮，内容降到 60% 透明度；重连成功后继续采样 |
| 系统不支持 | 显示主机信息 + 「当前仅支持 Linux 服务器」 |
| 部分探测失败 | 成功字段正常显示，失败卡片显示「—」，顶部汇总错误 |

### 3.5 响应式

中央工作区在两侧面板都展开、窗口最小时可能只有约 470px 宽。

| 可用宽度 | KPI | 详情指标网格 | 文件系统表 |
|---|---|---|---|
| ≥900px | 4 列 | 5 列 | 单列，横向滚动 |
| 768–900px | 2 列 | 3 列 | 单列，横向滚动 |
| <768px | 2 列 | 2 列 | 单列，横向滚动 |

详情区和文件系统表始终单列；趋势图随容器宽度缩放，指标网格与接口表允许横向滚动，不裁剪列内容。KPI 卡内边距随宽度收紧。

### 3.6 视觉规范

沿用现有深/浅主题 token。图表新增两个专用色，不复用 `accent-2`：

| 用途 | 深色（面板 `#1c1c1e`） | 浅色（面板 `#ffffff`） |
|---|---|---|
| 系列 1：CPU / 下行 | `#0a84ff` | `#0071e3` |
| 系列 2：内存 / 上行 | `#d97706` | `#c2410c` |

这两组值已通过 dataviz 校验脚本：亮度带、色度下限、CVD 色差、正常视觉色差、对比度全部通过。

现有 `accent-2 #5e5ce6` 与主蓝的色差不足（深色 10.5、浅色 8.1；浅色 deutan 模拟仅 3.1），不能作为第二根线。

其他规则：

- 曲线颜色只用于线和面积；数值、图例、轴文字使用文本色 token；
- 状态色 `ok / warn / err` 只表示阈值状态，不参与系列配色；
- KPI 大数字用比例数字，表格和坐标轴用 `tabular-nums`；
- 网格、坐标轴为 1px 实线、低对比度，不用虚线；
- 面积填充不超过 10% 不透明度。

## 4. 数据设计

### 4.1 采样

主进程每个周期只发一次 `exec`，用段落标记一次取回全部数据：

```sh
LC_ALL=C sh -c '
echo @@load; cat /proc/loadavg
echo @@uptime; cut -d" " -f1 /proc/uptime
echo @@mem; cat /proc/meminfo
echo @@cpu1; grep "^cpu" /proc/stat
sleep 0.25
echo @@cpu2; grep "^cpu" /proc/stat
echo @@disk; df -P -k
echo @@net; cat /proc/net/dev
echo @@procs; ls -d /proc/[0-9]* 2>/dev/null | wc -l
echo @@freq; grep "^cpu MHz" /proc/cpuinfo 2>/dev/null
echo @@fds; cat /proc/sys/fs/file-nr 2>/dev/null
echo @@diskio; cat /proc/diskstats 2>/dev/null
echo @@links; for i in /sys/class/net/*; do n=$(basename "$i"); echo "$n $(cat "$i/speed" 2>/dev/null)"; done
echo @@procstat; awk '...' /proc/[0-9]*/stat 2>/dev/null
# 仅当主机探测到 nvidia-smi 时才追加：
echo @@nvidia; nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null
echo @@amdgpu; for d in /sys/class/drm/card[0-9]*; do ... echo "amd|$n|$b|$mu|$mt|$t"; done
'
```

`/proc/<pid>/stat` 由一条 `awk` 扫描全部进程，输出 `pid|comm|ticks|rssPages`（`comm` 可含空格，所以用 `|` 分隔）；不额外起进程、不读 `cmdline`。`nvidia-smi` 是否执行由开启监控时的一次能力探测决定，避免在无 GPU 的机器上每 2 秒 fork 一次。

主机静态信息在采样开始时单独取一次：

```sh
LC_ALL=C sh -c '
echo @@hostname; hostname 2>/dev/null
echo @@os; grep "^PRETTY_NAME=" /etc/os-release 2>/dev/null | head -1
echo @@kernel; uname -sr 2>/dev/null
echo @@cpu; grep -m1 "^model name" /proc/cpuinfo 2>/dev/null
echo @@memtotal; grep "^MemTotal:" /proc/meminfo 2>/dev/null
echo @@caps; echo clk:$(getconf CLK_TCK ...); echo page:$(getconf PAGESIZE ...); command -v nvidia-smi >/dev/null 2>&1 && echo gpu:nvidia
'
```

`@@caps` 只取一次：`CLK_TCK` 用于把进程 tick 换算成 CPU%，`PAGESIZE` 用于把 RSS 页数换算成字节，`gpu:nvidia` 决定后续采样是否包含 `nvidia-smi`。

约束：

- 命令必须加 `LC_ALL=C`，避免本地化输出；
- 只读，不使用 `sudo`；
- `sleep 0.25` 用于计算两次 `/proc/stat` 的增量，避免使用开机以来的平均值；
- 单次超时 8 秒；如果上一次还没返回，跳过本周期，不排队；
- 失败后退避 2 → 4 → 8 → 16 → 30 秒，成功后恢复。

### 4.2 数据结构

```ts
export interface MonitorHost {
  hostname: string
  os?: string
  kernel?: string
  cpuModel?: string
  cores: number
  totalMemBytes: number
  interfaces: string[]
  bootedAt: number
}

export interface MonitorDisk {
  fs: string
  mount: string
  sizeBytes: number
  usedBytes: number
  availBytes: number
  usePct: number
  /** overlay / 容器运行时挂载，文件系统表默认隐藏。 */
  container?: boolean
}

export interface MonitorNet {
  iface: string
  rxBps: number
  txBps: number
  rxBytes: number
  txBytes: number
  /** sysfs 报告的链路速度（bit/s）；驱动不报告时缺失。 */
  speedBps?: number
}

/** 逐块设备速率，由相邻两次 /proc/diskstats 求差。 */
export interface MonitorDiskIo {
  dev: string
  readBps: number
  writeBps: number
  iops: number
  /** 采样间隔内有 I/O 在途的时间占比，0–100。 */
  activePct: number
  /** 近似平均响应时间（ms）。 */
  awaitMs: number
}

/** GPU：nvidia-smi 或 amdgpu sysfs 报告的当前值。 */
export interface MonitorGpu {
  vendor: 'nvidia' | 'amd'
  name: string
  /** 利用率 0–100；驱动不提供时为 undefined。 */
  utilPct?: number
  memUsedBytes?: number
  memTotalBytes?: number
  tempC?: number
}

/** 进程表中的一行。 */
export interface MonitorProcess {
  pid: number
  name: string
  /** 采样间隔内的瞬时占比，可超过 100（多核）。 */
  cpuPct: number
  /** 常驻内存（RSS），字节。 */
  memBytes: number
}

export interface MonitorSample {
  sessionId: string
  ts: number
  cpuPct: number
  perCorePct: number[]
  load: [number, number, number]
  cores: number
  processCount: number
  threadCount?: number
  openFds?: number
  cpuMhz?: number
  uptimeSec: number
  memTotalBytes: number
  memUsedBytes: number
  memAvailableBytes: number
  memCachedBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
  memCommittedBytes?: number
  memCommitLimitBytes?: number
  disks: MonitorDisk[]
  net: MonitorNet[]
  diskIo: MonitorDiskIo[]
  /** 只在检测到受支持 GPU 时存在。 */
  gpus?: MonitorGpu[]
  /** CPU 前 8 与内存前 8 的并集；无数据时缺失。 */
  processes?: MonitorProcess[]
}

export interface MonitorEvent {
  sessionId: string
  sampling: boolean
  paused: boolean
  host?: MonitorHost
  sample?: MonitorSample
  error?: string
}
```

### 4.3 解析与计算

| 指标 | 来源 | 计算 |
|---|---|---|
| CPU% | `/proc/stat` 两次 | `100 × (1 − Δidle / Δtotal)`；idle 含 iowait |
| 每核 | `cpu0…cpuN` | 同上，逐核计算 |
| 内存 | `/proc/meminfo` | 已用 = `MemTotal − MemAvailable`；缓存 = Buffers + Cached + SReclaimable |
| Swap | `/proc/meminfo` | `SwapTotal − SwapFree` |
| 磁盘 | `df -P -k` | 每行解析；挂载点含空格时合并剩余列 |
| 网络 | `/proc/net/dev` | 跳过 `lo`；速率 = 本次计数 − 上次计数 / 时间差 |
| 链路速度 | `/sys/class/net/<if>/speed` | Mbps × 10⁶；空值/0 视为未知 |
| 磁盘 I/O | `/proc/diskstats` | 只保留整块设备（`sd*/hd*/vd*/xvd*/nvme*n*/mmcblk*`），排除分区、loop、dm |
| 磁盘活动 | `/proc/diskstats` 第 10 字段 | `Δio_ms / Δt`，上限 100% |
| 磁盘响应 | `/proc/diskstats` | `Δio_ms / Δ(reads + writes)`；无操作时显示「—」 |
| 进程数 | `/proc/[0-9]*` | 行数 |
| 线程数 | `/proc/loadavg` | 第 4 字段 `running/total` 的 total |
| 打开句柄 | `/proc/sys/fs/file-nr` | 第一列 |
| CPU 频率 | `/proc/cpuinfo` | 所有 `cpu MHz` 取平均 |
| 已提交内存 | `/proc/meminfo` | `Committed_AS`、`CommitLimit` |
| 进程 CPU% | `/proc/<pid>/stat` utime+stime | `Δticks / CLK_TCK / Δt × 100`；一次 `awk` 扫全部进程 |
| 进程内存 | `/proc/<pid>/stat` 第 24 字段 | RSS 页数 × `PAGESIZE` |
| 进程 TOP | 上述结果 | 按 CPU 取前 8、按内存取前 8 合并去重，渲染层显示前 5 |
| GPU（NVIDIA） | `nvidia-smi --query-gpu` | 利用率 %、显存 MiB → 字节、温度 °C；`[N/A]` 视为缺失 |
| GPU（AMD） | `/sys/class/drm/card*/device/` | `gpu_busy_percent`、`mem_info_vram_used/total`、hwmon `temp1_input`（毫摄氏度） |
| uptime | `/proc/uptime` | 第一个浮点数 |

边界：

- 计数器回绕或重置导致差值为负时，速率按 0 处理，并重置基线；
- `Δtotal = 0` 时 CPU% 取上一次有效值或 0；
- 内存字段缺失（容器）按 0 显示并标记不完整；`Committed_AS` 缺失时指标显示「—」；
- 挂载点去重，同一设备重复挂载只保留一个；
- 容器判断：`overlay` 且挂载点不是 `/`，或挂载点位于 `/var/lib/docker`、`/var/lib/containerd`、`/var/lib/kubelet`、`/var/lib/rancher`、`/run/containerd`、`/run/k3s` 之下；
- 网络主接口优先选物理网卡（排除 `lo/docker/veth/br-/virbr/tun/tap/wg/cni/flannel/cali/kube-/vxlan/dummy`），有流量按实时速率排序，否则按累计字节排序；只有全部是虚拟接口时才回退到虚拟接口；
- 进程第一次出现时没有基线，CPU% 记 0，从第二个样本开始准确；进程消失后其基线随下一轮扫描丢弃；
- 进程名取内核的 `comm`（上限 15 字节），不额外读 `cmdline`；
- 没有 GPU、驱动不暴露使用率（如部分虚拟 GPU）时不显示 GPU 区块；`[N/A]` 数值显示为「—」；
- 多 GPU（`nvidia-smi` 多行 / 多个 amdgpu card）每块一张卡，两列网格；超过 8 块只显示前 8 块并标注总数；NVIDIA 与 AMD 同时存在时分别列出，不会重复计数；
- `nvidia-smi` 只在能力探测发现它时执行；AMD 分支只读 sysfs，在非 AMD 机器上是空 glob，几乎无成本。

### 4.4 生命周期

```
打开监控标签
  ├─ 会话已连接 → 在 monitor:<sessionId> 专用连接上 monitor.start
  └─ 会话未连接 → 显示 CTA，不静默建连
monitor.start
  ├─ 建立/复用专用连接，采集静态主机信息
  ├─ 生成空历史并立即采样一次
  ├─ 启动定时器，事件推送到渲染进程
  └─ 返回 { host, history, intervalMs, paused, error }
切换标签 → 组件保持挂载，采样继续
关闭监控标签
  ├─ 同服务器仍有终端/Agent → 仅 monitor.stop，会话保持连接
  └─ 最后消费者 → endSessionConnection：停止监控、停止 Agent、断开 SSH
关闭终端标签 → 仍有监控/Agent 时不断开连接
显式断开连接 → 先 monitor.pause(true)，保留监控标签与历史
应用退出 / 渲染进程重载 → monitor.stopAll()
```

同一会话只允许一个采样器；重复 `start` 复用现有实例并返回当前历史。`start` 的返回值里带 `paused` 和 `error`，因为首个样本失败是在轮询内部发生的，渲染进程需要靠它们判断是「采样中」还是「错误」。

`monitor.pause(sessionId, false)` 会被重复调用一次以确保恢复：暂停状态由主进程持有，渲染进程重载后两者可能不一致。

## 5. 技术架构

### 5.1 模块

```
src/main/monitor/MonitorService.ts   轮询、退避、生命周期
src/main/monitor/parse.ts            纯解析函数，便于单测
src/main/monitor/compute.ts          速率、CPU% 与 top-N 计算，纯函数
src/shared/types.ts                  MonitorHost / MonitorSample / MonitorEvent
src/shared/api.ts                    monitor.start / stop / pause / sampleNow / history
src/main/ipc.ts                      IPC handler
src/main/index.ts                    实例化与退出清理
src/preload/index.ts                 暴露 window.aishell.monitor
src/renderer/src/components/MonitorView.tsx   头部、KPI 卡、状态横幅、标签联动
src/renderer/src/components/monitor/   DetailPanel、TrendChart、DiskTable、Meter、format
src/renderer/src/state/store.ts       标签页类型、监控状态与历史
src/renderer/src/App.tsx              渲染 monitor 标签、事件订阅
src/renderer/src/components/TabBar.tsx
src/renderer/src/components/Sidebar.tsx
scripts/mock-ssh-server.mjs          返回可波动的模拟指标
scripts/test-monitor-parse.mts       解析器测试
scripts/test-monitor-compute.mts     速率与进程计算测试
```

### 5.2 IPC

```ts
monitor:start(sessionId, intervalMs) -> { host, history, intervalMs, paused, error? }
monitor:stop(sessionId)
monitor:stopAll()
monitor:pause(sessionId, paused)
monitor:sampleNow(sessionId) -> MonitorSample
monitor:sample 事件 -> MonitorEvent
```

采样数据不经过 settings，也不写入磁盘。

### 5.3 渲染进程状态

```ts
interface MonitorState {
  status: 'idle' | 'starting' | 'sampling' | 'paused' | 'error' | 'disconnected'
  host?: MonitorHost
  samples: MonitorSample[] // 最多 450
  intervalMs: number
  lastError?: string
  lastSampleAt?: number
}
```

按 `sessionId` 存储。事件到达时追加样本并裁剪到 450 条。

### 5.4 与现有代码的集成点

1. **专用连接**（`monitorConnId()` / `isMonitorConn()`，[monitor.ts](../../src/shared/monitor.ts)）承载全部探测，不占用终端连接，探测定时器也不会因为终端关闭而中断。
2. **关闭最后一个终端标签**（[store.ts](../../src/renderer/src/state/store.ts) 的 `closeTabNow`）把监控标签计入「连接仍在使用」；关闭最后一个监控标签时则调用 `endSessionConnection`，连同 Agent 与 SSH 一起收尾。
3. **侧边栏单击**优先找终端标签，其次任意同会话标签（监控）；双击仍然新建终端。
4. **App 的标签渲染**把 `monitor` 当作常驻挂载的标签，隐藏时不卸载；事件订阅只处理 `monitor:` 连接，不对它做延迟探测或断线 toast。
5. **活动会话回退**：关闭当前监控标签时，`activeSessionId` 回退到下一个标签或 Agent 上下文。
6. **显式断开连接**（`sessionActions.disconnectSession`）先暂停监控再断开，监控标签保留为「已断开」状态，由用户点「重新连接」恢复。
7. **TabBar**：标签图标使用 `Activity`，标题为服务器名 + 「监控」。

## 6. 安全与边界

- 探测命令全部只读；
- 不使用 `sudo`，不安装软件，不修改服务器；
- 不新增监听端口，数据只在本机内存中；
- **不写审计日志**：高频只读探测不是 Agent 操作，写入会淹没 JSONL 并产生大量「未完成」记录；
- 明确提示容器/cgroup 场景下 `/proc` 可能反映宿主限制，而不是容器配额；
- 非 Linux 服务器显示「暂不支持」，不做不完整的猜测解析。

## 7. 实施计划

### 阶段 1：采集与数据层

- `MonitorService` + `parse.ts`；
- 共享类型、IPC、preload；
- 环形缓冲、速率差分、退避、暂停/恢复；
- 进程扫描、GPU 探测、能力探测（CLK_TCK / PAGESIZE / nvidia-smi）；
- mock SSH 服务器支持探测脚本（`MOCK_GPU=1` 时可模拟 NVIDIA GPU）；
- 解析器单元测试。

### 阶段 2：界面

- 监控标签页与入口；
- 头部、四张 KPI 卡片、资源详情、文件系统表；
- 全部空/错/暂停/断开状态；
- 深/浅色和响应式。

### 阶段 3：联动与收尾

- 状态栏 CPU/内存摘要；
- 关闭标签、断开重连、关闭最后一个终端等边界；
- 文档、验证清单、真实 Linux 服务器走查。

## 8. 验证清单

- [x] `npm run typecheck`、`npm run build` 通过；
- [x] 解析器测试覆盖 Ubuntu/容器样本、`df` 多挂载/含空格挂载点、容器挂载标记、线程/句柄/频率、已提交内存、`/proc/diskstats` 过滤与字段映射、链路速度、进程行、NVIDIA/AMD GPU、能力探测、非 Linux 拒绝（41 项断言）；
- [x] 计算测试覆盖首样本零速率、计数器回绕、扇区转字节、活跃率上限、CPU tick 差分与舍入、top-N 并集、采样间隙后基线清空、历史裁剪（33 项断言）；
- [x] mock 服务器上四项 KPI、四个详情页签、文件系统表都有数据且随时间变化；
- [x] 详情页签切换、KPI 卡点选联动、CPU 逐核网格、内存构成条、磁盘逐设备 I/O 表、网络接口切换均正常；
- [x] 网络卡默认选物理接口 `eth0`，不再出现 `docker0 · 0 B/s`；切换到虚拟接口后卡片与图表同步，并标注「虚拟」；
- [x] 文件系统表默认隐藏容器 overlay 挂载，可展开/收起；挂载点完整路径可悬浮查看；
- [x] 趋势图时间窗固定，首分钟不再显示「近 11 秒」；样本从右向左填充；
- [x] 未连接时显示 CTA，连接成功后开始采样；不会静默建连；
- [x] 显式断开时保留监控标签与最后数据；点「重新连接」后继续采样；
- [x] 关闭终端标签但保留监控标签时，采样不中断；
- [x] 关闭监控标签但终端仍在时，只停止采样，会话保持连接；
- [x] 切到终端标签再切回，趋势图连续、无重复采样器；
- [x] 暂停/继续、2s→5s 切换后采样节奏符合预期；
- [x] 1100px 窗口下卡片换行为 3 列、指标网格收为 3 列，无溢出、无遮挡；
- [x] 深色/浅色下曲线和阈值色可读；悬停十字线、tooltip、表格视图正常；
- [x] CPU 详情显示负载（1/5/15 分钟），进程 TOP 按 CPU / 按内存切换排序正确，进程名含空格时不被截断；
- [x] 无 GPU 的机器不出现 GPU 区块；`MOCK_GPU=1` 时 GPU 区块显示使用率、显存与温度；
- [x] 监控采样不产生审计日志（活动列表为空）；
- [ ] 真实 Linux 服务器的 CPU、内存、磁盘、网络数值与 `top` / `free` / `df` / `sar` 基本一致（只在阿里云服务器截图上核对过接口与挂载点问题，未做数值对照）；
- [ ] 应用退出后无残留定时器或 SSH 通道（代码路径已覆盖，未单独做进程级验证）。

## 9. 风险与后续

| 风险 | 处理 |
|---|---|
| 不同发行版 `/proc`、`df` 输出差异 | `LC_ALL=C`、纯解析函数、fixture 单测、部分失败降级 |
| BusyBox / 精简系统缺少 `sleep` 等命令 | 探测失败时显示错误；v1 不承诺覆盖所有精简系统 |
| 容器内 CPU/内存配额不准确 | 界面注明；后续可读取 cgroup v2 作为补充 |
| 挂载点很多导致表格过长 | 容器挂载默认隐藏；宿主挂载点超过 8 个时折叠 |
| 高频 exec 增加 SSH 通道压力 | 2s 起、单在途、关闭标签即停、失败退避 |
| 网络/接口数量过多 | 默认跟随主物理接口；详情页可切换接口，表格物理在前 |
| `/proc/diskstats` 在虚拟化/云盘上可能不完整 | 无数据时磁盘 I/O 区显示空表；容量信息来自 `df`，不受影响 |
| 进程很多时 awk 扫描拖慢采样 | 只读 `stat`、单条 awk；实测数百进程约几十毫秒，包含在 8 秒超时内 |
| `nvidia-smi` 启动较慢或驱动异常 | 只在能力探测命中时调用，输出为空则视为无数据，不影响其他指标 |
| 云厂商 vGPU 不暴露利用率 | 显示「—」，不伪造数值 |

后续版本：

1. 阈值配置与本机通知；
2. 历史持久化与 CSV/JSONL 导出；
3. 多服务器总览；
4. GPU 使用率趋势图与 Intel 核显（需要额外接口）；
5. 温度、SMART 等需要额外工具或权限的指标。
