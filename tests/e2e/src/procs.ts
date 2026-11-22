// Child processes of the harness: every one is started here, logs to a file under the state
// directory, and is stopped by `stopAll` (also on a crash of the test process). Only processes
// this module started are ever signalled.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sleep, stateRoot } from './util.js';

export interface Proc {
  name: string;
  child: ChildProcess;
  logFile: string;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  alive(): boolean;
  /** SIGTERM, then SIGKILL after a grace period. */
  stop(graceMs?: number): Promise<void>;
  /** SIGKILL at once (a crash). */
  kill(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<RegExpExecArray>;
}

const live = new Set<Proc>();
/** The kernel's start time of a process (field 22 of /proc/<pid>/stat), or '?'. */
function startTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '?';
  } catch {
    return '?';
  }
}
const pidDir = (): string => path.join(stateRoot, 'pids');

export function startProc(name: string, cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; logDir?: string } = {}): Proc {
  const logDir = o.logDir ?? path.join(stateRoot, 'logs');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(pidDir(), { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  appendFileSync(logFile, `\n==== ${name} started ${new Date().toISOString()}\n`);
  const child = spawn(cmd, args, { env: o.env ?? process.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const onData = (c: Buffer): void => {
    const s = c.toString();
    buf += s;
    appendFileSync(logFile, s);
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const pidFile = path.join(pidDir(), `${name}-${child.pid}.pid`);
  if (child.pid) writeFileSync(pidFile, `${child.pid} ${startTime(child.pid)}`);
  let exited = false;
  const done = new Promise<void>((r) =>
    child.once('exit', () => {
      exited = true;
      rmSync(pidFile, { force: true });
      r();
    }),
  );
  child.once('error', (e) => {
    buf += `\n[spawn error] ${e.message}\n`;
    exited = true;
  });
  const p: Proc = {
    name, child, logFile,
    output: () => buf,
    alive: () => !exited,
    async stop(graceMs = 8_000) {
      live.delete(p);
      if (exited) return;
      child.kill('SIGTERM');
      await Promise.race([done, sleep(graceMs)]);
      if (!exited) {
        child.kill('SIGKILL');
        await done;
      }
    },
    async kill() {
      live.delete(p);
      if (exited) return;
      child.kill('SIGKILL');
      await done;
    },
    async waitForOutput(pattern, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const m = pattern.exec(buf);
        if (m) return m;
        if (exited) throw new Error(`${name} exited before printing ${pattern}:\n${buf.slice(-4000)}`);
        if (Date.now() > end) throw new Error(`${name} did not print ${pattern} in ${timeoutMs} ms:\n${buf.slice(-4000)}`);
        await sleep(50);
      }
    },
  };
  live.add(p);
  return p;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...live].map((p) => p.stop().catch(() => undefined)));
}

/** Kill what an earlier, crashed run left behind: only pids this harness recorded, and only while the kernel start time still matches. */
export function reapStale(): void {
  if (!existsSync(pidDir())) return;
  for (const f of readdirSync(pidDir())) {
    const file = path.join(pidDir(), f);
    const [pid, started] = readFileSync(file, 'utf8').trim().split(' ');
    // The same pid with the same kernel start time is the process this harness started, not a reused pid.
    if (Number(pid) > 1 && started && started !== '?' && startTime(Number(pid)) === started) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // gone
      }
    }
    rmSync(file, { force: true });
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    for (const p of live) p.child.kill('SIGKILL');
    process.exit(130);
  });
process.once('exit', () => {
  for (const p of live) p.child.kill('SIGKILL');
});
