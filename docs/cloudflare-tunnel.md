# Cloudflare Tunnel

The public Paseo hostname is `paseo-1.staticlabs.de`.
The remotely managed tunnel is `paseo-1`, ID `45b92ec4-7caf-4972-bdd7-0328ebbe2fec`.
Its published application targets `http://127.0.0.1:6769`.
The connector makes outbound connections to Cloudflare.

## Address and routing

The separate Caddy listener forwards ordinary traffic to the private daemon on port 6768.
It forwards `/__paseo_services/` to `/run/paseo-previews/gateway.sock`.
It preserves the real Host, Origin, request path, and WebSocket upgrade.
It sets `X-Forwarded-Proto: https` because Cloudflare terminates public HTTPS.
It removes forwarded authority supplied by clients.

Keep every existing Tailscale route active during this migration.
Port 443 targets port 8090, and port 10000 targets port 37569.
Port 8443 targets the existing front on port 6767.
Its `/jev/` and APK download routes remain in Tailscale.
Do not copy those file routes to Cloudflare or reset the Tailscale routing configuration.

The Cloudflare dashboard owns the hostname mapping.
Current documentation names Networking > Tunnels > tunnel > Routes > Add route > Published application.
The installation wizard can require a connected connector before it shows route controls.
Use the actual visible controls when the dashboard differs.
Leave the route path empty and the HTTP Host Header override empty.
The expected CNAME target is `45b92ec4-7caf-4972-bdd7-0328ebbe2fec.cfargotunnel.com`.
Proxied DNS can return Cloudflare addresses instead of this CNAME.
DNS alone cannot prove the configured local service target.

## Credentials and processes

Keep the connector token in `/home/agent/.config/cloudflared/paseo-tunnel.token`, owned by `agent`, mode 0600.
The NixOS module uses `LoadCredential` to copy this file into the service's private credential directory.
`cloudflared` receives only that runtime file path through `--token-file`.
Keep the token value out of Git, arguments, environment variables, and logs.
No global API key, account certificate, or locally managed tunnel JSON is required.

The host channel provides `cloudflared` 2026.7.3.
Cloudflare supports `--token-file` from version 2025.4.0.
Keep log verbosity at `warn` and automatic updates disabled for the Nix package.
The private metrics endpoint uses port 20242.
Outbound TCP and UDP port 7844 support HTTP/2 and QUIC.
The connector does not require new inbound firewall ports.

A temporary connector can unblock the installation wizard without changing Paseo.
On this VM, its unit is `paseo-cloudflared-connector-v2.service` and its metrics port is 20241.
Its token path is `/run/credentials/paseo-cloudflared-connector-v2.service/tunnel-token`.
Use this explicit path in transient units.
`systemd-run` escaped `%d` in the first attempt, so the process received a nonexistent literal path.
The corrected unit returned HTTP 200 from `/ready` with four ready connections on 2026-10-05.
Replace the temporary connector only after the persistent connector proves readiness.

## Authentication and origins

An origin is a URL's scheme, hostname, and port.
Ordinary control traffic can admit two explicit origins during migration.
`previews.additionalControlOrigins` adds exact HTTPS authorities without changing their names.
It does not grant Services preview authority.
Keep `hostnames` limited to the two real public names and existing local defaults.
Keep the daemon password and semantic permissions unchanged.

Browser WebSockets use the new hostname and their actual same-origin Origin header.
Native clients can use `wss://paseo-1.staticlabs.de/ws` with the existing daemon credential.
Native clients do not need a browser Origin header.
Keep any existing explicit CORS policy unless a tested client needs an additional exact origin.
Do not add wildcard CORS or rewrite the new hostname to the tailnet name.

The new browser origin starts with separate browser storage and cookies.
Log in through the new page and retain the old page while it owns pending messages.
Do not reload the old page during a checkpointed update.
Keep existing client connections and pairing credentials available.
New direct pairing links must advertise the new HTTPS/WSS endpoint.
Do not enable the relay or an interactive Cloudflare Access gate during this migration.
Those change the browser/native authentication flow and require separate qualification.

Services keeps one canonical origin in both transport configuration and `services/policy-v1.json`.
Initial Cloudflare qualification retains the tailnet Services origin.
After ordinary access passes, switch both canonical values to `https://paseo-1.staticlabs.de`.
This ends old-origin preview grants and requires fresh Open actions on the new origin.
The old hostname continues to serve ordinary Paseo control traffic.
Old preview cookies remain host-bound and cannot transfer to the new hostname.
Keep the existing Secure, HttpOnly, SameSite, and path rules.
Do not widen cookie domains or bypass ticket, source, or same-origin admission.
Native Services previews retain their existing unavailable state.

## Deployment and rollback

Read [fork maintenance](fork-maintenance.md) before activation.
Use [restart recovery](restart-recovery-plan.md) for continuity requirements.
Retain the previous host configuration, source archive, system closure, and Services policy before deployment.
Keep policy snapshots private because they can contain workspace metadata.
Never put token contents in a source archive.

Import the module from the host configuration with the reviewed immutable Paseo source:

```nix
(import "${paseoSrc}/nix/cloudflare-tunnel.nix" {
  paseoSource = paseoSrc;
  connectorEnabled = true;
  migrateServices = false;
})
```

Build and activate through `scripts/deploy-nixos.sh` outside `paseo.service`.
Use the live state directory and private deployment credential file from fork maintenance.
The wrapper builds first and requires a ready checkpoint before activation.
Make sure that the replacement reports the exact restored generation before proceeding.
If checkpoint preparation fails, preserve the running or paused daemon and diagnose the failure.
Never bypass failure with raw restart, signals, direct NixOS switch, or reboot.

Qualify public ordinary traffic before changing Services policy.
Exercise authenticated browser and native-style WebSockets through the real Cloudflare hostname.
Exercise browser reconnection, history reads, and direct pairing endpoint generation.
Make sure that unauthenticated access cannot control agents.
Make sure that the old hostname and every Tailscale route still work.

For Services cutover, change only the policy's `controlOrigin` field and preserve its other content.
Retain its prior bytes before replacement.
Set `migrateServices = true` in the module import.
Use another checkpointed deployment for this restart-bound policy change.
Exercise fresh browser Open, preview HTTP, cookie confirmation, WebSockets, and application prefix handling through Cloudflare.
Make sure that foreign origins and requests without preview authority still fail.
Report the end of old-origin preview grants plainly.

If ordinary Cloudflare qualification fails, retain Tailscale access and remove the candidate import with the checkpointed deployment path.
Restore the previous source pin only after its checkpoint-format preflight passes.
The initial rollback package supports format 4 and the same reserved-ingress guard.
Never restore an old checkpoint over newer accepted work.

If Services qualification fails, restore the exact saved policy and set `migrateServices = false`.
Use the checkpointed deployment path with the new package to repair the origin change.
This restores fresh Services Open actions on the tailnet origin.
It does not revive prior browser grants or cookies.
Keep checkpoints, deployment logs, both source archives, and newer state for diagnosis.

## Sources

Cloudflare documents the [dashboard setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/),
[token-file flag](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/),
and [origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).
Its [firewall guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) names the outbound ports.
Its [WebSocket guidance](https://developers.cloudflare.com/network/websockets/) describes idle closure and edge reconnects.
The systemd [credential documentation](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml) defines `LoadCredential` and private credential access.
