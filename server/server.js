// server.js
// Minimal backend for the WiFi locator demo.
//
// Run:
//   npm install express node-fetch
//   ROUTER_TYPE=mock node server.js
//
// Set ROUTER_TYPE to one of: mock | mikrotik | openwrt | unifi
// and fill in the matching config block below with your router's details.

const path = require("path");
const express = require("express");
const os = require("os");
const { exec } = require("child_process");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));


const PORT = process.env.PORT || 3000;
const ROUTER_TYPE = process.env.ROUTER_TYPE || "mock";

// In-memory store for the demo. Swap for a real database (sqlite/postgres/etc)
// before using this for anything beyond learning.
const locationPings = [];

// --- Subnet Scanner Helpers ------------------------------------------------
function getInterfaceType(name) {
  const n = name.toLowerCase();
  if (n.includes("wi-fi") || n.includes("wifi") || n.includes("wireless") || n.includes("wlan")) {
    return "wifi";
  }
  if (n.includes("ethernet") || n.includes("lan") || n.includes("eth") || n.includes("local area")) {
    if (n.includes("vethernet") || n.includes("virtual") || n.includes("vpn") || n.includes("host-only")) {
      return "virtual";
    }
    return "ethernet";
  }
  return "other";
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function longToIp(long) {
  return [
    (long >>> 24) & 255,
    (long >>> 16) & 255,
    (long >>> 8) & 255,
    long & 255
  ].join('.');
}

function getIpsInSubnet(ipAddress, netmask) {
  const ip = ipToLong(ipAddress);
  const mask = ipToLong(netmask);
  const network = ip & mask;
  const broadcast = network | (~mask);
  
  const rangeSize = broadcast - network - 1;
  const ips = [];
  
  if (rangeSize <= 0 || rangeSize > 512) {
    const parts = ipAddress.split('.');
    const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
    for (let i = 1; i <= 254; i++) {
      const target = `${base}.${i}`;
      if (target !== ipAddress) {
        ips.push(target);
      }
    }
  } else {
    for (let i = network + 1; i < broadcast; i++) {
      const target = longToIp(i);
      if (target !== ipAddress) {
        ips.push(target);
      }
    }
  }
  return ips;
}

function pingIP(ip) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32"
      ? `ping -n 1 -w 200 ${ip}`
      : `ping -c 1 -W 1 ${ip}`;
      
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      if (process.platform === "win32") {
        if (stdout.includes("Reply from") && !stdout.includes("Destination host unreachable") && !stdout.includes("Request timed out")) {
          resolve(ip);
        } else {
          reject(new Error("Ping failed"));
        }
      } else {
        resolve(ip);
      }
    });
  });
}

async function runPingSweep(ips) {
  const concurrency = 50;
  let index = 0;
  
  async function worker() {
    while (index < ips.length) {
      const ip = ips[index++];
      try {
        await pingIP(ip);
      } catch (e) {
        // Suppress ping errors
      }
    }
  }
  
  const workers = Array(Math.min(concurrency, ips.length)).fill(null).map(() => worker());
  await Promise.all(workers);
}

function parseArpTable(stdout) {
  const interfaceDevices = {};
  
  if (process.platform === "win32") {
    const sections = stdout.split(/Interface:\s*/i);
    for (let section of sections) {
      if (!section.trim()) continue;
      const lines = section.split("\n");
      const headerLine = lines[0].trim();
      const ipMatch = headerLine.match(/^([0-9.]+)/);
      if (!ipMatch) continue;
      const interfaceIp = ipMatch[1];
      
      const devices = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.toLowerCase().includes("dynamic")) {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const ip = parts[0];
            const mac = parts[1];
            if (ip !== interfaceIp && !ip.startsWith("169.254") && !ip.startsWith("224.") && !ip.startsWith("239.")) {
              devices.push({ ip, mac });
            }
          }
        }
      }
      interfaceDevices[interfaceIp] = devices;
    }
  } else {
    const lines = stdout.split("\n");
    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/\(([^)]+)\)\s+at\s+([0-9a-fA-F:-]+)/) 
                 || trimmed.match(/^([0-9.]+)\s+.*lladdr\s+([0-9a-fA-F:-]+)/);
                 
      if (match) {
        const ip = match[1];
        const mac = match[2];
        if (!ip.startsWith("169.254") && !ip.startsWith("224.") && !ip.startsWith("239.")) {
          if (!interfaceDevices["all"]) interfaceDevices["all"] = [];
          interfaceDevices["all"].push({ ip, mac });
        }
      }
    }
  }
  
  return interfaceDevices;
}

