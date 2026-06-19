# WiFi network status demo

A learning project: a webpage that shows how many devices are connected to
your WiFi, and (with explicit user permission) the visitor's GPS coordinates
including altitude.

## How it's split

- **Frontend** (`public/index.html`) — runs in the visitor's browser. Asks
  for geolocation permission via the standard browser prompt, then displays
  lat/long/altitude/accuracy and a device count pulled from your backend.
  This part works on any device, no router needed.

- **Backend** (`server/server.js`) — runs on a machine you control. Talks to
  your router's API to count connected devices, and stores location pings
  sent from the frontend. The "how many people are on this WiFi" number can
  only come from here — browsers have no API for it.

## Why two parts

A webpage has no way to see your router's client list directly; that data
lives on the router. So the count has to be fetched server-side and handed
to the page, rather than computed in the browser.

## Running it

```bash
cd server
npm init -y
npm install express
ROUTER_TYPE=mock node server.js
```

Open `http://localhost:3000`. With `ROUTER_TYPE=mock` you'll get a random
device count so you can build/test the frontend without touching real router
hardware.

## Connecting to your real router

`server.js` includes three ready-to-edit integrations — pick the one that
matches what you run, fill in the IP/credentials, and set `ROUTER_TYPE`
accordingly:

| ROUTER_TYPE | Hardware | What it uses |
|---|---|---|
| `mikrotik` | MikroTik RouterOS 7.x+ | Built-in REST API, reads DHCP leases |
| `openwrt` | OpenWrt | ubus JSON-RPC, reads DHCP leases |
| `unifi` | Ubiquiti UniFi Controller | Controller REST API, reads connected stations |

If you're on different hardware, the pattern is the same: find your router's
local admin API or SSH into it and parse `arp -a` / DHCP lease file, then
return a count from `getConnectedDeviceCount()`.

## Notes for going beyond a learning demo

- Move credentials out of the source file and into environment variables.
- Swap the in-memory `locationPings` array for a real database.
- If real visitors will use this, tell them clearly what's collected and
  why (a short line of copy, not just a privacy policy link), and don't
  store more location history than you actually need.
- Serve over HTTPS — geolocation won't even prompt on plain HTTP except on
  `localhost`.
