import { describe, expect, it } from "vitest";
import {
  reapStaleEmbeddedPostgresProcesses,
  selectStaleEmbeddedPostgresProcesses,
  type StalePostgresProcessInfo,
} from "./embedded-postgres-stale-reaper.js";

const DATA_DIR = "D:\\paperclip\\.paperclip-local-dev\\instances\\default\\db";
const OTHER_DATA_DIR = "D:\\paperclip\\.paperclip-local-dev\\instances\\qa\\db";
const EMBEDDED_EXE =
  "D:\\repo\\node_modules\\.pnpm\\@embedded-postgres+windows-x64@18.1.0-beta.16\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin\\postgres.exe";
const SYSTEM_EXE = "C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe";

const postmaster = (pid: number, dataDir: string, exe = EMBEDDED_EXE): StalePostgresProcessInfo => ({
  pid,
  parentPid: 40000,
  commandLine: `"${exe}" -D "${dataDir}" -p 54329`,
  executablePath: exe,
});

const worker = (pid: number, parentPid: number, exe: string | null = EMBEDDED_EXE): StalePostgresProcessInfo => ({
  pid,
  parentPid,
  commandLine: exe === null ? null : `"${exe}" --forkchild="io_worker" ${parentPid}`,
  executablePath: exe,
});

describe("selectStaleEmbeddedPostgresProcesses", () => {
  it("selects orphaned embedded workers whose postmaster is gone", () => {
    const procs = [worker(2428, 2536)];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([
      { pid: 2428, reason: "orphaned-child" },
    ]);
  });

  it("selects orphaned workers when executablePath is null but commandLine has embedded binary path", () => {
    const procs = [{
      pid: 15532,
      parentPid: 9920,
      commandLine: `"${EMBEDDED_EXE}" --forkchild="io_worker" 6056`,
      executablePath: null,
    }];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([
      { pid: 15532, reason: "orphaned-child" },
    ]);
  });

  it("selects children of dead port owner pid", () => {
    const procs = [{
      pid: 15532,
      parentPid: 9920,
      commandLine: `"C:\\some\\other\\path\\postgres.exe" --forkchild="io_worker" 6056`,
      executablePath: null,
    }];
    // 9920 owned the port, but 9920 is dead. 15532 is its child.
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR, [9920])).toEqual([
      { pid: 9920, reason: "port-owner" },
      { pid: 15532, reason: "orphaned-child" },
    ]);
  });

  it("selects a postmaster that still references the data directory plus its workers", () => {
    const procs = [postmaster(2536, DATA_DIR), worker(2428, 2536)];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([
      { pid: 2536, reason: "cluster-data-dir" },
      { pid: 2428, reason: "orphaned-child" },
    ]);
  });

  it("selects a worker with no readable executable path when its postmaster is selected", () => {
    const procs = [postmaster(2536, DATA_DIR), { ...worker(3000, 2536), executablePath: null }];
    const reaped = selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR);
    expect(reaped).toContainEqual({ pid: 3000, reason: "orphaned-child" });
  });

  it("matches the data directory regardless of separators, quotes, and case", () => {
    const procs = [{
      pid: 2536,
      parentPid: 40000,
      commandLine: '"d:/REPO/bin/postgres.exe" -D "d:/paperclip/.paperclip-local-dev/INSTANCES/DEFAULT/db" -p 54329',
      executablePath: "d:/repo/bin/postgres.exe",
    }];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([
      { pid: 2536, reason: "cluster-data-dir" },
    ]);
  });

  it("leaves a healthy cluster on another data directory untouched", () => {
    const procs = [postmaster(100, OTHER_DATA_DIR), worker(101, 100)];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([]);
  });

  it("leaves orphaned workers of a system PostgreSQL installation untouched", () => {
    const procs = [worker(2428, 2536, SYSTEM_EXE)];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([]);
  });

  it("never selects the current process even if its command line names the data directory", () => {
    const procs = [{ ...postmaster(process.pid, DATA_DIR) }];
    expect(selectStaleEmbeddedPostgresProcesses(procs, DATA_DIR)).toEqual([]);
  });
});

describe("reapStaleEmbeddedPostgresProcesses", () => {
  const capturingLog = () => {
    const messages: string[] = [];
    return {
      messages,
      log: {
        info: (message: string) => messages.push(`info: ${message}`),
        warn: (message: string) => messages.push(`warn: ${message}`),
        error: (message: string) => messages.push(`error: ${message}`),
      },
    };
  };

  it("does nothing outside Windows", async () => {
    const enumerate = async () => { throw new Error("must not enumerate"); };
    const result = await reapStaleEmbeddedPostgresProcesses({
      dataDir: DATA_DIR,
      platform: "linux",
      enumeratePostgresProcesses: enumerate,
      killProcessTree: async () => { throw new Error("must not kill"); },
    });
    expect(result).toEqual({ reaped: [] });
  });

  it("kills the orphan holding the cluster's shared memory and waits for it to exit", async () => {
    const enumerations: StalePostgresProcessInfo[][] = [[worker(2428, 2536)], []];
    const killed: number[] = [];
    const result = await reapStaleEmbeddedPostgresProcesses({
      dataDir: DATA_DIR,
      platform: "win32",
      enumeratePostgresProcesses: async () => enumerations.shift() ?? [],
      killProcessTree: async (pid) => { killed.push(pid); },
      delay: async () => {},
      pollIntervalMs: 1,
      settleDelayMs: 0,
    });
    expect(killed).toEqual([2428]);
    expect(result.reaped).toEqual([{ pid: 2428, reason: "orphaned-child" }]);
  });

  it("continues startup when the process scan fails", async () => {
    const { messages, log } = capturingLog();
    const result = await reapStaleEmbeddedPostgresProcesses({
      dataDir: DATA_DIR,
      platform: "win32",
      log,
      enumeratePostgresProcesses: async () => { throw new Error("powershell gone"); },
      killProcessTree: async () => { throw new Error("must not kill"); },
    });
    expect(result).toEqual({ reaped: [] });
    expect(messages.join("\n")).toContain("powershell gone");
  });

  it("continues after the wait budget when a stale process refuses to exit", async () => {
    const { messages, log } = capturingLog();
    const stuck = worker(2428, 2536);
    const result = await reapStaleEmbeddedPostgresProcesses({
      dataDir: DATA_DIR,
      platform: "win32",
      log,
      enumeratePostgresProcesses: async () => [stuck],
      killProcessTree: async () => {},
      delay: async () => {},
      pollIntervalMs: 1,
      maxWaitMs: 0,
      settleDelayMs: 0,
    });
    expect(result.reaped).toEqual([{ pid: 2428, reason: "orphaned-child" }]);
    expect(messages.join("\n")).toContain("did not exit within 0ms");
  });
});
