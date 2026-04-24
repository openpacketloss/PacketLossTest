# [PacketLossTest by OpenPacketLoss™](https://openpacketloss.com/) | Web Application

OpenPacketLoss™ is a modern, open-source network diagnostic tool built to measure raw packet loss directly from any web browser.

Unlike throughput tests that hide packet drops behind TCP retransmission, or legacy CLI tools like ping and traceroute that rely on rate-limited ICMP, OpenPacketLoss uses WebRTC Data Channels configured with ordered: false and maxRetransmits: 0, delivering unreliable, unordered SCTP datagrams that behave like raw UDP. The result is a true, protocol-accurate measurement of network stability as experienced by latency-sensitive applications like Zoom, Discord, and online gaming.

[![OpenPacketLoss Demo](assets/demo.gif)](https://openpacketloss.com)

## Key Features

- **Real-Time Visualization**: SVG-based interface displaying real-time packet transmission and loss events.
- **Directional Testing**: 
  - **Client to Server (C2S)**: Measures upload stability.
  - **Server to Client (S2C)**: Measures download stability.
  - **Dual-Direction**: Simultaneous testing for comprehensive network profiling.
- **Technical Metrics**:
  - **Packet Loss Percentage**: Calculated based on sequence number gaps.
  - **Jitter**: Latency variation (PDV) tracking.
  - **RTT (Latency)**: Accurate round-trip time measurement.
  - **Sequence Analysis**: Detection of out-of-order packet delivery.
- **Configurable Parameters**:
  - **Test Duration**: Support for short-burst or long-term stress testing.
  - **Packet Frequency**: Adjustable transmission intervals.
  - **Packet Size (MTU)**: Support for testing varying payloads from 100B to 9000B.

## How It Works

The application utilizes the WebRTC DataChannel API with the following constraints:
- `ordered: false`
- `maxRetransmits: 0`

This configuration forces the transport layer to behave as an unreliable protocol, similar to UDP. The engine transmits JSON-encoded packets containing sequence numbers and high-resolution timestamps. The endpoint analyzes these sequences to identify packet loss and calculate timing jitter.

This repository contains the web-based frontend. It requires a compatible [OpenPacketLoss Server](https://github.com/openpacketloss/OpenPacketLoss-Server) backend to facilitate WebRTC signaling and packet echoing.

## Self-Hosting

For accurate network diagnostics on local infrastructure (LAN, Wi-Fi, or VPN), hosting a private server is recommended. This minimizes external routing variables and congestion.

Documentation and deployment resources: https://openpacketloss.com/selfhosted-server

### Deployment Options

- **Docker ([OpenPacketLoss-Server-Docker](https://github.com/openpacketloss/OpenPacketLoss-Server-Docker))**: Containerized deployment for server environments.
  ```bash
  docker run -d --name openpacketloss --network host --restart unless-stopped openpacketloss/openpacketloss-server:latest
  ```
- **Native Applications ([OpenPacketLoss-Server](https://github.com/openpacketloss/OpenPacketLoss-Server))**: Available for Windows (Microsoft Store), Android (Google Play), iOS/macOS (App Store), and Linux (Snapcraft).
- **Direct Binaries**: Compiled packages for major operating systems including EXE, DMG, AppImage, DEB, and RPM.

## Project Structure

- `index.html`: Entry point containing application structure and metadata.
- `main.js`: Core test engine and client-side logic.
- `styles.min.css`: Compiled CSS for the application interface.
- `fonts.min.css`: Local font assets.
- `bundle.min.js`: Optimized production build.
- `icon/`: Static assets and PWA manifest.

## Getting Started

1. **Backend Deployment**: Initialize a server following the [Self-Hosting Guide](https://openpacketloss.com/selfhosted-server).
2. **Frontend Deployment**: Serve the files from this repository using any static web server.
3. **Configuration**: Configure the `window.SERVER_CONFIG` in `index.html` to point to the signaling endpoint of the deployed server.

## Related Repositories

- [OpenPacketLoss-Server](https://github.com/openpacketloss/OpenPacketLoss-Server): Core WebRTC server implementation.
- [OpenPacketLoss-Server-Docker](https://github.com/openpacketloss/OpenPacketLoss-Server-Docker): Containerized deployment for easy hosting.
- [PacketLossTest](https://github.com/openpacketloss/PacketLossTest): The web-based testing interface (this repository).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

Maintained by OpenPacketLoss.com
