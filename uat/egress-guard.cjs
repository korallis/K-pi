/**
 * UAT egress firewall (CommonJS preload via NODE_OPTIONS=--require).
 *
 * Allows loopback + unix sockets only. Every other connect/DNS attempt is
 * logged to $UAT_EGRESS_LOG and throws EUATEGRESS.
 *
 * Inherited by worker children that pass process.env through.
 * Never imports product source.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const dnsPromises = require("node:dns").promises;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]);

function logPath() {
	return process.env.UAT_EGRESS_LOG || "";
}

function stackTop() {
	const stack = new Error().stack || "";
	const lines = stack.split("\n").map((l) => l.trim());
	// skip Error + this helper + connect wrapper frames
	for (const line of lines) {
		if (!line.startsWith("at ")) continue;
		if (line.includes("egress-guard")) continue;
		return line.replace(/^at\s+/, "").slice(0, 240);
	}
	return lines[2] || "";
}

function record(host, port, kind) {
	const path = logPath();
	const entry = {
		at: new Date().toISOString(),
		kind,
		host: String(host ?? ""),
		port: port === undefined || port === null ? null : Number(port),
		stack_top: stackTop(),
	};
	if (path) {
		try {
			fs.appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
		} catch {
			// never mask the block with a log failure
		}
	}
	const err = new Error(
		`EUATEGRESS: blocked ${kind} to ${entry.host}${entry.port != null ? `:${entry.port}` : ""}`,
	);
	err.code = "EUATEGRESS";
	err.egress = entry;
	return err;
}

function isAllowedHost(host) {
	if (host == null || host === "") return true; // path-only / abstract unix
	const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
	if (LOOPBACK.has(h)) return true;
	// bare IPv4 loopback variants
	if (h === "127.0.0.1" || h.startsWith("127.")) return true;
	return false;
}

function normalizeConnectArgs(args) {
	// net.Socket#connect(options)
	// net.Socket#connect(path[, cb])  unix
	// net.Socket#connect(port[, host][, cb])
	if (args.length === 0) return { host: null, port: null, path: null };
	const first = args[0];
	if (typeof first === "object" && first !== null) {
		return {
			host: first.host ?? first.hostname ?? null,
			port: first.port ?? null,
			path: first.path ?? null,
		};
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) {
		// unix path or host-only oddity
		if (first.includes("/") || first.startsWith("\0")) {
			return { host: null, port: null, path: first };
		}
		return { host: first, port: args[1], path: null };
	}
	if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
		return { host: typeof args[1] === "string" ? args[1] : "127.0.0.1", port: Number(first), path: null };
	}
	return { host: null, port: null, path: null };
}

function guardConnect(original) {
	return function uatGuardedConnect(...args) {
		const n = normalizeConnectArgs(args);
		if (n.path) {
			// unix domain socket — local only
			return original.apply(this, args);
		}
		if (!isAllowedHost(n.host)) {
			throw record(n.host, n.port, "connect");
		}
		return original.apply(this, args);
	};
}

function guardLookup(original, label) {
	return function uatGuardedLookup(hostname, ...rest) {
		if (!isAllowedHost(hostname)) {
			const cb = rest.find((a) => typeof a === "function");
			const err = record(hostname, null, label);
			if (cb) {
				process.nextTick(() => cb(err));
				return;
			}
			return Promise.reject(err);
		}
		return original.call(this, hostname, ...rest);
	};
}

// --- install hooks ---
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = guardConnect(origConnect);

const origCreateConnection = net.createConnection;
net.createConnection = function uatCreateConnection(...args) {
	const n = normalizeConnectArgs(args);
	if (!n.path && !isAllowedHost(n.host)) {
		throw record(n.host, n.port, "createConnection");
	}
	return origCreateConnection.apply(this, args);
};
net.connect = net.createConnection;

const dnsMethods = ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt"];
for (const method of dnsMethods) {
	if (typeof dns[method] === "function") {
		dns[method] = guardLookup(dns[method].bind(dns), `dns.${method}`);
	}
	if (dnsPromises && typeof dnsPromises[method] === "function") {
		const orig = dnsPromises[method].bind(dnsPromises);
		dnsPromises[method] = async function uatDnsPromise(hostname, ...rest) {
			if (!isAllowedHost(hostname)) {
				throw record(hostname, null, `dns.promises.${method}`);
			}
			return orig(hostname, ...rest);
		};
	}
}

// self-identify for diagnostics
process.env.UAT_EGRESS_GUARD = "1";
