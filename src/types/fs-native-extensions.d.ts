declare module "fs-native-extensions" {
  /** True if the lock was granted, false if another handle holds it */
  export function tryLock(fd: number, options?: { shared?: boolean }): boolean;
  export function unlock(fd: number): void;
}