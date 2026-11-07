import { beforeEach } from "vitest";
import { resetDefaultWriteGuard } from "../src/utils/write-guard.js";

// The write guard keeps its count per process, which is right for the server and
// wrong for tests that share one process. Each test starts with an empty count.
beforeEach(() => resetDefaultWriteGuard());
