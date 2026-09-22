# GSS Network Lab (offline Electron desktop app)

For the complete operator and developer guide, see
[LAB-DOCUMENTATION.md](LAB-DOCUMENTATION.md).

## Gaston Software Solutions LLP

Kampala, Uganda  
Website: [www.gss-tec.com](https://www.gss-tec.com)  
Tel: **+256 755 274 944**

This is a local-first topology and agent test console. It can run completely
offline, and it can optionally publish complete infrastructure snapshots to
the GSS cloud backend. The default line-grid follows the supplied `topo.png` reference:
HQ core, ASA firewall, Cisco 2911/2960 devices, and Kawempe, Nansana, Masaka
and Ntinda branches.

## Requirements and intended use

The local topology server is a virtual fibre-network test environment. It is
used to simulate and validate the same monitoring workflows provided by
[GSS Network Intelligence](https://gss-creator-network-guardian.qvaultp.workers.dev/)
for:

- Linux servers.
- Windows servers.
- Fibre ISP infrastructure, including routers, switches, firewalls, OLTs,
  splitters, ONTs/CPEs, and customer devices.

To run the local lab, you need:

- A supported desktop operating system: Windows, macOS, or Linux.
- Node.js 18 or newer with npm.
- At least 4 GB RAM and 500 MB free disk space for the application and local
  dependencies.
- A display capable of showing the Topology, Management, and Traffic Monitor
  windows.
- Permission for the application to listen on local TCP port `8787`.
- An outbound HTTPS connection only when synchronizing with GSS Cloud.

The lab does not replace the Windows or Linux GSS Agent and does not configure
physical network equipment. It provides a safe virtual environment for testing
device discovery, telemetry, topology changes, traffic, incidents, and cloud
integration before using the platform with real infrastructure.

## Run

```powershell
cd desktop-lab
npm install
npm start
```

## Engineering baseline and re-engineering

This repository is the **GSS Virtual Fibre Lab baseline**. Engineers may clone
it, run the reference implementation, and adapt the topology, device models,
traffic rules, local API, and cloud adapter for their own approved use case.

Clone the baseline:

```powershell
git clone https://github.com/GSS-creator/network-guardian.git
cd network-guardian\desktop-lab
npm install
npm start
```

Recommended engineering workflow:

1. Create a feature branch from the baseline.
2. Read [LAB-DOCUMENTATION.md](LAB-DOCUMENTATION.md) before changing the
   runtime model.
3. Keep the normalized device contract (`device`, `interfaces`, `health`,
   `traffic`, `events`, `neighbours`, and `links`) compatible with the GSS
   Intelligence API unless the integration is intentionally being replaced.
4. Add new device types through the model and renderer together so the local
   API, topology inspector, traffic simulator, and cloud snapshot remain in
   agreement.
5. Test offline first, then test GSS Cloud synchronization with a dedicated
   integration key.
6. Submit changes through the team's normal review process.

Useful customization points:

- `renderer/app.js` — topology seed data, device behaviour, interactions, and
  traffic presentation.
- `main.cjs` — local server, persistence, telemetry collection, cloud upload,
  and Electron windows.
- `preload.cjs` — the secure IPC surface exposed to the renderer.
- `renderer/styles.css` — interface and topology presentation.
- `LAB-DOCUMENTATION.md` — operational and API reference.

Do not commit API keys, customer credentials, private certificates, local
database files, or production configuration. Use separate development keys and
environment-specific configuration for each deployment.

For a browser-only topology preview, run this in a second terminal:

```powershell
node preview.cjs
```

Then open `http://127.0.0.1:8787/topology?screen=topology`.

The app stores the topology in Electron's local profile. Add devices with their
real IP/hostname, select a device, and run an ICMP test from the PC hosting the
lab. Install the GSS Agent on the main server separately.

## GSS Intelligence cloud monitoring

To connect the lab to GSS Cloud, create or copy an Infrastructure API key
from the GSS web application:

**[GSS Cloud API Management](https://gss-creator-network-guardian.qvaultp.workers.dev/fiber#api)**

Open the API section, create an integration key, copy it, and paste it into
**Management → GSS Intelligence cloud** in this lab. The key is required for
cloud synchronization; the lab can still run locally without one.

In **Management → GSS Intelligence cloud**, paste the bearer API key and select
**Save cloud key**. The key is encrypted with the operating system credential
store in the server's local database; it is never included in the topology data
or cloud telemetry payload.

The Management screen shows **GSS Cloud: Online** only after the cloud API
accepts telemetry. It shows **Offline** if no key is configured, the local
server is stopped, or a cloud upload fails.

The local server persists its inventory in `gss-local-db.json` in Electron's
application-data directory. It contains the complete device records (including
interfaces and other model components), links, and update time. The UI loads
this server-side inventory on launch, and every add, topology edit, and status
change writes it back immediately. The cloud key is stored there only as an
OS-encrypted value, never in plaintext.

When the local server starts, it collects the complete fibre infrastructure and
sends it as one telemetry payload to
`https://gss-backend.qvaultp.workers.dev/api/infrastructure/telemetry`. The
same single-payload collection and upload runs once every 60 seconds. Each
payload includes every device, its interfaces and other components, traffic,
routing, VLANs, firewall data, neighbours, events, and every topology link.
For every device it also includes normalized `throughput_mbps`,
`bandwidth_mbps`, `bandwidth_utilization_percent`, `latency_ms`,
`packet_loss_percent`, `connection_errors`, `interface_errors`, `link_errors`,
CPU, memory, and `temperature_c` metrics. Throughput is measured from the byte
change between complete 60-second collections, so the first upload establishes
the baseline and later uploads report the measured rate.
Before reporting GSS Cloud as online, the local server verifies that the cloud
accepted every device in the snapshot. A partial acceptance is shown as an
offline/error state and is retried at the next interval.
Only outbound HTTPS access is required. You can alternatively set
`GSS_INTELLIGENCE_API_KEY` (or `GSS_API_KEY`) before launching the app.

The `topo.png` image is included as a reference panel in the app. The editable
canvas is intentionally rendered as a line-grid so links, branches, and device
status remain readable while testing real addresses.

The desktop launcher opens a third **Traffic Monitor** window alongside the
Topology and Management windows. It lists each receive event with timestamp,
bytes, destination device/IP, and source device/IP.

The local server exposes the same virtual devices to an Intelligence API:

```text
GET /api/devices
GET /api/infrastructure
GET /api/telemetry
GET /api/telemetry/history
GET /api/devices/{id}
GET /api/devices/{id}/interfaces
GET /api/devices/{id}/routes
GET /api/devices/{id}/vlans
GET /api/devices/{id}/traffic
GET /api/devices/{id}/health
GET /api/devices/{id}/events
GET /api/devices/{id}/topology
POST /api/devices/{id}/commands
```

Router, switch, firewall, OLT, splitter, ONT/CPE, server, and client nodes
have type-specific interfaces and operational data. Traffic increments RX/TX
packets and bytes on both endpoint devices and their interfaces.

Each switch in the starter lab already has a fibre access chain: **OLT → FDB /
passive splitter → ONT/CPE → customer client**. Select any switch (or OLT,
splitter, or ONT) before adding a device; the new device is attached to that
parent and a link is created automatically. This lets you model real GPON
branches, customer premises, access points, and servers without a cloud API.

## Local server and traffic simulation

Open **Management → Local lab server → Start local server**. The PC listens on
port `8787`, assigns missing lab identities, and reports its LAN address. The
GSS Main Server uses the PC's detected LAN IPv4 address; every other simulated
device receives a unique randomized private lab IP. The server continuously
collects the device management-plane snapshot (identity, interfaces, health,
traffic, routes, neighbours, events, and link statistics) once per second.
The server then emits concurrent traffic events over every topology
link; the corresponding wires glow in the Topology window. This is a local
simulation for testing the agent workflow and does not change the configuration
of physical Cisco devices.
