// tunnel.js
// A path-independent helper to start localtunnel on Windows.
const localtunnel = require("localtunnel");

(async () => {
  try {
    console.log("Connecting to localtunnel...");
    const tunnel = await localtunnel({ port: 3000 });
    
    console.log("\n==================================================");
    console.log("🎉 Tunnel successfully opened!");
    console.log(`🔗 Mobile URL: ${tunnel.url}`);
    console.log("==================================================\n");
    console.log("Keep this terminal window open to keep the tunnel active.");

    tunnel.on('close', () => {
      console.log("Tunnel closed.");
    });
  } catch (err) {
    console.error("Failed to start tunnel:", err.message);
  }
})();
