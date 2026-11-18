import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MONOREPO_ROOT } from "./script-registry.js";
import { applyEnvUpdates, maskValue, parseEnvFile, validateEnvUpdate, type EnvEntry } from "./env-file.js";

/**
 * The `.env` this serves is the monorepo root one — the file the console and
 * the backend actually load, since both call `dotenv.config()` against
 * `process.cwd()` and both are launched from the repo root by
 * `scripts/backend.sh`.
 *
 * `packages/console/.env` is a hand-maintained mirror that only takes effect
 * when someone runs `pnpm --dir packages/console dev` (cwd = that directory).
 * This service does not write it: two files edited by one button is how they
 * stop being identical without anyone noticing which one is stale. The panel
 * says out loud that the mirror exists.
 */
const ENV_FILE = ".env";
const MIRROR_FILE = "packages/console/.env";

/** Values without their value — the list endpoint masks secrets, and revealing
 *  one is a separate, loopback-only request. */
export type EnvEntryView = Omit<EnvEntry, "value"> & { value: string; masked: boolean };

export interface EnvView {
  file: string;
  entries: EnvEntryView[];
  /** Groups in the order they first appear in the file, so the panel's layout
   *  follows the file people already know rather than an alphabetic reshuffle. */
  groups: string[];
  /** Things worth saying next to the values: a missing file, a mirror that has
   *  drifted. */
  notes: string[];
}

@Injectable()
export class EnvSettingsService {
  private readonly logger = new Logger(EnvSettingsService.name);

  private get filePath(): string {
    return path.join(MONOREPO_ROOT, ENV_FILE);
  }

  read(): EnvView {
    const notes: string[] = [];
    if (!existsSync(this.filePath)) {
      notes.push(`${ENV_FILE} 不存在。保存时会新建它。`);
      return { file: ENV_FILE, entries: [], groups: [], notes };
    }
    const text = readFileSync(this.filePath, "utf8");
    const entries = parseEnvFile(text).map<EnvEntryView>((e) => ({
      ...e,
      value: e.secret ? maskValue(e.value) : e.value,
      masked: e.secret,
    }));

    const mirror = path.join(MONOREPO_ROOT, MIRROR_FILE);
    if (existsSync(mirror)) {
      const same = readFileSync(mirror, "utf8") === text;
      notes.push(
        same
          ? `${MIRROR_FILE} 目前与本文件内容相同。它只在 \`pnpm --dir packages/console dev\` 时生效；本页保存后需要你自己同步它。`
          : `${MIRROR_FILE} 与本文件已经不一致。它只在 \`pnpm --dir packages/console dev\` 时生效，届时读到的是它、不是这里的值。`,
      );
    }

    const groups: string[] = [];
    for (const e of entries) if (!groups.includes(e.group)) groups.push(e.group);
    return { file: ENV_FILE, entries, groups, notes };
  }

  /** The real value of one key. Separate from `read()` so the masked list can
   *  stay the default and every unmasking is its own deliberate request. */
  reveal(key: string): { key: string; value: string } {
    if (!existsSync(this.filePath)) throw new NotFoundException(`${ENV_FILE} 不存在`);
    const entry = parseEnvFile(readFileSync(this.filePath, "utf8")).find((e) => e.key === key);
    if (!entry) throw new NotFoundException(`${ENV_FILE} 里没有 ${key}`);
    return { key, value: entry.value };
  }

  /**
   * Write values back. Validates everything BEFORE touching the file, so a bad
   * key in a batch of ten cannot leave the other nine half-applied.
   *
   * Does not update this process's `process.env`. Most of these are read once
   * at boot (config.ts builds a frozen object; dotenv does not re-read), so
   * mutating the live environment would make the panel agree with itself while
   * the running stack still behaved the old way. The caller is told to restart
   * instead, which is the truth.
   */
  write(updates: Record<string, string>): { file: string; changed: string[]; backup: string | null } {
    const keys = Object.keys(updates);
    if (keys.length === 0) throw new BadRequestException("没有要保存的变量");
    const errors = keys.map((k) => validateEnvUpdate(k, updates[k])).filter((e): e is string => e !== null);
    if (errors.length > 0) throw new BadRequestException(errors.join("；"));

    const current = existsSync(this.filePath) ? readFileSync(this.filePath, "utf8") : "";
    const next = applyEnvUpdates(current, updates);
    if (next === current) return { file: ENV_FILE, changed: [], backup: null };

    let backup: string | null = null;
    if (current !== "") {
      backup = `${ENV_FILE}.bak`;
      copyFileSync(this.filePath, path.join(MONOREPO_ROOT, backup));
    }
    // Write-then-rename: a crash midway leaves the old `.env` intact rather
    // than a truncated one, and `.env` being half a file is the kind of damage
    // that is only discovered at the next boot.
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, this.filePath);
    this.logger.log(`.env updated: ${keys.join(", ")}`);
    return { file: ENV_FILE, changed: keys, backup };
  }
}
