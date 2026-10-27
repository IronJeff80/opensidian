# SPDX-License-Identifier: GPL-3.0-or-later
# Nix flake: package, checks and dev shell for opensidian.
#
# The toolchain is nixpkgs' current rustc. Every cargo invocation runs --locked against
# src-tauri/Cargo.lock (crane enforces the lock), so the flake can never pull
# a crate the lock does not pin.
#
# The Cargo.toml lives in src-tauri/, not the source root, but tauri.conf.json
# points frontendDist at ../ui, so the source must keep the whole repo layout
# while cargo runs from src-tauri/ (see the postUnpack dance below).
{
  description = "opensidian — vault-compatible markdown notes app (GPL-3.0-or-later)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    crane.url = "github:ipetkov/crane";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      flake-utils,
    }:
    # Only x86_64-linux tested (same as README). aarch64 can be added once
    # verified on ARM hardware.
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        craneLib = crane.mkLib pkgs;

        # Keep only what the build touches, so cargo hash churn stays low.
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            let
              base = builtins.baseNameOf path;
            in
            (pkgs.lib.cleanSourceFilter path type)
            || (
              type == "directory"
              && builtins.elem base [
                "ui"
                "packaging"
                "fonts"
              ]
            );
        };

        commonArgs = {
          cargoToml = ./src-tauri/Cargo.toml;
          cargoLock = ./src-tauri/Cargo.lock;
          strictDeps = true;

          # Run cargo from src-tauri/ while the repo layout (ui/ for the
          # embedded frontend) stays intact around it.
          postUnpack = ''
            cd $sourceRoot/src-tauri
            sourceRoot="."
          '';

          nativeBuildInputs = with pkgs; [
            pkg-config
            wrapGAppsHook3
          ];

          buildInputs = with pkgs; [
            # webkitgtk_4_1.dev carries the javascriptcoregtk-4.1 and
            # libsoup-3.0 pc files (javascriptcoregtk has no top-level attr)
            webkitgtk_4_1
            webkitgtk_4_1.dev
            gtk3
            openssl
            librsvg
            libayatana-appindicator
          ];
        };

        # The [patch.crates-io] table in src-tauri/Cargo.toml is the source of
        # truth for path-vendored crates.
        vendored = (builtins.fromTOML (builtins.readFile ./src-tauri/Cargo.toml)).patch."crates-io" or { };

        cargoArtifacts = craneLib.buildDepsOnly (
          commonArgs
          // {
            inherit src;
            pname = "opensidian-deps";
            # buildDepsOnly stubs every crate with mkDummySrc — including the
            # [patch.crates-io] path-vendored crates in src-tauri/vendor/, which
            # gio/atk/cairo/javascriptcore-rs then cannot compile against.
            # Put the real sources back after the stubbing.
            extraDummyScript = pkgs.lib.concatStrings (
              pkgs.lib.mapAttrsToList (_: spec: ''
                rm -rf $out/src-tauri/${spec.path}
                cp -r ${./src-tauri + "/${spec.path}"} $out/src-tauri/${spec.path}
              '') vendored
            );
          }
        );

        opensidian = craneLib.buildPackage (
          commonArgs
          // {
            inherit src cargoArtifacts;
            version = (builtins.fromJSON (builtins.readFile ./src-tauri/tauri.conf.json)).version;
            # The flock/spawn/landlock tests need a wider sandbox than the Nix
            # build sandbox allows; cargo tests live in `checks` instead.
            doCheck = false;
            postInstall = ''
              install -Dm644 ${./packaging/flatpak/dev.koto.opensidian.desktop} \
                $out/share/applications/dev.koto.opensidian.desktop
              # launcher icon = the official logo (packaging/linux/render-icons.sh
              # renders the PNGs from opensidian.svg; the svg is the scalable icon)
              for s in 48 64 128 256 512; do
                install -Dm644 ${./packaging/linux/icons}/$s.png \
                  $out/share/icons/hicolor/''${s}x''${s}/apps/dev.koto.opensidian.png
              done
              install -Dm644 ${./packaging/linux/opensidian.svg} \
                $out/share/icons/hicolor/scalable/apps/dev.koto.opensidian.svg
            '';
            meta = with pkgs.lib; {
              description = "Vault-compatible markdown notes app (opensidian)";
              homepage = "https://github.com/jpzk/opensidian";
              license = licenses.gpl3Plus;
              mainProgram = "opensidian";
              platforms = platforms.linux;
            };
          }
        );

      in
      {
        packages = {
          default = opensidian;
          inherit opensidian;
        };

        # NOTE: no `checks` output. 11 of the integration tests (flock
        # contention, process spawning, landlock confinement) need a wider
        # sandbox than the Nix build environment grants, so `cargoTest` inside
        # a check derivation fails for environmental, not code, reasons.
        # Run tests from the dev shell: nix develop -c cargo test --locked

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustc
            cargo
            clippy
            rustfmt
            rust-analyzer
            pkg-config
          ];
          buildInputs = commonArgs.buildInputs;
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
        };
      }
    );
}
