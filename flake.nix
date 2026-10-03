{
  inputs = {
    nixpkgs.url = github:nixos/nixpkgs/nixpkgs-unstable;
    rust-overlay = {
      url = github:oxalica/rust-overlay;
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs = { self, nixpkgs, rust-overlay }:
    let
      forAllSystems = with nixpkgs.lib; f: foldAttrs mergeAttrs { }
        (map (s: { ${s} = f s; }) systems.flakeExposed);
    in
    {
      devShell = forAllSystems
        (system:
          let
            pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
            # The engine crate's toolchain, from the same pin CI builds the releases with.
            rust = pkgs.rust-bin.fromRustupToolchainFile ./engine/rust-toolchain.toml;
          in
          pkgs.mkShell rec {
            packages = with pkgs; [
	      nodejs_22
	      # Needed for node-gyp to build native addons from source (e.g. the `inotify` package used for
	      # real IN_Q_OVERFLOW detection on Linux - see local-import-scan.js/character-metadata-db.js's
	      # watcher-overflow handling) - this project's other native deps (better-sqlite3, @reflink/reflink)
	      # ship prebuilt binaries and never needed this, `inotify` has none and requires a from-source build.
	      python3
	      # engine/ (st-engine): development builds only; installs fetch the prebuilt file.
	      rust
            ];
            # Playwright's downloaded browsers can't run on NixOS. tests/package.json pins @playwright/test
            # to this nixpkgs' playwright-driver version so the browser revisions match.
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          });
    };
}
