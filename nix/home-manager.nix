{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.codex-limit-auto-reset;
in
{
  options.services.codex-limit-auto-reset = {
    enable = lib.mkEnableOption "automatic redemption of Codex rate-limit reset credits";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The codex-limit-auto-reset package to use.";
    };

    codexHome = lib.mkOption {
      type = lib.types.str;
      default = config.home.sessionVariables.CODEX_HOME or "${config.home.homeDirectory}/.codex";
      defaultText = lib.literalExpression ''config.home.sessionVariables.CODEX_HOME or (config.home.homeDirectory + "/.codex")'';
      description = "Directory containing the user's Codex authentication.";
    };

    codexPackage = lib.mkOption {
      type = lib.types.package;
      default = if config.programs.codex.enable then config.programs.codex.package else pkgs.codex;
      defaultText = lib.literalExpression "if config.programs.codex.enable then config.programs.codex.package else pkgs.codex";
      description = "The Codex CLI package used to redeem credits.";
    };

    resetRemainingPercent = lib.mkOption {
      type = lib.types.nullOr (lib.types.ints.between 0 20);
      default = null;
      description = "Redeem one reset when a main Codex allowance has this percentage or less remaining. Null disables usage monitoring.";
    };

    usagePollSeconds = lib.mkOption {
      type = lib.types.ints.between 10 3600;
      default = 60;
      description = "Usage polling interval when resetRemainingPercent is enabled.";
    };

    redeemBeforeMinutes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 360;
      description = "Redeem credits this many minutes before expiration.";
    };

    advisor = {
      enable = lib.mkEnableOption "read-only account switching recommendations in the journal";
      codexAuthPackage = lib.mkOption {
        type = lib.types.package;
        default = pkgs.codex-auth;
        description = "codex-auth with version 1 JSON list and reset-credit metadata.";
      };
      lowPercent = lib.mkOption {
        type = lib.types.ints.between 0 100;
        default = 20;
      };
      warningHours = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2;
      };
      probabilityThreshold = lib.mkOption {
        type = lib.types.float;
        default = 0.7;
      };
      expiryHours = lib.mkOption {
        type = lib.types.ints.positive;
        default = 6;
      };
      cooldownSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 21600;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          !cfg.advisor.enable
          || (
            cfg.advisor.probabilityThreshold >= 0.0
            && cfg.advisor.probabilityThreshold <= 1.0
            && cfg.advisor.cooldownSeconds >= 1800
          );
        message = "Codex advisor probability must be 0..1 and cooldown at least 1800 seconds.";
      }
    ];
    systemd.user.services.codex-usage-advisor = lib.mkIf cfg.advisor.enable {
      Unit.Description = "Codex account switching advice (no switching or reset actions)";
      Service = {
        Type = "oneshot";
        ExecStart = "${cfg.package}/bin/codex-usage-advisor";
        Environment = [
          "CODEX_HOME=${cfg.codexHome}"
          "CODEX_AUTH_BIN=${lib.getExe cfg.advisor.codexAuthPackage}"
          "ADVISOR_STATE_FILE=${config.xdg.stateHome}/codex-usage-advisor/state.json"
          "ADVISOR_LOW_PERCENT=${toString cfg.advisor.lowPercent}"
          "ADVISOR_WARNING_HOURS=${toString cfg.advisor.warningHours}"
          "ADVISOR_PROBABILITY=${toString cfg.advisor.probabilityThreshold}"
          "ADVISOR_EXPIRY_HOURS=${toString cfg.advisor.expiryHours}"
          "ADVISOR_COOLDOWN_SECONDS=${toString cfg.advisor.cooldownSeconds}"
        ];
        UMask = "0077";
        TimeoutStartSec = "3min";
      };
    };
    systemd.user.timers.codex-usage-advisor = lib.mkIf cfg.advisor.enable {
      Unit.Description = "Check Codex usage and reset forecast every five minutes";
      Install.WantedBy = [ "timers.target" ];
      Timer = {
        OnBootSec = "2min";
        OnUnitInactiveSec = "5min";
        RandomizedDelaySec = "15s";
      };
    };
    systemd.user.services.codex-limit-auto-reset = {
      Unit.Description = "Codex Limit Auto Reset";
      Install.WantedBy = [ "default.target" ];
      Service = {
        ExecStart = lib.getExe cfg.package;
        Environment = [
          "CODEX_BIN=${lib.getExe cfg.codexPackage}"
          "CODEX_HOME=${cfg.codexHome}"
          "REDEEM_BEFORE_MINUTES=${toString cfg.redeemBeforeMinutes}"
          "USAGE_POLL_SECONDS=${toString cfg.usagePollSeconds}"
          "STATE_FILE=${config.xdg.stateHome}/codex-limit-auto-reset/recovery.json"
        ]
        ++ lib.optional (
          cfg.resetRemainingPercent != null
        ) "RESET_REMAINING_PERCENT=${toString cfg.resetRemainingPercent}";
        Restart = "on-failure";
        RestartSec = "10s";
      };
    };
  };
}
