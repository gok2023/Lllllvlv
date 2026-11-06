import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

type Location = {
  current?: string;
  pending?: { source: string; target: string; sourcePid: number };
  error?: string;
};

export class UserDataLocation {
  private readonly file: string;
  private location: Location = {};

  constructor(
    private readonly appData: string,
    private readonly fallback: string,
  ) {
    this.file = join(appData, "Freebo-data-location.json");
    try {
      this.location = JSON.parse(readFileSync(this.file, "utf8")) as Location;
    } catch {
      // No pointer yet, or a damaged pointer: the original directory stays authoritative.
    }
  }

  get error() {
    return this.location.error;
  }

  private save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.location), { flag: "wx" });
    try {
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private acquireMigrationLock(): () => void {
    const lock = `${this.file}.lock`;
    for (let attempt = 0; attempt < 3000; attempt++) {
      try {
        const descriptor = openSync(lock, "wx");
        writeFileSync(descriptor, String(process.pid));
        closeSync(descriptor);
        return () => unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = 0;
        try {
          owner = Number(readFileSync(lock, "utf8"));
        } catch {
          /* Another process is creating it. */
        }
        if (owner && !this.processExists(owner)) {
          try {
            unlinkSync(lock);
          } catch {
            /* Another process may have released it. */
          }
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    throw new Error("等待数据目录迁移超时");
  }

  private validDirectory(path: unknown): path is string {
    try {
      return (
        typeof path === "string" &&
        isAbsolute(path) &&
        existsSync(path) &&
        statSync(path).isDirectory()
      );
    } catch {
      return false;
    }
  }

  resolve(): string {
    if (this.location.pending) {
      const release = this.acquireMigrationLock();
      try {
        this.location = JSON.parse(readFileSync(this.file, "utf8")) as Location;
        const pending = this.location.pending;
        if (pending) {
          const previous = this.location.current;
          try {
            // A relaunched process may start before the previous Chromium process has released its databases.
            if (!Number.isInteger(pending.sourcePid) || pending.sourcePid <= 0)
              throw new Error("迁移来源进程无效");
            for (
              let attempt = 0;
              attempt < 300 && this.processExists(pending.sourcePid);
              attempt++
            ) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            }
            if (this.processExists(pending.sourcePid))
              throw new Error("原应用尚未退出，请稍后重试迁移");
            if (!this.validDirectory(pending.source) || !isAbsolute(pending.target))
              throw new Error("迁移源或目标路径无效");
            if (existsSync(pending.target)) throw new Error("目标数据目录已经存在");
            const staging = `${pending.target}.migrating-${randomUUID()}`;
            try {
              cpSync(pending.source, staging, {
                recursive: true,
                errorOnExist: true,
                force: false,
              });
              const sourceNames = readdirSync(pending.source).sort();
              const copiedNames = readdirSync(staging).sort();
              if (JSON.stringify(sourceNames) !== JSON.stringify(copiedNames))
                throw new Error("复制内容不完整");
              renameSync(staging, pending.target);
            } catch (error) {
              rmSync(staging, { recursive: true, force: true });
              throw error;
            }
            this.location = { current: pending.target };
            this.save();
          } catch (error) {
            this.location = { current: previous, error: String(error) };
            try {
              this.save();
            } catch {
              /* The original pointer remains authoritative. */
            }
          }
        }
      } finally {
        release();
      }
    }
    if (this.location.current) {
      if (!this.validDirectory(this.location.current))
        throw new Error(`已迁移的数据目录不可访问：${String(this.location.current)}`);
      return this.location.current;
    }
    return this.fallback;
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  targetFor(selected: string, current: string): string {
    if (!this.validDirectory(selected)) throw new Error("请选择存在的文件夹");
    const parent = realpathSync(selected);
    const target = join(parent, "Freebo");
    const source = realpathSync(current);
    const inSource = relative(source, parent);
    if (
      !inSource ||
      (!inSource.startsWith(`..${sep}`) && inSource !== ".." && !isAbsolute(inSource))
    ) {
      throw new Error("目标文件夹不能位于当前数据目录中");
    }
    if (resolve(target).toLowerCase() === source.toLowerCase())
      throw new Error("目标与当前数据目录相同");
    if (existsSync(target))
      throw new Error(`目标数据目录 ${basename(target)} 已存在，请选择其他文件夹`);
    if (
      resolve(dirname(source)).toLowerCase() === parent.toLowerCase() &&
      basename(source).toLowerCase() === "freebo"
    ) {
      throw new Error("目标与当前数据目录相同");
    }
    return target;
  }

  prepare(source: string, target: string) {
    if (this.targetFor(dirname(target), source) !== target)
      throw new Error("目标路径已变化，请重新选择");
    this.location = {
      ...this.location,
      pending: { source, target, sourcePid: process.pid },
      error: undefined,
    };
    this.save();
  }
}
