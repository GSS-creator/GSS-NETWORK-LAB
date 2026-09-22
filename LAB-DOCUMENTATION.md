# GSS Virtual Fibre Lab

## 1. Purpose

The GSS Virtual Fibre Lab is an Electron desktop application for building and
testing a software-defined fibre/ISP network before connecting the GSS
Intelligence cloud to physical infrastructure. It provides:

- An editable line-grid topology.
- Virtual routers, switches, firewalls, OLTs, splitters, ONTs/CPEs, servers,
  and customer devices.
- Device identity, interfaces, routing, VLAN, firewall, traffic, health,
  neighbour, and event data.
- A local management server on the operator's PC.
- Continuous simulated traffic and per-link traffic visibility.
- A local HTTP management API.
- Complete infrastructure snapshots for GSS-CLOUD.
- A third-party collector-style integration test without installing an agent
  on every network device.

The lab is a behavioural simulator and test harness. It does not configure
physical Cisco, Huawei, OLT, switch, firewall, or customer equipment.

It is the virtual test environment for [GSS Network Intelligence](https://gss-creator-network-guardian.qvaultp.workers.dev/),
which monitors Linux servers, Windows servers, and Fibre ISP networks.

## Requirements

- Windows, macOS, or Linux desktop operating system.
- Node.js 18 or newer and npm.
- At least 4 GB RAM and 500 MB free disk space.
- A display large enough for the Topology, Management, and Traffic Monitor
  windows.
- Permission to listen on local TCP port `8787`.
- Outbound HTTPS access only when GSS Cloud synchronization is enabled.

The lab is a safe virtual test environment. It does not install the GSS Agent,
change physical routers or switches, or execute arbitrary commands on the host.

## 2. Application layout

The application opens three coordinated Electron windows:

1. **Topology** — the editable network canvas. Move nodes, create links,
   select devices, inspect health, and disconnect/reconnect a device.
2. **Management** — start and stop the local server, view device inventory,
   run local tests, add devices, and configure GSS Cloud telemetry.
3. **Traffic Monitor** — a live receive-event feed showing timestamp, bytes,
   source, destination, and IP addresses.

All windows use the same Electron profile and local infrastructure database.
Changes made in one window are visible to the others.

## 3. Installation and startup

Requirements:

- Windows, macOS, or Linux with Node.js.
- npm.
- Electron dependencies installed in this directory.

Install and start:

```powershell
cd C:\Users\Dell\Desktop\network-guardian\desktop-lab
npm install
npm start
```

### Windows executable packaging

Create a Windows x64 distributable from the `desktop-lab` directory:

```powershell
npx @electron/packager . GSS-Network-Lab --platform=win32 --arch=x64 --out=dist --overwrite --prune=true
```

The resulting executable is
`dist\GSS-Network-Lab-win32-x64\GSS-Network-Lab.exe`. Distribute the complete
output directory, including its `resources` directory, rather than copying the
executable by itself. The build is not code-signed unless a signing
certificate is added separately.

The browser-only preview is useful when Electron is unavailable:

```powershell
node preview.cjs
```

Then open `http://127.0.0.1:8787/topology?screen=topology` after the preview
server starts. The full local management server is available from the Electron
application's **Management** window.

## 4. Engineering baseline and re-engineering

This repository is the GSS Virtual Fibre Lab baseline for engineers who need
to adapt the simulator for an approved network, product, or research use case.

```powershell
git clone https://github.com/GSS-creator/GSS-NETWORK-LAB.git
cd GSS-NETWORK-LAB
npm install
npm start
```

Use a feature branch and test locally before enabling cloud synchronization.
Keep the normalized device and telemetry contracts compatible with GSS Cloud
unless the related integration is intentionally being replaced. Never commit
customer credentials, API keys, certificates, or `gss-local-db.json`. Main
customization points are `renderer/app.js` (models/UI), `main.cjs` (runtime,
API, persistence, and cloud adapter), `preload.cjs` (IPC), and
`renderer/styles.css` (presentation).

## 5. Starter topology

The seeded topology follows the supplied Cisco reference and contains:

### Core

```text
GSS Main Server
    |
ASA-01 Firewall
    |
CORE-2911 Router
    |
CORE-2960 Switch
```

### Centres and branches

- Kawempe
- Nansana
- Masaka
- Ntinda
- HQ/core

Each centre has a router and access switch. The access hierarchy is:

```text
Centre Switch
    |
OLT
    |
FDB / passive splitter
    |
ONT / CPE
    |
Customer client
```

The starter data creates three ONT/client branches per centre. The initial
topology therefore models a core, multiple branch routers, access switches,
OLTs, splitters, ONTs, and customer endpoints rather than only a drawing of
routers.

## 6. Device model

Every virtual device has a common identity and operational model.

### Common identity

- `id` — stable simulator identifier.
- `name` — operator-facing name.
- `type` — device class.
- `vendor` and `model` — simulated vendor/model.
- `firmware` — simulated GSS-LabOS version.
- `mac` — generated local MAC address.
- `ip` — assigned or operator-supplied address.
- `site` — branch/centre label.
- `coords` — map position as `[longitude, latitude]` when exported to cloud.
- `status` — `online`, `degraded`, or `offline`.

### Supported device classes

| Type | Behaviour represented |
| --- | --- |
| Server | Local GSS management server and host health |
| Firewall | Inside/outside/DMZ interfaces, NAT, zones, ACL and sessions |
| Router | Gigabit/fibre interfaces and connected/static/OSPF routes |
| Switch | 24 switch ports, VLANs, trunks, STP and MAC-table model |
| OLT | Uplink and PON interfaces with fibre access hierarchy |
| Fibre Splitter | Passive PON input/output path |
| ONT / CPE | Customer-premises Ethernet/Wi-Fi endpoint |
| Client | End-user or downstream device |
| Access Point | Wireless access endpoint when added by the operator |

### Device health

The inspector exposes CPU, memory, temperature, uptime, status, traffic RX/TX,
interface state/speed/duplex/MTU, packets, bytes, errors, and drops. Models
also expose routing, VLAN, firewall, neighbours, and event data where the
device type supports them.

## 7. Address assignment

When the local server starts:

- The GSS Main Server uses the PC's first non-internal IPv4 address.
- Other active virtual devices receive unique randomized private `10/8`
  addresses.
- Passive splitters retain the `passive` address.
- Missing MAC addresses are generated locally.
- Existing operator-supplied addresses are retained unless the runtime server
  must assign a missing identity.

The generated addresses are simulator identities. They do not create real
Windows network adapters and do not change physical router configuration.

## 8. Editing the topology

### Moving devices

Drag a device on the Topology screen. Links follow the device. The canvas is
zoomable from 10% upward and has scrollable workspace space for large labs.

### Selecting a device

Tap the centre of a node (the tap zone, not the outer drag area). The inspector
shows identity, interfaces, health, traffic, and connection controls.

### Creating links

1. Select **Connect devices**.
2. Tap the first device.
3. Tap the second device.
4. The link is persisted in the local topology.

### Adding devices

Use **Management → Lab devices → Add device**. Enter a name, type, optional IP,
site/centre, and optional parent. Selecting a switch, OLT, splitter, or ONT as
the parent automatically creates the appropriate topology link.

The new device receives a model appropriate to its type and appears on the
Topology screen after saving.

### Disconnecting and reconnecting

The selected device inspector has **Disconnect** and **Reconnect** actions.
Disconnecting a device:

- Sets its status to `offline`.
- Brings its model interfaces down.
- Stops simulated traffic through that device and its downstream paths.
- Updates the local topology and event log.

Reconnecting restores the device and allows reachable traffic to resume.

## 9. Traffic simulation

The local runtime emits traffic every 100 ms. It rotates a concurrent window
across up to eight topology links at a time, so core, branch, OLT, ONT, and
customer links all receive activity over time.

For each delivered packet the lab updates:

- Source TX packets and bytes.
- Destination RX packets and bytes.
- The selected interface counters.
- Link packet and byte totals.
- Last activity timestamp.
- Traffic Monitor event stream.

Traffic is routed only through devices reachable from the GSS Main Server. An
offline device or broken path prevents traffic beyond that point, while
unrelated branches remain active.

The simulated traffic is deliberately lightweight. It demonstrates flow,
reachability, counters, link activity, and fault propagation; it is not a
packet-forwarding implementation capable of saturating a physical interface.

## 10. Local management server

Click **Start local server** in Management. The Electron main process listens
on port `8787` on `0.0.0.0`.

The returned URL uses the PC's detected LAN address, for example:

```text
http://192.168.1.20:8787
```

The server is local and unauthenticated by design. Use it only on a trusted
test network or bind it behind an appropriate firewall when exposing it to
other machines.

### Local HTTP endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/` | Service information and timestamp |
| GET | `/api/devices` | All devices and links |
| GET | `/api/infrastructure` | Latest complete snapshot |
| GET | `/api/telemetry` | Latest complete snapshot alias |
| GET | `/api/telemetry/history` | Recent local snapshots |
| GET | `/api/devices/:id` | Device summary |
| GET | `/api/devices/:id/interfaces` | Interfaces and counters |
| GET | `/api/devices/:id/routes` | Routing table |
| GET | `/api/devices/:id/vlans` | VLAN configuration |
| GET | `/api/devices/:id/traffic` | Device traffic counters |
| GET | `/api/devices/:id/health` | CPU, memory, temperature, uptime, status |
| GET | `/api/devices/:id/events` | Device event log |
| GET | `/api/devices/:id/topology` | Neighbours |
| POST | `/api/devices/:id/commands` | Apply a local simulated command |

Supported local command actions include `shutdown`/`disable` and
`start`/`enable`. The local API command changes simulator state; it does not
execute arbitrary shell commands.

## 11. Snapshot collection

The collector creates a complete infrastructure snapshot containing:

- Collection timestamp and collector identity.
- Every device and its identity.
- Device location/site and coordinates.
- Interfaces and interface counters.
- Health and traffic.
- Routing and VLAN data.
- Firewall data.
- Neighbours and event history.
- Every topology link and link statistics.

The local runtime collects a fresh snapshot every second for the local API.
The in-memory history keeps the latest 120 snapshots.

## 12. GSS-CLOUD integration

The cloud integration is optional. The lab remains functional without it.

### Configure the cloud key

In **Management → GSS Intelligence cloud**:

1. Paste the bearer integration key created in the GSS web application.
2. Select **Save cloud key**.
3. Start the local server.
4. Wait for the status to become **GSS Cloud: Online**.

The key is encrypted with Electron's operating-system credential store and is
not included in telemetry. It can also be supplied before startup:

```powershell
$env:GSS_INTELLIGENCE_API_KEY = "gss_live_..."
npm start
```

### Cloud endpoint

```text
POST https://gss-backend.qvaultp.workers.dev/api/infrastructure/telemetry
Authorization: Bearer gss_live_...
Content-Type: application/json
```

Cloud uploads occur once per plan-approved interval (currently approximately
65 seconds in the lab to provide timing margin). The cloud receives one
complete snapshot rather than individual device requests. The lab checks the
cloud response and only reports success when all local devices were accepted.

### Cloud payload shape

```json
{
  "device_id": "gss-fibre-infrastructure-192-168-1-20",
  "name": "GSS Fibre Infrastructure Inventory",
  "type": "Infrastructure",
  "ip": "192.168.1.20",
  "metrics": {
    "inventory_kind": "full-fibre-infrastructure",
    "device_count": 53,
    "link_count": 52,
    "collected_at": "2026-09-22T12:00:00.000Z"
  },
  "infrastructure": {
    "devices": [
      {
        "device_id": "masaka-olt",
        "site": "Masaka",
        "network_type": "fiber_isp",
        "coords": [31.7322, -0.3338],
        "location": {
          "name": "Masaka",
          "longitude": 31.7322,
          "latitude": -0.3338
        }
      }
    ],
    "links": []
  }
}
```

Coordinates use `[longitude, latitude]`, matching the GSS web map. Explicit
coordinates are preferred. The lab supplies centre-level coordinates for the
seeded branches when a device does not already have coordinates.

## 13. Cloud location and map behaviour

The cloud stores coordinates on each Fibre device. The web Network view then:

- Plots every device with a map marker.
- Uses the exact reported coordinates when available.
- Falls back to a named centre position when only a site is known.
- Shows the device name, type, centre, customer ID, and status in the marker
  popup.
- Uses green, amber, and red marker colours for online, degraded, and offline.

To update locations for an existing infrastructure, restart the lab or send a
new complete snapshot after editing the site/coordinates. A device that is not
present in a complete snapshot is eventually marked offline by the cloud's
Fibre liveness rules.

## 14. Persistence

The Electron local database is stored in the application-data directory as:

```text
gss-local-db.json
```

It contains:

- Devices and complete model records.
- Links.
- Last infrastructure update timestamp.
- Encrypted cloud API key material.

Topology changes, device additions, links, status changes, and runtime server
state are persisted automatically. Removing this file resets the local lab
database; export a copy first if the topology is important.

## 15. Test procedures

### Basic local test

1. Start Electron.
2. Open Management and select **Start local server**.
3. Confirm the PC server address and port 8787.
4. Open the Topology window and observe moving link traffic.
5. Open Traffic Monitor and confirm RX events.
6. Select a device and inspect counters and health.

### Link failure test

1. Select a branch router or switch.
2. Select **Disconnect**.
3. Verify that only that branch and downstream devices stop receiving traffic.
4. Confirm the disconnected link is marked down.
5. Select **Reconnect** and verify recovery.

### Cloud integration test

1. Create an Infrastructure API key in the GSS web application.
2. Save it in Management.
3. Start the local server.
4. Confirm that the status reports every device and link accepted.
5. Open the web Network page and verify device markers and centre labels.
6. Open Devices/Overview and confirm metrics arrive for the selected Fibre
   devices.

### API inspection test

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/devices
Invoke-RestMethod http://127.0.0.1:8787/api/infrastructure
Invoke-RestMethod http://127.0.0.1:8787/api/telemetry/history
Invoke-RestMethod http://127.0.0.1:8787/api/devices/masaka-olt/health
```

Use the actual device ID returned by `/api/devices` for device-specific calls.

## 16. Troubleshooting

### `127.0.0.1 refused to connect`

The local server is not running. Start it from Management. The browser preview
and Electron local server are separate processes.

### GSS Cloud is offline

Check that:

- The cloud API key is configured.
- The local server is running.
- The PC has outbound HTTPS access.
- The API key has not been revoked.
- The cloud has not returned a plan interval (`429`) response.

The lab keeps collecting locally while cloud upload retries.

### A device does not appear in the cloud

Confirm that the cloud status says all devices were accepted. The full snapshot
must contain a unique `device_id` for every device and the declared device
count must match. Restart the local server to send a fresh complete snapshot.

### Traffic is not moving

Check that the local server is running, the source and destination are online,
and the path remains connected to the GSS Main Server. A disconnected upstream
device correctly blocks only its downstream branch.

### Device markers overlap

Multiple devices in one centre may intentionally share a centre-level fallback
coordinate. Send explicit device GPS coordinates when individual placement is
required.

## 17. Security and scope

- The local API has no authentication and should remain on a trusted lab LAN.
- The cloud key is stored through Electron's OS credential store.
- The simulator accepts only predefined local state commands.
- It does not run arbitrary commands on the host.
- It does not modify physical network devices.
- Cloud telemetry uses HTTPS and the GSS Infrastructure API key.

## 18. Source map

| File | Responsibility |
| --- | --- |
| `main.cjs` | Electron main process, local server, persistence, traffic, cloud sync |
| `preload.cjs` | Secure renderer-to-main IPC bridge |
| `renderer/index.html` | Three-window UI structure |
| `renderer/app.js` | Topology editing, inspector, controls, traffic display |
| `renderer/styles.css` | Topology, management, inspector, and traffic styling |
| `preview.cjs` | Browser-only preview server |
| `package.json` | Electron scripts and dependency declaration |
| `gss-local-db.json` | Runtime-created local state file |

## 19. Intended next extensions

The lab is ready for adapters that replace virtual models with real collectors:

- SNMPv3 polling for routers, switches, firewalls, and OLTs.
- LLDP/CDP neighbour discovery.
- REST/SSH vendor adapters.
- Syslog and NetFlow/IPFIX ingestion.
- Real interface counters and link faults.
- Authenticated local API access.
- Queue-fallback draining after cloud quota recovery.

These adapters should preserve the current normalized model so the topology,
local API, cloud API, map, anomaly engine, and AI operations do not need to
change when virtual devices are replaced by physical infrastructure.
