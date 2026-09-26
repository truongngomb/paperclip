import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Process metadata for a running postgres.exe, as reported by the OS. */
export interface StalePostgresProcessInfo {
  pid: number;
  parentPid: number | null;
  commandLine: string | null;
  executablePath: string | null;
}

export type StaleEmbeddedPostgresReapReason = "cluster-data-dir" | "orphaned-child" | "port-owner";

export interface StaleEmbeddedPostgresReapEntry {
  pid: number;
  reason: StaleEmbeddedPostgresReapReason;
}

export interface StaleEmbeddedPostgresReapResult {
  reaped: StaleEmbeddedPostgresReapEntry[];
}

export interface StaleEmbeddedPostgresReaperLog {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface StaleEmbeddedPostgresReaperOptions {
  dataDir: string;
  port?: number;
  platform?: NodeJS.Platform;
  log?: StaleEmbeddedPostgresReaperLog;
  enumeratePostgresProcesses?: () => Promise<StalePostgresProcessInfo[]>;
  enumeratePortOwners?: (port: number) => Promise<number[]>;
  killProcessTree?: (pid: number) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  settleDelayMs?: number;
}

const silentLog: StaleEmbeddedPostgresReaperLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const normalizeProcessText = (value: string): string => value.replace(/"/g, "").replace(/\\/g, "/").toLowerCase();

const isEmbeddedPostgresBinary = (proc: StalePostgresProcessInfo): boolean => {
  const combined = `${proc.executablePath ?? ""} ${proc.commandLine ?? ""}`;
  const normalized = normalizeProcessText(combined);
  return (
    normalized.includes("@embedded-postgres") ||
    normalized.includes("embedded-postgres") ||
    normalized.includes("paperclip") ||
    normalized.includes("node_modules")
  );
};

const referencesDataDirectory = (proc: StalePostgresProcessInfo, dataDir: string): boolean => {
  const combined = `${proc.executablePath ?? ""} ${proc.commandLine ?? ""}`;
  return normalizeProcessText(combined).includes(normalizeProcessText(dataDir));
};

const isForkChild = (proc: StalePostgresProcessInfo): boolean =>
  proc.commandLine !== null && normalizeProcessText(proc.commandLine).includes("--forkchild");

/**
 * Windows keeps a PostgreSQL cluster's shared memory block alive until every
 * postgres.exe of that cluster has exited, so an unclean server shutdown that
 * kills the postmaster but strands worker children makes every later
 * `postgres -D <dataDir>` fail with "pre-existing shared memory block is still
 * in use". postmaster.pid only records the postmaster, so it cannot see this
 * state. Select the postgres.exe processes that must die before the cluster can
 * start again:
 * - any process whose command line names this cluster's data directory,
 * - any process owning the configured database listening port or child of that process,
 * - `--forkchild` workers of an embedded postgres binary whose postmaster is
 *   gone (already dead or doomed).
 */
export function selectStaleEmbeddedPostgresProcesses(
  processes: StalePostgresProcessInfo[],
  dataDir: string,
  extraDoomedPids?: Iterable<number>,
): StaleEmbeddedPostgresReapEntry[] {
  const doomed = new Map<number, StaleEmbeddedPostgresReapReason>();

  if (extraDoomedPids) {
    for (const pid of extraDoomedPids) {
      if (pid > 0 && pid !== process.pid) {
        doomed.set(pid, "port-owner");
      }
    }
  }

  for (const proc of processes) {
    if (proc.pid === process.pid) continue;
    if (referencesDataDirectory(proc, dataDir)) {
      doomed.set(proc.pid, "cluster-data-dir");
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (doomed.has(proc.pid) || proc.pid === process.pid) continue;

      const parentDoomed = proc.parentPid !== null && doomed.has(proc.parentPid);
      const parentAlive =
        proc.parentPid !== null &&
        !parentDoomed &&
        processes.some((other) => other.pid === proc.parentPid);

      if (parentDoomed) {
        doomed.set(proc.pid, "orphaned-child");
        changed = true;
        continue;
      }

      if (isForkChild(proc)) {
        if (!parentAlive && isEmbeddedPostgresBinary(proc)) {
          doomed.set(proc.pid, "orphaned-child");
          changed = true;
        }
      }
    }
  }

  // Any child process of a doomed process (including non-forkchild helpers)
  changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (doomed.has(proc.pid) || proc.pid === process.pid) continue;
      if (proc.parentPid !== null && doomed.has(proc.parentPid)) {
        doomed.set(proc.pid, "orphaned-child");
        changed = true;
      }
    }
  }

