// Socket transports: a net.Socket is a duplex stream (readable === writable),
// so both sides are just the generic stream framing over that one socket.
import type { Socket } from "node:net";
import type { ClientTransport } from "@ateam/protocol";
import type { ServerTransport } from "../rpc";
import { streamClientTransport, streamServerTransport } from "./stream";

/** Server side of a socket connection: receives ClientFrames, sends ServerFrames. */
export function socketServerTransport(socket: Socket): ServerTransport {
	return streamServerTransport(socket, socket);
}

/** Client side of a socket connection: sends ClientFrames, receives ServerFrames. */
export function socketClientTransport(socket: Socket): ClientTransport {
	return streamClientTransport(socket, socket);
}
