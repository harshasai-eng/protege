// Run as a separate process by locks.test.ts: takes a lock, reports, and keeps it until killed
import { takeLock } from "../../src/storage/locks.ts";

process.send?.(takeLock(process.argv[2]!) ? "held" : "busy");
setInterval(() => {}, 1_000);