  return [...doomed].map(([pid, reason]) => ({ pid, reason }));
}

async function listWindowsPostgresProcesses(): Promise<StalePostgresProcessInfo[]> {
  const { stdout: probe } = await execFileAsync(
    "tasklist",
    ["/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"],
    { timeout: 15_000, windowsHide: true },
  );
  if (!probe.includes("postgres.exe")) return [];

  const script =
    "Get-CimInstance Win32_Process | Where-Object Name -eq 'postgres.exe' | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((raw) => {
    const record = raw as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return [];
    const parentPid = Number(record.ParentProcessId);
    return [{
      pid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : null,
      executablePath: typeof record.ExecutablePath === "string" ? record.ExecutablePath : null,
    }];
  });
}

async function listWindowsPortOwnerPids(port: number): Promise<number[]> {
  try {
    const script =
      `$conns = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique; ` +
      `if ($conns) { ConvertTo-Json -Compress @($conns) } else { '[]' }`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 10_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
    const pids = Array.isArray(parsed) ? parsed : [parsed];
    return pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000, windowsHide: true });
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function reapStaleEmbeddedPostgresProcesses(
  options: StaleEmbeddedPostgresReaperOptions,
): Promise<StaleEmbeddedPostgresReapResult> {
  if ((options.platform ?? process.platform) !== "win32") return { reaped: [] };
  const log = options.log ?? silentLog;
  const enumerate = options.enumeratePostgresProcesses ?? listWindowsPostgresProcesses;
  const enumeratePort = options.enumeratePortOwners ?? listWindowsPortOwnerPids;
  const killProcessTree = options.killProcessTree ?? killWindowsProcessTree;
  const delay = options.delay ?? defaultDelay;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const settleDelayMs = options.settleDelayMs ?? 250;

  let processes: StalePostgresProcessInfo[];
  try {
    processes = await enumerate();
  } catch (error) {
    log.warn(
      `Could not scan for stale embedded PostgreSQL processes; continuing startup anyway (${describeError(error)})`,
    );
    return { reaped: [] };
  }

  let portOwnerPids: number[] = [];
  if (options.port) {
    try {
      portOwnerPids = await enumeratePort(options.port);
    } catch {
      portOwnerPids = [];
    }
  }

  const stale = selectStaleEmbeddedPostgresProcesses(processes, options.dataDir, portOwnerPids);
  if (stale.length === 0) return { reaped: [] };

  log.warn(
    `Stopping ${stale.length} stale embedded PostgreSQL process(es) left over from an unclean shutdown: ` +
      stale.map((entry) => `pid=${entry.pid} (${entry.reason})`).join(", "),
  );
  await Promise.all(
    stale.map(async (entry) => {
      try {
        await killProcessTree(entry.pid);
      } catch {
        // Already dead or cleaned up.
      }
    }),
  );

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    await delay(pollIntervalMs);
    let survivors: number[];
    try {
      const observed = new Set((await enumerate()).map((proc) => proc.pid));
      survivors = stale.filter((entry) => observed.has(entry.pid)).map((entry) => entry.pid);
    } catch {
      break;
    }
    if (survivors.length === 0) break;
    if (Date.now() >= deadline) {
      log.warn(
        `Stale embedded PostgreSQL processes did not exit within ${maxWaitMs}ms (pids: ${survivors.join(", ")}); continuing startup anyway`,
      );
      break;
    }
  }

  await delay(settleDelayMs);
  return { reaped: stale };
}
