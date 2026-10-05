# Import from the host configuration with its immutable, reviewed Paseo source.
{ paseoSource, connectorEnabled ? false, migrateServices ? false }:
{ config, lib, pkgs, ... }:
let
  hostname = "paseo-1.staticlabs.de";
  oldOrigin = "https://agent.tail4cfb4c.ts.net:8443";
  newOrigin = "https://${hostname}";
  cfg = config.services.paseo;
  frontModule = pkgs.runCommand "paseo-cloudflare-front.mjs" {
    nativeBuildInputs = [ pkgs.esbuild ];
  } ''
    cp ${paseoSource}/packages/server/src/server/service-preview/front-config.ts front-config.ts
    cp ${paseoSource}/packages/server/src/server/service-preview/control-transport.ts control-transport.ts
    esbuild front-config.ts --bundle --platform=node --format=esm --outfile="$out"
  '';
  frontConfig = pkgs.runCommand "paseo-cloudflare-front.json" {
    nativeBuildInputs = [ pkgs.nodejs_22 ];
  } ''
    node --input-type=module - ${frontModule} > "$out" <<'JS'
    const { createPreviewFrontConfig } = await import(process.argv[2]);
    const config = createPreviewFrontConfig({
      listenPort: 6769,
      daemonPort: ${toString cfg.previews.daemonPort},
      gatewaySocketPath: '/run/paseo-previews/gateway.sock',
      controlOrigin: 'https://${hostname}',
    });
    for (const route of config.apps.http.servers.paseo.routes) {
      for (const handler of route.handle) {
        if (handler.handler === 'reverse_proxy') {
          handler.headers.request.set['X-Forwarded-Proto'] = ['https'];
        }
      }
    }
    process.stdout.write(JSON.stringify(config));
    JS
  '';
in
{
  assertions = [
    {
      assertion = cfg.enable && cfg.previews.enable && cfg.previews.daemonPort != 6769 && cfg.port != 6769;
      message = "The Cloudflare front requires Paseo previews and a separate loopback port 6769.";
    }
    {
      assertion = lib.versionAtLeast pkgs.cloudflared.version "2025.4.0";
      message = "Cloudflare token-file requires cloudflared 2025.4.0 or later.";
    }
  ];

  # The existing front and daemon admit the real second authority. The canonical
  # preview origin and saved Services policy stay unchanged in the canary stage.
  services.paseo.previews.controlOrigin = lib.mkForce (if migrateServices then newOrigin else oldOrigin);
  services.paseo.previews.additionalControlOrigins = [ (if migrateServices then oldOrigin else newOrigin) ];
  services.paseo.previews.additionalFrontPorts = [ 6769 ];
  services.paseo.hostnames = [ "agent.tail4cfb4c.ts.net" hostname ];

  systemd.services.paseo-cloudflare-front = {
    description = "Paseo Cloudflare HTTP front on loopback 6769";
    after = [ "network.target" "systemd-tmpfiles-setup.service" "paseo.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      User = cfg.user;
      Group = cfg.group;
      ExecStartPre = "${cfg.previews.frontPackage}/bin/caddy validate --config ${frontConfig}";
      ExecStart = "${cfg.previews.frontPackage}/bin/caddy run --config ${frontConfig}";
      Restart = "on-failure";
      TimeoutStopSec = "infinity";
    };
  };

  # Remotely managed tunnel paseo-1: 45b92ec4-7caf-4972-bdd7-0328ebbe2fec.
  # This string is a runtime path. Never interpolate the credential contents.
  systemd.services.paseo-cloudflare-tunnel = {
    description = "Paseo Cloudflare tunnel paseo-1";
    after = [ "network-online.target" "paseo-cloudflare-front.service" ];
    wants = [ "network-online.target" ];
    wantedBy = lib.optionals connectorEnabled [ "multi-user.target" ];
    serviceConfig = {
      DynamicUser = true;
      LoadCredential = [ "tunnel-token:/home/agent/.config/cloudflared/paseo-tunnel.token" ];
      ExecStart = "${pkgs.cloudflared}/bin/cloudflared --no-autoupdate tunnel --loglevel warn --metrics 127.0.0.1:20242 run --token-file /run/credentials/paseo-cloudflare-tunnel.service/tunnel-token";
      Restart = "on-failure";
      RestartSec = 5;
      UMask = "0077";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
    };
  };
}
