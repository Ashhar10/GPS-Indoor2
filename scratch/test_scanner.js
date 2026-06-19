const os = require("os");
const { exec } = require("child_process");

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
  console.log("Analyzing interfaces...");
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
    console.log("No active non-virtual IPv4 interfaces found.");
    return;
  }
  
  console.log(`Pinging ${allSubnetIps.length} IPs across ${activeInterfaces.length} interfaces in parallel...`);
  const start = Date.now();
  await runPingSweep(allSubnetIps);
  console.log(`Ping sweep completed in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  
  const cmd = process.platform === "win32" ? "arp -a" : "arp -an";
  exec(cmd, (err, stdout) => {
    if (err) {
      console.error("Failed to run arp command:", err);
      return;
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
    
    console.log("\nScan Results:");
    console.log(`Total devices discovered: ${totalDevices}`);
    console.log(JSON.stringify(activeInterfaces, null, 2));
  });
}

performSubnetScan();