async function performSubnetScan() {
  const interfaces = os.networkInterfaces();
  const activeInterfaces = [];
  const allSubnetIps = [];
  
  for (let [name, infoList] of Object.entries(interfaces)) {
    const type = getInterfaceType(name);
    if (type === "virtual") continue;
    
    for (let info of infoList) {
      if (info.family === "IPv4" && !info.internal) {
        const ips = getIpsInSubnet(info.address, info.netmask);
        activeInterfaces.push({
          name,
          ip: info.address,
          netmask: info.netmask,
          type,
          subnetIps: ips,
          devices: []
        });
        allSubnetIps.push(...ips);
      }
    }
  }
  
  if (activeInterfaces.length === 0) {
    return { totalDevices: 0, interfaces: [] };
  }
  
  const uniqueIps = [...new Set(allSubnetIps)];
  await runPingSweep(uniqueIps);
  
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "arp -a" : "arp -an";
    exec(cmd, (err, stdout) => {
      if (err) {
        return resolve({ totalDevices: 0, interfaces: activeInterfaces });
      }
      
      const arpData = parseArpTable(stdout);
      let totalDevices = 0;
      
      for (let iface of activeInterfaces) {
        if (process.platform === "win32") {
          const devices = arpData[iface.ip] || [];
          iface.devices = devices;
          iface.deviceCount = devices.length;
          totalDevices += devices.length;
        } else {
          const allDevices = arpData["all"] || [];
          const matchedDevices = allDevices.filter(d => iface.subnetIps.includes(d.ip));
          const uniqueMatched = [];
          const seen = new Set();
          for (let d of matchedDevices) {
            if (!seen.has(d.ip)) {
              seen.add(d.ip);
              uniqueMatched.push(d);
            }
          }
          iface.devices = uniqueMatched;
          iface.deviceCount = uniqueMatched.length;
          totalDevices += uniqueMatched.length;
        }
        delete iface.subnetIps;
      }
      
      resolve({
        totalDevices,
        interfaces: activeInterfaces
      });
    });
  });
}


// ---------------------------------------------------------------------------
// Router integrations — pick the one matching your hardware and fill in config
// ---------------------------------------------------------------------------

async function getConnectedDeviceCount() {
  switch (ROUTER_TYPE) {
    case "scan":
      const scanResults = await performSubnetScan();
      return scanResults.totalDevices;
    case "mikrotik":
      return getCountFromMikrotik();
    case "openwrt":
      return getCountFromOpenWrt();
    case "unifi":
      return getCountFromUnifi();
    case "mock":
    default:
      // Useful for frontend development without a real router on hand.
      return Math.floor(Math.random() * 12) + 1;
  }
}

// --- MikroTik RouterOS (REST API, RouterOS 7.x+) ---------------------------
// Enable the REST API on the router first: /ip/service set www-ssl disabled=no
// (or plain www if you're on a trusted local network only)
async function getCountFromMikrotik() {
  const ROUTER_IP = "192.168.88.1";
  const USER = "admin";
  const PASS = "your-password";

  const res = await fetch(`http://${ROUTER_IP}/rest/ip/dhcp-server/lease`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")
    }
  });
  const leases = await res.json();
  // Count only leases currently bound (active), not just historically issued
  return leases.filter(l => l.status === "bound").length;
}

// --- OpenWrt (via ubus over HTTP, requires rpcd + uhttpd-mod-ubus) ----------
// Docs: https://openwrt.org/docs/techref/ubus
async function getCountFromOpenWrt() {
  const ROUTER_IP = "192.168.1.1";
  const USER = "root";
  const PASS = "your-password";

  const loginRes = await fetch(`http://${ROUTER_IP}/ubus`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "call",
      params: [0, "session", "login", { username: USER, password: PASS }]
    })
  });
  const loginData = await loginRes.json();
  const sessionId = loginData.result[1].ubus_rpc_session;

  const hostsRes = await fetch(`http://${ROUTER_IP}/ubus`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "call",
      params: [sessionId, "dhcp", "ipv4leases", {}]
    })
  });
  const hostsData = await hostsRes.json();
  const leasesByInterface = hostsData.result[1].device || {};
  return Object.values(leasesByInterface).flatMap(d => d.leases || []).length;
}

// --- Ubiquiti UniFi Controller ----------------------------------------------
// Docs: https://ubntwiki.com/products/software/unifi-controller/api
async function getCountFromUnifi() {
  const CONTROLLER = "https://192.168.1.5:8443";
  const USER = "admin";
  const PASS = "your-password";
  const SITE = "default";

  // Note: UniFi controllers commonly use self-signed certs on the LAN;
  // handle TLS appropriately for your environment rather than disabling
  // verification globally.
  const loginRes = await fetch(`${CONTROLLER}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const cookie = loginRes.headers.get("set-cookie");

  const clientsRes = await fetch(`${CONTROLLER}/api/s/${SITE}/stat/sta`, {
    headers: { Cookie: cookie }
  });
  const clientsData = await clientsRes.json();
  return clientsData.data.length;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/wifi-stats", async (req, res) => {
  try {
    if (ROUTER_TYPE === "scan") {
      const scanResults = await performSubnetScan();
      res.json({
        connectedDevices: scanResults.totalDevices,
        source: "subnet-scan",
        interfaces: scanResults.interfaces
      });
    } else {
      const connectedDevices = await getConnectedDeviceCount();
      res.json({ connectedDevices, source: ROUTER_TYPE });
    }
  } catch (err) {
    console.error("Router query failed:", err.message);
    res.status(502).json({ error: "Could not reach router" });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const scanResults = await performSubnetScan();
    res.json(scanResults);
  } catch (err) {
    console.error("Subnet scan failed:", err.message);
    res.status(500).json({ error: "Scan failed", details: err.message });
  }
});

app.post("/api/location", (req, res) => {
  const { latitude, longitude, altitude, accuracy, timestamp } = req.body || {};

  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return res.status(400).json({ error: "latitude and longitude are required numbers" });
  }

  locationPings.push({ latitude, longitude, altitude, accuracy, timestamp, receivedAt: Date.now() });
  res.json({ ok: true, stored: locationPings.length });
});

app.get("/api/location", (req, res) => {
  // For the demo only — remove or protect this in anything beyond local testing.
  res.json(locationPings);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (router mode: ${ROUTER_TYPE})`);
});
