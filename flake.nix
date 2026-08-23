{
  inputs = {
    nixpkgs.url = github:nixos/nixpkgs/nixpkgs-unstable;
  };
  outputs = { self, nixpkgs }:
    let
      forAllSystems = with nixpkgs.lib; f: foldAttrs mergeAttrs { }
        (map (s: { ${s} = f s; }) systems.flakeExposed);
    in
    {
      devShell = forAllSystems
        (system:
          let pkgs = nixpkgs.legacyPackages.${system}; in
          pkgs.mkShell rec {
            packages = with pkgs; [
	      nodejs_22
	      # Needed for node-gyp to build native addons from source (e.g. the `inotify` package used for
	      # real IN_Q_OVERFLOW detection on Linux - see local-import-scan.js/character-metadata-db.js's
	      # watcher-overflow handling) - this project's other native deps (better-sqlite3, @reflink/reflink)
	      # ship prebuilt binaries and never needed this, `inotify` has none and requires a from-source build.
	      python3
            ];
          });
    };
}
