// What `ateam proxy` runs, for tests that start the forwarder as the engine does.
import { runForwarder } from "../../src/proxy/forwarder";

void runForwarder(process.env.ATEAM_DATA_DIR ?? "");
