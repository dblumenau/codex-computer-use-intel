import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = join(dirname(fileURLToPath(import.meta.url)), "activity-overlay");
let child: ChildProcessWithoutNullStreams | undefined;
let sequence = 0;
const pending = new Map<string, () => void>();
let warned = false;
function warn(error: unknown): void {
  if (!warned) { warned = true; process.stderr.write(`[computer-use-intel] Activity overlay unavailable: ${String(error)}\n`); }
}
function start(): ChildProcessWithoutNullStreams | undefined {
  if (child) return child;
  if (!existsSync(binary)) { warn(`build ${binary} with npm run build:overlay`); return; }
  const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  child = proc;
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const id = buffer.slice(0, index).trim().split(" ")[0]!; buffer = buffer.slice(index + 1);
      pending.get(id)?.();
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => warn(chunk.toString().trim()));
  proc.stdin.on("error", warn);
  proc.on("error", warn);
  proc.on("close", () => { if (child === proc) child = undefined; for (const done of pending.values()) done(); });
  const cleanup = () => proc.kill();
  process.once("exit", cleanup);
  proc.once("close", () => process.removeListener("exit", cleanup));
  return proc;
}
async function command(action: string, launch = true): Promise<void> {
  const proc = launch ? start() : child;
  if (!proc || proc.stdin.destroyed) return;
  const id = String(++sequence);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { warn("companion response timed out"); finish(); proc.kill(); }, 8000);
    const finish = () => { clearTimeout(timer); pending.delete(id); resolve(); };
    pending.set(id, finish);
    proc.stdin.write(`${id} ${action}\n`, (error) => { if (error) { warn(error); finish(); } });
  });
}
export async function withActivity<T>(operation: () => Promise<T>): Promise<T> {
  await command("begin");
  try { return await operation(); } finally { await command("end", false); }
}
export async function withoutActivityOverlay<T>(operation: () => Promise<T>): Promise<T> {
  await command("hide", false);
  try { return await operation(); } finally { await command("show", false); }
}
