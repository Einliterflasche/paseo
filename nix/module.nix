{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.paseo;
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "services" "paseo" "allowedHosts" ] [ "services" "paseo" "hostnames" ])
  ];

  options.services.paseo = {
    enable = lib.mkEnableOption "Paseo, a self-hosted daemon for AI coding agents";

    package = lib.mkPackageOption pkgs "paseo" { };

    user = lib.mkOption {
      type = lib.types.str;
      default = "paseo";
      description = "User account under which Paseo runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "paseo";
      description = "Group under which Paseo runs.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default =
        if cfg.user == "paseo"
        then "/var/lib/paseo"
        else "/home/${cfg.user}/.paseo";
      defaultText = lib.literalExpression ''
        if cfg.user == "paseo"
        then "/var/lib/paseo"
        else "/home/''${cfg.user}/.paseo"
      '';
      description = "Directory for Paseo state (PASEO_HOME). Stores agent data, config, and logs.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 6767;
      description = "Port for the Paseo daemon to listen on.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address for the Paseo daemon to bind to.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the firewall for the Paseo daemon port.";
    };

    shutdownCheckpointTimeout = lib.mkOption {
      type = lib.types.ints.positive;
      default = 120;
      description = ''
        Seconds a running daemon may spend committing a restart checkpoint when
        the service stops (`systemctl stop` or `restart`, a VM or host shutdown).
        The next start restores that checkpoint instead of pausing recovery.
        Sets `PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS`. A failed or timed-out
        checkpoint retains the daemon and blocks replacement. Diagnose the
        failure before retrying the checkpointed deployment command.
      '';
    };

    previews = {
      enable = lib.mkEnableOption "the independent same-address service preview front";

      controlOrigin = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "https://paseo.example.com";
        description = ''
          Exact existing HTTPS Paseo origin, including any nondefault port.
          Required for the control-only front independently of preview policy.
        '';
      };

      additionalControlOrigins = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "https://paseo.example.com" ];
        description = ''
          Additional exact HTTPS origins for ordinary control traffic during
          migration. Services previews remain bound to controlOrigin and their
          matching saved policy. These origins do not grant preview authority.
        '';
      };

      additionalFrontPorts = lib.mkOption {
        type = lib.types.listOf lib.types.port;
        default = [ ];
        description = "Additional loopback control fronts excluded from Services registration.";
      };

      daemonPort = lib.mkOption {
        type = lib.types.port;
        default = 6768;
        description = ''
          Private daemon port when previews.enable is true. The public loopback
          front keeps services.paseo.port, including during gateway failure.
          First installation needs the checkpointed continuity preflight.
        '';
      };

      frontPackage = lib.mkPackageOption pkgs "caddy" { };
    };

    hostnames = lib.mkOption {
      type = lib.types.either (lib.types.enum [ true ]) (lib.types.listOf lib.types.str);
      default = [ ];
      example = [ ".example.com" "myhost.local" ];
      description = ''
        Hostnames the Paseo daemon accepts in the Host header (DNS rebinding protection).
        Localhost and IP addresses are always allowed by default.

        Use a leading dot to match a domain and all its subdomains
        (e.g. `".example.com"` matches `example.com` and `foo.example.com`).

        Set to `true` to allow any host (not recommended).
      '';
    };

    relay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether to enable relay-based remote access. When false, the daemon
          runs with `--no-relay` and only accepts direct (LAN/loopback)
          connections.
        '';
      };

      mode = lib.mkOption {
        type = lib.types.enum [ "hosted" "remote" ];
        default = "hosted";
        description = ''
          How the daemon reaches the relay when `relay.enable = true`:

          - `"hosted"` (default): use the upstream `app.paseo.sh` relay.
            Preserves the current behavior; no extra options needed.
          - `"remote"`: connect to a self-hosted relay at
            `relay.host:relay.port`. Sets `PASEO_RELAY_ENDPOINT` and
            `PASEO_RELAY_USE_TLS` for the daemon.

          A `"local"` mode (running a relay on the same host as a systemd
          unit) is not yet implemented — the relay package currently only
          ships a Cloudflare Workers adapter. Tracked separately.
        '';
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "relay.example.com";
        description = "Relay hostname. Required when `relay.mode = \"remote\"`.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Relay port. Used when `relay.mode = \"remote\"`.";
      };

      useTls = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to use TLS when connecting to the relay. Used when `relay.mode = \"remote\"`.";
      };

      publicUseTls = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = ''
          Whether the public (client-facing) relay endpoint uses TLS.
          When `null` (default), the daemon falls back to `relay.useTls`.
          Override when the internal path is plain `ws://` behind a
          TLS-terminating reverse proxy.
        '';
      };
    };

    inheritUserEnvironment = lib.mkOption {
      type = lib.types.bool;
      default = cfg.user != "paseo";
      defaultText = lib.literalExpression ''cfg.user != "paseo"'';
      description = ''
        Whether to include the user's profile PATH in the service environment.

        When Paseo runs as a real user (not the default system user), AI agents
        need access to the user's tools (git, ssh, etc.). This adds the user's
        NixOS profile, home-manager profile (`~/.nix-profile/bin` and
        `~/.local/state/nix/profile/bin`), and system paths so agents can use
        them without manually setting PATH.

        Enabled by default when `user` is set to a non-default value.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          PASEO_RELAY_ENDPOINT = "relay.paseo.sh:443";
        }
      '';
      description = "Extra environment variables for the Paseo daemon.";
    };

    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      default = { };
      example = lib.literalExpression ''
        {
          daemon.mcp = { enabled = true; injectIntoAgents = false; };
          agents.providers.myAcp = {
            extends = "acp";
            label = "My Agent";
            command = { path = "/run/current-system/sw/bin/my-acp"; };
          };
          log.file = { level = "info"; path = "/var/lib/paseo/daemon.log"; };
        }
      '';
      description = ''
        Declarative content for `$PASEO_HOME/config.json`. Rendered to JSON
        and installed on every service start.

        Runtime mutations to `config.json` (e.g. via `paseo daemon set-password`
        or the mobile app toggling MCP injection / provider overrides) are
        overwritten on the next restart. Pick one: manage via this option, or
        manage via the CLI — not both.

        The full schema is defined by `PersistedConfigSchema` in
        `packages/server/src/server/persisted-config.ts`.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    let
      settingsFile = (pkgs.formats.json { }).generate "paseo-config.json" cfg.settings;
      previewSocket = "/run/paseo-previews/gateway.sock";
      previewFrontModule = pkgs.runCommand "paseo-preview-front.mjs" {
        nativeBuildInputs = [ pkgs.esbuild ];
      } ''
        cp ${../packages/server/src/server/service-preview/front-config.ts} front-config.ts
        cp ${../packages/server/src/server/service-preview/control-transport.ts} control-transport.ts
        esbuild front-config.ts \
          --bundle --platform=node --format=esm --outfile="$out"
      '';
      previewFrontConfig = pkgs.runCommand "paseo-preview-front.json" {
        nativeBuildInputs = [ pkgs.nodejs_22 ];
      } ''
        node --input-type=module - ${previewFrontModule} \
          ${toString cfg.port} ${toString cfg.previews.daemonPort} ${lib.escapeShellArg previewSocket} ${lib.escapeShellArg cfg.previews.controlOrigin} ${lib.escapeShellArg (builtins.toJSON cfg.previews.additionalControlOrigins)} > "$out" <<'JS'
        const { createPreviewFrontConfig } = await import(process.argv[2]);
        process.stdout.write(JSON.stringify(createPreviewFrontConfig({
          listenPort: Number(process.argv[3]),
          daemonPort: Number(process.argv[4]),
          gatewaySocketPath: process.argv[5],
          controlOrigin: process.argv[6],
          additionalControlOrigins: JSON.parse(process.argv[7]),
        })));
        JS
      '';
    in
    {
    assertions = [
      {
        assertion = !(cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.host == "");
        message = ''
          services.paseo.relay.host must be set when relay.mode = "remote".
        '';
      }
      {
        assertion = !cfg.previews.enable || (cfg.listenAddress == "127.0.0.1" && cfg.port != cfg.previews.daemonPort);
        message = "Service previews require distinct front/daemon ports and listenAddress 127.0.0.1.";
      }
      {
        assertion = !cfg.previews.enable || cfg.previews.controlOrigin != "";
        message = "Service previews require the existing HTTPS controlOrigin independently of feature policy.";
      }
    ];

    users.users.${cfg.user} = lib.mkIf (cfg.user == "paseo") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
    };

    users.groups.${cfg.group} = lib.mkIf (cfg.group == "paseo") { };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 ${cfg.user} ${cfg.group} - -"
    ] ++ lib.optionals cfg.previews.enable [
      "d /run/paseo-previews 0700 ${cfg.user} ${cfg.group} - -"
    ];

    # This front has no PartOf/BindsTo relationship with the daemon or gateway.
    # Preview worker failure must not interrupt ordinary Paseo connections.
    systemd.services.paseo-preview-front = lib.mkIf cfg.previews.enable {
      description = "Paseo same-address service preview front";
      # Ordering only: on first activation the old daemon must release the front
      # port before Caddy starts. Later daemon failure/restarts do not stop it.
      after = [ "network.target" "systemd-tmpfiles-setup.service" "paseo.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStartPre = "${cfg.previews.frontPackage}/bin/caddy validate --config ${previewFrontConfig}";
        ExecStart = "${cfg.previews.frontPackage}/bin/caddy run --config ${previewFrontConfig}";
        Restart = "on-failure";
        TimeoutStopSec = "infinity";
      };
    };

    systemd.services.paseo = {
      description = "Paseo - self-hosted daemon for AI coding agents";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      preStart = lib.mkIf (cfg.settings != { }) ''
        install -m 0600 ${settingsFile} ${cfg.dataDir}/config.json
      '';

      environment = {
        PASEO_HOME = cfg.dataDir;
        PASEO_LISTEN = "${cfg.listenAddress}:${toString (if cfg.previews.enable then cfg.previews.daemonPort else cfg.port)}";
        PASEO_SHUTDOWN_CHECKPOINT_TIMEOUT_MS = toString (cfg.shutdownCheckpointTimeout * 1000);
        PASEO_SERVICE_CGROUP = "/system.slice/paseo.service";
      } // lib.optionalAttrs cfg.previews.enable {
        PASEO_SERVICES_FRONT_PORT = toString cfg.port;
        PASEO_SERVICES_GATEWAY_SOCKET = previewSocket;
        PASEO_SERVICES_CONTROL_ORIGIN = cfg.previews.controlOrigin;
      } // lib.optionalAttrs (cfg.previews.enable && cfg.previews.additionalControlOrigins != [ ]) {
        PASEO_SERVICES_ADDITIONAL_CONTROL_ORIGINS = lib.concatStringsSep "," cfg.previews.additionalControlOrigins;
      } // lib.optionalAttrs (cfg.previews.enable && cfg.previews.additionalFrontPorts != [ ]) {
        PASEO_SERVICES_ADDITIONAL_FRONT_PORTS = lib.concatMapStringsSep "," toString cfg.previews.additionalFrontPorts;
      } // lib.optionalAttrs cfg.inheritUserEnvironment (
        let
          # Match dataDir's convention. We can't read users.users.<name>.home
          # because the user may be managed outside NixOS.
          userHome = "/home/${cfg.user}";
        in {
          # mkForce overrides the default PATH from NixOS's systemd module (which
          # only includes store paths for coreutils/grep/sed/systemd). When the
          # daemon runs as a real user, also include home-manager profile paths
          # so user-installed CLIs (claude, opencode, codex, ...) are reachable
          # by agent processes the daemon spawns.
          PATH = lib.mkForce (lib.concatStringsSep ":" (
            lib.optionals (cfg.user != "paseo") [
              "${userHome}/.nix-profile/bin"
              "${userHome}/.local/state/nix/profile/bin"
            ]
            ++ [
              "/etc/profiles/per-user/${cfg.user}/bin"
              "/run/current-system/sw/bin"
              "/run/wrappers/bin"
              "/nix/var/nix/profiles/default/bin"
            ]
          ));
        }
      ) // lib.optionalAttrs (cfg.hostnames == true) {
        PASEO_HOSTNAMES = "true";
      } // lib.optionalAttrs (lib.isList cfg.hostnames && cfg.hostnames != [ ]) {
        PASEO_HOSTNAMES = lib.concatStringsSep "," cfg.hostnames;
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote") {
        PASEO_RELAY_ENDPOINT = "${cfg.relay.host}:${toString cfg.relay.port}";
        PASEO_RELAY_USE_TLS = if cfg.relay.useTls then "true" else "false";
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.publicUseTls != null) {
        PASEO_RELAY_PUBLIC_USE_TLS = if cfg.relay.publicUseTls then "true" else "false";
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;

        ExecStart =
          "${cfg.package}/bin/paseo-server"
          + lib.optionalString (!cfg.relay.enable) " --no-relay";

        Restart = "on-failure";
        RestartSec = 5;

        # Managed services and the preview gateway prefer OOM termination. Losing
        # one must not make systemd stop the supervisor and every active agent.
        OOMPolicy = "continue";

        # Only the supervisor receives SIGTERM. It asks the worker to commit a
        # restart checkpoint and to quiesce its agents itself; signaling every
        # provider process at once would kill the agents before that capture.
        KillMode = "mixed";
        # A failed checkpoint must never turn into systemd-forced termination.
        SendSIGKILL = false;
        KillSignal = "SIGTERM";
        TimeoutStopSec = "infinity";
      };
    };

    environment.systemPackages = [ cfg.package ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
    }
  );
}
