import { chmod, mkdir, stat, statfs } from "node:fs/promises";

/** A problem with Protege's home folder, worded for the user */
export class HomeError extends Error {
  override name = "HomeError";
}

// Linux filesystem type numbers (statfs f_type) where SQLite's locking and
// shared memory can't be trusted: the database could be damaged
const NETWORK_FILESYSTEMS = new Map<number, string>([
  [0x6969, "NFS"],
  [0x517b, "SMB"],
  [0xfe534d42, "SMB"],
  [0xff534d42, "CIFS"],
  [0x01021997, "9p, a Windows drive seen from WSL"],
]);

/** The network filesystem's name for a statfs type number, if it is one */
export function networkFilesystem(type: number): string | undefined {
  return NETWORK_FILESYSTEMS.get(type >>> 0); // >>> 0: read the number as unsigned
}

/**
 * Creates home folder if needed, refuses a network drive (Linux), and makes the folder private (macOS and Linux)
 */
export async function prepareHome(home: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const warnings: string[] = [];

  if (platform === "linux") {
    const kind = networkFilesystem((await statfs(home)).type);
    if (kind) {
      throw new HomeError(
        `${home} is on a network drive (${kind}), where the database can be damaged. Use a local folder: set PROTEGE_HOME.`,
      );
    }
  }

  // Windows: user's home folder is private by default
  if (platform !== "win32") {
    const { mode } = await stat(home);
    if ((mode & 0o077) !== 0) {
      try {
        await chmod(home, 0o700);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") throw err;
        warnings.push(`Couldn't make ${home} private (${code}). Run: chmod 700 ${home}`);
      }
    }
  }
  return warnings;
}