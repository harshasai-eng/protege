import { homedir } from "node:os";
import { join } from "node:path";

/** Protege's own folder: PROTEGE_HOME when set, otherwise ~/.protege. */
export function protegeHome(): string {
  return process.env.PROTEGE_HOME || join(homedir(), ".protege");
}

/** Every path in Protege's folder keeps under its home folder, in one place. */
export function protegePaths(home: string = protegeHome()) {
  return {
    home,
    config: join(home, "protege.yaml"),
    envFile: join(home, ".env"),
    logs: join(home, "logs"),
    database: join(home, "protege.db"),
    artifacts: join(home, "artifacts"),
    locks: join(home, "locks"),
    updateLock: join(home, "update.lock"),
    skills: join(home, "skills"),
    runtime: join(home, "runtime"),
  };
}